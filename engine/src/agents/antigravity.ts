import { getWorkspace, resolveWorkspaceByRoot, runWithWorkspace } from '../workspace-context.js';
import { log } from '../log.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getConfig } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentSessionEntry, type AgentSessionProgress } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, estimateCostUSD } from '../task-store.js';
import { resolveTaskExecutionRoot, resolveResumeExecutionRoot, assertIsolatedSpawnRoot } from '../task-worktree.js';
import { resolveExecutionRootReclaimOpts } from '../pr-cleanup.js';
import { notifyGroupSessionTerminal, notifyDelegationComplete, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { killProcessTree } from '../kill-process-tree.js';
import { getExemptPidsForSession, clearHoldsForSession } from '../background-process-holds.js';
import { checkFrameworkHealth, checkSkillStaleness } from '../notifications.js';
import { captureTurnStartState, clearNeedsActionIfSet, flagIfParked } from '../parked-ticket.js';
import { buildMemberScopeArgs } from '../group.js';
import { buildGroupDocsScopeArg } from '../group-member-worktree.js';
import { appendTranscriptLine } from '../transcript.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import {
  EFFORT_LEVELS,
  type EffortLevel,
  cleanChildEnv,
  appendSessionOutput,
  appendErrorToSession,
  flushSessionOutput,
  activityFor,
  attachStdoutProcessing as sharedAttachStdoutProcessing,
  buildInitialPrompt,
  terminalizeResumedExit,
  surfaceResumeFailure,
  isChatEditGated,
  isScratchSession,
  prependEditGateNote,
  resolveModel,
  buildTokenMetadataUpdate,
  buildPhaseHandoffNote,
  stopOutcomeText,
  type CliTask,
} from './shared.js';

// FLUX-1738: names observed on the live `init.tools` list of agy 1.1.26 (56 built-ins), NOT from
// docs. Unknown names fall through to activityFor's generic label. Antigravity's tool vocabulary is
// its own — it shares nothing with Gemini CLI's `read_file`/`write_file`/`run_shell_command`, which
// is one more reason this adapter is not a fork of gemini.ts.
const ANTIGRAVITY_TOOL_ACTIVITY_MAP: Record<string, string> = {
  view_file: 'Reading',
  list_dir: 'Reading',
  read_resource: 'Reading',
  notebook_edit: 'Editing',
  write_to_file: 'Editing',
  replace_file_content: 'Editing',
  multi_replace_file_content: 'Editing',
  sed_file: 'Editing',
  run_command: 'Running command',
  command_status: 'Running command',
  send_command_input: 'Running command',
  notebook_execution: 'Running command',
  grep_search: 'Searching',
  find_by_name: 'Searching',
  search_web: 'Researching',
  read_url_content: 'Researching',
  open_browser_url: 'Researching',
  read_browser_page: 'Researching',
  invoke_subagent: 'Delegating',
  define_subagent: 'Delegating',
  manage_subagents: 'Delegating',
  browser_subagent: 'Delegating',
  manage_task: 'Planning',
  schedule: 'Planning',
  ask_question: 'Asking',
  ask_permission: 'Asking',
  ask_custom_permission: 'Asking',
  call_mcp_tool: 'Working',
  generate_image: 'Working',
  finish: 'Working',
};

/**
 * FLUX-1738: `--print-timeout` defaults to **5 minutes**, which would guillotine essentially every
 * real Event Horizon session (a grooming or implementation turn routinely runs far longer). No other
 * adapter has a wall-clock cap to defeat, so this is easy to miss until sessions start dying at
 * exactly 5:00 with a clean exit and a truncated transcript. Sent on every spawn, spawn and resume
 * alike. Go duration string — `agy` parses it with `time.ParseDuration`.
 */
const PRINT_TIMEOUT = '24h';

/**
 * FLUX-1738: `agy --effort` accepts ONLY low|medium|high — but Event Horizon's own EFFORT_LEVELS
 * are `low|medium|high|xhigh|max`, so passing an EH effort straight through is a live bug for the
 * top two levels. Probed: `--effort xhigh` fails with
 *   `invalid model selection (--model "" --effort "xhigh"): invalid --effort "xhigh" (valid: low, medium, high)`
 * ...and in `--output-format json` mode that failure EXITS 0 with `status:"ERROR"` — a session that
 * looks successful while having done nothing. We only ever use `stream-json`, which exits 1 for the
 * same input (so the exit handler does mark it failed), but the two extra levels are still simply
 * unusable. Clamp instead of dropping: an operator who asked for maximum reasoning gets Antigravity's
 * maximum, rather than silently falling back to the CLI's default.
 */
const AGY_EFFORT_LEVELS = new Set(['low', 'medium', 'high']);

export function clampAntigravityEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  if (AGY_EFFORT_LEVELS.has(effort)) return effort;
  if (effort === 'xhigh' || effort === 'max') return 'high';
  return undefined;
}

/** Narrow shape of the loosely-typed ticket record this adapter actually reads from. */
interface AntigravityTask extends CliTask {
  id?: string;
  branch?: string;
  effortLevel?: string;
  kind?: string;
}

/**
 * FLUX-1738: on Windows the installer drops the binary at `%LOCALAPPDATA%\agy\bin\agy.exe` — NOT the
 * `~/.local/bin/agy` the docs describe, and NOT the `…\Programs\Antigravity\bin` entry the IDE puts
 * on PATH (that directory does not exist). `agy` is consequently absent from a non-login shell's
 * PATH on a working install, so a `where agy` preflight would false-negative a perfectly good
 * install — the `windows-binary-resolution` preflight concern in CAPABILITY_PROBES, and the same
 * class of bug as copilot.ts's checkCopilotBinaryInstalled. Probe the pinned path first and only
 * then fall back to the bare name (mirrors resolveGrokBinary).
 */
export function antigravityUserBinaryPath(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'agy', 'bin', 'agy.exe');
  }
  return path.join(os.homedir(), '.local', 'bin', 'agy');
}

let cachedAntigravityBinary: string | null = null;

export function resolveAntigravityBinary(): string {
  if (cachedAntigravityBinary) return cachedAntigravityBinary;
  const pinned = antigravityUserBinaryPath();
  if (fs.existsSync(pinned)) {
    cachedAntigravityBinary = pinned;
    return pinned;
  }
  cachedAntigravityBinary = 'agy';
  return 'agy';
}

/** Test seam — the module-scoped resolution cache would otherwise leak between test files. */
export function resetAntigravityBinaryCache(): void {
  cachedAntigravityBinary = null;
}

/**
 * Multi-repo group scope. Unlike gemini.ts — which has to translate `--add-dir` into its own
 * `--include-directories` — Antigravity accepts `--add-dir` verbatim (repeatable), so the shared
 * group args pass straight through.
 */
export function buildAntigravityScopeArgs(workspaceRoot: string): string[] {
  return [...buildMemberScopeArgs(), ...buildGroupDocsScopeArg(workspaceRoot)];
}

export interface AntigravityArgOpts {
  /** Resume an existing conversation by id (`init.conversation_id` from a prior turn). */
  conversationId?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  skipPermissions?: boolean | undefined;
  scopeArgs?: string[];
}

/**
 * FLUX-1738: every flag here was read off `agy --help` on the live 1.1.26 binary. NONE of Gemini
 * CLI's flags survive the transition — `--yolo`, `--resume`, `--screen-reader` and `--skip-trust`
 * all simply do not exist on `agy`, so a copied gemini.ts argv fails outright.
 *
 * Prompt delivery over stdin: Windows caps a command line at 32,767 chars (FLUX-1444). `agy`
 * reads non-TTY stdin directly when `--output-format stream-json` is provided (its `--input-format`
 * defaults to `text`). Note that `-p ''` / `--print=''` must NOT be passed: `agy` explicitly
 * rejects an empty prompt argument with `Error: empty prompt. Usage: agy --print "your prompt here"`
 * (FLUX-1751).
 */
/**
 * FLUX-1751: an EMPTY prompt makes `agy` hang forever, so it is refused before the spawn.
 *
 * Probed on agy 1.1.26: with no `-p` and empty stdin, `agy` was still alive when killed externally
 * at 75s under `--print-timeout 20s` — its own timeout does NOT interrupt it. Production
 * `PRINT_TIMEOUT` is 24h, so an empty prompt is a session pinned for a day holding a worktree slot
 * (and, under the Furnace, a burn slot).
 *
 * This is specifically a regression risk created by removing `-p`: the previously shipped `-p ''`
 * shape failed LOUDLY (`Error: empty prompt. Usage: agy --print "your prompt here"`) — that error
 * is the FLUX-1751 bug this guard's sibling fix removed. Dropping `-p` fixed the false failure and
 * introduced a silent hang in its place; both need covering.
 *
 * NOTE on prompt SIZE: deliberately not guarded here. Probing suggested large stdin prompts
 * (~23-30 KB) could be dropped while still reporting `status:"SUCCESS"`, but the results were
 * non-monotonic (23 KB dropped, 24 KB delivered, 25/26 KB dropped) and the test account hit its
 * usage quota during that run — which is exactly what intermittent throttling looks like. Cause is
 * therefore UNRESOLVED (size ceiling vs. rate limiting), and a byte threshold guessed from
 * contaminated data would block legitimate turns. `antigravityNoOpTurnError` below guards the
 * observable symptom instead, which is correct whatever the cause.
 */
export function antigravityPromptDeliveryError(prompt: string): string | null {
  if (!prompt || !prompt.trim()) {
    return 'Refusing to spawn agy with an empty prompt — agy hangs indefinitely on empty stdin and --print-timeout does not interrupt it.';
  }
  return null;
}

/**
 * FLUX-1751: catch a turn that reports success while having done nothing.
 *
 * Observed live: `{"status":"SUCCESS","response":"","usage":{"input_tokens":0,…}}` — no error, no
 * tokens, empty reply, exit 0. Left alone the exit handler marks the session `completed` and posts
 * an empty completion comment, i.e. a ticket that looks worked and was not. That is the
 * `silent-spawn-behavior` preflight concern, and the worst failure mode an adapter can have.
 *
 * Guarding the SYMPTOM rather than a suspected cause is deliberate: a model call that consumed zero
 * input tokens provably never happened, whether it was dropped for size, throttled by quota, or
 * something not yet seen. No probe of the cause is needed for this check to be right.
 */
export function antigravityNoOpTurnError(result: { status?: string; response?: string; usage?: { input_tokens?: number } } | undefined): string | null {
  if (!result || result.status !== 'SUCCESS') return null;
  const inputTokens = result.usage?.input_tokens ?? 0;
  if (inputTokens > 0) return null;
  if ((result.response ?? '').trim()) return null;
  return 'agy reported status:"SUCCESS" but consumed 0 input tokens and returned an empty response — the prompt never reached a model, so this turn did nothing. Treating it as a failure rather than a completed session.';
}

/**
 * FLUX-1751: classify an `agy` result error into EH's `terminalReason` taxonomy.
 *
 * The quota string was hit for real while probing: `"Individual quota reached. Please upgrade your
 * subscription to increase your limits. Resets in 154h27m15s."` That is transient, not a defect —
 * the Furnace stoker must cool the ticket down and retry at the reset window rather than park it,
 * and an auth-shaped classification would wrongly halt the whole batch.
 */
export function classifyAntigravityTerminalReason(text: string | undefined): 'rate-limited' | 'auth-expired' | 'context-exhausted' | undefined {
  if (!text) return undefined;
  if (/quota reached|rate limit|resource[_ ]exhausted|too many requests|\b429\b/i.test(text)) return 'rate-limited';
  if (/not authenticated|unauthorized|invalid credentials|token has expired|\b40[13]\b/i.test(text)) return 'auth-expired';
  if (/context (?:length|window) exceeded|prompt is too long|too many tokens/i.test(text)) return 'context-exhausted';
  return undefined;
}

export function buildAntigravityArgs(opts: AntigravityArgOpts): string[] {
  const args = [
    '--output-format', 'stream-json',
    '--print-timeout', PRINT_TIMEOUT,
  ];
  if (opts.model) args.push('--model', opts.model);
  // Effort is a real flag with no `--model` precondition (the Copilot FLUX-977 trap does not apply).
  // Deliberately the ONLY effort mechanism: `agy models` slugs also bake effort in
  // (`gemini-3.8-flash-high`), and sending both invites a silent disagreement.
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.skipPermissions) args.push('--dangerously-skip-permissions');
  // `--conversation <id>` is the resume mechanism. `--continue`/`-c` ("most recent") also exists but
  // is never used: EH always holds an explicit id, and "most recent" is ambiguous across concurrent
  // sessions sharing one CLI install.
  if (opts.conversationId) args.push('--conversation', opts.conversationId);
  if (opts.scopeArgs?.length) args.push(...opts.scopeArgs);
  return args;
}

export function resolveAntigravityEffort(
  session: CliSessionRecord,
  effortOverrideRaw: string,
  task: AntigravityTask,
): string | undefined {
  const { supported, flag } = CLI_CAPABILITIES.antigravity.effort;
  if (!supported || !flag) return undefined;
  const effective = session.effortOverride || effortOverrideRaw || task.effortLevel || getConfig().effortLevel || '';
  if (!EFFORT_LEVELS.includes(effective as EffortLevel)) return undefined;
  // Clamp EH's 5-level scale onto agy's 3 — see clampAntigravityEffort.
  return clampAntigravityEffort(effective);
}

/**
 * Spawn `agy`. Markedly simpler than spawnGemini: `agy` is a single self-contained Go binary, so
 * there is no npm shim, no `node <entrypoint>` resolution, and no `cmd.exe /c` fallback to strip
 * NODE_OPTIONS out of — the three things resolveGeminiWindowsLaunch exists to handle.
 */
export function spawnAntigravity(
  args: string[],
  executionRoot: string,
  conversationId?: string,
  sessionId?: string,
): ReturnType<typeof spawn> {
  const exePath = resolveAntigravityBinary();
  const logTag = `[${conversationId ?? 'antigravity'}]`;
  log.info(`${logTag} Spawning: ${exePath} [${args.length} args]`);
  return spawn(exePath, args, {
    cwd: executionRoot,
    env: cleanChildEnv('antigravity', conversationId, sessionId),
    stdio: 'pipe',
    windowsHide: true,
  });
}

// ─── stream-json schema (agy 1.1.26, live-probed — FLUX-1738) ───
//
// Three event kinds and no others:
//   {"event":"init","conversation_id":…,"init":{"cwd":…,"tools":[…],"permission_mode":…}}
//   {"event":"step_update","step_update":{"conversation_id":…,"step_index":N,"state":…,"step_type":…,…}}
//   {"event":"result","result":{"conversation_id":…,"status":"SUCCESS","response":…,"usage":{…}}}
//
// `state` is ACTIVE | DONE | ERROR; `step_type` is user_input | agent_response | tool. Note this
// shares NO field with Gemini CLI's schema — not even `session_id`, which gemini.ts keys resume on.

interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** A SUBSET of output_tokens, not an addition to it — never accumulate it separately. */
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AntigravityStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: 'ACTIVE' | 'DONE' | 'ERROR' | string;
  step_type?: 'user_input' | 'agent_response' | 'tool' | string;
  text_delta?: string;
  duration_seconds?: number;
  tool_name?: string;
  tool_info?: {
    name?: string;
    /** PascalCase keys (`Pattern`, `SearchDirectory`, `DirectoryPath`, `CommandLine`, `TargetFile`). */
    parameters?: Record<string, unknown>;
    error?: { type?: string; message?: string };
  };
  usage?: AntigravityUsage;
}

interface AntigravityCliEvent {
  event?: 'init' | 'step_update' | 'result' | string;
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[]; permission_mode?: string };
  step_update?: AntigravityStepUpdate;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    /** Present when `status` is not SUCCESS — the human-readable rejection reason. */
    error?: string;
    duration_seconds?: number;
    num_turns?: number;
    /** CUMULATIVE across the conversation — see accumulateAntigravityUsage. Never accounted here. */
    usage?: AntigravityUsage;
  };
}

/**
 * Pull a human-readable progress line out of a tool step. Antigravity's parameter keys are
 * **PascalCase**, so Gemini's `file_path`/`command` lookups find nothing here — a silent
 * degradation (every row would read as the bare activity label) rather than a crash, which is
 * exactly why it is spelled out. Key names observed live; unknown tools fall back to the label.
 */
/** FLUX-1800: agy reports Windows paths even when this engine (or its test run) is on POSIX, where
 *  `path.basename` doesn't split on `\\` — the v1.13.0 macOS release job failed on exactly that. */
function anyPathBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function antigravityProgressMessage(
  toolName: string | undefined,
  params: Record<string, unknown> | undefined,
  fallback: string,
): string {
  if (!toolName || !params) return fallback;
  const str = (key: string): string | undefined => {
    const v = params[key];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const file = str('TargetFile') || str('AbsolutePath') || str('FilePath');
  const dir = str('DirectoryPath') || str('SearchDirectory');
  const cmd = str('CommandLine') || str('Command');
  const query = str('Query') || str('Pattern') || str('SearchTerm');
  switch (toolName) {
    case 'view_file':
      return file ? `Reading ${anyPathBasename(file)}` : fallback;
    case 'write_to_file':
      return file ? `Writing ${anyPathBasename(file)}` : fallback;
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file':
      return file ? `Editing ${anyPathBasename(file)}` : fallback;
    case 'list_dir':
      return dir ? `Reading ${anyPathBasename(dir) || dir}` : fallback;
    case 'run_command': {
      if (!cmd) return fallback;
      const clipped = cmd.slice(0, 50);
      return `Running: ${clipped}${cmd.length > 50 ? '...' : ''}`;
    }
    case 'grep_search':
    case 'find_by_name':
    case 'search_web':
      return query ? `Searching ${query.slice(0, 50)}` : fallback;
    case 'call_mcp_tool': {
      const mcpTool = str('ToolName') || str('Name');
      return mcpTool ? `Calling ${mcpTool}` : fallback;
    }
    default:
      return fallback;
  }
}

/**
 * Fold one `usage` block into the session's running totals.
 *
 * FLUX-1738 — the trap this function exists to avoid, and the FLUX-1375 failure mode repeating:
 * `result.usage` is **CUMULATIVE across the whole conversation**, not per-turn. Probed: turn 1
 * reported input_tokens 13705; the resumed turn 2 reported 27646 = 13705 + 13941, where 13941 was
 * turn 2's own per-step figure. So `result.usage` is precisely the sum of every per-step usage the
 * conversation has ever emitted. Accumulating BOTH would double-count every resumed turn, and
 * accumulating `result.usage` alone would re-add the whole history on each resume.
 *
 * Therefore: accumulate per-step DONE usage only (one model call each — the natural billing unit,
 * and the same convention claude-code.ts uses), and never read `result.usage` for accounting.
 *
 * `thinking_tokens` is a SUBSET of `output_tokens` (probed: output 25, thinking 23, total 13730 =
 * input 13705 + output 25 — thinking is not in the total separately), so it is deliberately not
 * added anywhere.
 */
export function accumulateAntigravityUsage(session: CliSessionRecord, usage: AntigravityUsage | undefined): void {
  if (!usage) return;
  const inputTok = usage.input_tokens ?? 0;
  const outputTok = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_tokens ?? 0;
  if (!inputTok && !outputTok && !cacheRead) return;
  session.inputTokens = (session.inputTokens ?? 0) + inputTok;
  session.outputTokens = (session.outputTokens ?? 0) + outputTok;
  session.cacheReadTokens = (session.cacheReadTokens ?? 0) + cacheRead;
  // `input_tokens` includes the cached portion, so price the fresh remainder at the input rate and
  // the cached tokens at their own cheaper rate rather than billing the same tokens twice.
  session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.model, {
    freshInputTokens: Math.max(0, inputTok - cacheRead),
    cacheReadTokens: cacheRead,
    outputTokens: outputTok,
  });
  session.costIsEstimated = true;
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  return sharedAttachStdoutProcessing<AntigravityCliEvent>(proc, session, {
    onEvent: (evt, trimmed, commitPendingAssistantText) => {
      // FLUX-969 convention: tee every raw line to the durable per-ticket transcript. The board
      // orchestrator chat has no ticket to comment on and reads GET /transcript exclusively, so an
      // adapter that skips this shows a blank chat even though the turn succeeded.
      appendTranscriptLine(taskId, trimmed);

      if (evt.event === 'init') {
        // The resume id. `--conversation <id>` accepts this exact value — verified by resuming and
        // asking a question only the prior turn could answer (the FLUX-959 standard: a clean exit
        // alone is not proof, since a CLI that silently starts fresh also exits 0).
        if (evt.conversation_id) session.resumeSessionId = evt.conversation_id;
        // Default is `request-review`; `--dangerously-skip-permissions` flips it to
        // `always-proceed`. In `request-review` a non-interactive run cannot satisfy the review, so
        // tool calls soft-deny with only a stderr note — a session that appears to run but silently
        // does nothing. Log the mismatch loudly rather than letting it look like a model failure.
        const mode = evt.init?.permission_mode;
        if (mode && mode !== 'always-proceed' && session.skipPermissions) {
          log.info(`[${taskId}] agy reports permission_mode=${mode} despite --dangerously-skip-permissions`);
        }
        session.pendingAssistantText = '';
        return;
      }

      if (evt.event === 'step_update') {
        const step = evt.step_update;
        if (!step) return;
        if (!session.resumeSessionId && step.conversation_id) session.resumeSessionId = step.conversation_id;

        // Per-step usage — the ONLY accounting source. See accumulateAntigravityUsage.
        if (step.state === 'DONE' || step.state === 'ERROR') {
          accumulateAntigravityUsage(session, step.usage);
        }

        if (step.step_type === 'agent_response') {
          if (session.currentActivity !== 'Thinking') {
            session.currentActivity = 'Thinking';
            session.lastProgressLog = undefined;
            broadcastEvent('activity', { taskId, activity: session.currentActivity });
          }
          // `text_delta` is a genuine partial chunk (partialDeltas:true). Accumulate; the shared
          // commitPendingAssistantText turns the run of deltas into one narration block.
          if (typeof step.text_delta === 'string' && step.text_delta) {
            appendSessionOutput(session, step.text_delta, 'stdout', true);
            flushSessionOutput(session, false, 'text');
          }
          return;
        }

        if (step.step_type === 'tool') {
          const toolName = step.tool_name || step.tool_info?.name;
          if (step.state === 'ACTIVE') {
            // A tool call ends the current narration run — commit it before switching activity.
            commitPendingAssistantText();
            const newActivity = activityFor(ANTIGRAVITY_TOOL_ACTIVITY_MAP, toolName ?? '');
            if (session.currentActivity !== newActivity) {
              session.currentActivity = newActivity;
              session.lastProgressLog = undefined;
            }
            if (toolName && session.sessionHistoryEntry?.sessionId) {
              const progressMsg = antigravityProgressMessage(toolName, step.tool_info?.parameters, newActivity);
              const ts = new Date().toISOString();
              session.sessionHistoryEntry.progress.push({
                timestamp: ts,
                message: progressMsg,
                type: 'tool',
                data: { toolName, parameters: step.tool_info?.parameters },
              });
              broadcastEvent('progress', {
                taskId,
                sessionId: session.sessionHistoryEntry.sessionId,
                timestamp: ts,
                message: progressMsg,
                type: 'tool',
              });
            }
            broadcastEvent('activity', { taskId, activity: session.currentActivity });
          } else if (step.state === 'ERROR') {
            // Per-step, NOT fatal — the run still exits 0 with result.status SUCCESS (probed: a
            // `find_by_name` timeout). Surface it inline (appendErrorToSession broadcasts a
            // `progress` SSE, so it reaches the live chat) without touching session status.
            const detail = step.tool_info?.error?.message;
            appendErrorToSession(
              session,
              `Tool failed: ${toolName || 'unknown'}${detail ? ` — ${detail}` : ''}`,
            );
          }
          return;
        }

        // `user_input` and any step_type a future agy adds: nothing to render.
        return;
      }

      if (evt.event === 'result') {
        commitPendingAssistantText();
        session.currentActivity = undefined;
        broadcastEvent('activity', { taskId, activity: null });
        // Deliberately NOT accumulating result.usage — it is cumulative across the conversation.
        const status = evt.result?.status;
        if (status && status !== 'SUCCESS') {
          // `result.error` carries the actionable text (e.g. an invalid --effort/--model rejection);
          // the bare status alone is not diagnosable. In stream-json mode such a run also exits 1,
          // so the exit handler independently marks the session failed — this is the "why".
          const detail = evt.result?.error;
          appendErrorToSession(session, `Agent error: ${status}${detail ? ` — ${detail}` : ''}`);
          // FLUX-1751: classify quota/auth/context so the Furnace stoker cools down and retries
          // rather than parking the ticket (or, for auth, halts the batch for a human re-auth).
          const reason = classifyAntigravityTerminalReason(detail);
          if (reason) session.terminalReason = reason;
        } else {
          // FLUX-1751: a SUCCESS that consumed nothing did nothing — fail it loudly instead of
          // letting the exit handler post an empty completion comment on a ticket. Marked
          // 'rate-limited' because throttling is the leading suspected cause and that reason makes
          // the stoker retry; a genuine size/delivery fault re-fails identically on retry, so the
          // recoverable classification costs one wasted attempt at worst and never loses work.
          const noOp = antigravityNoOpTurnError(evt.result);
          if (noOp) {
            appendErrorToSession(session, noOp);
            session.terminalReason = 'rate-limited';
          }
        }
        return;
      }

      // Unknown event kind — keep the raw line visible rather than dropping it silently, so a
      // future agy schema addition shows up as noise in the chat instead of vanishing.
      commitPendingAssistantText();
      appendSessionOutput(session, trimmed, 'stdout', false);
    },
    onParseError: (trimmed) => {
      appendSessionOutput(session, trimmed, 'stdout', false);
      if (!session.currentActivity) {
        session.currentActivity = 'Working';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      }
    },
  }, 'text');
}

export async function startCliSession(
  session: CliSessionRecord,
  task: AntigravityTask,
  appendPrompt: string,
  effortOverrideRaw: string,
  workspaceRoot: string,
) {
  const label = session.label;
  const id = session.taskId;
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot, resolveExecutionRootReclaimOpts(workspaceRoot));
  session.executionRoot = executionRoot;
  assertIsolatedSpawnRoot('antigravity', id, task, executionRoot, workspaceRoot);

  // Resolver-aware preflight, NOT a PATH check: `agy` is genuinely absent from PATH on a working
  // Windows install (see antigravityUserBinaryPath), so `checkBinaryInstalled('agy')` would reject
  // a healthy install. Fail only when neither the pinned path nor the bare name can be used.
  const binary = resolveAntigravityBinary();
  if (binary === 'agy' && !fs.existsSync(antigravityUserBinaryPath())) {
    throw new Error(
      `Antigravity CLI not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash — expected the binary at ${antigravityUserBinaryPath()}`,
    );
  }

  log.info(`[${id}] Starting Antigravity CLI session in ${workspaceRoot}`);

  const groomingStatuses = [getConfig().requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = session.model || resolveModel(session.taskKey ?? 'implementation.lead', 'antigravity', getConfig());
  if (selectedModel) session.model = selectedModel;

  const taskPhase = session.phase ?? (groomingStatuses.includes(task.status) ? 'grooming'
    : (task.status === 'In Progress' || task.status === 'Todo') ? 'implementation'
    : task.status === (getConfig()?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined);

  // chatEditGateEnforced:false — `--mode plan` exists and is the obvious lever, but until someone
  // probes that plan mode blocks a file write while STILL permitting mutating event-horizon MCP
  // calls (the codex FLUX-1631 trap, where a sandbox blocked both and made the gate useless), the
  // gate stays advisory in the prompt, as it is for gemini.
  const editsGated = isChatEditGated(session, task) || isScratchSession(task);
  const initialPrompt = buildInitialPrompt(task, appendPrompt, {
    phase: taskPhase,
    framework: 'antigravity',
    editsGated,
    batchTicketIds: session.batchTicketIds,
    batchExcluded: session.batchExcluded,
    planFirst: session.planFirst,
  });

  const antigravityArgs = buildAntigravityArgs({
    model: selectedModel ?? undefined,
    effort: resolveAntigravityEffort(session, effortOverrideRaw, task),
    skipPermissions: session.skipPermissions,
    scopeArgs: buildAntigravityScopeArgs(workspaceRoot),
  });
  log.info(`[${id}] Args:`, antigravityArgs);

  // FLUX-1751: validate BEFORE the spawn — an empty prompt hangs for the full 24h PRINT_TIMEOUT and
  // an over-large one reports SUCCESS having done nothing. Throwing here matches the binary-missing
  // throw above: the caller surfaces it as a launch failure.
  const deliveryError = antigravityPromptDeliveryError(initialPrompt);
  if (deliveryError) throw new Error(deliveryError);

  const proc = spawnAntigravity(antigravityArgs, executionRoot, id, session.id);
  // Prompt over stdin — see buildAntigravityArgs. Attach the error listener BEFORE writing: an
  // EPIPE (child died before the write landed) would otherwise be an unhandled 'error' event.
  proc.stdin!.on('error', () => {});
  proc.stdin!.write(initialPrompt);
  proc.stdin!.end();
  session.proc = proc as ChildProcessWithoutNullStreams;
  session.pid = proc.pid;
  session.status = 'running';
  session.args = antigravityArgs;
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  proc.on('error', async (error) => {
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    commitPending();
    const failureMessage = (error as NodeJS.ErrnoException).code === 'ENAMETOOLONG'
      ? `Failed to start agent: spawn ENAMETOOLONG — combined argv length ${antigravityArgs.join(' ').length} chars exceeds the OS command-line limit (prompt is delivered via stdin, not argv)`
      : `Failed to start agent: ${error.message}`;
    appendErrorToSession(session, failureMessage);
    flushSessionOutput(session, true, 'text');
    await session.writeQueue;

    const outcome = `${label} session failed to start: ${error.message}`;
    if (session.sessionHistoryEntry?.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = 'failed';
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        sessionEntry.progress = accumulatedProgress;
      });
    } else {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt!)],
      });
    }
    log.info(`[${id}] Failed to spawn agy: ${error.message}`);
  });

  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label, {
    groupId: session.groupId,
    role: session.role,
    pattern: session.groupType,
  });
  session.sessionHistoryEntry = sessionEntry;
  await updateTaskWithHistory(id, { updatedBy: 'Agent', entries: [sessionEntry] });

  session.progressHeartbeat = setInterval(() => {
    if (session.currentActivity && session.sessionHistoryEntry) {
      if (session.lastProgressLog !== session.currentActivity) {
        session.lastProgressLog = session.currentActivity;
        session.sessionHistoryEntry.progress.push({
          timestamp: new Date().toISOString(),
          message: session.currentActivity,
          type: 'info',
        });
      }
    }
  }, 15000);

  proc.on('exit', async (code, signal) => {
    killProcessTree(proc, undefined, { label: id, exemptPids: getExemptPidsForSession(session.id) });
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    commitPending();
    flushSessionOutput(session, true, 'text');
    await session.writeQueue;

    session.currentActivity = undefined;
    delete session.pid;

    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'waiting-input';
    if (session.requestedStop) {
      session.endedAt = new Date().toISOString();
      session.status = 'cancelled';
      finalStatus = 'cancelled';
    } else if (session.pausedForInput) {
      session.status = 'waiting-input';
      finalStatus = 'waiting-input';
    } else if (code === 0) {
      // persistentChat:true — a clean chat turn stays resumable rather than going terminal and
      // posting its reply as a bogus ticket completion comment (the codex FLUX-1630 shape).
      if (session.phase === 'chat') {
        session.status = 'waiting-input';
        finalStatus = 'waiting-input';
      } else {
        session.endedAt = new Date().toISOString();
        session.status = 'completed';
        finalStatus = 'completed';
      }
    } else {
      session.endedAt = new Date().toISOString();
      session.status = 'failed';
      finalStatus = 'failed';
    }

    const outcome = session.requestedStop
      ? `${label} session stopped ${stopOutcomeText(session)}.`
      : `${label} session ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;

    const tokenUpdate = buildTokenMetadataUpdate(id, session);

    if (finalStatus === 'waiting-input') {
      if (tokenUpdate) {
        await updateTaskWithHistory(id, { updatedBy: 'Agent', entries: [], tokenMetadata: tokenUpdate });
      }
      const pausedHistoryEntry = session.sessionHistoryEntry;
      if (pausedHistoryEntry?.sessionId) {
        await updateAgentSession(id, pausedHistoryEntry.sessionId, (sessionEntry) => {
          sessionEntry.status = 'waiting-input';
          sessionEntry.outcome = `${label} paused — waiting for user input.`;
          sessionEntry.progress = pausedHistoryEntry.progress || [];
        });
      }
      broadcastEvent('taskUpdated', { id });
      return;
    }

    if (finalStatus === 'failed') {
      const stderrHint = session.stderrCapture?.trim();
      appendErrorToSession(session, stderrHint ? `${outcome}\n${stderrHint}` : outcome);
      await session.writeQueue;
    }

    if (session.sessionHistoryEntry?.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = finalStatus;
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        sessionEntry.progress = accumulatedProgress;
      });

      const textEntries = accumulatedProgress.filter((p: AgentSessionProgress) => p.type === 'text' && p.message?.trim());
      const lastText = textEntries.length > 0 ? textEntries[textEntries.length - 1]?.message : '';
      if (lastText && finalStatus === 'completed') {
        const maxCommentLen = 3000;
        const commentBody = lastText.length > maxCommentLen ? lastText.slice(0, maxCommentLen) + '...' : lastText;
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [buildCommentEntry(label, commentBody, session.endedAt!)],
          tokenMetadata: tokenUpdate ?? undefined,
        });
      } else if (tokenUpdate) {
        await updateTaskWithHistory(id, { updatedBy: 'Agent', entries: [], tokenMetadata: tokenUpdate });
      }
    } else {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt!)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }

    if (finalStatus === 'completed') {
      // FLUX-1555: a child 'exit' handler has no ambient request binding — rebind to the owning board.
      runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), () => {
        checkFrameworkHealth(session.framework).catch(() => {});
        checkSkillStaleness(session.framework).catch(() => {});
      });
      await runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), () => flagIfParked(session, id));
    }

    notifyDelegationComplete(session);
    if (session.groupId) {
      notifyGroupSessionTerminal(session.taskId, session.groupId).catch(() => {});
    }
    checkAutoRestart();
    broadcastEvent('taskUpdated', { id });
  });
}

export async function sendCliSessionInput(
  session: CliSessionRecord,
  message: string,
  user: string,
  workspaceRoot: string,
) {
  const id = session.taskId;
  let executionRoot: string;
  try {
    executionRoot = await resolveResumeExecutionRoot(session, getWorkspace().tasks[id], workspaceRoot);
  } catch (error) {
    return surfaceResumeFailure(session, id, error, workspaceRoot);
  }

  const inputAt = new Date().toISOString();
  session.lastInputAt = inputAt;
  session.status = 'running';
  session.requestedStop = false;
  delete session.blockedReason;
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  const handoffTask = getWorkspace().tasks[id] as AntigravityTask;
  const gatedMessage = prependEditGateNote(session, handoffTask, 'antigravity', safeMessage);
  const handoffNote = buildPhaseHandoffNote(session, handoffTask, 'antigravity');
  if (handoffNote) session.handoffPhaseAnnounced = true;
  const promptForCli = handoffNote ? `${handoffNote}\n\n---\n\n${gatedMessage}` : gatedMessage;

  // A resume carries the SAME model/effort/permission flags as the opening spawn — `--conversation`
  // resumes the transcript, it does not re-establish invocation settings.
  const resumeArgs = buildAntigravityArgs({
    conversationId: session.resumeSessionId,
    model: session.model,
    effort: resolveAntigravityEffort(session, '', handoffTask),
    skipPermissions: session.skipPermissions,
    scopeArgs: buildAntigravityScopeArgs(workspaceRoot),
  });

  // FLUX-1751: same pre-spawn validation as the opening turn. This path is the likelier one to hit
  // it: a resumed turn's prompt is user/engine-supplied (a chat reply, or a wake ticker's message),
  // so an empty one is reachable, and a review turn with an inlined diff can exceed the ceiling.
  // Routed through surfaceResumeFailure — the same seam the execution-root guard above uses — so it
  // reaches the chat instead of vanishing into an HTTP 500.
  const resumeDeliveryError = antigravityPromptDeliveryError(promptForCli);
  if (resumeDeliveryError) {
    return surfaceResumeFailure(session, id, new Error(resumeDeliveryError), workspaceRoot);
  }

  const replyProc = spawnAntigravity(resumeArgs, executionRoot, id, session.id);
  replyProc.stdin!.on('error', () => {});
  replyProc.stdin!.write(promptForCli);
  replyProc.stdin!.end();
  session.proc = replyProc as ChildProcessWithoutNullStreams;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  replyProc.on('error', async (error) => {
    terminalizeResumedExit(session);
    commitReplyPending();
    if (!session.requestedStop) {
      const failureMessage = (error as NodeJS.ErrnoException).code === 'ENAMETOOLONG'
        ? `Failed to resume agent: spawn ENAMETOOLONG — combined argv length ${resumeArgs.join(' ').length} chars exceeds the OS command-line limit (prompt is delivered via stdin, not argv)`
        : `Failed to resume agent: ${error.message}`;
      appendErrorToSession(session, failureMessage);
    }
    flushSessionOutput(session, true, 'text');
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    log.info(`[${id}] Failed to spawn agy for reply: ${error.message}`);
  });

  replyProc.on('exit', async (code, signal) => {
    killProcessTree(replyProc, undefined, { label: id, exemptPids: getExemptPidsForSession(session.id) });
    commitReplyPending();
    flushSessionOutput(session, true, 'text');
    if (!session.requestedStop && !session.pausedForInput && (code !== 0 || signal)) {
      const replyOutcome = `${session.label} reply ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;
      const stderrHint = session.stderrCapture?.trim();
      appendErrorToSession(session, stderrHint ? `${replyOutcome}\n${stderrHint}` : replyOutcome);
    }
    terminalizeResumedExit(session);
    // FLUX-1375: flush unconditionally — buildTokenMetadataUpdate diffs against the session's own
    // flushed baseline, so this is correct however many resumed turns have run.
    const resumeTokenUpdate = buildTokenMetadataUpdate(id, session);
    if (resumeTokenUpdate) {
      await updateTaskWithHistory(id, { updatedBy: 'Agent', entries: [], tokenMetadata: resumeTokenUpdate });
    }
    if (!session.pausedForInput && !session.requestedStop) {
      await runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), () => flagIfParked(session, id));
    }
    broadcastEvent('taskUpdated', { id });
  });
}

export class AntigravityAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'antigravity',
    displayName: 'Antigravity CLI',
    configSchema: {},
    // Gemini 3 Pro list pricing. costIsEstimated is set on every accumulation — `agy` reports no
    // cost of its own (no total_cost_usd anywhere in the stream), so every figure is an estimate.
    costModel: { inputPerMToken: 2, outputPerMToken: 12, currency: 'usd' },
    capabilities: {
      // Only the three `agy --effort` actually accepts — NOT [...EFFORT_LEVELS]. EH's `xhigh`/`max`
      // are rejected by the CLI (see clampAntigravityEffort); advertising them here would invite a
      // caller to send an effort that cannot work.
      effortLevels: ['low', 'medium', 'high'],
      compacting: true,
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Antigravity CLI';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    return startCliSession(session, task as AntigravityTask, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot);
  }

  stop(session: CliSessionRecord): void {
    // FLUX-1645: explicit Stop force-clears holds first — always wins the race against a hold.
    clearHoldsForSession(session.id);
    // Tree-kill so the agent's own MCP servers are reaped rather than orphaned.
    killProcessTree(session.proc);
  }
}

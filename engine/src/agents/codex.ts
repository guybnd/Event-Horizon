import { getWorkspace, resolveWorkspaceByRoot, runWithWorkspace } from '../workspace-context.js';
import { log } from '../log.js';
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getConfig } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentSessionEntry } from '../history.js';
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
import { appendTranscriptLine, appendTranscriptEvent } from '../transcript.js';
import { getEnginePort } from '../packaged-mode.js';
import { signConversation } from '../session-binding.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest, SendInputOptions } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import { EFFORT_LEVELS, type EffortLevel, cleanChildEnv, checkBinaryInstalled, appendSessionOutput, appendErrorToSession, flushSessionOutput, activityFor, attachStdoutProcessing as sharedAttachStdoutProcessing, buildInitialPrompt, terminalizeResumedExit, surfaceResumeFailure, isChatEditGated, isScratchSession, prependEditGateNote, resolveModel, buildTokenMetadataUpdate, buildPhaseHandoffNote, resolveAttachmentAbsPaths, type CliTask } from './shared.js';

// codex item.type -> progress-activity label. Mirrors copilot.ts's TOOL_ACTIVITY_MAP, keyed by the
// codex JSONL item shape instead of a bare tool name (FLUX-1625 Phase 0: item.type is the stable
// discriminator across command_execution / file_change / mcp_tool_call / web_search / reasoning /
// agent_message / todo_list — see CodexItem below).
const ITEM_ACTIVITY_MAP: Record<string, string> = {
  command_execution: 'Running command',
  file_change: 'Editing',
  mcp_tool_call: 'Working',
  web_search: 'Researching',
  reasoning: 'Thinking',
  agent_message: 'Responding',
  todo_list: 'Working',
};

/** One `item` payload on a codex `item.started`/`item.completed` event — a union of every item
 *  `type` codex emits; only the fields this parser reads. Live-verified against codex-cli 0.146.0
 *  (`codex exec --json -s read-only "…"`, this ticket's own session — not just Phase 0's notes):
 *  `agent_message` (`text`, arrives whole on `item.completed`, no `item.started`) and
 *  `command_execution` (`command` is a single STRING — not an array — plus `aggregated_output` /
 *  `exit_code` / `status`; a failed command sets `status:"failed"` with the nonzero `exit_code`,
 *  a running one `status:"in_progress"` with `exit_code:null`) are both confirmed live. `mcp_tool_call`
 *  (`server`/`tool`/`arguments`/`result`/`error`/`status` on ONE item — richer than Claude's
 *  tool_use/tool_result pair, no toolNamesById correlation needed) is per Phase 0's own live probe
 *  (this session had no MCP server configured to re-verify against). `file_change`/`web_search`/
 *  `todo_list`/`reasoning` shapes are inferred from codex's documented event schema, NOT
 *  independently live-probed — the parser degrades gracefully (optional chaining throughout) if a
 *  field name here turns out to differ from what a real capture shows. */
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string | string[];
  aggregated_output?: string;
  exit_code?: number | null;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  // Live-verified (this ticket, FLUX-1630): on a failed `mcp_tool_call`, codex sends `error` as an
  // OBJECT (e.g. `{message, code}`), not a string — the success-path fixture only ever showed
  // `"error": null`, so the original `string` typing (and the naive template interpolation it
  // encouraged) went uncaught until a real failure collapsed to `[object Object]`. See
  // `stringifyItemError` below for the normalization.
  error?: string | { message?: string; code?: string | number; [key: string]: unknown } | null;
  status?: string;
  query?: string;
}

/** Normalize a codex item's `error` field into a human-readable string before interpolating it
 *  into a progress/error message. A string passes through unchanged; an object (the real shape of
 *  an `mcp_tool_call` failure, FLUX-1630) prefers `.message`, falls back to `.code`, and finally to
 *  a truncated `JSON.stringify` so the reason is never silently lost as `[object Object]`. */
function stringifyItemError(error: CodexItem['error']): string | undefined {
  if (error == null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  if (error.code !== undefined) return String(error.code);
  try {
    return JSON.stringify(error).slice(0, 500);
  } catch {
    return String(error);
  }
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  reasoning_output_tokens?: number;
}

/** One line of Codex CLI's `--json` stdout — the shape this adapter parses. FLUX-1625 Phase 0 (live
 *  probe, codex-cli 0.146.0): `thread.started`/`turn.started`/`item.started`/`item.completed`/
 *  `turn.completed` confirmed against the live CLI; `thread_id` is the accepted `codex exec resume`
 *  token (verified round-trip — NOT the turn/parent id, avoiding the FLUX-959 trap). */
interface CodexCliEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  message?: string;
  error?: string;
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  // FLUX-932: shared line-buffer / JSON.parse / commitPendingAssistantText skeleton lives in shared.ts.
  // This supplies Codex's per-CLI parser. narrationType 'text' → styled 'text' Narration block,
  // matching copilot.ts/gemini.ts (Codex has no token-level deltas either — partialDeltas:false).
  return sharedAttachStdoutProcessing<CodexCliEvent>(proc, session, {
    onEvent: (evt, trimmed, commitPendingAssistantText) => {
      // FLUX-969: tee raw event lines to the durable per-ticket transcript (copilot.ts/gemini.ts
      // parity) — the board orchestrator chat has no ticket to comment on and relies entirely on
      // this for a real reply to ever show up. No delta-event exclusion needed here (codex has none).
      // FLUX-1637: the one renderable case — a completed agent_message — is normalized into the
      // canonical Claude-shaped assistant event instead, so projection.ts's existing Claude branch
      // (no per-CLI Codex branch) renders it; everything else still tees raw for the substrate record.
      if (evt.type === 'item.completed' && evt.item?.type === 'agent_message'
          && typeof evt.item.text === 'string' && evt.item.text.trim()) {
        appendTranscriptEvent(taskId, { type: 'assistant', message: { content: [{ type: 'text', text: evt.item.text }] } });
      } else {
        appendTranscriptLine(taskId, trimmed);
      }

      if (evt.type === 'thread.started') {
        // FLUX-1625 Phase 0: `thread_id` IS the accepted `codex exec resume <id>` token — verified
        // live (round-tripped a follow-up that only makes sense with the prior turn's context).
        if (typeof evt.thread_id === 'string' && evt.thread_id) {
          session.resumeSessionId = evt.thread_id;
        }
        return;
      }

      if (evt.type === 'turn.started') {
        commitPendingAssistantText();
        session.currentActivity = 'Thinking';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
        return;
      }

      if (evt.type === 'item.started') {
        const item = evt.item;
        if (!item) return;
        commitPendingAssistantText();
        const newActivity = activityFor(ITEM_ACTIVITY_MAP, item.type ?? '');
        const activityChanged = session.currentActivity !== newActivity;
        session.currentActivity = newActivity;
        if (activityChanged) session.lastProgressLog = undefined;
        broadcastEvent('activity', { taskId, activity: session.currentActivity });

        if (session.sessionHistoryEntry) {
          let progressMsg = newActivity;
          if (item.type === 'command_execution' && item.command) {
            const cmd = (Array.isArray(item.command) ? item.command.join(' ') : item.command).slice(0, 50);
            progressMsg = `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
          } else if (item.type === 'file_change' && item.changes?.[0]?.path) {
            progressMsg = `Editing ${path.basename(item.changes[0].path)}`;
          } else if (item.type === 'mcp_tool_call' && item.tool) {
            progressMsg = `Calling ${item.tool}`;
          } else if (item.type === 'web_search' && item.query) {
            progressMsg = `Searching: ${item.query.slice(0, 40)}`;
          }
          session.sessionHistoryEntry.progress.push({
            timestamp: new Date().toISOString(),
            message: progressMsg,
            type: 'tool',
            data: { toolName: item.type, parameters: item },
          });
        }
        return;
      }

      if (evt.type === 'item.completed') {
        const item = evt.item;
        if (!item) return;

        if (item.type === 'agent_message') {
          // FLUX-1625: live-verified that a simple text reply emits NO item.started at all (only
          // item.completed) — so surface the 'Responding' activity here rather than relying on a
          // started event that may never arrive. No token-level deltas (partialDeltas:false) — the
          // whole assistant message arrives on ONE item.completed event, so there's nothing to
          // accumulate into pendingAssistantText first; commit it directly (mirrors gemini.ts's
          // native message/role:'assistant' whole-block branch).
          if (session.currentActivity !== 'Responding') {
            session.currentActivity = 'Responding';
            broadcastEvent('activity', { taskId, activity: session.currentActivity });
          }
          if (typeof item.text === 'string' && item.text.trim()) {
            appendSessionOutput(session, item.text, 'stdout', true);
            flushSessionOutput(session, false, 'text');
          }
        } else if (item.type === 'mcp_tool_call' || item.type === 'command_execution' || item.type === 'file_change') {
          // Live-verified (this session): a failed command_execution sets status:"failed" with the
          // nonzero exit_code — never item.error (that field stayed undefined even on a confirmed
          // `exit 1` failure). Surface exit_code/aggregated_output for that case; item.error (when
          // present, e.g. an mcp_tool_call failure) takes priority as the more specific detail.
          const failed = item.status === 'failed' || item.status === 'error' || !!item.error;
          if (failed) {
            const label = item.type === 'mcp_tool_call' ? (item.tool || 'mcp tool') : item.type;
            const detail = stringifyItemError(item.error)
              || (item.type === 'command_execution' && typeof item.exit_code === 'number'
                ? `exit code ${item.exit_code}${item.aggregated_output ? `: ${item.aggregated_output.slice(0, 500)}` : ''}`
                : item.status);
            console.error(`[${taskId}] Item failed:`, detail);
            appendErrorToSession(session, `Tool failed: ${label}${detail ? ` — ${detail}` : ''}`);
          }
        } else if (item.type === 'error') {
          appendErrorToSession(session, `Agent error: ${item.text || 'unknown'}`);
        }
        return;
      }

      if (evt.type === 'turn.completed') {
        commitPendingAssistantText();
        session.currentActivity = undefined;
        broadcastEvent('activity', { taskId, activity: null });

        const usage = evt.usage;
        if (usage) {
          // FLUX-1625 Phase 0: usage carries cached_input_tokens / cache_write_input_tokens /
          // reasoning_output_tokens — mirrors Claude's cache accounting (fresh + cache-read = total
          // input). reasoning_output_tokens is treated as a breakdown of output_tokens (OpenAI's
          // usual convention), not additive — avoids double-counting.
          const inputTok = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
          const outputTok = usage.output_tokens ?? 0;
          session.inputTokens = (session.inputTokens ?? 0) + inputTok;
          session.outputTokens = (session.outputTokens ?? 0) + outputTok;
          session.cacheReadTokens = (session.cacheReadTokens ?? 0) + (usage.cached_input_tokens ?? 0);
          session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + (usage.cache_write_input_tokens ?? 0);
          // FLUX-1625: codex's usage payload carries no direct cost figure (unlike Copilot's
          // total_cost_usd) — always estimate from model-pricing.md.
          session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.model, {
            freshInputTokens: usage.input_tokens ?? 0,
            cacheReadTokens: usage.cached_input_tokens ?? 0,
            cacheCreationTokens: usage.cache_write_input_tokens ?? 0,
            outputTokens: outputTok,
          });
          session.costIsEstimated = true;
        }
        return;
      }

      if (evt.type === 'error') {
        appendErrorToSession(session, `Agent error: ${evt.error || evt.message || 'unknown'}`);
      }
    },
    onParseError: (trimmed) => {
      appendSessionOutput(session, trimmed + '\n', 'stdout', true);
      flushSessionOutput(session, false, 'text');
      if (!session.currentActivity) {
        session.currentActivity = 'Working';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      }
    },
  }, 'text');
}

// FLUX-1625 (windows-binary-resolution probe): unlike Copilot/Gemini, codex-cli ships a compiled
// native binary (no JS entry-point fallback needed) — but an npm-global install still lands a
// shell shim (`codex.cmd`) on PATH ahead of the real `.exe` on Windows (same FLUX-975/974 class of
// bug: spawning the shim mangles stdio and the JSON stream never parses). Cached after the first
// resolution (FLUX-974 precedent) — the resolved path can't change without a reinstall + restart.
let cachedCodexBinary: string | null = null;

function resolveCodexBinary(id: string): string {
  if (cachedCodexBinary) return cachedCodexBinary;
  const resolved = resolveCodexBinaryUncached(id);
  cachedCodexBinary = resolved;
  return resolved;
}

function resolveCodexBinaryUncached(id: string): string {
  const isWin = process.platform === 'win32';
  try {
    const checker = isWin ? 'where' : 'which';
    const result = execSync(`${checker} codex`, { encoding: 'utf8', env: cleanChildEnv('codex'), timeout: 10_000, windowsHide: true }).trim();
    const matches = result.split(/\r?\n/).filter(Boolean);
    if (isWin) {
      const exeMatch = matches.find(m => m.endsWith('.exe'));
      if (exeMatch && fs.existsSync(exeMatch)) {
        log.info(`[${id}] Found codex.exe: ${exeMatch}`);
        return exeMatch;
      }
    } else {
      const firstMatch = matches[0];
      if (firstMatch && fs.existsSync(firstMatch)) {
        log.info(`[${id}] Found codex on PATH: ${firstMatch}`);
        return firstMatch;
      }
    }
  } catch {}
  log.info(`[${id}] codex.exe not found on PATH, falling back to bare name (a .cmd/.ps1 shim will be spawned via shell on Windows if present)`);
  return 'codex';
}

/** Spawn the codex process using the resolved binary info. */
export function spawnCodex(id: string, args: string[], cwdRoot: string, sessionId?: string) {
  const exePath = resolveCodexBinary(id);
  const env = cleanChildEnv('codex', id, sessionId);
  if (process.platform === 'win32' && exePath === 'codex') {
    // No .exe found on PATH — fall back to a shell spawn so a .cmd/.ps1 shim (if that's all that's
    // installed) still resolves, mirroring gemini.ts's last-resort shell fallback. Strips
    // NODE_OPTIONS via an explicit prefix so the shim can't re-inject it.
    log.info(`[${id}] Spawning (shell fallback): codex [${args.length} args]`);
    return spawn('cmd.exe', ['/c', 'set "NODE_OPTIONS=" && codex', ...args], {
      cwd: cwdRoot,
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
  }
  log.info(`[${id}] Spawning: ${exePath} [${args.length} args]`);
  return spawn(exePath, args, {
    cwd: cwdRoot,
    env,
    stdio: 'pipe',
    windowsHide: true,
  });
}

// Escapes a value for embedding inside a TOML basic (double-quoted) string — backslash and quote
// are the two characters that would otherwise break parsing (e.g. a Windows workspace path's
// `\` separators). Defensive: live-testing showed codex's own "falls back to a raw string literal
// when TOML parse fails" behavior (see `-c`'s --help text) already tolerates an unescaped backslash
// here, but that's an implementation-detail fallback, not a documented contract — escape explicitly
// so this doesn't depend on it.
function tomlStringEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
interface CodexModelsCache { models?: Array<{ slug?: unknown }> }

/** Read the CLI's server-fetched, account-scoped model list when it is available. */
export function readCodexModelSlugs(cachePath = path.join(os.homedir(), '.codex', 'models_cache.json')): string[] {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as CodexModelsCache;
    return [...new Set((cache.models ?? []).flatMap(({ slug }) =>
      typeof slug === 'string' && slug.trim() ? [slug.trim()] : []))];
  } catch {
    return [];
  }
}

/** Fail before spawning when the local Codex cache proves a configured model is unavailable. */
export function assertCodexModelAvailable(model: string | undefined, slugs = readCodexModelSlugs()): void {
  if (!model || slugs.length === 0 || slugs.includes(model)) return;
  throw new Error(`Codex model "${model}" is unavailable for this account. Available models: ${slugs.join(', ')}. Update integrations.codexCli.tiers or choose one of these slugs.`);
}

function resolveCodexEffort(session: CliSessionRecord, effortOverrideRaw: string, task: CliTask): string | undefined {
  const effective = session.effortOverride || effortOverrideRaw || task.effortLevel || getConfig().effortLevel || '';
  return EFFORT_LEVELS.includes(effective as EffortLevel) ? effective : undefined;
}

function buildCodexEffortArgs(effort: string | undefined): string[] {
  // FLUX-1629: CLI_CAPABILITIES.codex.effort.flag is deliberately undefined — Codex has no bare
  // --effort flag, only a `-c key=value` config override, named by `configKey`. Composing the
  // `-c` invocation here (rather than in the shared capability) keeps a generic
  // `args.push(effortCap.flag, level)` consumer, like copilot-board.ts's pattern, from ever
  // reaching for this framework and emitting the invalid `-c high`.
  const { supported, configKey } = CLI_CAPABILITIES.codex.effort;
  if (!supported || !configKey || !effort) return [];
  // `-c` works on both `exec` and `exec resume`, unlike -s.
  return ['-c', `${configKey}="${effort}"`];
}

// FLUX-1625 Phase 0 + live re-verification against codex-cli 0.146.0: codex's per-spawn MCP
// override is `-c mcp_servers.<name>.<key>=<value>` (confirmed: `codex mcp list -c 'mcp_servers.X.
// url="…"'` reflects the override, and a read-only-sandboxed `codex exec` call to
// `get_board_config` over this loopback mount succeeded — THE make-or-break probe). No user-global
// config.toml write, matching the FLUX-901 B.9 "installers must not write user-global state"
// principle (bakesPermissionAllowlist:false).
//
// FLUX-1213 header parity — re-verified live (superseding the Phase 0 "known gap" note): a nested
// `http_headers.<key>` path on the SAME `mcp_servers.<name>` entry round-trips correctly (`codex mcp
// list --json` echoed back the exact header set via repeated `-c` flags for the same table), so the
// per-conversation `x-eh-conversation-id`/`x-eh-conversation-token`/`x-eh-workspace` headers CAN be
// injected the same way Claude/Copilot's `buildMcpServerEntry` do — closing the gap the original
// Phase 0 note left open.
export function buildCodexMcpConfigArgs(conversationId?: string, workspaceRoot?: string, sessionId?: string): string[] {
  const args = ['-c', `mcp_servers.event_horizon.url="http://127.0.0.1:${getEnginePort()}/mcp"`];
  if (conversationId) {
    args.push('-c', `mcp_servers.event_horizon.http_headers.x-eh-conversation-id="${tomlStringEscape(conversationId)}"`);
    args.push('-c', `mcp_servers.event_horizon.http_headers.x-eh-conversation-token="${tomlStringEscape(signConversation(conversationId))}"`);
  }
  if (workspaceRoot) {
    args.push('-c', `mcp_servers.event_horizon.http_headers.x-eh-workspace="${tomlStringEscape(workspaceRoot)}"`);
  }
  // FLUX-1645: this session's own signed identity, distinct from conversationId (the ticket) — see
  // buildMcpServerEntry's matching comment for why hold_background_process needs it.
  if (sessionId) {
    args.push('-c', `mcp_servers.event_horizon.http_headers.x-eh-session-id="${tomlStringEscape(sessionId)}"`);
    args.push('-c', `mcp_servers.event_horizon.http_headers.x-eh-session-token="${tomlStringEscape(signConversation(sessionId))}"`);
  }
  return args;
}

export async function startCliSession(session: CliSessionRecord, task: CliTask, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const label = session.label;
  const id = session.taskId;
  // FLUX-519: run the agent in this task's worktree when one exists (else engine root).
  // FLUX-1617: self-heal a missing worktree by reclaiming a stale slot before failing (Gap 1).
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot, resolveExecutionRootReclaimOpts(workspaceRoot));
  session.executionRoot = executionRoot;

  // FLUX-1018 / FLUX-1028: fail closed on the fresh-spawn path — codex's `exec` mode never checks
  // a branch out itself, so spawning with cwd = workspaceRoot would commit straight to master.
  assertIsolatedSpawnRoot('Codex', id, task, executionRoot, workspaceRoot);

  // FLUX-1641: precheck before spawning, mirroring claude-code.ts/gemini.ts — codex previously had
  // no precheck at all, so a missing binary surfaced as a bare `spawn codex ENOENT` instead of an
  // actionable install message. Unlike copilot's resolver (VS Code globalStorage + npm-loader
  // fallback), resolveCodexBinaryUncached above only ever probes PATH via which/where 'codex' — the
  // same binary name and mechanism checkBinaryInstalled itself uses — so there's no resolver
  // divergence here and the shared PATH-only checker is safe to use as-is.
  await checkBinaryInstalled('codex');

  log.info(`[${id}] Starting Codex CLI session in ${workspaceRoot}`);

  const groomingStatuses = [getConfig().requireInputStatus || 'Require Input', 'Grooming'];
  // FLUX-1373: resolve via the task-tier policy, same as every other adapter.
  const selectedModel = session.model || resolveModel(session.taskKey ?? 'implementation.lead', 'codex', getConfig());
  if (selectedModel) session.model = selectedModel;
  assertCodexModelAvailable(selectedModel);

  // FLUX-1193: prefer the session's own launch phase over a status-derived guess (mirrors
  // copilot.ts/claude-code.ts) — the ONLY branch that renders the FLUX-926/1123 edit-gate note.
  const taskPhase = session.phase ?? (groomingStatuses.includes(task.status) ? 'grooming'
    : (task.status === 'In Progress' || task.status === 'Todo') ? 'implementation'
    : task.status === (getConfig()?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined);

  const editsGated = isChatEditGated(session, task) || isScratchSession(task);
  const initialPrompt = buildInitialPrompt(task, appendPrompt, { phase: taskPhase, framework: 'codex', editsGated, batchTicketIds: session.batchTicketIds, batchExcluded: session.batchExcluded });

  // FLUX-1625 Phase 0 gotcha 2/3: `-a/--ask-for-approval` is top-level-only and rejected by `exec`
  // (codex exec never prompts — it silently does whatever the sandbox mode permits). `-C/--cd` is
  // spawn-only and deliberately NOT passed — resume relies on the inherited process `cwd` this
  // spawn() call already sets below (correct by construction, not by design; see gotcha 3).
  //
  // FLUX-1631: sandbox mode is NOT actually usable as the permission-bypass lever, contrary to the
  // FLUX-1625 assumption above. Live-verified (this ticket, codex-cli 0.146.0): codex elicits a
  // human approval for every MCP tool call — including every mutating event-horizon call
  // (add_note/change_status/etc.) — and non-interactive `exec` can never answer that elicitation.
  // Every combination of `-s read-only`/`-s workspace-write` with `-c approval_policy="never"` (and
  // even disabling the `guardian_approval`/`tool_call_mcp_elicitation` features individually) still
  // auto-cancels the call ("user cancelled MCP tool call"); only
  // `--dangerously-bypass-approvals-and-sandbox` clears it, and that flag also lifts the sandbox —
  // there is no config that keeps a sandbox while unblocking MCP writes today. `request_permissions_tool`
  // (`codex features list`) is the eventual narrower fix; it reports `under development` and is not
  // usable yet. So the bypass is unconditional here, same posture as Copilot's `--yolo` /
  // Gemini's `--yolo --skip-trust` — worktree isolation (`assertIsolatedSpawnRoot` above) is what
  // actually bounds a session, not this flag. `CLI_CAPABILITIES.codex.chatEditGateEnforced` is
  // `false` accordingly (types.ts) — the FLUX-926 chat edit gate degrades to the advisory
  // `chatEditGateNote`, exactly like Copilot/Gemini. Revisit once `request_permissions_tool` ships
  // stable and can exempt EH's MCP server from elicitation without lifting the sandbox.
  const effortArgs = buildCodexEffortArgs(resolveCodexEffort(session, effortOverrideRaw, task));
  const codexArgs = [
    'exec',
    '--json',
    ...(selectedModel ? ['--model', selectedModel] : []),
    '--dangerously-bypass-approvals-and-sandbox',
    ...effortArgs,
    ...buildCodexMcpConfigArgs(id, workspaceRoot, session.id),
    // Multi-repo group: put every checked-out member repo in scope (no-op single-repo).
    ...buildMemberScopeArgs(),
    // Member worktree: add local .flux-group/ so the agent reads shared group docs (FLUX-422).
    ...buildGroupDocsScopeArg(workspaceRoot),
  ];

  // FLUX-1625: effort is unprobed (CLI_CAPABILITIES.codex.effort.supported === false) — no
  // --effort-equivalent flag is sent regardless of what the caller requested.

  log.info(`[${id}] Args: [${codexArgs.join(', ')}] (prompt ${initialPrompt.length} chars, via stdin)`);

  const proc = spawnCodex(id, codexArgs, executionRoot, session.id);
  // FLUX-1625 Phase 0 gotcha 1: codex hangs FOREVER if stdin stays open alongside an argv prompt —
  // no prompt rides argv here, but stdin must still be explicitly closed after writing (matches the
  // FLUX-1444 write-then-.end() pattern every other adapter uses).
  proc.stdin.on('error', () => {});
  proc.stdin.write(initialPrompt);
  proc.stdin.end();

  session.proc = proc;
  session.pid = proc.pid;
  session.status = 'running';
  session.command = 'codex';
  session.args = codexArgs;
  // FLUX-651: snapshot ticket state at turn start; drop any stale "parked" flag.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr.on('data', (chunk) => {
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
      ? `Failed to start agent: spawn ENAMETOOLONG — combined argv length ${codexArgs.join(' ').length} chars exceeds the OS command-line limit (prompt is delivered via stdin, not argv)`
      : `Failed to start agent: ${error.message}`;
    appendErrorToSession(session, failureMessage);
    flushSessionOutput(session, true, 'text');
    await session.writeQueue;

    const outcome = `${label} session failed to start: ${error.message}`;

    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
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

    console.error(`[${id}] Failed to spawn codex:`, error.message);
  });

  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label, {
    groupId: session.groupId,
    role: session.role,
    pattern: session.groupType,
  });
  session.sessionHistoryEntry = sessionEntry;

  await updateTaskWithHistory(id, {
    updatedBy: 'Agent',
    entries: [sessionEntry],
  });

  session.progressHeartbeat = setInterval(() => {
    if (session.currentActivity && session.sessionHistoryEntry) {
      const now = new Date().toISOString();
      if (session.lastProgressLog !== session.currentActivity) {
        session.lastProgressLog = session.currentActivity;
        session.sessionHistoryEntry.progress.push({
          timestamp: now,
          message: session.currentActivity,
          type: 'info',
        });
      }
    }
  }, 15000);

  proc.on('exit', async (code, signal) => {
    // FLUX-1207: best-effort reap of any orphaned descendants on every exit. FLUX-1645: spare any
    // pid THIS session holds on an ordinary exit — explicit Stop (below) never passes exemptions.
    killProcessTree(proc, undefined, { label: id, exemptPids: getExemptPidsForSession(session.id) });
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    commitPending();
    flushSessionOutput(session, true, 'text');
    await session.writeQueue;

    let finalStatus: 'completed' | 'failed' | 'cancelled' | 'waiting-input';
    if (session.requestedStop) {
      session.endedAt = new Date().toISOString();
      session.status = 'cancelled';
      finalStatus = 'cancelled';
    } else if (session.pausedForInput) {
      // FLUX-985: agent moved the ticket to Require Input and was told to stop mid-turn — stay
      // resumable (waiting-input, no endedAt) rather than force 'completed'.
      session.status = 'waiting-input';
      finalStatus = 'waiting-input';
    } else if (code === 0) {
      if (session.phase === 'chat') {
        // FLUX-1630: codex is persistentChat:true (resume is live-verified — see CAPABILITY_PROBES) —
        // mirrors claude-code.ts: a clean chat turn stays resumable (waiting-input, no endedAt) so
        // the next message --resumes the same thread_id instead of the terminal-'completed' path
        // below posting the reply as a ticket comment and tripping the FLUX-651 parked backstop.
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
      ? `${label} session stopped by user.`
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
      const fullMessage = stderrHint ? `${outcome}\n${stderrHint}` : outcome;
      appendErrorToSession(session, fullMessage);
      await session.writeQueue;
    }

    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = finalStatus;
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        sessionEntry.progress = accumulatedProgress;
      });

      const textEntries = accumulatedProgress.filter((p) => p.type === 'text' && p.message?.trim());
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
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [],
          tokenMetadata: tokenUpdate,
        });
      }
    } else {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt!)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }

    if (finalStatus === 'completed') {
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
  });
}

export class CodexAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'codex',
    displayName: 'Codex CLI',
    configSchema: {},
    // FLUX-1625 (cost-model probe, unconfirmed): mirrors gpt-5-family rates already used for
    // Copilot/Gemini's manifests here — this field is not read by estimateCostUSD (which reads
    // .docs/event-horizon/model-pricing.md instead); needs a real pricing check regardless.
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      // FLUX-1629: Codex accepts Event Horizon's five effort levels through a -c override.
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Codex CLI';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    return startCliSession(session, task as CliTask, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot, opts);
  }

  stop(session: CliSessionRecord): void {
    // FLUX-1645: explicit Stop force-clears first — always wins the race against a hold (AC7).
    clearHoldsForSession(session.id);
    killProcessTree(session.proc);
  }
}

export async function sendCliSessionInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions) {
  const id = session.taskId;
  let executionRoot: string;
  try {
    executionRoot = await resolveResumeExecutionRoot(session, getWorkspace().tasks[id], workspaceRoot);
  } catch (error) {
    return surfaceResumeFailure(session, id, error, workspaceRoot);
  }

  // FLUX-1641: precheck before spawning — see the fresh-spawn call site's comment above.
  await checkBinaryInstalled('codex');

  const inputAt = new Date().toISOString();
  session.lastInputAt = inputAt;
  session.status = 'running';
  session.requestedStop = false;
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  // FLUX-1637: record the reply as a structured user turn (parity with claude-code.ts:1660) so it
  // renders as a chat bubble via projection.ts, in addition to the history-comment write below.
  appendTranscriptEvent(id, { type: 'user', text: message, attachments: opts?.attachments ?? [], timestamp: inputAt });

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  const handoffTask = getWorkspace().tasks[id] as CliTask;
  const gatedMessage = prependEditGateNote(session, handoffTask, 'codex', safeMessage);
  const handoffNote = buildPhaseHandoffNote(session, handoffTask, 'codex');
  if (handoffNote) session.handoffPhaseAnnounced = true;
  const promptForCli = handoffNote ? `${handoffNote}\n\n---\n\n${gatedMessage}` : gatedMessage;

  // FLUX-1625 Phase 0 + live re-verification: `-i/--image <FILE>...` is confirmed present on BOTH
  // `codex exec` and `codex exec resume` (`--help` output) — unlike Claude's imageAttachments
  // (a "Read this file" text instruction, since claude -p has no image flag), codex has a genuine
  // native flag, so attachments are passed as real `-i` args rather than a prompt-text workaround.
  const attachmentArgs = resolveAttachmentAbsPaths(opts?.attachments).flatMap((absPath) => ['-i', absPath]);

  // FLUX-1625 Phase 0 gotcha 2, re-verified live against codex-cli 0.146.0 (`codex exec resume
  // --help`): `-s`/`--sandbox` and `-C`/`--cd` are NOT accepted on resume. Unlike Copilot's FLUX-977
  // precedent (which drops --model on resume because Copilot's OWN bug ties --effort's rejection to
  // a missing --model), codex's `-m`/`--model` IS listed as a valid `exec resume` option — re-specify
  // it here.
  // FLUX-1631: same unconditional bypass as the spawn path above (see startCliSession's comment for
  // the full rationale — sandbox mode never actually unblocked mutating MCP calls, only this flag
  // does, and it also lifts the sandbox). `--dangerously-bypass-approvals-and-sandbox` is confirmed
  // accepted directly on `exec resume` (live-verified, `codex exec resume --help`), unlike `-s`/`-C`.
  assertCodexModelAvailable(session.model);
  const effortArgs = buildCodexEffortArgs(resolveCodexEffort(session, '', handoffTask));
  const resumeArgs = session.resumeSessionId
    ? ['exec', 'resume', session.resumeSessionId, '--json', ...(session.model ? ['--model', session.model] : []), ...attachmentArgs, '--dangerously-bypass-approvals-and-sandbox', ...effortArgs, ...buildCodexMcpConfigArgs(id, workspaceRoot, session.id)]
    : ['exec', '--json', ...(session.model ? ['--model', session.model] : []), ...attachmentArgs, '--dangerously-bypass-approvals-and-sandbox', ...effortArgs, ...buildCodexMcpConfigArgs(id, workspaceRoot, session.id)];

  log.info(`[${id}] Reply spawn, resume=${session.resumeSessionId || 'none'}`);
  const replyProc = spawnCodex(id, resumeArgs, executionRoot, session.id);
  replyProc.stdin.on('error', () => {});
  replyProc.stdin.write(promptForCli);
  replyProc.stdin.end();

  session.proc = replyProc;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr.on('data', (chunk) => {
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
    console.error(`[${id}] Failed to spawn codex for reply:`, error.message);
  });

  replyProc.on('exit', async (code, signal) => {
    // FLUX-1645: spare any pid THIS session holds — see the matching comment on the initial spawn.
    killProcessTree(replyProc, undefined, { label: id, exemptPids: getExemptPidsForSession(session.id) });
    commitReplyPending();
    flushSessionOutput(session, true, 'text');
    if (!session.requestedStop && !session.pausedForInput && (code !== 0 || signal)) {
      const replyOutcome = `${session.label} reply ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;
      const stderrHint = session.stderrCapture?.trim();
      appendErrorToSession(session, stderrHint ? `${replyOutcome}\n${stderrHint}` : replyOutcome);
    }
    terminalizeResumedExit(session);
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

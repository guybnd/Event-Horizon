import { log } from '../log.js';
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, tasksCache, estimateCostUSD } from '../task-store.js';
import { resolveTaskExecutionRoot, resolveResumeExecutionRoot, assertIsolatedSpawnRoot } from '../task-worktree.js';
import { notifyGroupSessionTerminal, notifyDelegationComplete, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { killProcessTree } from '../kill-process-tree.js';
import { checkFrameworkHealth, checkSkillStaleness } from '../notifications.js';
import { captureTurnStartState, clearNeedsActionIfSet, flagIfParked } from '../parked-ticket.js';
import { buildMemberScopeArgs } from '../group.js';
import { buildGroupDocsScopeArg } from '../group-member-worktree.js';
import { appendTranscriptLine } from '../transcript.js';
import { buildMcpServerEntry } from '../workflow-installer.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import { EFFORT_LEVELS, type EffortLevel, cleanChildEnv, appendSessionOutput, appendErrorToSession, flushSessionOutput, activityFor, attachStdoutProcessing as sharedAttachStdoutProcessing, buildInitialPrompt, terminalizeResumedExit, surfaceResumeFailure, isChatEditGated, prependEditGateNote, type CliTask } from './shared.js';

const TOOL_ACTIVITY_MAP: Record<string, string> = {
  powershell: 'Running command',
  shell: 'Running command',
  edit: 'Editing',
  create: 'Editing',
  view: 'Reading',
  glob: 'Searching',
  grep: 'Searching',
  web_fetch: 'Researching',
  ask_user: 'Waiting for input',
  task: 'Delegating',
  sql: 'Working',
};

/** One line of Copilot CLI's JSONL stdout — the shape this adapter parses. Fields are a union of
 *  every event `type` Copilot emits; only the ones this parser reads. */
interface CopilotCliEvent {
  type?: string;
  data?: {
    deltaContent?: string;
    toolName?: string;
    name?: string;
    parameters?: Record<string, unknown>;
    input?: Record<string, unknown>;
    is_error?: boolean;
    error?: string;
    content?: unknown;
    usage?: CopilotUsage;
    sessionId?: string;
    id?: string;
  };
  is_error?: boolean;
  error?: string;
  subtype?: string;
  sessionId?: string;
  usage?: CopilotUsage;
}

interface CopilotUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  // FLUX-932: shared line-buffer / JSON.parse / commitPendingAssistantText skeleton lives in shared.ts.
  // This supplies Copilot's per-CLI parser (assistant.message_delta / tool_call / turn_end usage).
  // narrationType 'text' (4th arg below) → Copilot flushes the styled 'text' Narration block.
  return sharedAttachStdoutProcessing<CopilotCliEvent>(proc, session, {
    onEvent: (evt, trimmed, commitPendingAssistantText) => {

        // FLUX-969: tee raw event lines to the durable per-ticket transcript, mirroring
        // claude-code.ts's attachStdoutProcessing (which has done this since FLUX-602). This
        // adapter never called appendTranscriptLine at all — it only updated the live SSE
        // buffer + in-memory session progress, neither of which the chat window (GET /transcript)
        // reads from. Invisible for a per-ticket DISPATCHED session (its final reply lands as a
        // ticket comment on exit instead — see the proc.on('exit', ...) handler below) but fatal
        // for the board orchestrator chat, which has no ticket to comment on and relies entirely
        // on the transcript: a real reply happened, the chat window showed nothing.
        // Two exclusions (adversarial review caught the second one — the first pass only had
        // the first exclusion):
        //   1. Streaming delta chunks (arrive dozens-per-second) — same exclusion Claude's tee
        //      makes for `stream_event` partial deltas. Tool-call params/output in the COMPLETE
        //      events below (`assistant.tool_call*`, `assistant.tool_result`) are kept — Claude's
        //      own tee already writes the equivalent (full `toolBlock.input`, e.g. file paths /
        //      shell commands) verbatim today, so this is parity, not new exposure.
        //   2. `session.*` housekeeping events (mcp_server_status_changed, mcp_servers_loaded,
        //      skills_loaded, tools_updated) — these are Copilot-specific process-startup noise
        //      with no Claude equivalent, fire on every spawn (not once per conversation), carry
        //      zero conversational value, and can be large (skills_loaded includes every local
        //      skill file's absolute path; mcp_servers_loaded includes full server configs).
        if (
          evt.type !== 'assistant.message_delta' && evt.type !== 'assistant.reasoning_delta' && evt.type !== 'assistant.tool_call_delta'
          && typeof evt.type === 'string' && !evt.type.startsWith('session.')
        ) {
          appendTranscriptLine(taskId, trimmed);
        }

        // Handle Copilot CLI JSONL event types
        if (evt.type === 'assistant.message_delta' && evt.data?.deltaContent) {
          // Assistant text delta
          session.pendingAssistantText += evt.data.deltaContent;
          session.liveOutputBuffer += evt.data.deltaContent;
          if (!session.currentActivity || session.currentActivity === 'Thinking') {
            session.currentActivity = 'Responding';
            broadcastEvent('activity', { taskId, activity: session.currentActivity });
          }
        } else if (evt.type === 'assistant.message_start') {
          commitPendingAssistantText();
          session.currentActivity = 'Responding';
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
        } else if (evt.type === 'assistant.reasoning_delta') {
          // Reasoning — track activity but don't emit as text
          if (session.currentActivity !== 'Thinking') {
            session.currentActivity = 'Thinking';
            broadcastEvent('activity', { taskId, activity: session.currentActivity });
          }
        } else if (evt.type === 'assistant.tool_call_start' || evt.type === 'assistant.tool_call') {
          // Tool invocation started
          commitPendingAssistantText();
          const toolName = evt.data?.toolName || evt.data?.name || 'unknown';
          const newActivity = activityFor(TOOL_ACTIVITY_MAP, toolName);
          const activityChanged = session.currentActivity !== newActivity;
          session.currentActivity = newActivity;

          if (activityChanged) {
            session.lastProgressLog = undefined;
          }

          broadcastEvent('activity', { taskId, activity: session.currentActivity });

          // Accumulate tool progress in memory
          if (session.sessionHistoryEntry) {
            const params = evt.data?.parameters || evt.data?.input || {};
            let progressMsg = newActivity;
            if ((toolName === 'edit' || toolName === 'create') && typeof params.path === 'string') {
              progressMsg = `Editing ${path.basename(params.path)}`;
            } else if (toolName === 'view' && typeof params.path === 'string') {
              progressMsg = `Reading ${path.basename(params.path)}`;
            } else if (toolName === 'powershell' && params.command) {
              const cmd = String(params.command).slice(0, 50);
              progressMsg = `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
            } else if ((toolName === 'grep' || toolName === 'glob') && params.pattern) {
              progressMsg = `Searching: ${String(params.pattern).slice(0, 40)}`;
            }
            session.sessionHistoryEntry.progress.push({
              timestamp: new Date().toISOString(),
              message: progressMsg,
              type: 'tool',
              data: { toolName, parameters: params },
            });
          }
        } else if (evt.type === 'assistant.tool_call_delta') {
          // Tool call streaming — no-op for progress tracking
        } else if (evt.type === 'assistant.tool_result') {
          // Tool completed
          if (evt.data?.is_error) {
            console.error(`[${taskId}] Tool failed:`, evt.data.error || evt.data.content);
            // FLUX-981: previously this only pushed an in-memory progress row — no SSE broadcast, no
            // flush — so a tool error never reached the live chat. Route it through the shared helper
            // so it broadcasts a `progress` SSE immediately (and still persists to progress[]).
            appendErrorToSession(session, `Tool failed: ${evt.data.toolName || 'unknown'}${evt.data.error ? ` — ${evt.data.error}` : ''}`);
          }
        } else if (evt.type === 'assistant.turn_start') {
          // New turn
          session.currentActivity = 'Thinking';
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
        } else if (evt.type === 'assistant.turn_end' || evt.type === 'result') {
          // Turn completed — may contain usage stats
          commitPendingAssistantText();
          session.currentActivity = undefined;
          broadcastEvent('activity', { taskId, activity: null });

          // FLUX-981: a session/turn-level error reported on the result event was previously dropped
          // here — Claude and Gemini both surface this, Copilot didn't. Mirror them so an API /
          // overload / invalid-request error reaches the chat. Not a permission HITL prompt, so this
          // does NOT flip to waiting-input; the exit handler still runs afterward.
          if (evt.is_error || evt.data?.is_error) {
            appendErrorToSession(session, `Agent error: ${evt.error || evt.data?.error || evt.subtype || 'unknown'}`);
          }

          // FLUX-959: `result.sessionId` is the actual resumable Copilot CLI session id — verified
          // live against the installed CLI. The previous capture (a `user.message` event's
          // `parentId`) was a different id in the internal event-parent chain, NOT a value `copilot
          // --resume <id>` accepts; every resumed turn failed with "No session, task, or name
          // matched". `result` is the authoritative, final word for the turn, so this overwrites
          // unconditionally rather than only-if-unset.
          if (evt.type === 'result' && typeof evt.sessionId === 'string' && evt.sessionId) {
            session.resumeSessionId = evt.sessionId;
          }

          const usage = evt.data?.usage || evt.usage;
          if (usage) {
            const inputTok = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            const outputTok = usage.output_tokens ?? 0;
            session.inputTokens = (session.inputTokens ?? 0) + inputTok;
            session.outputTokens = (session.outputTokens ?? 0) + outputTok;
            session.cacheReadTokens = (session.cacheReadTokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
            session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
            if (typeof usage.total_cost_usd === 'number') {
              session.costUSD = (session.costUSD ?? 0) + usage.total_cost_usd;
            } else {
              session.costUSD = (session.costUSD ?? 0) + estimateCostUSD('copilot', inputTok, outputTok);
              session.costIsEstimated = true;
            }
          }
        } else if (evt.type === 'session.updated' || evt.type === 'session.created') {
          // Capture the session ID for resume support
          const sessionOrId = evt.data?.sessionId || evt.data?.id;
          if (sessionOrId) {
            session.resumeSessionId = sessionOrId;
          }
        }
        // Skip ephemeral session setup events (session.mcp_*, session.tools_updated, etc.)
    },
    onParseError: (trimmed) => {
      // Non-JSON output — treat as plain text activity
      appendSessionOutput(session, trimmed + '\n', 'stdout', true);
      flushSessionOutput(session, false, 'text');
      if (!session.currentActivity) {
        session.currentActivity = 'Working';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      }
    },
  }, 'text');
}

type ResolvedCopilotBinary = { nodePath: string | null; entryPoint: string | null; exePath: string };

// FLUX-974: the resolved binary path can't change during this process's lifetime (it would take
// an engine restart to install/move the CLI), but `spawnCopilot` called `resolveCopilotBinary`
// fresh on EVERY spawn — start AND every resumed turn — re-running its `where`/`npm prefix -g`
// execSync chain each time. Measured at ~1s+ of pure overhead per turn on a machine without a
// compiled copilot.exe (the common case, which falls to the slower node+npm-loader.js path).
// Cache the result after the first resolution; only the id used for logging varies per call.
// Tradeoff accepted: if the first resolution lands on the slower node+npm-loader.js fallback
// (no .exe found yet) and a compiled .exe is installed later in this same process's lifetime,
// the cache won't notice — it keeps using the already-working slow path until the next engine
// restart. Never breaks anything (both paths function), just leaves a performance win on the
// table until restart — an acceptable tradeoff for eliminating guaranteed per-turn overhead.
let cachedCopilotBinary: ResolvedCopilotBinary | null = null;

/** Resolve the copilot binary path across platforms — cached after the first call (FLUX-974). */
function resolveCopilotBinary(id: string): ResolvedCopilotBinary {
  if (cachedCopilotBinary) return cachedCopilotBinary;
  const resolved = resolveCopilotBinaryUncached(id);
  cachedCopilotBinary = resolved;
  return resolved;
}

function resolveCopilotBinaryUncached(id: string): ResolvedCopilotBinary {
  const isWin = process.platform === 'win32';

  // 1. Try to find the compiled binary (copilot.exe on Windows, copilot on Unix).
  // The compiled binary handles MCP server initialization (.mcp.json reading and
  // server spawning) as part of its startup. The node + JS entry point path skips
  // this, causing MCP tools to be unavailable in non-interactive mode.
  try {
    const checker = isWin ? 'where' : 'which';
    const result = execSync(`${checker} copilot`, { encoding: 'utf8', env: cleanChildEnv('copilot'), timeout: 10_000, windowsHide: true }).trim();
    const matches = result.split(/\r?\n/).filter(Boolean);

    if (isWin) {
      const exeMatch = matches.find(m => m.endsWith('.exe'));
      if (exeMatch && fs.existsSync(exeMatch)) {
        log.info(`[${id}] Found copilot.exe: ${exeMatch}`);
        return { nodePath: null, entryPoint: null, exePath: exeMatch };
      }
    } else {
      const firstMatch = matches[0];
      if (firstMatch && fs.existsSync(firstMatch)) {
        log.info(`[${id}] Found copilot on PATH: ${firstMatch}`);
        return { nodePath: null, entryPoint: null, exePath: firstMatch };
      }
    }
  } catch {}

  // 2. Check VS Code globalStorage for native binary
  const vsCodeCandidates = getVSCodeGlobalStoragePaths();
  for (const candidate of vsCodeCandidates) {
    if (fs.existsSync(candidate)) {
      log.info(`[${id}] Found copilot via VS Code globalStorage: ${candidate}`);
      return { nodePath: null, entryPoint: null, exePath: candidate };
    }
  }

  // 3. Windows fallback: spawn node + JS entry point (MCP tools may not load,
  // but at least basic functionality works when no .exe is available).
  if (isWin) {
    let systemNodePath: string | null = null;
    try {
      const whereResult = execSync('where node', { encoding: 'utf8', env: cleanChildEnv('copilot'), timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/);
      const selfExe = process.execPath.toLowerCase();
      systemNodePath = whereResult.find(p => p.toLowerCase() !== selfExe && fs.existsSync(p)) || null;
      if (!systemNodePath) systemNodePath = whereResult[0] || null;
    } catch {}

    let entryPoint: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', env: cleanChildEnv('copilot'), timeout: 10_000, windowsHide: true }).trim();
      const candidate = path.join(npmPrefix, 'node_modules', '@github', 'copilot', 'npm-loader.js');
      if (fs.existsSync(candidate)) {
        entryPoint = candidate;
        log.info(`[${id}] Found copilot JS entry (fallback): ${entryPoint}`);
      }
    } catch (err) {
      log.info(`[${id}] Failed to resolve copilot via npm prefix:`, err);
    }

    if (!entryPoint) {
      try {
        const result = execSync('where copilot', { encoding: 'utf8', env: cleanChildEnv('copilot'), timeout: 10_000, windowsHide: true }).trim();
        const cmdMatch = result.split(/\r?\n/).find(m => m.endsWith('.cmd'));
        if (cmdMatch) {
          const binDir = path.dirname(cmdMatch);
          const candidate = path.join(binDir, 'node_modules', '@github', 'copilot', 'npm-loader.js');
          if (fs.existsSync(candidate)) {
            entryPoint = candidate;
          }
        }
      } catch {}
    }

    if (entryPoint && systemNodePath) {
      log.info(`[${id}] Will spawn (node fallback): ${systemNodePath} ${entryPoint}`);
      return { nodePath: systemNodePath, entryPoint, exePath: systemNodePath };
    }
  }

  log.info(`[${id}] copilot not found, falling back to bare name`);
  return { nodePath: null, entryPoint: null, exePath: 'copilot' };
}

/** Returns candidate paths for the Copilot CLI binary installed by VS Code's Copilot Chat extension. */
function getVSCodeGlobalStoragePaths(): string[] {
  const candidates: string[] = [];
  const binaryName = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
  const relPath = path.join('User', 'globalStorage', 'github.copilot-chat', 'copilotCli', binaryName);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(path.join(appData, 'Code', relPath));
      candidates.push(path.join(appData, 'Code - Insiders', relPath));
    }
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (home) {
      candidates.push(path.join(home, 'Library', 'Application Support', 'Code', relPath));
      candidates.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', relPath));
    }
  } else {
    const configDir = process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, '.config') : '');
    if (configDir) {
      candidates.push(path.join(configDir, 'Code', relPath));
      candidates.push(path.join(configDir, 'Code - Insiders', relPath));
    }
  }
  return candidates;
}

/** Spawn the copilot process using the resolved binary info. */
export function spawnCopilot(id: string, args: string[], cwdRoot: string) {
  const { nodePath, entryPoint, exePath } = resolveCopilotBinary(id);

  if (nodePath && entryPoint) {
    // Spawn node directly with JS entry point (avoids .cmd path-with-spaces issues on Windows)
    log.info(`[${id}] Spawning: node ${path.basename(entryPoint)} [${args.length} args]`);
    return spawn(nodePath, [entryPoint, ...args], {
      cwd: cwdRoot,
      env: cleanChildEnv('copilot', id),
      stdio: 'pipe',
      windowsHide: true,
    });
  }

  log.info(`[${id}] Spawning: ${exePath} [${args.length} args]`);
  return spawn(exePath, args, {
    cwd: cwdRoot,
    env: cleanChildEnv('copilot', id),
    stdio: 'pipe',
    windowsHide: true,
  });
}

// FLUX-984: Copilot never auto-loads the workspace .mcp.json in non-interactive (-p) mode —
// confirmed live, no permission flag (--yolo, --allow-all, --allow-tool) changes it. `copilot mcp
// list`/`get` detect the workspace config fine; a scripted -p run silently ignores it and falls
// back to the model reading .flux/ files directly instead of calling the event-horizon MCP tools
// at all. The documented fix is --additional-mcp-config, injecting the server explicitly. Exported
// so copilot-board.ts (the board spec) can reuse it — same capability, same mechanism, both spawn
// paths need it.
// FLUX-1213: `conversationId`, when passed, carries this spawn's bound identity as HTTP headers on
// the injected entry (same shared-HTTP-mount problem/fix as claude-code.ts's
// eventHorizonSpawnOverride) so this session's HITL prompts route to its own ticket instead of the
// `__board__` catch-all.
export function buildAdditionalMcpConfigArgs(conversationId?: string): string[] {
  return ['--additional-mcp-config', JSON.stringify({ mcpServers: { 'event-horizon': buildMcpServerEntry(conversationId) } })];
}

export async function startCliSession(session: CliSessionRecord, task: CliTask, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const label = session.label;
  const id = session.taskId;
  // FLUX-519: run the agent in this task's worktree when one exists (else engine root).
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot);
  session.executionRoot = executionRoot;

  // FLUX-1018 / FLUX-1028: fail closed on the fresh-spawn path (shared helper —
  // see assertIsolatedSpawnRoot in task-worktree.ts). Copilot's `-p` mode never
  // checks the branch out itself, so spawning with cwd = workspaceRoot would
  // commit straight to master (the FLUX-972 incident).
  assertIsolatedSpawnRoot('Copilot', id, task, executionRoot, workspaceRoot);

  log.info(`[${id}] Starting Copilot CLI session in ${workspaceRoot}`);

  const copilotIntegration = configCache.integrations?.copilotCli;
  const groomingStatuses = [configCache.requireInputStatus || 'Require Input', 'Grooming'];
  // FLUX-931: session.model carries a delegate's resolved model (routes/cli-session.ts
  // /delegate) — honor it over the status-derived grooming/implementation model, mirroring
  // claude-code.ts's `session.model || selectedModel`.
  const selectedModel = session.model || (copilotIntegration
    ? (groomingStatuses.includes(task.status) ? copilotIntegration.groomingModel : copilotIntegration.implementationModel)
    : null);

  // FLUX-1193: prefer the session's own launch phase — set by the caller (routes/cli-session.ts
  // passes 'chat' for ticket chat, per useChatSession.ts) — over a status-derived guess, mirroring
  // claude-code.ts's `phase: session.phase`. Without this, a chat session's task.status (e.g. 'Todo')
  // always fell through to the 'implementation' branch below: buildInitialPrompt's `case 'chat':` —
  // the ONLY branch that renders the FLUX-926/1123 edit-gate note, and the only one with the
  // free-form "Conversational session" instructions — was unreachable for Copilot/Gemini chat.
  const taskPhase = session.phase ?? (groomingStatuses.includes(task.status) ? 'grooming'
    : (task.status === 'In Progress' || task.status === 'Todo') ? 'implementation'
    : task.status === (configCache?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined);

  // FLUX-1123: Copilot has no --disallowed-tools equivalent (see FILE_MUTATION_TOOLS's comment in
  // claude-code.ts), so this can only be an advisory note in the prompt, not a real block.
  const initialPrompt = buildInitialPrompt(task, appendPrompt, { phase: taskPhase, framework: 'copilot', editsGated: isChatEditGated(session, task) });

  const copilotArgs = [
    ...(selectedModel ? ['--model', selectedModel] : []),
    '-p', initialPrompt,
    '--output-format', 'json',
    ...(session.skipPermissions ? ['--yolo'] : ['--allow-all-tools']),
    // FLUX-984: explicit MCP config injection — workspace .mcp.json is never auto-loaded in -p mode.
    ...buildAdditionalMcpConfigArgs(id),
    // Multi-repo group: put every checked-out member repo in scope (no-op single-repo).
    ...buildMemberScopeArgs(),
    // Member worktree: add local .flux-group/ so the agent reads shared group docs (FLUX-422).
    ...buildGroupDocsScopeArg(workspaceRoot),
  ];

  const effortCap = CLI_CAPABILITIES.copilot.effort;
  const globalEffort = configCache.effortLevel as string | undefined;
  const taskEffort = task.effortLevel;
  const effectiveEffort = (effortOverrideRaw || taskEffort || globalEffort || '') as string;
  // FLUX-977: Copilot CLI rejects --effort outright when no explicit --model is set (its default
  // "auto" model "does not support reasoning effort configuration" — confirmed against the live
  // CLI). Gate on `selectedModel` too, not just a resolved effort value, so a global effort
  // default with no Copilot model configured (the common case — Copilot wasn't the previous
  // default agent, so most users never set integrations.copilotCli) degrades quietly instead of
  // crashing every single Copilot session outright.
  const effortRequested = effortCap.supported && effortCap.flag && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel);
  if (effortRequested && selectedModel) {
    copilotArgs.push(effortCap.flag!, effectiveEffort);
  } else if (effortRequested && !selectedModel) {
    // FLUX-977: don't just silently drop the user's requested effort level — that replaces the
    // old crash with a new, quieter silent-failure pattern (effort visibly requested somewhere,
    // invisibly ignored here). Log it so "why didn't effort do anything" is answerable from logs.
    log.info(`[${id}] Dropping --effort "${effectiveEffort}" — no Copilot model configured (integrations.copilotCli); Copilot rejects --effort without an explicit --model.`);
  }

  log.info(`[${id}] Args: [${copilotArgs.map((a, i) => i === copilotArgs.indexOf(initialPrompt) ? `<prompt ${initialPrompt.length} chars>` : a).join(', ')}]`);

  const proc = spawnCopilot(id, copilotArgs, executionRoot);

  session.proc = proc;
  session.pid = proc.pid;
  session.status = 'running';
  session.command = 'copilot';
  session.args = copilotArgs;
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
    // FLUX-981: surface the spawn failure inline in the chat, not only as a history activity entry.
    appendErrorToSession(session, `Failed to start agent: ${error.message}`);
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

    console.error(`[${id}] Failed to spawn copilot:`, error.message);
  });

  // Create agent_session history entry
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

  // Start progress heartbeat - accumulate activity in memory every 15 seconds
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
    // FLUX-1207: best-effort reap of any orphaned descendants (e.g. a Bash-tool-launched vitest
    // run) on every exit, not only engine-initiated stop().
    killProcessTree(proc, undefined, { label: id });
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
      // FLUX-985: agent moved the ticket to Require Input and was told to stop mid-turn. Mirror
      // claude-code.ts — stay resumable (waiting-input, no endedAt) rather than force 'completed',
      // which would post the agent's mid-turn question as a bogus completion comment, prematurely
      // fire the group-terminal barrier, and drop the session from the active/parked view while it
      // is genuinely awaiting the user. The resume route already accepts 'waiting-input'
      // (routes/cli-session.ts), so resumability is unaffected. Pause branch ONLY — copilot stays
      // persistentChat:false, so a normal chat turn still goes 'completed'.
      session.status = 'waiting-input';
      finalStatus = 'waiting-input';
    } else if (code === 0) {
      session.endedAt = new Date().toISOString();
      session.status = 'completed';
      finalStatus = 'completed';
    } else {
      session.endedAt = new Date().toISOString();
      session.status = 'failed';
      finalStatus = 'failed';
    }

    const outcome = session.requestedStop
      ? `${label} session stopped by user.`
      : `${label} session ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;

    const tokenUpdate = (session.inputTokens ?? 0) > 0 || (session.outputTokens ?? 0) > 0
      ? (() => {
          const prev = tasksCache[id]?.tokenMetadata || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
          return {
            inputTokens: (prev.inputTokens ?? 0) + (session.inputTokens ?? 0),
            outputTokens: (prev.outputTokens ?? 0) + (session.outputTokens ?? 0),
            costUSD: parseFloat(((prev.costUSD ?? 0) + (session.costUSD ?? 0)).toFixed(6)),
            costIsEstimated: prev.costIsEstimated || session.costIsEstimated || false,
            cacheReadTokens: (prev.cacheReadTokens ?? 0) + (session.cacheReadTokens ?? 0),
            cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (session.cacheCreationTokens ?? 0),
          };
        })()
      : null;

    // FLUX-985: paused for user input — flush tokens + mark the session entry waiting-input, but do
    // NOT go terminal: no completion comment (the last text is the agent's Require-Input message, not
    // a result), no group-barrier notify, no delegation-complete, no parked-flag, no endedAt.
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

    // FLUX-981: a nonzero/signal exit the user did NOT cancel surfaces inline in the chat, in addition
    // to the outcome/activity record. finalStatus is 'failed' only for a genuine failure (requestedStop
    // → 'cancelled', pausedForInput returned above) — this preserves the cancelled-guard. Await the
    // write queue so the injected ⚠️ line lands in progress[] before it's snapshotted below.
    if (finalStatus === 'failed') {
      const stderrHint = session.stderrCapture?.trim();
      const fullMessage = stderrHint ? `${outcome}\n${stderrHint}` : outcome;
      appendErrorToSession(session, fullMessage);
      await session.writeQueue;
    }

    // Close the session entry with outcome and flush accumulated progress
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
      checkFrameworkHealth(session.framework).catch(() => {});
      checkSkillStaleness(session.framework).catch(() => {});
      // FLUX-651: flag if the agent left the ticket parked in a working status without acting.
      await flagIfParked(session, id);
    }

    // FLUX-985: settle any delegation awaiting this session (supervisor/delegate pattern). copilot.ts
    // was the ONLY adapter that omitted this — claude-code.ts and gemini.ts both call it. Without it,
    // a `delegate` to a Copilot specialist never resolves awaitDelegation on clean exit; the
    // orchestrator blocks for the full delegation timeout (up to 600s) and then receives a bogus
    // 'cancelled'/timeout result with the completed child's real output discarded.
    notifyDelegationComplete(session);

    if (session.groupId) {
      notifyGroupSessionTerminal(session.taskId, session.groupId).catch(() => {});
    }

    checkAutoRestart();
  });
}

export class CopilotAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'copilot',
    displayName: 'Copilot CLI',
    configSchema: {},
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Copilot CLI';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    // The AgentAdapter interface types the incoming task as `unknown` (it's a bare ticket
    // frontmatter record with no canonical compile-time type — see task-store.ts's
    // `tasksCache: Record<string, any>`), but every caller (routes/cli-session.ts) always
    // passes the actual ticket record, whose shape is exactly what CliTask names.
    return startCliSession(session, task as CliTask, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot);
  }

  stop(session: CliSessionRecord): void {
    // Tree-kill so the agent's MCP servers (serena, context7, …) are reaped too, not orphaned —
    // the stale-node-process leak. See kill-process-tree.ts.
    killProcessTree(session.proc);
  }
}

export async function sendCliSessionInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string) {
  const id = session.taskId;
  // FLUX-519 review: resume in the SAME root the session started in; refuse to fall
  // back onto master if the worktree was removed (e.g. the ticket was finished).
  // FLUX-1018 / FLUX-1028: shared fail-closed guard — see resolveResumeExecutionRoot
  // in task-worktree.ts. FLUX-1120: this throws BEFORE any child process spawns, so
  // surface it the same way a spawn failure is surfaced instead of letting it vanish
  // into an HTTP-500-only response — see surfaceResumeFailure in shared.ts.
  let executionRoot: string;
  try {
    executionRoot = await resolveResumeExecutionRoot(session, tasksCache[id], workspaceRoot);
  } catch (error) {
    return surfaceResumeFailure(session, id, error);
  }

  const inputAt = new Date().toISOString();
  session.lastInputAt = inputAt;
  session.status = 'running';
  // FLUX-915: clear a stale stop flag before resuming so a prior stop can't mis-cancel this turn.
  session.requestedStop = false;
  // FLUX-651: new turn — snapshot ticket state and drop any stale "parked" flag.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  // FLUX-926 / FLUX-1123: same advisory "why is this blocked" note as the initial spawn,
  // recomputed per resumed turn (Copilot has no real block — see the editsGated comment above).
  const promptForCli = prependEditGateNote(session, tasksCache[id] as CliTask, 'copilot', safeMessage);
  // FLUX-984: explicit MCP config injection on the resume path too — the gap applies to every spawn.
  const resumeArgs = session.resumeSessionId
    ? ['-p', promptForCli, '--resume', session.resumeSessionId, '--output-format', 'json', '--yolo', ...buildAdditionalMcpConfigArgs(id)]
    : ['-p', promptForCli, '--output-format', 'json', '--yolo', ...buildAdditionalMcpConfigArgs(id)];

  log.info(`[${id}] Reply spawn, resume=${session.resumeSessionId || 'none'}`);
  const replyProc = spawnCopilot(id, resumeArgs, executionRoot);

  session.proc = replyProc;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  replyProc.on('error', async (error) => {
    // FLUX-915/921: a stop racing a spawn error stays 'cancelled' rather than reverting to resumable.
    terminalizeResumedExit(session);
    commitReplyPending();
    // FLUX-981: surface the reply spawn failure inline in the chat, not only as an activity entry.
    // Skip when the user cancelled — a stop that races the spawn error isn't a fault.
    if (!session.requestedStop) {
      appendErrorToSession(session, `Failed to resume agent: ${error.message}`);
    }
    flushSessionOutput(session, true, 'text');
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    console.error(`[${id}] Failed to spawn copilot for reply:`, error.message);
  });

  replyProc.on('exit', async (code, signal) => {
    // FLUX-1207: best-effort reap of any orphaned descendants (e.g. a Bash-tool-launched vitest
    // run) on every exit, not only engine-initiated stop().
    killProcessTree(replyProc, undefined, { label: id });
    commitReplyPending();
    flushSessionOutput(session, true, 'text');
    // FLUX-981: a crashed resumed turn (nonzero/signal, not user-stopped) was silent in the chat.
    // Also exclude pausedForInput (mirrors claude-code.ts): when the agent parked for Require Input
    // mid-turn and the process then exits nonzero/signaled, that's a legitimate HITL pause — not a
    // failure — so labeling it "reply ended with code N" would mislabel it as a crash.
    if (!session.requestedStop && !session.pausedForInput && (code !== 0 || signal)) {
      const replyOutcome = `${session.label} reply ended with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`;
      const stderrHint = session.stderrCapture?.trim();
      appendErrorToSession(session, stderrHint ? `${replyOutcome}\n${stderrHint}` : replyOutcome);
    }
    // FLUX-915/921: a user-requested stop stays 'cancelled' instead of reverting to 'waiting-input'
    // (which counted the killed session as active forever). Otherwise the resumable conversation
    // stays waiting-input.
    terminalizeResumedExit(session);
    // FLUX-651: resumed turn ended — flag if the agent parked without acting. Skip a stopped turn.
    if (!session.pausedForInput && !session.requestedStop) await flagIfParked(session, id);
    broadcastEvent('taskUpdated', { id });
  });
}

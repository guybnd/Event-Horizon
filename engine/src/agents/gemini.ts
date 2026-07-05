import { log } from '../log.js';
import { spawn, exec, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentSessionEntry, type AgentSessionProgress } from '../history.js';
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
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import { EFFORT_LEVELS, type EffortLevel, cleanChildEnv, checkBinaryInstalled, appendSessionOutput, appendErrorToSession, enqueueSessionWrite, flushSessionOutput, activityFor, attachStdoutProcessing as sharedAttachStdoutProcessing, buildInitialPrompt, terminalizeResumedExit, surfaceResumeFailure } from './shared.js';

const TOOL_ACTIVITY_MAP: Record<string, string> = {
  Bash: 'Running command',
  Edit: 'Editing',
  Write: 'Editing',
  Read: 'Reading',
  WebFetch: 'Researching',
  WebSearch: 'Researching',
  Agent: 'Delegating',
  TodoWrite: 'Planning',
};

export function buildGeminiScopeArgs(workspaceRoot: string): string[] {
  const scopeArgs = [...buildMemberScopeArgs(), ...buildGroupDocsScopeArg(workspaceRoot)];
  const geminiScopeArgs: string[] = [];
  for (let i = 0; i < scopeArgs.length; i += 2) {
    const dir = scopeArgs[i + 1];
    if (scopeArgs[i] === '--add-dir' && dir) {
      geminiScopeArgs.push('--include-directories', dir);
    }
  }
  return geminiScopeArgs;
}

const execAsync = promisify(exec);

interface GeminiWindowsLaunch {
  /** Resolved system node executable, or 'node' bare name as a last-resort fallback. */
  nodeCmd: string;
  entryPoint: string | null;
  exePath: string | null;
}

/** Narrow shape of the loosely-typed ticket record this adapter actually reads from. */
interface GeminiTask {
  id?: string;
  branch?: string;
  status?: string;
  effortLevel?: string;
}

/** Claude-schema `assistant.content[]` block — the fallback shape this adapter also parses. */
interface AssistantContentBlock {
  type: string;
  name?: string;
  text?: string;
  input?: { file_path?: string; command?: string; [key: string]: unknown };
}

// FLUX-1003 (epic FLUX-996): was three SYNCHRONOUS `execSync` calls (`where node`, `npm prefix -g`,
// `where gemini`) run on EVERY spawnGemini call — i.e. every turn, not just cold start — blocking
// the whole Node event loop for their combined duration each time. Unlike Claude (FLUX-975) and
// Copilot (FLUX-974), this resolution was never cached at all. Converted to async `exec` (kept in
// the shell-based family — `npm`/`gemini` resolve to `.cmd` wrappers on Windows, which `execFile`
// can't invoke without `shell:true`) plus a module-scoped cache.
//
// Caching mirrors FLUX-975's philosophy: cache a resolution only when it's DEFINITIVE. `npm prefix
// -g` succeeding is the definitive signal here (mirrors resolveClaudeExePath) — the derived
// entryPoint/exePath candidates can't change without a reinstall + engine restart, whether or not
// they were found. A transient failure (the subprocess itself couldn't run — timeout, spawn error)
// is NOT cached, so the next spawn retries full resolution rather than being stuck on a bad guess
// until restart.
let cachedGeminiWindowsLaunch: GeminiWindowsLaunch | undefined;

async function resolveGeminiWindowsLaunch(binaryName: string): Promise<GeminiWindowsLaunch> {
  if (cachedGeminiWindowsLaunch !== undefined) return cachedGeminiWindowsLaunch;

  // CRITICAL: spawn('node', ...) from within a pkg binary resolves to the pkg binary itself (not
  // system node) due to Windows CreateProcess search order — we must resolve the full path via
  // 'where node'. This step alone isn't cache-gating (a missing system node doesn't block us; we
  // fall back to the bare 'node' name), so its own failure doesn't affect `definitive` below.
  let systemNodePath: string | null = null;
  try {
    const prefixEnv = cleanChildEnv('gemini');
    const { stdout } = await execAsync('where node', { env: prefixEnv, timeout: 10_000, windowsHide: true });
    const whereResult = stdout.trim().split(/\r?\n/);
    // Filter out our own exe — pkg binaries ARE node binaries and 'where' may list them.
    const selfExe = process.execPath.toLowerCase();
    systemNodePath = whereResult.find(p => p.toLowerCase() !== selfExe && fs.existsSync(p)) || whereResult[0] || null;
  } catch {
    // 'where node' failed — will fall back to 'node' bare name (may break in pkg context).
  }

  // Prefer the JS entry point with system node over gemini.exe — the exe is a pkg binary that
  // crashes when NODE_OPTIONS carries V8 flags leaked from VS Code terminals or other tools.
  let entryPoint: string | null = null;
  let exePath: string | null = null;
  let npmPrefixSucceeded = false;
  try {
    const prefixEnv = cleanChildEnv('gemini');
    const { stdout } = await execAsync('npm prefix -g', { env: prefixEnv, timeout: 10_000, windowsHide: true });
    npmPrefixSucceeded = true;
    const npmPrefix = stdout.trim();
    const candidateJs = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    const candidateExe = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bin', 'gemini.exe');
    if (fs.existsSync(candidateJs)) {
      entryPoint = candidateJs;
    } else if (fs.existsSync(candidateExe)) {
      exePath = candidateExe;
    }
  } catch (err) {
    log.info('[gemini] Failed to resolve gemini via npm prefix:', err);
  }

  // Second attempt: use 'where' to find the gemini cmd/exe and resolve the JS entry relative to it.
  if (!entryPoint && !exePath) {
    try {
      const prefixEnv = cleanChildEnv('gemini');
      const { stdout } = await execAsync(`where ${binaryName}`, { env: prefixEnv, timeout: 10_000, windowsHide: true });
      const wherePath = stdout.trim().split(/\r?\n/)[0];
      if (wherePath) {
        // The .cmd is usually in the same dir as the npm prefix bin — try to find the JS bundle
        // relative to it, then the parent-directory npm-global layout pattern.
        const binDir = path.dirname(wherePath);
        const candidateJs = path.join(binDir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
        const parentCandidate = path.join(binDir, '..', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
        if (fs.existsSync(candidateJs)) {
          entryPoint = candidateJs;
        } else if (fs.existsSync(parentCandidate)) {
          entryPoint = parentCandidate;
        }
      }
    } catch {
      // where command failed — will fall through to the cmd.exe shell fallback at spawn time.
    }
  }

  const result: GeminiWindowsLaunch = { nodeCmd: systemNodePath || 'node', entryPoint, exePath };
  if (npmPrefixSucceeded) cachedGeminiWindowsLaunch = result;
  return result;
}

/**
 * Resolve and spawn the gemini CLI process. Factored out of `startCliSession`/`sendCliSessionInput`
 * (which both inlined this same Windows JS-entry/exe/shell-fallback resolution) so the board
 * orchestrator's Gemini `BoardSpec` (FLUX-959) can reuse it without a third copy.
 */
export async function spawnGemini(geminiArgs: string[], executionRoot: string, conversationId?: string): Promise<ReturnType<typeof spawn>> {
  const binaryName = 'gemini';
  // Preserve the per-session log tag the two inlined call sites used (`[${id}]`) rather than a
  // flat `[gemini]` — important for grepping logs when multiple sessions run concurrently.
  const logTag = `[${conversationId ?? 'gemini'}]`;
  if (process.platform === 'win32') {
    // On Windows, find the JS entry point or .exe instead of using cmd.exe wrapper (see
    // resolveGeminiWindowsLaunch for why, and its caching rationale).
    const { nodeCmd, entryPoint, exePath } = await resolveGeminiWindowsLaunch(binaryName);
    const env = cleanChildEnv('gemini', conversationId);
    if (entryPoint) {
      log.info(`${logTag} Windows spawn (node=${nodeCmd}): ${entryPoint}`);
      return spawn(nodeCmd, [entryPoint, ...geminiArgs], {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } else if (exePath) {
      log.info(`${logTag} Windows spawn (exe): ${exePath}`);
      return spawn(exePath, geminiArgs, {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    }
    // Last resort: use shell. Remove NODE_OPTIONS via explicit prefix to prevent
    // .cmd wrappers from re-injecting it.
    log.info(`${logTag} Windows spawn (fallback): ${binaryName}`);
    return spawn('cmd.exe', ['/c', `set "NODE_OPTIONS=" && ${binaryName}`, ...geminiArgs], {
      cwd: executionRoot,
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
  }
  return spawn(binaryName, geminiArgs, {
    cwd: executionRoot,
    env: cleanChildEnv('gemini', conversationId),
    stdio: 'pipe',
  });
}

/** One line of Gemini CLI's JSONL stdout — handles BOTH the native Gemini `message`/`tool_use`
 *  schema and the Claude-schema `assistant.content[]` fallback this adapter also parses. Fields
 *  are a union of every event `type` either schema emits; only the ones this parser reads. */
interface GeminiCliEvent {
  type?: string;
  session_id?: string;
  message?: { content?: AssistantContentBlock[] };
  role?: string;
  content?: string;
  tool_name?: string;
  parameters?: { title?: string; summary?: string; strategic_intent?: string; file_path?: string; command?: string; [key: string]: unknown };
  is_error?: boolean;
  error?: string;
  subtype?: string;
  stats?: { input_tokens?: number; output_tokens?: number; cached?: number; total_cost_usd?: number };
  usage?: {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  // FLUX-932: shared line-buffer / JSON.parse / commitPendingAssistantText skeleton lives in shared.ts.
  // This supplies Gemini's per-CLI parser (handles BOTH the Gemini `message`/`tool_use` schema AND the
  // Claude-schema `assistant.content[]` fallback). narrationType 'text' → styled Narration block.
  // (The Gemini blank-output fix now lives in shared `appendSessionOutput` — every adapter accumulates.)
  return sharedAttachStdoutProcessing<GeminiCliEvent>(proc, session, {
    onEvent: (evt, trimmed, commitPendingAssistantText) => {
        // FLUX-969: tee every raw event line to the durable per-ticket transcript, mirroring
        // claude-code.ts's attachStdoutProcessing (which has done this since FLUX-602). This
        // adapter never called appendTranscriptLine at all — it only updated the live SSE buffer
        // + in-memory session progress, neither of which the chat window (GET /transcript) reads
        // from. Invisible for a per-ticket DISPATCHED session (its final reply lands as a ticket
        // comment on exit instead) but fatal for the board orchestrator chat, which has no ticket
        // to comment on and relies entirely on the transcript: a real reply happened, the chat
        // window showed nothing. Unlike copilot.ts, Gemini's parser has no separate streaming-delta
        // event type to exclude — every event here is already a complete message/tool/result.
        appendTranscriptLine(taskId, trimmed);

        // Gemini CLI uses 'init' or 'message' for role=assistant
        if (!session.resumeSessionId && evt.session_id) {
          session.resumeSessionId = evt.session_id;
        }

        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          // Claude Code schema
          const toolBlock = evt.message.content.find((b: AssistantContentBlock) => b.type === 'tool_use');
          if (toolBlock) {
            session.pendingAssistantText = '';
            const newActivity = activityFor(TOOL_ACTIVITY_MAP, toolBlock.name ?? '');
            const activityChanged = session.currentActivity !== newActivity;
            session.currentActivity = newActivity;

            if (activityChanged) {
              session.lastProgressLog = undefined;
            }

            if (session.sessionHistoryEntry?.sessionId) {
              const toolName = toolBlock.name;
              let progressMsg = newActivity;
              if (toolBlock.input) {
                if (toolName === 'Read' && toolBlock.input.file_path) {
                  progressMsg = `Reading ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Edit' && toolBlock.input.file_path) {
                  progressMsg = `Editing ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Write' && toolBlock.input.file_path) {
                  progressMsg = `Writing ${path.basename(toolBlock.input.file_path)}`;
                } else if (toolName === 'Bash' && toolBlock.input.command) {
                  const cmd = String(toolBlock.input.command).slice(0, 50);
                  progressMsg = `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
                }
              }
              // Accumulate tool progress in memory only — written to file at session end
              if (session.sessionHistoryEntry) {
                const ts = new Date().toISOString();
                session.sessionHistoryEntry.progress.push({ 
                  timestamp: ts, 
                  message: progressMsg,
                  type: 'tool',
                  data: { toolName, parameters: toolBlock.input }
                });
                // Broadcast tool progress via SSE for real-time portal updates
                broadcastEvent('progress', {
                  taskId,
                  sessionId: session.sessionHistoryEntry.sessionId,
                  timestamp: ts,
                  message: progressMsg,
                  type: 'tool',
                });
              }
            }
          } else {
            commitPendingAssistantText();
            session.currentActivity = 'Thinking';
          }
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
          for (const block of evt.message.content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              session.liveOutputBuffer += block.text;
              if (!toolBlock) {
                session.pendingAssistantText += block.text;
              }
            }
          }
        } else if (evt.type === 'message' && evt.role === 'assistant') {
          // Gemini CLI schema
          commitPendingAssistantText();
          session.currentActivity = 'Thinking';
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
          
          if (typeof evt.content === 'string' && evt.content.trim()) {
            // FLUX-932: route through the shared appendSessionOutput (isAssistantText=true) instead of
            // poking liveOutputBuffer/outputBuffer directly, so THIS branch — the real Gemini CLI schema
            // (per FLUX-969's commit message: "Gemini's native message/role:'assistant' event") — also
            // accumulates into session.cumulativeOutput. The Claude-schema-fallback branch above got the
            // FLUX-932 cumulativeOutput fix (dropping appendSessionOutput's dead trackCumulative=false),
            // but this native branch — what an actual Gemini CLI session emits — still bypassed it
            // entirely, so a real Gemini session's captured output stayed '' even after that fix landed.
            appendSessionOutput(session, evt.content, 'stdout', true);
            // Trigger debounced flush to broadcast progress via SSE (matching Claude behavior)
            flushSessionOutput(session, false, 'text');
          }
        } else if (evt.type === 'tool_use') {
          // Gemini CLI tool use schema
          session.pendingAssistantText = '';
          const newActivity = activityFor(TOOL_ACTIVITY_MAP, evt.tool_name ?? '');
          const activityChanged = session.currentActivity !== newActivity;
          session.currentActivity = newActivity;

          if (activityChanged) {
            session.lastProgressLog = undefined;
          }

          if (session.sessionHistoryEntry?.sessionId) {
            const toolName = evt.tool_name;
            const params = evt.parameters || {};
            let progressMsg = newActivity;
            let type: 'tool' | 'topic' = 'tool';
            let data: Record<string, unknown> = { toolName, parameters: params };

            if (toolName === 'update_topic') {
              type = 'topic';
              progressMsg = params.title || 'Topic Update';
              data = { title: params.title, summary: params.summary, strategicIntent: params.strategic_intent };
            } else if (toolName === 'read_file' && params.file_path) {
              progressMsg = `Reading ${path.basename(params.file_path)}`;
            } else if (toolName === 'replace' && params.file_path) {
              progressMsg = `Editing ${path.basename(params.file_path)}`;
            } else if (toolName === 'write_file' && params.file_path) {
              progressMsg = `Writing ${path.basename(params.file_path)}`;
            } else if (toolName === 'run_shell_command' && params.command) {
              const cmd = String(params.command).slice(0, 50);
              progressMsg = `Running: ${cmd}${cmd.length >= 50 ? '...' : ''}`;
            }

            // Accumulate tool progress in memory only — written to file at session end
            if (toolName && session.sessionHistoryEntry) {
              const ts = new Date().toISOString();
              session.sessionHistoryEntry.progress.push({ 
                timestamp: ts, 
                message: progressMsg,
                type,
                data
              });
              // Broadcast tool progress via SSE for real-time portal updates
              broadcastEvent('progress', {
                taskId,
                sessionId: session.sessionHistoryEntry.sessionId,
                timestamp: ts,
                message: progressMsg,
                type,
              });
            }
          }
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
        } else if (evt.type === 'tool_result') {
          if (evt.is_error) {
            console.error(`[${taskId}] Tool ${evt.tool_name || 'unknown'} failed:`, evt.error);
            // FLUX-981: previously this only accumulated an in-memory progress row — no SSE broadcast,
            // no flush — so a tool error never reached the live chat. Route it through the shared
            // helper so it broadcasts a `progress` SSE immediately (and still persists to progress[]).
            appendErrorToSession(session, `Tool failed: ${evt.tool_name || 'unknown'}${evt.error ? ` — ${evt.error}` : ''}`);
          }
        } else {
          if (evt.type !== 'tool_use' && evt.type !== 'tool_result' && evt.type !== 'message' && evt.type !== 'init') {
            commitPendingAssistantText();
          } else {
            session.pendingAssistantText = '';
          }
          
          // Only append raw JSON if it's not a known type we've already handled or want to hide
          if (evt.type !== 'message' && evt.type !== 'tool_use' && evt.type !== 'tool_result' && evt.type !== 'init' && evt.type !== 'result') {
            appendSessionOutput(session, trimmed, 'stdout', false);
          }
        }

        if (evt.type === 'result') {
          session.currentActivity = undefined;
          broadcastEvent('activity', { taskId, activity: null });
        }
        
        // Token usage handling
        if (evt.type === 'result' && evt.stats) {
          // Gemini CLI stats schema
          const inputTok = evt.stats.input_tokens ?? 0;
          const outputTok = evt.stats.output_tokens ?? 0;
          const cacheRead = evt.stats.cached ?? 0;
          session.inputTokens = (session.inputTokens ?? 0) + inputTok;
          session.outputTokens = (session.outputTokens ?? 0) + outputTok;
          session.cacheReadTokens = (session.cacheReadTokens ?? 0) + cacheRead;
          
          if (typeof evt.stats.total_cost_usd === 'number') {
            session.costUSD = (session.costUSD ?? 0) + evt.stats.total_cost_usd;
          } else {
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.resumeSessionId, inputTok, outputTok);
            session.costIsEstimated = true;
          }
        } else if (evt.type === 'result' && evt.usage) {
          // Claude Code usage schema
          const cacheRead = evt.usage?.cache_read_input_tokens ?? 0;
          const cacheCreation = evt.usage?.cache_creation_input_tokens ?? 0;
          const freshInput = evt.usage?.input_tokens ?? 0;
          const inputTok = freshInput + cacheRead + cacheCreation;
          const outputTok = evt.usage?.output_tokens ?? 0;
          session.inputTokens = (session.inputTokens ?? 0) + inputTok;
          session.outputTokens = (session.outputTokens ?? 0) + outputTok;
          session.cacheReadTokens = (session.cacheReadTokens ?? 0) + cacheRead;
          session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + cacheCreation;
          if (typeof evt.total_cost_usd === 'number') {
            session.costUSD = (session.costUSD ?? 0) + evt.total_cost_usd;
          } else {
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.resumeSessionId, inputTok, outputTok);
            session.costIsEstimated = true;
          }
        }
        if (evt.type === 'tool_use_blocked' || (evt.type === 'result' && evt.is_error && /permission|not allowed|denied/i.test(String(evt.error || '')))) {
          const reason = evt.tool_name
            ? `Blocked: ${evt.tool_name}${evt.error ? ` â€” ${evt.error}` : ''}`
            : String(evt.error || 'Permission denied');
          session.blockedReason = reason;
          session.status = 'waiting-input';
          flushSessionOutput(session, true, 'text');
          enqueueSessionWrite(session, async () => {
            await updateTaskWithHistory(taskId, {
              updatedBy: 'Agent',
              nextStatus: configCache.requireInputStatus || 'Require Input',
              entries: [buildActivityEntry(`${session.label} blocked: ${reason}`, 'Agent', new Date().toISOString())],
            });
          });
        } else if (evt.type === 'result' && evt.is_error) {
          // FLUX-981: a non-permission result error (API error, overload, invalid request) was
          // previously dropped — it doesn't match the permission regex and has no other handler.
          // Surface it inline. Do NOT flip to waiting-input: the exit handler still runs after.
          appendErrorToSession(session, `Agent error: ${evt.error || evt.subtype || 'unknown'}`);
        }
    },
    onParseError: (trimmed) => {
      appendSessionOutput(session, trimmed, 'stdout', false);
      // Broadcast that we received some output even if it wasn't valid JSON
      if (!session.currentActivity) {
        session.currentActivity = 'Working';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      }
    },
  }, 'text');
}

export async function startCliSession(session: CliSessionRecord, task: GeminiTask, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const framework = session.framework;
  const binaryName = 'gemini';
  const label = session.label;
  const id = session.taskId;
  // FLUX-519: run the agent in this task's worktree when one exists (else engine root).
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot);
  session.executionRoot = executionRoot;

  // FLUX-1018 / FLUX-1028: fail closed on the fresh-spawn path (shared helper —
  // see assertIsolatedSpawnRoot in task-worktree.ts).
  assertIsolatedSpawnRoot(framework, id, task, executionRoot, workspaceRoot);

  log.info(`[${id}] Starting ${framework} session in ${workspaceRoot}`);

  await checkBinaryInstalled(binaryName);

  const geminiIntegration = configCache.integrations?.geminiCli;
  const groomingStatuses = [configCache.requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModelRaw = geminiIntegration && framework === 'gemini'
    ? (groomingStatuses.includes(task.status) ? geminiIntegration.groomingModel : geminiIntegration.implementationModel)
    : null;

  // Validate the model name against known Gemini CLI models
  const KNOWN_GEMINI_MODELS = [
    'gemini-3-pro-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.1-pro-preview-customtools',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it',
    'auto',
    'pro',
    'flash',
    'flash-lite'
  ];

  let selectedModel = selectedModelRaw;
  if (selectedModel) {
    const modelLower = selectedModel.toLowerCase().trim();
    if (!KNOWN_GEMINI_MODELS.some(m => m.toLowerCase() === modelLower)) {
      console.warn(`[Gemini CLI] Model "${selectedModel}" is unrecognized by Gemini CLI. Falling back to default model resolving to prevent 404 errors.`);
      selectedModel = null;
    }
  }

  const taskPhase = groomingStatuses.includes(task.status) ? 'grooming'
    : (task.status === 'In Progress' || task.status === 'Todo') ? 'implementation'
    : task.status === (configCache?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined;

  const initialPrompt = buildInitialPrompt(task, appendPrompt, { phase: taskPhase, framework: 'gemini' });

  const geminiArgs = [
    ...(selectedModel ? ['--model', selectedModel] : []),
    '-p', initialPrompt,
    '--output-format', 'stream-json',
    '--screen-reader',
    ...(session.skipPermissions ? ['--yolo'] : []),
    // --skip-trust is used to bypass the "Are you sure you want to run this?" confirmation 
    // for commands that are already trusted/validated by the engine's internal logic
    // or when running in a non-interactive automation context.
    '--skip-trust',
    ...buildGeminiScopeArgs(workspaceRoot),
  ];

  log.info(`[${id}] Args:`, geminiArgs);

  const effortCap = CLI_CAPABILITIES[framework].effort;
  const globalEffort = configCache.effortLevel as string | undefined;
  const taskEffort = task.effortLevel;
  const effectiveEffort = (effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (effortCap.supported && effortCap.flag && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    geminiArgs.push(effortCap.flag, effectiveEffort);
  }

  const proc = await spawnGemini(geminiArgs, executionRoot, id);
  session.proc = proc as ChildProcessWithoutNullStreams;
  session.pid = proc.pid;
  session.status = 'running';
  session.args = geminiArgs;
  // FLUX-651: snapshot ticket state at turn start; drop any stale "parked" flag.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  proc.on('error', async (error) => {
    // Clear heartbeat timer
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

    console.error(`[${id}] Failed to spawn ${binaryName}:`, error.message);
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
      // Only log if we haven't logged this same activity recently
      if (session.lastProgressLog !== session.currentActivity) {
        session.lastProgressLog = session.currentActivity;
        // Accumulate in memory only — written to file when session ends
        session.sessionHistoryEntry.progress.push({
          timestamp: now,
          message: session.currentActivity,
          type: 'info',
        });
      }
    }
  }, 15000);

  proc.on('exit', async (code, signal) => {
    // Clear heartbeat timer
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
      // (routes/cli-session.ts), so resumability is unaffected. Pause branch ONLY — gemini stays
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
        // Merge in-memory progress accumulated during the session
        sessionEntry.progress = accumulatedProgress;
      });

      // Save the agent's final message as a comment on the ticket
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
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [],
          tokenMetadata: tokenUpdate,
        });
      }
    } else {
      // Fallback to old behavior
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

    // Notify delegation awaiters (supervisor pattern).
    notifyDelegationComplete(session);

    if (session.groupId) {
      notifyGroupSessionTerminal(session.taskId, session.groupId).catch(() => {});
    }

    checkAutoRestart();
  });
}

export class GeminiAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'gemini',
    displayName: 'Gemini CLI',
    configSchema: {},
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Gemini CLI';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    return startCliSession(session, task as GeminiTask, appendPrompt, effortOverride, workspaceRoot);
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
  const binaryName = session.command;
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

  await checkBinaryInstalled(binaryName);

  const inputAt = new Date().toISOString();
  session.lastInputAt = inputAt;
  session.status = 'running';
  // FLUX-915: clear a stale stop flag before resuming so a prior stop can't mis-cancel this turn.
  session.requestedStop = false;
  // FLUX-909: new turn started — clear the stale block reason from a prior parked turn so the
  // card no longer reads as amber "Needs your input" after the user resumes the session.
  delete session.blockedReason;
  // FLUX-651: new turn — snapshot ticket state and drop any stale "parked" flag.
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  const geminiScopeArgs = buildGeminiScopeArgs(workspaceRoot);
  const resumeArgs = session.resumeSessionId
    ? ['-p', safeMessage, '--resume', session.resumeSessionId, '--output-format', 'stream-json', '--screen-reader', '--yolo', '--skip-trust', ...geminiScopeArgs]
    : ['-p', safeMessage, '--output-format', 'stream-json', '--screen-reader', '--yolo', '--skip-trust', ...geminiScopeArgs];

  const replyProc = await spawnGemini(resumeArgs, executionRoot, id);
  session.proc = replyProc as ChildProcessWithoutNullStreams;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr!.on('data', (chunk) => {
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
    console.error(`[${id}] Failed to spawn ${binaryName} for reply:`, error.message);
  });

  replyProc.on('exit', async (code, signal) => {
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

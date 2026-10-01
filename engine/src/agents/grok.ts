import { getWorkspace, resolveWorkspaceByRoot, runWithWorkspace } from '../workspace-context.js';
import { log } from '../log.js';
import { spawn, execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { getConfig } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession } from '../task-store.js';
import { resolveTaskExecutionRoot, resolveResumeExecutionRoot, assertIsolatedSpawnRoot } from '../task-worktree.js';
import { resolveExecutionRootReclaimOpts } from '../pr-cleanup.js';
import { notifyGroupSessionTerminal, notifyDelegationComplete, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { killProcessTree } from '../kill-process-tree.js';
import { getExemptPidsForSession, clearHoldsForSession } from '../background-process-holds.js';
import { checkFrameworkHealth, checkSkillStaleness } from '../notifications.js';
import { captureTurnStartState, clearNeedsActionIfSet, flagIfParked } from '../parked-ticket.js';
import { appendTranscriptEvent } from '../transcript.js';
import { getEnginePort } from '../packaged-mode.js';
import { getGlobalDataDir } from '../global-settings.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest, SendInputOptions } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import {
  EFFORT_LEVELS,
  type EffortLevel,
  cleanChildEnv,
  appendSessionOutput,
  appendErrorToSession,
  flushSessionOutput,
  buildInitialPrompt,
  terminalizeResumedExit,
  surfaceResumeFailure,
  isChatEditGated,
  isScratchSession,
  prependEditGateNote,
  resolveModel,
  buildTokenMetadataUpdate,
  buildPhaseHandoffNote,
  resolveAttachmentAbsPaths,
  stopOutcomeText,
  type CliTask,
} from './shared.js';
import {
  attachAnthropicStdoutProcessing,
  grokProgressLabel,
} from './anthropic-stream.js';
import { grokMcpConfigToml, isEhOwnedGrokMcpToml } from './grok-mcp-config.js';

export { grokMcpConfigToml } from './grok-mcp-config.js';

// FLUX-1723: names observed on the live `system/init` tool list, NOT Grok's README (the two
// disagree). Unknown names fall through to activityFor's generic label.
const GROK_TOOL_ACTIVITY_MAP: Record<string, string> = {
  read_file: 'Reading',
  write: 'Editing',
  search_replace: 'Editing',
  run_terminal_command: 'Running command',
  list_dir: 'Reading',
  grep: 'Searching',
  web_search: 'Researching',
  web_fetch: 'Researching',
  spawn_subagent: 'Delegating',
  search_tool: 'Working',
  use_tool: 'Working',
  ask_user_question: 'Asking',
  image_gen: 'Working',
  image_edit: 'Working',
};

const EH_TOOL_HINT = [
  'Event Horizon MCP tools are hidden behind search_tool / use_tool.',
  'Call search_tool with the exact name first, then use_tool.',
  'Names you will need: get_ticket, list_tickets, get_board_config, create_ticket, update_ticket,',
  'change_status, add_note, finish_ticket, branch, archive, read_skill, ask_user_question.',
].join(' ');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function grokHomeDir(): string {
  return path.join(getGlobalDataDir(), 'grok-home');
}

export function grokAuthSourcePath(): string {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

export function grokUserBinaryPath(): string {
  return process.platform === 'win32'
    ? path.join(os.homedir(), '.grok', 'bin', 'grok.exe')
    : path.join(os.homedir(), '.grok', 'bin', 'grok');
}

/** FLUX-1722 decision 3: EH owns GROK_HOME. Project-scope `.grok/config.toml` silently wins.
 *  The installer now writes the same placeholder-header entry there so a user-run Grok in the
 *  repo gets EH MCP; that owned shape is not a conflict. Warn only for a *foreign* override. */
export function projectGrokConfigConflict(executionRoot: string): string | null {
  const projectFile = path.join(executionRoot, '.grok', 'config.toml');
  try {
    const text = fs.readFileSync(projectFile, 'utf8');
    if (!/\[mcp_servers\.event-horizon\]/.test(text)) return null;
    if (isEhOwnedGrokMcpToml(text)) return null;
    return `Project ${projectFile} defines mcp_servers.event-horizon and will override EH's GROK_HOME entry. Remove it with: grok mcp remove event-horizon --scope project`;
  } catch {
    return null;
  }
}

export function seedGrokAuth(home: string, sourcePath = grokAuthSourcePath(), now = Date.now()): 'copied' | 'refreshed' | 'kept' | 'missing' {
  const dest = path.join(home, 'auth.json');
  if (!fs.existsSync(sourcePath)) return 'missing';
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(sourcePath, dest);
    return 'copied';
  }
  const srcMtime = fs.statSync(sourcePath).mtimeMs;
  const destMtime = fs.statSync(dest).mtimeMs;
  if (srcMtime > destMtime && srcMtime <= now + 1000) {
    fs.copyFileSync(sourcePath, dest);
    return 'refreshed';
  }
  return 'kept';
}

export function ensureGrokHome(executionRoot: string): { home: string; warning: string | null } {
  const home = grokHomeDir();
  fs.mkdirSync(home, { recursive: true });
  seedGrokAuth(home);
  const configPath = path.join(home, 'config.toml');
  const toml = grokMcpConfigToml(getEnginePort());
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  if (existing !== toml) fs.writeFileSync(configPath, toml, 'utf8');
  return { home, warning: projectGrokConfigConflict(executionRoot) };
}

let cachedGrokBinary: string | null = null;

export function resolveGrokBinary(): string {
  if (cachedGrokBinary) return cachedGrokBinary;
  const pinned = grokUserBinaryPath();
  if (fs.existsSync(pinned)) {
    cachedGrokBinary = pinned;
    return pinned;
  }
  cachedGrokBinary = 'grok';
  return 'grok';
}

export function grokSessionUuid(session: CliSessionRecord): string {
  const candidate = session.resumeSessionId || session.id;
  if (candidate && UUID_RE.test(candidate)) return candidate;
  return randomUUID();
}

export interface GrokArgOpts {
  isResume: boolean;
  sessionId: string;
  executionRoot: string;
  promptFile: string;
  model?: string | undefined;
  effort?: string | undefined;
}

/** FLUX-1722 decision 6: spawn emits `-s <uuid>`, resume emits `-r <uuid>` with `-s` absent.
 *  Sending both is a hard error on the live CLI. `--trust` is undocumented as of grok 1.0.13. */
export function buildGrokArgs(opts: GrokArgOpts): string[] {
  const args = [
    '--output-format', 'streaming-messages-json',
    '--include-partial-messages',
    '--trust',
    '--always-approve',
    '--cwd', opts.executionRoot,
    '--prompt-file', opts.promptFile,
  ];
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--reasoning-effort', opts.effort);
  if (opts.isResume) args.push('-r', opts.sessionId);
  else args.push('-s', opts.sessionId);
  return args;
}

function resolveGrokEffort(session: CliSessionRecord, effortOverrideRaw: string, task: CliTask): string | undefined {
  const { supported, flag } = CLI_CAPABILITIES.grok.effort;
  if (!supported || !flag) return undefined;
  const effective = session.effortOverride || effortOverrideRaw || task.effortLevel || getConfig().effortLevel || '';
  return EFFORT_LEVELS.includes(effective as EffortLevel) ? effective : undefined;
}

export function writePromptFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-grok-prompt-'));
  const file = path.join(dir, 'prompt.txt');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function cleanupPromptFile(file: string | undefined): void {
  if (!file) return;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(file)); } catch { /* ignore */ }
}

/**
 * Bind the session's terminalizer as soon as the child exists — before any await.
 * Grok can finish (or the Windows launcher can exit) during `updateTaskWithHistory`;
 * if `exit` is registered after that await, Node has already emitted it, the in-memory
 * session stays `running`, the portal spinner never clears, and Stop 409s.
 * `close` is a second shot for the case where stdio drains after the pid is gone.
 */
export interface GrokLifetimeProc {
  on(event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export function wireGrokChildLifetime(
  proc: GrokLifetimeProc,
  onEnd: (code: number | null, signal: NodeJS.Signals | null) => void,
): void {
  let done = false;
  const fire = (code: number | null, signal: NodeJS.Signals | null) => {
    if (done) return;
    done = true;
    onEnd(code, signal);
  };
  proc.on('exit', fire);
  proc.on('close', fire);
  if (proc.exitCode !== null || proc.signalCode !== null) {
    queueMicrotask(() => fire(proc.exitCode, proc.signalCode));
  }
}

/** Parse `ps -ax -o pid=,args=` output for grok workers bound to `sessionId`.
 *  Leader processes (no `-s`/`-r`) are excluded. */
export function grokWorkerPidsFromPs(psOutput: string, sessionId: string): number[] {
  if (!sessionId) return [];
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[2]!;
    if (!args.includes(sessionId)) continue;
    if (!/(?:^|[\\/\s])grok(?:\.exe)?(?:\s|$)/i.test(args)) continue;
    if (!/(?:^|\s)-(?:s|r)\s/.test(args)) continue;
    pids.push(Number(m[1]));
  }
  return pids;
}

/** Kill grok workers whose command line carries this session uuid. Never the leader
 *  (`grok` / `grok.exe` with no `-s`/`-r`). Used by Stop when `session.proc` is already dead. */
export function killGrokWorkersForSession(sessionId: string): void {
  if (!sessionId) return;
  const safe = sessionId.replace(/'/g, '');
  if (process.platform === 'win32') {
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = 'grok.exe'" | Where-Object { $_.CommandLine -like '*${safe}*' -and ($_.CommandLine -like '*-s *' -or $_.CommandLine -like '*-r *') } | ForEach-Object { taskkill /F /PID $_.ProcessId | Out-Null }`,
      ],
      { windowsHide: true, timeout: 8000 },
      () => {},
    );
    return;
  }
  execFile('ps', ['-ax', '-o', 'pid=,args='], { timeout: 8000 }, (err, stdout) => {
    if (err) return;
    for (const pid of grokWorkerPidsFromPs(String(stdout || ''), sessionId)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
}

export function spawnGrok(id: string, args: string[], cwdRoot: string, conversationId?: string, sessionId?: string, workspaceRoot?: string) {
  const { home, warning } = ensureGrokHome(cwdRoot);
  if (warning) log.info(`[${id}] ${warning}`);
  const exePath = resolveGrokBinary();
  const env = cleanChildEnv('grok', conversationId, sessionId);
  env.GROK_HOME = home;
  if (workspaceRoot) env.EH_WORKSPACE = workspaceRoot;
  log.info(`[${id}] Spawning: ${exePath} GROK_HOME=${home} [${args.length} args]`);
  return spawn(exePath, args, {
    cwd: cwdRoot,
    env,
    stdio: 'pipe',
    windowsHide: true,
  });
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  return attachAnthropicStdoutProcessing(proc, session, taskId, {
    toolActivityMap: GROK_TOOL_ACTIVITY_MAP,
    progressLabel: grokProgressLabel,
  });
}

function withEhToolHint(prompt: string): string {
  return `${EH_TOOL_HINT}\n\n${prompt}`;
}

async function finalizeGrokSpawnExit(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  id: string,
  label: string,
  workspaceRoot: string,
  promptFile: string,
  commitPending: () => void,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  cleanupPromptFile(promptFile);
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
    const fullMessage = stderrHint ? `${outcome}\n${stderrHint}` : outcome;
    appendErrorToSession(session, fullMessage);
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
  // updateAgentSession does not broadcast; without this the portal keeps the last
  // `running` snapshot, Stop 409s, and the spinner never clears.
  broadcastEvent('taskUpdated', { id });
}

export async function startCliSession(session: CliSessionRecord, task: CliTask, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const label = session.label;
  const id = session.taskId;
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot, resolveExecutionRootReclaimOpts(workspaceRoot));
  session.executionRoot = executionRoot;
  assertIsolatedSpawnRoot('Grok', id, task, executionRoot, workspaceRoot);

  const binary = resolveGrokBinary();
  if (binary === 'grok' && !fs.existsSync(grokUserBinaryPath())) {
    throw new Error('Grok Build CLI not found. Install from https://docs.x.ai and ensure ~/.grok/bin/grok.exe exists.');
  }

  log.info(`[${id}] Starting Grok CLI session in ${workspaceRoot}`);

  const groomingStatuses = [getConfig().requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = session.model || resolveModel(session.taskKey ?? 'implementation.lead', 'grok', getConfig());
  if (selectedModel) session.model = selectedModel;

  const taskPhase = session.phase ?? (groomingStatuses.includes(task.status) ? 'grooming'
    : (task.status === 'In Progress' || task.status === 'Todo') ? 'implementation'
    : task.status === (getConfig()?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined);

  const editsGated = isChatEditGated(session, task) || isScratchSession(task);
  const initialPrompt = withEhToolHint(buildInitialPrompt(task, appendPrompt, {
    phase: taskPhase,
    framework: 'grok',
    editsGated,
    batchTicketIds: session.batchTicketIds,
    batchExcluded: session.batchExcluded,
    planFirst: session.planFirst,
  }));

  const sessionUuid = grokSessionUuid(session);
  session.resumeSessionId = sessionUuid;
  const promptFile = writePromptFile(initialPrompt);
  const grokArgs = buildGrokArgs({
    isResume: false,
    sessionId: sessionUuid,
    executionRoot,
    promptFile,
    model: selectedModel,
    effort: resolveGrokEffort(session, effortOverrideRaw, task),
  });

  log.info(`[${id}] Args: [${grokArgs.join(', ')}] (prompt ${initialPrompt.length} chars, via --prompt-file)`);

  const proc = spawnGrok(id, grokArgs, executionRoot, id, session.id, workspaceRoot);
  proc.stdin.on('error', () => {});
  proc.stdin.end();

  session.proc = proc;
  session.pid = proc.pid;
  session.status = 'running';
  session.command = binary;
  session.args = grokArgs;
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label, {
    groupId: session.groupId,
    role: session.role,
    pattern: session.groupType,
  });
  session.sessionHistoryEntry = sessionEntry;

  wireGrokChildLifetime(proc, (code, signal) => {
    void finalizeGrokSpawnExit(proc, session, id, label, workspaceRoot, promptFile, commitPending, code, signal);
  });

  proc.on('error', async (error) => {
    cleanupPromptFile(promptFile);
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }
    session.status = 'failed';
    session.endedAt = new Date().toISOString();
    commitPending();
    appendErrorToSession(session, `Failed to start agent: ${error.message}`);
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
    console.error(`[${id}] Failed to spawn grok:`, error.message);
    broadcastEvent('taskUpdated', { id });
  });

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
}

export async function sendCliSessionInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions) {
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
  captureTurnStartState(session, id);
  void clearNeedsActionIfSet(id);

  appendTranscriptEvent(id, { type: 'user', text: message, attachments: opts?.attachments ?? [], timestamp: inputAt });

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  const handoffTask = getWorkspace().tasks[id] as CliTask;
  const attachmentNote = resolveAttachmentAbsPaths(opts?.attachments)
    .map((p) => `Attached image (read with read_file): ${p}`)
    .join('\n');
  const gatedMessage = prependEditGateNote(session, handoffTask, 'grok', attachmentNote ? `${safeMessage}\n\n${attachmentNote}` : safeMessage);
  const handoffNote = buildPhaseHandoffNote(session, handoffTask, 'grok');
  if (handoffNote) session.handoffPhaseAnnounced = true;
  const promptForCli = withEhToolHint(handoffNote ? `${handoffNote}\n\n---\n\n${gatedMessage}` : gatedMessage);

  const sessionUuid = grokSessionUuid(session);
  session.resumeSessionId = sessionUuid;
  const promptFile = writePromptFile(promptForCli);
  const resumeArgs = buildGrokArgs({
    isResume: true,
    sessionId: sessionUuid,
    executionRoot,
    promptFile,
    model: session.model,
    effort: resolveGrokEffort(session, '', handoffTask),
  });

  log.info(`[${id}] Reply spawn, resume=${sessionUuid}`);
  const replyProc = spawnGrok(id, resumeArgs, executionRoot, id, session.id, workspaceRoot);
  replyProc.stdin.on('error', () => {});
  replyProc.stdin.end();

  session.proc = replyProc;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  const finalizeReply = async (code: number | null, signal: NodeJS.Signals | null) => {
    cleanupPromptFile(promptFile);
    killProcessTree(replyProc, undefined, { label: id, exemptPids: getExemptPidsForSession(session.id) });
    commitReplyPending();
    flushSessionOutput(session, true, 'text');
    session.currentActivity = undefined;
    delete session.pid;
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
  };

  wireGrokChildLifetime(replyProc, (code, signal) => { void finalizeReply(code, signal); });

  replyProc.on('error', async (error) => {
    cleanupPromptFile(promptFile);
    terminalizeResumedExit(session);
    commitReplyPending();
    if (!session.requestedStop) {
      appendErrorToSession(session, `Failed to resume agent: ${error.message}`);
    }
    flushSessionOutput(session, true, 'text');
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    console.error(`[${id}] Failed to spawn grok for reply:`, error.message);
    broadcastEvent('taskUpdated', { id });
  });
}

export class GrokAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'grok',
    displayName: 'Grok Build',
    configSchema: {},
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Grok Build';
  }

  async start(session: CliSessionRecord, task: unknown, appendPrompt: string, effortOverride: string, workspaceRoot: string): Promise<void> {
    return startCliSession(session, task as CliTask, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string, opts?: SendInputOptions): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot, opts);
  }

  stop(session: CliSessionRecord): void {
    clearHoldsForSession(session.id);
    try { session.proc?.stdin?.destroy(); } catch { /* already closed */ }
    try { session.proc?.stdout?.destroy(); } catch { /* already closed */ }
    try { session.proc?.stderr?.destroy(); } catch { /* already closed */ }
    killProcessTree(session.proc);
    // The shared leader (`grok.exe` with no -s/-r) is left alone. Workers carry the session uuid.
    killGrokWorkersForSession(session.resumeSessionId || session.id);
    const proc = session.proc;
    const alreadyDead = !proc || proc.exitCode !== null || proc.signalCode !== null;
    if (alreadyDead && (session.status === 'running' || session.status === 'pending')) {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
      session.currentActivity = undefined;
      broadcastEvent('taskUpdated', { id: session.taskId });
    }
  }
}

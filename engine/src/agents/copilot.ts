import { spawn, execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentMessageEntry, buildAgentSessionEntry, appendSessionProgress, closeAgentSession, type AgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, tasksCache, estimateCostUSD } from '../task-store.js';
import { cliSessionsById, cliSessionIdByTaskId, notifyGroupSessionTerminal, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { checkFrameworkHealth, checkSkillStaleness } from '../notifications.js';
import { buildMemberScopeArgs } from '../group.js';
import { buildGroupDocsScopeArg } from '../group-member-worktree.js';
import { getModulePromptFragments } from '../modules.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from './types.js';

function checkBinaryInstalled(binaryName: string): void {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(checker, [binaryName], { stdio: 'ignore', env: cleanChildEnv(), timeout: 10_000, windowsHide: true });
  } catch {
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`);
  }
}

function cleanChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  }
  env.EVENT_HORIZON_FRAMEWORK = 'copilot';
  return env;
}

// Effort levels accepted by the --effort CLI flag, in ascending order.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export const PROVIDER_CAPABILITIES = {
  copilot: { supportsEffort: true, effortFlag: '--effort' },
};

export function cliLabelForFramework() {
  return 'Copilot CLI';
}

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

export function appendSessionOutput(session: CliSessionRecord, chunk: Buffer | string, source: 'stdout' | 'stderr', isAssistantText = false) {
  const text = String(chunk ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return;

  // Filter out noise from Windows ConPTY/AttachConsole failures
  if (source === 'stderr' && (
    text.includes('AttachConsole failed') || 
    text.includes('conpty_console_list_agent.js') ||
    text.includes('Shared memory agent failed')
  )) {
    return;
  }

  const prefix = source === 'stderr' ? '[stderr] ' : '';
  session.liveOutputBuffer += `${prefix}${text}`;
  if (isAssistantText) {
    session.outputBuffer += text;
    session.cumulativeOutput += text;
  }
  session.lastOutputAt = new Date().toISOString();
}

export function enqueueSessionWrite(session: CliSessionRecord, writer: () => Promise<void>) {
  session.writeQueue = session.writeQueue
    .then(writer)
    .catch((error) => {
      console.error(`CLI session ${session.id} failed to append task history:`, error);
    });
}

export function flushSessionOutput(session: CliSessionRecord, force = false) {
  if (!session.outputBuffer.trim()) return;

  const flushNow = async () => {
    const bufferedText = session.outputBuffer.trim();
    session.outputBuffer = '';
    if (!bufferedText) return;

    const timestamp = new Date().toISOString();
    const maxLength = 2000;
    const clippedText = bufferedText.length > maxLength
      ? `${bufferedText.slice(0, maxLength)}...`
      : bufferedText;

    // Broadcast progress immediately via SSE (UI gets live updates)
    broadcastEvent('progress', {
      taskId: session.taskId,
      sessionId: session.sessionHistoryEntry?.sessionId,
      timestamp,
      message: clippedText,
    });

    // Accumulate progress in memory only — do NOT write to the ticket file
    // during an active session. Writing continuously causes the agent to see
    // the file changing and back off from editing it. The full progress is
    // flushed to the ticket file once when the session ends.
    if (session.sessionHistoryEntry) {
      session.sessionHistoryEntry.progress.push({
        timestamp,
        message: clippedText,
        type: 'text',
      });
    }
  };

  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = undefined;
  }

  if (force) {
    enqueueSessionWrite(session, flushNow);
    return;
  }

  session.flushTimer = setTimeout(() => {
    session.flushTimer = undefined;
    enqueueSessionWrite(session, flushNow);
  }, 1000);
}

export function buildInitialPrompt(task: any, appendPrompt: string, opts?: { phase?: string }): string {
  const readyStatus = (configCache as any)?.readyForMergeStatus || 'Ready';
  const taskStatus = (task as any).status || 'Unknown';
  const mcpNote = 'CRITICAL: Use the "event-horizon" MCP tools (change_status, update_ticket, add_comment, log_progress) for ALL ticket updates. Do NOT edit .flux/ files directly — direct edits corrupt session tracking.';
  const actionInstruction = (() => {
    if (taskStatus === 'Grooming' || taskStatus === 'Require Input') {
      return `The ticket is in ${taskStatus}. Your job is to GROOM this ticket:\n` +
        `1. Use update_ticket to fill metadata (priority, effort, tags) and rewrite the body with a Problem/Motivation section and Implementation Plan.\n` +
        `2. If questions are unresolved, use change_status to move to "Require Input" with a comment containing your question.\n` +
        `3. When grooming is complete, use change_status to move to "Todo".\n` +
        mcpNote;
    }
    if (taskStatus === 'In Progress') {
      return `The ticket is currently In Progress. If the implementation is already complete, use change_status to move it to "${readyStatus}" with a completion summary comment. If work remains, complete it then move to "${readyStatus}". Do not exit without updating the ticket status.\n${mcpNote}`;
    }
    if (taskStatus === 'Todo') {
      return `The ticket is in Todo. Begin implementation: use change_status to move to "In Progress", complete the work, then use change_status to move to "${readyStatus}" when done.\n${mcpNote}`;
    }
    if (taskStatus === readyStatus) {
      return `The ticket is in ${readyStatus} awaiting user review. Do not move it further — wait for the user to say "finish ${task.id}".`;
    }
    return 'Respond with implementation progress updates and blockers. Keep updates concise.';
  })();

  const moduleFragments = getModulePromptFragments(opts?.phase, Array.isArray(task.tags) ? task.tags : undefined);

  const lines = [
    `You are working on ticket ${task.id}.`,
    `Title: ${task.title || 'Untitled ticket'}`,
    `Current status: ${taskStatus}`,
    '',
    'Ticket description:',
    (task.body || '').trim() || '(No description)',
    '',
    'Latest activity:',
    ...(Array.isArray(task.history) ? task.history.filter((e: any) => e?.type !== 'agent_message').slice(-3).map((entry: any) => {
      if (entry?.type === 'status_change') {
        return `- [${entry.date || ''}] ${entry.user || 'Unknown'} moved ${entry.from || '?'} -> ${entry.to || '?'}`;
      }
      return `- [${entry?.date || ''}] ${entry?.user || 'Unknown'}: ${entry?.comment || entry?.type || 'activity'}`;
    }) : ['- (No history)']),
    '',
    ...(moduleFragments ? [moduleFragments, ''] : []),
    actionInstruction,
    ...(appendPrompt ? ['', appendPrompt] : []),
  ];
  return lines.join('\n').replace(/\0/g, '');
}

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  const commitPendingAssistantText = () => {
    if (session.pendingAssistantText) {
      appendSessionOutput(session, session.pendingAssistantText, 'stdout', true);
      flushSessionOutput(session);
      session.pendingAssistantText = '';
    }
  };

  let lineBuf = '';
  let stdoutChunkCount = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutChunkCount++;
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);

        // Capture the session ID from the parentId chain for resume support.
        // The session UUID appears in `assistant.turn_start` parentId or the initial user.message id.
        if (evt.type === 'user.message' && evt.id) {
          // The Copilot CLI session ID is embedded in the output — capture from
          // the parentId of the first user.message or from session metadata.
          if (!session.claudeSessionId && evt.parentId) {
            session.claudeSessionId = evt.parentId;
          }
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
          const newActivity = TOOL_ACTIVITY_MAP[toolName] ?? 'Working';
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
            if ((toolName === 'edit' || toolName === 'create') && params.path) {
              progressMsg = `Editing ${path.basename(params.path)}`;
            } else if (toolName === 'view' && params.path) {
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
            if (session.sessionHistoryEntry) {
              session.sessionHistoryEntry.progress.push({
                timestamp: new Date().toISOString(),
                message: `Tool failed: ${evt.data.toolName || 'unknown'}`,
                type: 'info',
                data: { error: evt.data.error || evt.data.content },
              });
            }
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
          if (evt.data?.sessionId || evt.data?.id) {
            session.claudeSessionId = evt.data.sessionId || evt.data.id;
          }
        }
        // Skip ephemeral session setup events (session.mcp_*, session.tools_updated, etc.)
      } catch {
        // Non-JSON output — treat as plain text activity
        appendSessionOutput(session, trimmed + '\n', 'stdout', true);
        flushSessionOutput(session);
        if (!session.currentActivity) {
          session.currentActivity = 'Working';
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
        }
      }
    }
  });

  return commitPendingAssistantText;
}

/** Resolve the copilot binary path across platforms. */
function resolveCopilotBinary(id: string): { nodePath: string | null; entryPoint: string | null; exePath: string } {
  const isWin = process.platform === 'win32';

  // 1. Try to find the compiled binary (copilot.exe on Windows, copilot on Unix).
  // The compiled binary handles MCP server initialization (.mcp.json reading and
  // server spawning) as part of its startup. The node + JS entry point path skips
  // this, causing MCP tools to be unavailable in non-interactive mode.
  try {
    const checker = isWin ? 'where' : 'which';
    const result = execSync(`${checker} copilot`, { encoding: 'utf8', env: cleanChildEnv(), timeout: 10_000, windowsHide: true }).trim();
    const matches = result.split(/\r?\n/).filter(Boolean);

    if (isWin) {
      const exeMatch = matches.find(m => m.endsWith('.exe'));
      if (exeMatch && fs.existsSync(exeMatch)) {
        console.log(`[${id}] Found copilot.exe: ${exeMatch}`);
        return { nodePath: null, entryPoint: null, exePath: exeMatch };
      }
    } else {
      const firstMatch = matches[0];
      if (firstMatch && fs.existsSync(firstMatch)) {
        console.log(`[${id}] Found copilot on PATH: ${firstMatch}`);
        return { nodePath: null, entryPoint: null, exePath: firstMatch };
      }
    }
  } catch {}

  // 2. Check VS Code globalStorage for native binary
  const vsCodeCandidates = getVSCodeGlobalStoragePaths();
  for (const candidate of vsCodeCandidates) {
    if (fs.existsSync(candidate)) {
      console.log(`[${id}] Found copilot via VS Code globalStorage: ${candidate}`);
      return { nodePath: null, entryPoint: null, exePath: candidate };
    }
  }

  // 3. Windows fallback: spawn node + JS entry point (MCP tools may not load,
  // but at least basic functionality works when no .exe is available).
  if (isWin) {
    let systemNodePath: string | null = null;
    try {
      const whereResult = execSync('where node', { encoding: 'utf8', env: cleanChildEnv(), timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/);
      const selfExe = process.execPath.toLowerCase();
      systemNodePath = whereResult.find(p => p.toLowerCase() !== selfExe && fs.existsSync(p)) || null;
      if (!systemNodePath) systemNodePath = whereResult[0] || null;
    } catch {}

    let entryPoint: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', env: cleanChildEnv(), timeout: 10_000, windowsHide: true }).trim();
      const candidate = path.join(npmPrefix, 'node_modules', '@github', 'copilot', 'npm-loader.js');
      if (fs.existsSync(candidate)) {
        entryPoint = candidate;
        console.log(`[${id}] Found copilot JS entry (fallback): ${entryPoint}`);
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve copilot via npm prefix:`, err);
    }

    if (!entryPoint) {
      try {
        const result = execSync('where copilot', { encoding: 'utf8', env: cleanChildEnv(), timeout: 10_000, windowsHide: true }).trim();
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
      console.log(`[${id}] Will spawn (node fallback): ${systemNodePath} ${entryPoint}`);
      return { nodePath: systemNodePath, entryPoint, exePath: systemNodePath };
    }
  }

  console.log(`[${id}] copilot not found, falling back to bare name`);
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
function spawnCopilot(id: string, args: string[], workspaceRoot: string) {
  const { nodePath, entryPoint, exePath } = resolveCopilotBinary(id);

  if (nodePath && entryPoint) {
    // Spawn node directly with JS entry point (avoids .cmd path-with-spaces issues on Windows)
    console.log(`[${id}] Spawning: node ${path.basename(entryPoint)} [${args.length} args]`);
    return spawn(nodePath, [entryPoint, ...args], {
      cwd: workspaceRoot,
      env: cleanChildEnv(),
      stdio: 'pipe',
      windowsHide: true,
    });
  }

  console.log(`[${id}] Spawning: ${exePath} [${args.length} args]`);
  return spawn(exePath, args, {
    cwd: workspaceRoot,
    env: cleanChildEnv(),
    stdio: 'pipe',
    windowsHide: true,
  });
}

export async function startCliSession(session: CliSessionRecord, task: any, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const label = session.label;
  const id = session.taskId;

  console.log(`[${id}] Starting Copilot CLI session in ${workspaceRoot}`);

  const copilotIntegration = (configCache as any).integrations?.copilotCli;
  const groomingStatuses = [(configCache as any).requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = copilotIntegration
    ? (groomingStatuses.includes(task.status) ? copilotIntegration.groomingModel : copilotIntegration.implementationModel)
    : null;

  const taskPhase = groomingStatuses.includes(task.status) ? 'grooming'
    : (task.status === 'In Progress' || task.status === 'Todo') ? 'implementation'
    : task.status === ((configCache as any)?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined;

  const initialPrompt = buildInitialPrompt(task, appendPrompt, { phase: taskPhase });

  const copilotArgs = [
    ...(selectedModel ? ['--model', selectedModel] : []),
    '-p', initialPrompt,
    '--output-format', 'json',
    ...(session.skipPermissions ? ['--yolo'] : ['--allow-all-tools']),
    // Multi-repo group: put every checked-out member repo in scope (no-op single-repo).
    ...buildMemberScopeArgs(),
    // Member worktree: add local .flux-group/ so the agent reads shared group docs (FLUX-422).
    ...buildGroupDocsScopeArg(workspaceRoot),
  ];

  const caps = PROVIDER_CAPABILITIES['copilot'];
  const globalEffort = (configCache as any).effortLevel as string | undefined;
  const taskEffort = (task as any).effortLevel as string | undefined;
  const effectiveEffort = (effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (caps.supportsEffort && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    copilotArgs.push(caps.effortFlag, effectiveEffort);
  }

  console.log(`[${id}] Args: [${copilotArgs.map((a, i) => i === copilotArgs.indexOf(initialPrompt) ? `<prompt ${initialPrompt.length} chars>` : a).join(', ')}]`);

  let proc = spawnCopilot(id, copilotArgs, workspaceRoot);

  session.proc = proc;
  session.pid = proc.pid;
  session.status = 'running';
  session.command = 'copilot';
  session.args = copilotArgs;

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
    flushSessionOutput(session, true);
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
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
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
    if (session.progressHeartbeat) {
      clearInterval(session.progressHeartbeat);
      session.progressHeartbeat = undefined;
    }

    commitPending();
    flushSessionOutput(session, true);
    await session.writeQueue;
    session.endedAt = new Date().toISOString();

    let finalStatus: 'completed' | 'failed' | 'cancelled';
    if (session.requestedStop) {
      session.status = 'cancelled';
      finalStatus = 'cancelled';
    } else if (code === 0) {
      session.status = 'completed';
      finalStatus = 'completed';
    } else {
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

    // Close the session entry with outcome and flush accumulated progress
    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      const accumulatedProgress = session.sessionHistoryEntry.progress || [];
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = finalStatus;
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
        sessionEntry.progress = accumulatedProgress;
      });

      const textEntries = accumulatedProgress.filter((p: any) => p.type === 'text' && p.message?.trim());
      const lastText = textEntries.length > 0 ? textEntries[textEntries.length - 1].message : '';
      if (lastText && finalStatus === 'completed') {
        const maxCommentLen = 3000;
        const commentBody = lastText.length > maxCommentLen ? lastText.slice(0, maxCommentLen) + '...' : lastText;
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [buildCommentEntry(label, commentBody, session.endedAt)],
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
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }

    if (finalStatus === 'completed') {
      checkFrameworkHealth(session.framework).catch(() => {});
      checkSkillStaleness(session.framework).catch(() => {});
    }

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
    return startCliSession(session, task, appendPrompt, effortOverride, workspaceRoot);
  }

  async sendInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string): Promise<void> {
    return sendCliSessionInput(session, message, user, workspaceRoot);
  }

  stop(session: CliSessionRecord): void {
    session.proc?.kill('SIGTERM');
  }
}

export async function sendCliSessionInput(session: CliSessionRecord, message: string, user: string, workspaceRoot: string) {
  const id = session.taskId;

  const inputAt = new Date().toISOString();
  session.lastInputAt = inputAt;
  session.status = 'running';

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  const resumeArgs = session.claudeSessionId
    ? ['-p', safeMessage, '--resume', session.claudeSessionId, '--output-format', 'json', '--yolo']
    : ['-p', safeMessage, '--output-format', 'json', '--yolo'];

  console.log(`[${id}] Reply spawn, resume=${session.claudeSessionId || 'none'}`);
  const replyProc = spawnCopilot(id, resumeArgs, workspaceRoot);

  session.proc = replyProc;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  replyProc.on('error', async (error) => {
    session.status = 'waiting-input';
    commitReplyPending();
    flushSessionOutput(session, true);
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    console.error(`[${id}] Failed to spawn copilot for reply:`, error.message);
  });

  replyProc.on('exit', async () => {
    commitReplyPending();
    flushSessionOutput(session, true);
    session.status = 'waiting-input';
  });
}

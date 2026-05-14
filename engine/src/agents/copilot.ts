import { spawn, execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentMessageEntry, buildAgentSessionEntry, appendSessionProgress, closeAgentSession, type AgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, tasksCache, estimateCostUSD } from '../task-store.js';
import { cliSessionsById, cliSessionIdByTaskId } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from './types.js';

function checkBinaryInstalled(binaryName: string): void {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(checker, [binaryName], { stdio: 'ignore' });
  } catch {
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`);
  }
}

// Effort levels accepted by the --effort CLI flag, in ascending order.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export const PROVIDER_CAPABILITIES = {
  claude: { supportsEffort: true, effortFlag: '--effort' },
  copilot: { supportsEffort: false, effortFlag: '' },
};

export function cliLabelForFramework(framework: 'claude' | 'copilot' | 'gemini') {
  return 'Copilot CLI';
}

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

export function appendSessionOutput(session: CliSessionRecord, chunk: Buffer | string, source: 'stdout' | 'stderr', isAssistantText = false) {
  const text = String(chunk ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) return;

  const prefix = source === 'stderr' ? '[stderr] ' : '';
  session.liveOutputBuffer += `${prefix}${text}`;
  if (isAssistantText) {
    session.outputBuffer += text;
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

    // Broadcast progress immediately via SSE
    broadcastEvent('progress', {
      taskId: session.taskId,
      sessionId: session.sessionHistoryEntry?.sessionId,
      timestamp,
      message: clippedText,
    });

    // If we have a session history entry, append progress to it
    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      await updateAgentSession(session.taskId, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.progress.push({ timestamp, message: clippedText });
      });
    } else {
      // Fallback to old behavior if session entry not found
      await updateTaskWithHistory(session.taskId, {
        updatedBy: 'Agent',
        entries: [
          buildAgentMessageEntry(clippedText, session.label, timestamp),
        ],
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

export function buildInitialPrompt(task: any, appendPrompt: string): string {
  const readyStatus = (configCache as any)?.readyForMergeStatus || 'Ready';
  const taskStatus = (task as any).status || 'Unknown';
  const actionInstruction = (() => {
    if (taskStatus === 'In Progress') {
      return `The ticket is currently In Progress. If the implementation is already complete, move it to "${readyStatus}" status and post a completion summary comment. If work remains, complete it then move to "${readyStatus}". Do not exit without updating the ticket status.`;
    }
    if (taskStatus === 'Todo') {
      return `The ticket is in Todo. Begin implementation: move it to In Progress, complete the work, then move it to "${readyStatus}" when done.`;
    }
    if (taskStatus === readyStatus) {
      return `The ticket is in ${readyStatus} awaiting user review. Do not move it further — wait for the user to say "finish ${task.id}".`;
    }
    return 'Respond with implementation progress updates and blockers. Keep updates concise.';
  })();

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
    actionInstruction,
    ...(appendPrompt ? ['', appendPrompt] : []),
  ];
  // Node's spawn rejects strings containing null bytes; strip them to prevent
  // ticket content (e.g. bad escape sequences) from breaking the spawn call.
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
  proc.stdout.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Regex heuristics for Copilot activity
      if (trimmed.startsWith('Running: ') || trimmed.startsWith('$ ')) {
        session.currentActivity = 'Running command';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      } else if (trimmed.includes('Reading ') || trimmed.startsWith('Looking at ')) {
        session.currentActivity = 'Reading';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      } else if (trimmed.includes('Writing ') || trimmed.startsWith('Editing ')) {
        session.currentActivity = 'Editing';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      } else if (trimmed.includes('Thinking')) {
        session.currentActivity = 'Thinking';
        broadcastEvent('activity', { taskId, activity: session.currentActivity });
      }

      appendSessionOutput(session, trimmed + '\n', 'stdout', true);
      flushSessionOutput(session);
    }
  });

  return commitPendingAssistantText;
}

export async function startCliSession(session: CliSessionRecord, task: any, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const framework = session.framework;
  const binaryName = 'gh';
  const label = session.label;
  const id = session.taskId;

  checkBinaryInstalled(binaryName);

  const claudeIntegration = (configCache as any).integrations?.copilotCli;
  const groomingStatuses = [(configCache as any).requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = null;

  const initialPrompt = buildInitialPrompt(task, appendPrompt);

  const copilotArgs = [
    'copilot',
    'suggest',
    initialPrompt
  ];

  const caps = PROVIDER_CAPABILITIES[framework] ?? PROVIDER_CAPABILITIES['copilot'];
  const globalEffort = (configCache as any).effortLevel as string | undefined;
  const taskEffort = (task as any).effortLevel as string | undefined;
  const effectiveEffort = (effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (caps.supportsEffort && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    copilotArgs.push(caps.effortFlag, effectiveEffort);
  }

  let proc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    // The npm bin wrapper is a bash script that execs claude.exe
    // Direct spawn of .exe preserves stdio streams for JSON output
    let exePath: string | null = null;
    try {
      const candidateExe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe');
      if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
        console.log(`[${id}] Found gh.exe at: ${exePath}`);
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve gh.exe path:`, err);
    }

    if (!exePath) {
      // Fallback to expecting 'gh' in PATH
      exePath = 'gh';
    }

    console.log(`[${id}] Windows spawn: ${exePath} with ${copilotArgs.length} args`);
    console.log(`[${id}] Prompt length: ${initialPrompt.length} chars`);
    proc = spawn(exePath, copilotArgs, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'pipe',
      shell: true,
    });
  } else {
    proc = spawn(binaryName, copilotArgs, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'pipe',
    });
  }
  session.proc = proc;
  session.pid = proc.pid;
  session.status = 'running';
  session.args = copilotArgs;

  const commitPending = attachStdoutProcessing(proc, session, id);

  proc.stderr.on('data', (chunk) => {
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
    flushSessionOutput(session, true);
    await session.writeQueue;

    const outcome = `${label} session failed to start: ${error.message}`;

    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = 'failed';
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
      });
    } else {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
      });
    }

    console.error(`[${id}] Failed to spawn ${binaryName}:`, error.message);
  });

  // Create agent_session history entry
  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label);
  session.sessionHistoryEntry = sessionEntry;

  await updateTaskWithHistory(id, {
    updatedBy: 'Agent',
    entries: [sessionEntry],
  });

  // Start progress heartbeat - log activity every 15 seconds if no updates
  session.progressHeartbeat = setInterval(() => {
    if (session.currentActivity && session.sessionHistoryEntry?.sessionId) {
      const now = new Date().toISOString();
      // Only log if we haven't logged this same activity recently
      if (session.lastProgressLog !== session.currentActivity) {
        session.lastProgressLog = session.currentActivity;
        enqueueSessionWrite(session, async () => {
          await updateAgentSession(id, session.sessionHistoryEntry!.sessionId, (sessionEntry) => {
            sessionEntry.progress.push({
              timestamp: now,
              message: session.currentActivity!,
            });
          });
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

    // Close the session entry with outcome
    if (session.sessionHistoryEntry && session.sessionHistoryEntry.sessionId) {
      await updateAgentSession(id, session.sessionHistoryEntry.sessionId, (sessionEntry) => {
        sessionEntry.status = finalStatus;
        sessionEntry.outcome = outcome;
        sessionEntry.endedAt = session.endedAt;
      });

      // Update token metadata separately
      if (tokenUpdate) {
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
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }
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
      effortLevels: [],
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
  const binaryName = session.command;

  checkBinaryInstalled(binaryName);

  const inputAt = new Date().toISOString();
  session.lastInputAt = inputAt;
  session.status = 'running';

  await updateTaskWithHistory(id, {
    updatedBy: user,
    entries: [buildCommentEntry(user, message, inputAt)],
  });

  const safeMessage = message.replace(/\0/g, '');
  const resumeArgs = [
    'copilot',
    'suggest',
    safeMessage
  ];

  let replyProc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    let exePath: string | null = null;
    try {
      const candidateExe = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe');
      if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve gh.exe path for reply:`, err);
    }

    if (!exePath) {
      exePath = 'gh';
    }

    console.log(`[${id}] Windows reply spawn: ${exePath}`);
    replyProc = spawn(exePath, resumeArgs, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'pipe',
    });
  } else {
    replyProc = spawn(binaryName, resumeArgs, {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'pipe',
    });
  }
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
    console.error(`[${id}] Failed to spawn ${binaryName} for reply:`, error.message);
  });

  replyProc.on('exit', async () => {
    commitReplyPending();
    flushSessionOutput(session, true);
    session.status = 'waiting-input';
  });
}

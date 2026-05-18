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
    execFileSync(checker, [binaryName], { stdio: 'ignore', env: cleanChildEnv(), timeout: 10_000 });
  } catch {
    throw new Error(`"${binaryName}" is not installed or not on PATH. Please install it before starting an agent session.`);
  }
}

function cleanChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  }
  env.NODE_OPTIONS = '';
  return env;
}

// Effort levels accepted by the --effort CLI flag, in ascending order.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export const PROVIDER_CAPABILITIES = {
  claude: { supportsEffort: true, effortFlag: '--effort' },
  copilot: { supportsEffort: false, effortFlag: '' },
};

export function cliLabelForFramework(framework: 'claude' | 'copilot') {
  return framework === 'claude' ? 'Claude Code' : 'Copilot CLI';
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
      session.sessionHistoryEntry.progress.push({ timestamp, message: clippedText });
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
    if (taskStatus === 'Grooming' || taskStatus === 'Require Input') {
      return `The ticket is in ${taskStatus}. Your job is to GROOM this ticket by editing the ticket file (.flux/${task.id}.md) directly:\n` +
        `1. Fill inferable metadata in the YAML frontmatter (priority, effort, tags).\n` +
        `2. Rewrite the markdown body with a clear Problem/Motivation section and an Implementation Plan.\n` +
        `3. If questions are unresolved, set status to "Require Input" and add a history comment with your question.\n` +
        `4. When grooming is complete, set status to "Todo" and add a status_change history entry.\n` +
        `CRITICAL: You MUST edit the .flux/${task.id}.md file to persist all changes. Do not just report findings in chat.`;
    }
    if (taskStatus === 'In Progress') {
      return `The ticket is currently In Progress. If the implementation is already complete, move it to "${readyStatus}" status and post a completion summary comment. If work remains, complete it then move to "${readyStatus}". Do not exit without updating the ticket status.\nCRITICAL: You MUST edit .flux/${task.id}.md to persist status changes and add history entries.`;
    }
    if (taskStatus === 'Todo') {
      return `The ticket is in Todo. Begin implementation: move it to In Progress, complete the work, then move it to "${readyStatus}" when done.\nCRITICAL: You MUST edit .flux/${task.id}.md to persist status changes and add history entries.`;
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
      try {
        const evt = JSON.parse(trimmed);
        if (!session.claudeSessionId && evt.session_id) {
          session.claudeSessionId = evt.session_id;
        }
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          const toolBlock = evt.message.content.find((b: any) => b.type === 'tool_use');
          if (toolBlock) {
            session.pendingAssistantText = '';
            const newActivity = TOOL_ACTIVITY_MAP[toolBlock.name] ?? 'Working';
            const activityChanged = session.currentActivity !== newActivity;
            session.currentActivity = newActivity;

            // Reset last progress log when activity changes
            if (activityChanged) {
              session.lastProgressLog = undefined;
            }

            // Log progress when activity changes or for significant tools
            if (activityChanged && session.sessionHistoryEntry?.sessionId) {
              const toolName = toolBlock.name;
              let progressMsg = session.currentActivity;

              // Add context for specific tools if available
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
                session.sessionHistoryEntry.progress.push({
                  timestamp: new Date().toISOString(),
                  message: progressMsg,
                  type: 'tool',
                  data: { toolName, parameters: toolBlock.input }
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
        } else {
          if (evt.type !== 'tool_use' && evt.type !== 'tool_result') {
            commitPendingAssistantText();
          } else {
            session.pendingAssistantText = '';
          }
          appendSessionOutput(session, trimmed, 'stdout', false);
        }
        if (evt.type === 'result') {
          session.currentActivity = undefined;
          broadcastEvent('activity', { taskId, activity: null });
        }
        if (evt.type === 'result' && evt.usage) {
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
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.claudeSessionId, inputTok, outputTok);
            session.costIsEstimated = true;
          }
        }
        if (evt.type === 'tool_use_blocked' || (evt.type === 'result' && evt.is_error && /permission|not allowed|denied/i.test(String(evt.error || '')))) {
          const reason = evt.tool_name
            ? `Blocked: ${evt.tool_name}${evt.error ? ` — ${evt.error}` : ''}`
            : String(evt.error || 'Permission denied');
          session.blockedReason = reason;
          session.status = 'waiting-input';
          flushSessionOutput(session, true);
          enqueueSessionWrite(session, async () => {
            await updateTaskWithHistory(taskId, {
              updatedBy: 'Agent',
              nextStatus: configCache.requireInputStatus || 'Require Input',
              entries: [buildActivityEntry(`${session.label} blocked: ${reason}`, 'Agent', new Date().toISOString())],
            });
          });
        }
      } catch {
        appendSessionOutput(session, trimmed, 'stdout', false);
      }
    }
  });

  return commitPendingAssistantText;
}

export async function startCliSession(session: CliSessionRecord, task: any, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const framework = session.framework;
  const binaryName = framework === 'claude' ? 'claude' : 'copilot';
  const label = session.label;
  const id = session.taskId;

  checkBinaryInstalled(binaryName);

  const claudeIntegration = (configCache as any).integrations?.claudeCode;
  const groomingStatuses = [(configCache as any).requireInputStatus || 'Require Input', 'Grooming'];
  const selectedModel = claudeIntegration && framework === 'claude'
    ? (groomingStatuses.includes(task.status) ? claudeIntegration.groomingModel : claudeIntegration.implementationModel)
    : null;

  const initialPrompt = buildInitialPrompt(task, appendPrompt);

  const claudeArgs = [
    ...(selectedModel ? ['--model', selectedModel] : []),
    '-p', initialPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    ...(session.skipPermissions ? ['--dangerously-skip-permissions'] : []),
  ];

  const caps = PROVIDER_CAPABILITIES[framework] ?? PROVIDER_CAPABILITIES['copilot'];
  const globalEffort = (configCache as any).effortLevel as string | undefined;
  const taskEffort = (task as any).effortLevel as string | undefined;
  const effectiveEffort = (effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (caps.supportsEffort && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    claudeArgs.push(caps.effortFlag, effectiveEffort);
  }

  let proc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    // The npm bin wrapper is a bash script that execs claude.exe
    // Direct spawn of .exe preserves stdio streams for JSON output
    let exePath: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 10_000 }).trim();
      const candidateExe = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
        console.log(`[${id}] Found claude.exe at: ${exePath}`);
      } else {
        console.log(`[${id}] claude.exe not found at ${candidateExe}`);
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve claude.exe path:`, err);
    }

    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }

    console.log(`[${id}] Windows spawn: ${exePath} with ${claudeArgs.length} args`);
    console.log(`[${id}] Prompt length: ${initialPrompt.length} chars`);
    proc = spawn(exePath, claudeArgs, {
      cwd: workspaceRoot,
      env: cleanChildEnv(),
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    proc = spawn(binaryName, claudeArgs, {
      cwd: workspaceRoot,
      env: cleanChildEnv(),
      stdio: 'pipe',
    });
  }
  session.proc = proc;
  session.pid = proc.pid;
  session.status = 'running';
  session.args = claudeArgs;

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

    console.error(`[${id}] Failed to spawn ${binaryName}:`, error.message);
  });

  // Create agent_session history entry
  const sessionEntry = buildAgentSessionEntry(session.id, session.startedAt, label);
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
        // Merge in-memory progress accumulated during the session
        sessionEntry.progress = accumulatedProgress;
      });

      // Save the agent's final message as a comment on the ticket
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
      // Fallback to old behavior
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
        tokenMetadata: tokenUpdate ?? undefined,
      });
    }
  });
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly manifest: ProviderManifest = {
    id: 'claude-code',
    displayName: 'Claude Code',
    configSchema: {},
    costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' },
    capabilities: {
      compacting: true,
      effortLevels: [...EFFORT_LEVELS],
      memoryFiles: true,
    },
  };

  labelForFramework(): string {
    return 'Claude Code';
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
  const resumeArgs = session.claudeSessionId
    ? ['-p', safeMessage, '--resume', session.claudeSessionId, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
    : ['-p', safeMessage, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];

  let replyProc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the actual .exe instead of using cmd.exe wrapper
    let exePath: string | null = null;
    try {
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', timeout: 10_000 }).trim();
      const candidateExe = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
      }
    } catch (err) {
      console.log(`[${id}] Failed to resolve claude.exe path for reply:`, err);
    }

    if (!exePath) {
      throw new Error('claude.exe not found. Please install @anthropic-ai/claude-code globally: npm install -g @anthropic-ai/claude-code');
    }

    console.log(`[${id}] Windows reply spawn: ${exePath} --resume ${session.claudeSessionId || '(new)'}`);
    replyProc = spawn(exePath, resumeArgs, {
      cwd: workspaceRoot,
      env: cleanChildEnv(),
      stdio: 'pipe',
    });
  } else {
    replyProc = spawn(binaryName, resumeArgs, {
      cwd: workspaceRoot,
      env: cleanChildEnv(),
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

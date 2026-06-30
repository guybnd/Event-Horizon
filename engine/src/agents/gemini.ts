import { log } from '../log.js';
import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { configCache } from '../config.js';
import { buildActivityEntry, buildCommentEntry, buildAgentMessageEntry, buildAgentSessionEntry, appendSessionProgress, closeAgentSession, type AgentSessionEntry } from '../history.js';
import { updateTaskWithHistory, updateAgentSession, tasksCache, estimateCostUSD } from '../task-store.js';
import { resolveTaskExecutionRoot } from '../task-worktree.js';
import { cliSessionsById, cliSessionIdByTaskId, notifyGroupSessionTerminal, notifyDelegationComplete, checkAutoRestart } from '../session-store.js';
import { broadcastEvent } from '../events.js';
import { killProcessTree } from '../kill-process-tree.js';
import { checkFrameworkHealth, checkSkillStaleness } from '../notifications.js';
import { captureTurnStartState, clearNeedsActionIfSet, flagIfParked } from '../parked-ticket.js';
import { getModulePromptFragments } from '../modules.js';
import { buildMemberScopeArgs } from '../group.js';
import { buildGroupDocsScopeArg } from '../group-member-worktree.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from './types.js';
import { CLI_CAPABILITIES } from './types.js';
import { EFFORT_LEVELS, type EffortLevel, cleanChildEnv, checkBinaryInstalled, appendSessionOutput, enqueueSessionWrite, flushSessionOutput } from './shared.js';

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

export function buildInitialPrompt(task: any, appendPrompt: string, opts?: { phase?: string | undefined }): string {
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
  // Node's spawn rejects strings containing null bytes; strip them to prevent
  // ticket content (e.g. bad escape sequences) from breaking the spawn call.
  return lines.join('\n').replace(/\0/g, '');
}

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

export function attachStdoutProcessing(
  proc: ReturnType<typeof spawn>,
  session: CliSessionRecord,
  taskId: string,
) {
  const commitPendingAssistantText = () => {
    if (session.pendingAssistantText) {
      appendSessionOutput(session, session.pendingAssistantText, 'stdout', true, false);
      flushSessionOutput(session, false, 'text');
      session.pendingAssistantText = '';
    }
  };

  let lineBuf = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        
        // Gemini CLI uses 'init' or 'message' for role=assistant
        if (!session.claudeSessionId && evt.session_id) {
          session.claudeSessionId = evt.session_id;
        }

        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          // Claude Code schema
          const toolBlock = evt.message.content.find((b: any) => b.type === 'tool_use');
          if (toolBlock) {
            session.pendingAssistantText = '';
            const newActivity = TOOL_ACTIVITY_MAP[toolBlock.name] ?? 'Working';
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
            // Append to output buffers for tracking and eventual flush
            session.liveOutputBuffer += evt.content;
            session.outputBuffer += evt.content;
            session.lastOutputAt = new Date().toISOString();
            // Trigger debounced flush to broadcast progress via SSE (matching Claude behavior)
            flushSessionOutput(session, false, 'text');
          }
        } else if (evt.type === 'tool_use') {
          // Gemini CLI tool use schema
          session.pendingAssistantText = '';
          const newActivity = TOOL_ACTIVITY_MAP[evt.tool_name] ?? 'Working';
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
            let data: any = { toolName, parameters: params };

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
            
            // Accumulate in memory only
            if (session.sessionHistoryEntry) {
              session.sessionHistoryEntry.progress.push({ 
                timestamp: new Date().toISOString(), 
                message: `Tool failed: ${evt.tool_name || 'unknown'}`,
                type: 'info',
                data: { toolName: evt.tool_name, error: evt.error }
              });
            }
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
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.claudeSessionId, inputTok, outputTok);
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
            session.costUSD = (session.costUSD ?? 0) + estimateCostUSD(session.claudeSessionId, inputTok, outputTok);
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
        }
      } catch {
        appendSessionOutput(session, trimmed, 'stdout', false);
        // Broadcast that we received some output even if it wasn't valid JSON
        if (!session.currentActivity) {
          session.currentActivity = 'Working';
          broadcastEvent('activity', { taskId, activity: session.currentActivity });
        }
      }
    }
  });

  return commitPendingAssistantText;
}

export async function startCliSession(session: CliSessionRecord, task: any, appendPrompt: string, effortOverrideRaw: string, workspaceRoot: string) {
  const framework = session.framework;
  const binaryName = 'gemini';
  const label = session.label;
  const id = session.taskId;
  // FLUX-519: run the agent in this task's worktree when one exists (else engine root).
  const executionRoot = await resolveTaskExecutionRoot(task, workspaceRoot);
  session.executionRoot = executionRoot;

  log.info(`[${id}] Starting ${framework} session in ${workspaceRoot}`);

  checkBinaryInstalled(binaryName);

  const geminiIntegration = (configCache as any).integrations?.geminiCli;
  const groomingStatuses = [(configCache as any).requireInputStatus || 'Require Input', 'Grooming'];
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
    : task.status === ((configCache as any)?.readyForMergeStatus || 'Ready') ? 'review'
    : undefined;

  const initialPrompt = buildInitialPrompt(task, appendPrompt, { phase: taskPhase });

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
  const globalEffort = (configCache as any).effortLevel as string | undefined;
  const taskEffort = (task as any).effortLevel as string | undefined;
  const effectiveEffort = (effortOverrideRaw || taskEffort || globalEffort || '') as string;
  if (effortCap.supported && effortCap.flag && EFFORT_LEVELS.includes(effectiveEffort as EffortLevel)) {
    geminiArgs.push(effortCap.flag, effectiveEffort);
  }

  let proc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    // On Windows, find the JS entry point or .exe instead of using cmd.exe wrapper.
    // Prefer JS entry point with system node over gemini.exe — the exe is a pkg
    // binary that crashes when NODE_OPTIONS contains V8 flags (e.g. --max-old-space-size)
    // leaked from VS Code terminals or other tools.
    //
    // CRITICAL: spawn('node', ...) from within a pkg binary resolves to the pkg binary
    // itself (not system node) due to Windows CreateProcess search order.
    // We must resolve the full path to system node via 'where node'.
    let exePath: string | null = null;
    let entryPoint: string | null = null;
    let systemNodePath: string | null = null;
    try {
      const prefixEnv = cleanChildEnv('gemini');
      const whereResult = execSync('where node', { encoding: 'utf8', env: prefixEnv, timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/);
      // Filter out our own exe — pkg binaries ARE node binaries and 'where' may list them
      const selfExe = process.execPath.toLowerCase();
      systemNodePath = whereResult.find(p => p.toLowerCase() !== selfExe && fs.existsSync(p)) || null;
      if (!systemNodePath) systemNodePath = whereResult[0] || null;
    } catch {
      // 'where node' failed — will fall back to 'node' bare name (may break in pkg context)
    }
    try {
      const prefixEnv = cleanChildEnv('gemini');
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', env: prefixEnv, timeout: 10_000, windowsHide: true }).trim();
      const candidateJs = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
      const candidateExe = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bin', 'gemini.exe');
      
      if (fs.existsSync(candidateJs)) {
        entryPoint = candidateJs;
      } else if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
      }
    } catch (err) {
      log.info(`[${id}] Failed to resolve gemini via npm prefix:`, err);
    }

    // Second attempt: use 'where' to find the gemini cmd/exe and resolve the JS entry
    if (!entryPoint && !exePath) {
      try {
        const prefixEnv = cleanChildEnv('gemini');
        const wherePath = execSync(`where ${binaryName}`, { encoding: 'utf8', env: prefixEnv, timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/)[0];
        if (wherePath) {
          // The .cmd is usually in the same dir as the npm prefix bin — try to find the JS bundle relative to it
          const binDir = path.dirname(wherePath);
          const candidateJs = path.join(binDir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
          if (fs.existsSync(candidateJs)) {
            entryPoint = candidateJs;
          } else {
            // Try parent directory pattern (npm global: prefix/bin/gemini.cmd, prefix/node_modules/...)
            const parentCandidate = path.join(binDir, '..', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
            if (fs.existsSync(parentCandidate)) {
              entryPoint = parentCandidate;
            }
          }
        }
      } catch {
        // where command failed — will fall through to shell fallback
      }
    }

    const env = cleanChildEnv('gemini', id);
    const nodeCmd = systemNodePath || 'node';
    if (entryPoint) {
      log.info(`[${id}] Windows spawn (node=${nodeCmd}): ${entryPoint}`);
      proc = spawn(nodeCmd, [entryPoint, ...geminiArgs], {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } else if (exePath) {
      log.info(`[${id}] Windows spawn (exe): ${exePath}`);
      proc = spawn(exePath, geminiArgs, {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } else {
      // Last resort: use shell. Remove NODE_OPTIONS via explicit prefix to prevent
      // .cmd wrappers from re-injecting it.
      log.info(`[${id}] Windows spawn (fallback): ${binaryName}`);
      proc = spawn('cmd.exe', ['/c', `set "NODE_OPTIONS=" && ${binaryName}`, ...geminiArgs], {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    }
  } else {
    proc = spawn(binaryName, geminiArgs, {
      cwd: executionRoot,
      env: cleanChildEnv('gemini', id),
      stdio: 'pipe',
    });
  }
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
        entries: [buildActivityEntry(outcome, 'Agent', session.endedAt)],
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
    return startCliSession(session, task, appendPrompt, effortOverride, workspaceRoot);
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
  const executionRoot = session.executionRoot ?? await resolveTaskExecutionRoot(tasksCache[id], workspaceRoot);
  if (executionRoot !== workspaceRoot && !fs.existsSync(executionRoot)) {
    throw new Error(`Worktree for ${id} no longer exists (ticket likely finished) — refusing to resume the agent on master.`);
  }

  checkBinaryInstalled(binaryName);

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
  const resumeArgs = session.claudeSessionId
    ? ['-p', safeMessage, '--resume', session.claudeSessionId, '--output-format', 'stream-json', '--screen-reader', '--yolo', '--skip-trust', ...geminiScopeArgs]
    : ['-p', safeMessage, '--output-format', 'stream-json', '--screen-reader', '--yolo', '--skip-trust', ...geminiScopeArgs];

  let replyProc: ReturnType<typeof spawn>;
  if (process.platform === 'win32') {
    let exePath: string | null = null;
    let entryPoint: string | null = null;
    let systemNodePath: string | null = null;
    try {
      const prefixEnv = cleanChildEnv('gemini');
      const whereResult = execSync('where node', { encoding: 'utf8', env: prefixEnv, timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/);
      const selfExe = process.execPath.toLowerCase();
      systemNodePath = whereResult.find(p => p.toLowerCase() !== selfExe && fs.existsSync(p)) || null;
      if (!systemNodePath) systemNodePath = whereResult[0] || null;
    } catch {}
    try {
      const prefixEnv = cleanChildEnv('gemini');
      const npmPrefix = execSync('npm prefix -g', { encoding: 'utf8', env: prefixEnv, timeout: 10_000, windowsHide: true }).trim();
      const candidateJs = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
      const candidateExe = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'bin', 'gemini.exe');
      
      if (fs.existsSync(candidateJs)) {
        entryPoint = candidateJs;
      } else if (fs.existsSync(candidateExe)) {
        exePath = candidateExe;
      }
    } catch (err) {
      log.info(`[${id}] Failed to resolve gemini path for reply:`, err);
    }

    // Second attempt: use 'where' to find the JS entry
    if (!entryPoint && !exePath) {
      try {
        const prefixEnv = cleanChildEnv('gemini');
        const wherePath = execSync(`where ${binaryName}`, { encoding: 'utf8', env: prefixEnv, timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/)[0];
        if (wherePath) {
          const binDir = path.dirname(wherePath);
          const candidateJs = path.join(binDir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
          if (fs.existsSync(candidateJs)) {
            entryPoint = candidateJs;
          } else {
            const parentCandidate = path.join(binDir, '..', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
            if (fs.existsSync(parentCandidate)) {
              entryPoint = parentCandidate;
            }
          }
        }
      } catch {}
    }

    const env = cleanChildEnv('gemini', id);
    const nodeCmd = systemNodePath || 'node';
    if (entryPoint) {
      log.info(`[${id}] Windows reply spawn (node=${nodeCmd}): ${entryPoint}`);
      replyProc = spawn(nodeCmd, [entryPoint, ...resumeArgs], {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } else if (exePath) {
      log.info(`[${id}] Windows reply spawn (exe): ${exePath}`);
      replyProc = spawn(exePath, resumeArgs, {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    } else {
      log.info(`[${id}] Windows reply spawn (fallback): ${binaryName}`);
      replyProc = spawn('cmd.exe', ['/c', `set "NODE_OPTIONS=" && ${binaryName}`, ...resumeArgs], {
        cwd: executionRoot,
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
    }
  } else {
    replyProc = spawn(binaryName, resumeArgs, {
      cwd: executionRoot,
      env: cleanChildEnv('gemini', id),
      stdio: 'pipe',
    });
  }
  session.proc = replyProc as ChildProcessWithoutNullStreams;
  session.pid = replyProc.pid;

  const commitReplyPending = attachStdoutProcessing(replyProc, session, id);

  replyProc.stderr!.on('data', (chunk) => {
    appendSessionOutput(session, chunk, 'stderr', false);
  });

  replyProc.on('error', async (error) => {
    // FLUX-915: a stop racing a spawn error stays 'cancelled' rather than reverting to resumable.
    if (session.requestedStop) {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
    } else {
      session.status = 'waiting-input';
    }
    commitReplyPending();
    flushSessionOutput(session, true, 'text');
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`${session.label} reply failed: ${error.message}`, 'Agent', new Date().toISOString())],
    });
    console.error(`[${id}] Failed to spawn ${binaryName} for reply:`, error.message);
  });

  replyProc.on('exit', async () => {
    commitReplyPending();
    flushSessionOutput(session, true, 'text');
    // FLUX-915: a user-requested stop stays 'cancelled' instead of reverting to 'waiting-input'
    // (which counted the killed session as active forever). Otherwise the resumable conversation
    // stays waiting-input.
    if (session.requestedStop) {
      session.status = 'cancelled';
      session.endedAt = new Date().toISOString();
    } else {
      session.status = 'waiting-input';
    }
    // FLUX-651: resumed turn ended — flag if the agent parked without acting. Skip a stopped turn.
    if (!session.pausedForInput && !session.requestedStop) await flagIfParked(session, id);
    broadcastEvent('taskUpdated', { id });
  });
}

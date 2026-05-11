import type { CliSessionRecord, CliSessionSummary } from './agents/types.js';

export const cliSessionsById = new Map<string, CliSessionRecord>();
export const cliSessionIdByTaskId = new Map<string, string>();

export function getCliSessionSummaryForTask(taskId: string): CliSessionSummary | undefined {
  const sessionId = cliSessionIdByTaskId.get(taskId);
  if (!sessionId) return undefined;
  const session = cliSessionsById.get(sessionId);
  if (!session) return undefined;

  return {
    id: session.id,
    taskId: session.taskId,
    framework: session.framework,
    status: session.status,
    command: session.command,
    args: [...session.args],
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    pid: session.pid,
    label: session.label,
    lastOutputAt: session.lastOutputAt,
    lastInputAt: session.lastInputAt,
    blockedReason: session.blockedReason,
    liveOutput: session.liveOutputBuffer || undefined,
    skipPermissions: session.skipPermissions,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    costUSD: session.costUSD,
    costIsEstimated: session.costIsEstimated,
    cacheReadTokens: session.cacheReadTokens,
    cacheCreationTokens: session.cacheCreationTokens,
  };
}

export function stopAllCliSessions(reason: string) {
  for (const session of cliSessionsById.values()) {
    if (!session.proc) continue;
    if (session.status === 'running' || session.status === 'waiting-input' || session.status === 'pending') {
      session.requestedStop = true;
      try {
        session.proc.kill('SIGTERM');
      } catch (error) {
        console.warn(`Failed to stop CLI session ${session.id} during ${reason}:`, error);
      }
    }
  }
}

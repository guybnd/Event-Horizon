import type { CliSessionRecord, CliSessionSummary, CliFramework, ExecutionPattern, PatternPosition } from './agents/types.js';
import { CLI_CAPABILITIES as capabilities } from './agents/types.js';

export const cliSessionsById = new Map<string, CliSessionRecord>();
export const cliSessionsByTaskId = new Map<string, string[]>();

// Backwards-compat alias: returns the most recent session ID for a task
export const cliSessionIdByTaskId = {
  get(taskId: string): string | undefined {
    const ids = cliSessionsByTaskId.get(taskId);
    if (!ids || ids.length === 0) return undefined;
    return ids[ids.length - 1];
  },
  set(taskId: string, sessionId: string): void {
    registerSession(taskId, sessionId);
  },
  delete(taskId: string): boolean {
    return cliSessionsByTaskId.delete(taskId);
  },
  has(taskId: string): boolean {
    const ids = cliSessionsByTaskId.get(taskId);
    return !!ids && ids.length > 0;
  },
};

export function registerSession(taskId: string, sessionId: string): void {
  const ids = cliSessionsByTaskId.get(taskId) || [];
  if (!ids.includes(sessionId)) {
    ids.push(sessionId);
    cliSessionsByTaskId.set(taskId, ids);
  }
}

export function unregisterSession(taskId: string, sessionId: string): void {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids) return;
  const idx = ids.indexOf(sessionId);
  if (idx >= 0) ids.splice(idx, 1);
  if (ids.length === 0) cliSessionsByTaskId.delete(taskId);
}

function toSummary(session: CliSessionRecord): CliSessionSummary {
  const summary: CliSessionSummary = {
    id: session.id,
    taskId: session.taskId,
    framework: session.framework,
    status: session.status,
    command: session.command,
    args: [...session.args],
    startedAt: session.startedAt,
    label: session.label,
  };
  if (session.skipPermissions != null) summary.skipPermissions = session.skipPermissions;
  if (session.inputTokens != null) summary.inputTokens = session.inputTokens;
  if (session.outputTokens != null) summary.outputTokens = session.outputTokens;
  if (session.costUSD != null) summary.costUSD = session.costUSD;
  if (session.endedAt) summary.endedAt = session.endedAt;
  if (session.pid) summary.pid = session.pid;
  if (session.lastOutputAt) summary.lastOutputAt = session.lastOutputAt;
  if (session.lastInputAt) summary.lastInputAt = session.lastInputAt;
  if (session.blockedReason) summary.blockedReason = session.blockedReason;
  if (session.liveOutputBuffer) summary.liveOutput = session.liveOutputBuffer;
  if (session.currentActivity) summary.currentActivity = session.currentActivity;
  if (session.costIsEstimated) summary.costIsEstimated = session.costIsEstimated;
  if (session.cacheReadTokens) summary.cacheReadTokens = session.cacheReadTokens;
  if (session.cacheCreationTokens) summary.cacheCreationTokens = session.cacheCreationTokens;
  if (session.role) summary.role = session.role;
  if (session.pattern) summary.pattern = session.pattern;
  if (session.patternPosition) summary.patternPosition = session.patternPosition;
  if (session.groupId) summary.groupId = session.groupId;
  if (session.groupSeq != null) summary.groupSeq = session.groupSeq;
  if (session.groupType) summary.groupType = session.groupType;
  if (session.groupVariant) summary.groupVariant = session.groupVariant;
  if (session.lockedPaths) summary.lockedPaths = session.lockedPaths;
  if (session.outputData) summary.outputData = session.outputData;
  return summary;
}

export function getCliSessionSummaryForTask(taskId: string): CliSessionSummary | undefined {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return undefined;

  // Prefer the most recent active session; fall back to the last session
  for (let i = ids.length - 1; i >= 0; i--) {
    const session = cliSessionsById.get(ids[i]!);
    if (session && ['pending', 'running', 'waiting-input'].includes(session.status)) {
      return toSummary(session);
    }
  }

  const lastSession = cliSessionsById.get(ids[ids.length - 1]!);
  return lastSession ? toSummary(lastSession) : undefined;
}

export function getAllSessionSummariesForTask(taskId: string): CliSessionSummary[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return [];
  const summaries: CliSessionSummary[] = [];
  for (const id of ids) {
    const session = cliSessionsById.get(id);
    if (session) summaries.push(toSummary(session));
  }
  return summaries;
}

export function getActiveSessionsForTask(taskId: string): CliSessionRecord[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids) return [];
  return ids
    .map(id => cliSessionsById.get(id))
    .filter((s): s is CliSessionRecord => !!s && ['pending', 'running', 'waiting-input'].includes(s.status));
}

// Return all sessions belonging to one orchestration run group, in launch order.
export function getSessionGroup(taskId: string, groupId: string): CliSessionRecord[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids) return [];
  return ids
    .map(id => cliSessionsById.get(id))
    .filter((s): s is CliSessionRecord => !!s && s.groupId === groupId);
}

// ── Deferred combiner (scatter-gather fan-in barrier) ───────────────────────
// In a scatter-gather run with a combiner, the combiner must run AFTER its
// worker ("step") sessions finish — otherwise it races them and synthesizes
// nothing. We register the combiner as pending at launch and spawn it only once
// every worker in the group reaches a terminal state.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface PendingCombinerSpec {
  taskId: string;
  groupId: string;
  framework: CliFramework;
  role: string;
  appendPrompt: string;
  skipPermissions: boolean;
  groupType?: ExecutionPattern;
  groupVariant?: 'combiner' | 'headless';
  /** Number of worker sessions the combiner must wait for. Guards against
   *  launching before every worker has registered (fast-completion race). */
  expectedWorkers: number;
}

const pendingCombinersByGroup = new Map<string, PendingCombinerSpec>();

/** A launcher is injected by the cli-session route to avoid an import cycle. */
export type CombinerLauncher = (spec: PendingCombinerSpec, anyWorkerSucceeded: boolean) => Promise<void>;
let combinerLauncher: CombinerLauncher | null = null;
export function setCombinerLauncher(fn: CombinerLauncher): void {
  combinerLauncher = fn;
}

export function registerPendingCombiner(spec: PendingCombinerSpec): void {
  pendingCombinersByGroup.set(spec.groupId, spec);
}

export function getPendingCombiner(groupId: string): PendingCombinerSpec | undefined {
  return pendingCombinersByGroup.get(groupId);
}

export function unregisterPendingCombiner(groupId: string): boolean {
  return pendingCombinersByGroup.delete(groupId);
}

/**
 * Called by adapters when a session reaches a terminal state. If the session
 * belongs to a group with a pending combiner and every worker ("step") session
 * in that group is now terminal, dequeue and launch the combiner.
 */
export async function notifyGroupSessionTerminal(taskId: string, groupId: string | undefined): Promise<void> {
  if (!groupId) return;
  const spec = pendingCombinersByGroup.get(groupId);
  if (!spec) return;

  const workers = getSessionGroup(taskId, groupId).filter(s => s.patternPosition === 'step');
  if (workers.length === 0) return;
  // Wait until every expected worker has registered AND all are terminal.
  if (workers.length < spec.expectedWorkers) return;
  const allTerminal = workers.every(s => TERMINAL_STATUSES.has(s.status));
  if (!allTerminal) return;

  // Claim the combiner so concurrent terminal events don't double-launch.
  pendingCombinersByGroup.delete(groupId);
  const anyWorkerSucceeded = workers.some(s => s.status === 'completed');

  if (!combinerLauncher) {
    console.warn(`No combiner launcher registered; pending combiner for group ${groupId} dropped.`);
    return;
  }
  try {
    await combinerLauncher(spec, anyWorkerSucceeded);
  } catch (error) {
    console.error(`Failed to launch deferred combiner for group ${groupId}:`, error);
  }
}


// File-lock enforcement: check if any active session holds a conflicting path lock
export function checkPathConflicts(taskId: string, requestedPaths: string[]): { conflict: boolean; holder?: string; paths?: string[] } {
  if (!requestedPaths || requestedPaths.length === 0) return { conflict: false };

  const activeSessions = getActiveSessionsForTask(taskId);
  for (const session of activeSessions) {
    if (!session.lockedPaths || session.lockedPaths.length === 0) continue;
    const overlapping = requestedPaths.filter(p =>
      session.lockedPaths!.some(locked => p.startsWith(locked) || locked.startsWith(p))
    );
    if (overlapping.length > 0) {
      return { conflict: true, holder: session.id, paths: overlapping };
    }
  }
  return { conflict: false };
}

// Validate that a CLI framework supports the requested orchestration pattern
export function validatePatternSupport(framework: CliFramework, pattern: ExecutionPattern, position: PatternPosition): string | null {
  const caps = capabilities[framework];
  if (!caps) return `Unknown framework: ${framework}`;

  if (pattern === 'supervisor' && position === 'lead' && !caps.supervisor) {
    return `${framework} does not support the supervisor pattern as lead (no session resume/child spawning)`;
  }
  if (pattern === 'scatter-gather' && !caps.scatter) {
    return `${framework} does not support scatter-gather`;
  }
  if (pattern === 'relay' && !caps.resume && position === 'step') {
    return `${framework} does not support relay (no session resume) — use as fire-and-forget only`;
  }
  return null;
}

export function getActiveSessionCount(): number {
  let count = 0;
  for (const session of cliSessionsById.values()) {
    if (session.status === 'running' || session.status === 'waiting-input' || session.status === 'pending') {
      count++;
    }
  }
  return count;
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

export function stopAllSessionsForTask(taskId: string, reason: string) {
  const activeSessions = getActiveSessionsForTask(taskId);
  for (const session of activeSessions) {
    session.requestedStop = true;
    session.status = 'cancelled';
    session.endedAt = new Date().toISOString();
    if (session.proc) {
      try {
        session.proc.kill('SIGTERM');
      } catch (error) {
        console.warn(`Failed to stop session ${session.id} for task ${taskId} during ${reason}:`, error);
      }
    }
  }
}

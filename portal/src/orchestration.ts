import type { CliSessionSummary, CliSessionStatus, ExecutionPattern, GroupVariant } from './types';

export const ACTIVE_SESSION_STATUSES: CliSessionStatus[] = ['pending', 'running', 'waiting-input'];

export function isActiveSession(s: Pick<CliSessionSummary, 'status'>): boolean {
  return ACTIVE_SESSION_STATUSES.includes(s.status);
}

/** Strip the multi-session role prefix (e.g. "reviewer:architect" -> "architect"). */
export function normalizeRoleLabel(role?: string): string | undefined {
  if (!role) return undefined;
  return role.replace(/^reviewer:/, '');
}

export interface SessionGroup {
  groupId: string;
  groupType?: ExecutionPattern;
  groupVariant?: GroupVariant;
  sessions: CliSessionSummary[];
  /** True when this group has more than one session (render as a cluster). */
  isMulti: boolean;
}

/**
 * Bucket a task's sessions into orchestration run groups. Sessions sharing a
 * groupId form one group; ungrouped sessions each become their own singleton
 * group keyed by their session id (legacy single-session behavior).
 * Groups are returned ordered by their earliest session start time (newest first).
 */
export function groupSessions(sessions: CliSessionSummary[] | undefined | null): SessionGroup[] {
  if (!sessions || sessions.length === 0) return [];
  const byGroup = new Map<string, CliSessionSummary[]>();
  for (const s of sessions) {
    const key = s.groupId || `__solo__${s.id}`;
    const bucket = byGroup.get(key) ?? [];
    bucket.push(s);
    byGroup.set(key, bucket);
  }

  const groups: SessionGroup[] = [];
  for (const [key, members] of byGroup) {
    // groupSeq orders relay pipelines; otherwise keep launch order by startedAt.
    const ordered = [...members].sort((a, b) => {
      if (a.groupSeq != null && b.groupSeq != null) return a.groupSeq - b.groupSeq;
      return a.startedAt.localeCompare(b.startedAt);
    });
    const head = ordered[0];
    // A relay pipeline may only have 1 session spawned so far but groupTotal
    // tells us how many are expected — treat it as multi from the start.
    const expectedTotal = head.groupTotal ?? ordered.length;
    groups.push({
      groupId: head.groupId || key,
      groupType: head.groupType,
      groupVariant: head.groupVariant,
      sessions: ordered,
      isMulti: expectedTotal > 1,
    });
  }

  groups.sort((a, b) => {
    const aStart = a.sessions[0]?.startedAt ?? '';
    const bStart = b.sessions[0]?.startedAt ?? '';
    return bStart.localeCompare(aStart);
  });
  return groups;
}

export interface GroupAggregate {
  total: number;
  active: number;
  completed: number;
  failed: number;
  waitingInput: number;
  /** The session designated as the orchestrator/combiner/lead, if any. */
  lead?: CliSessionSummary;
  /** Non-lead worker sessions (reviewers / pipeline steps / peers). */
  steps: CliSessionSummary[];
  done: boolean;
}

export function aggregateGroup(group: SessionGroup): GroupAggregate {
  const lead = group.sessions.find(
    s => s.patternPosition === 'lead' || s.patternPosition === 'combiner' || s.role === 'orchestrator'
  );
  const steps = group.sessions.filter(s => s !== lead);
  let active = 0, completed = 0, failed = 0, waitingInput = 0;
  for (const s of group.sessions) {
    if (s.status === 'completed') completed++;
    else if (s.status === 'failed' || s.status === 'cancelled') failed++;
    else if (s.status === 'waiting-input') { waitingInput++; active++; }
    else if (s.status === 'pending' || s.status === 'running') active++;
  }
  return {
    total: group.sessions.length,
    active,
    completed,
    failed,
    waitingInput,
    lead,
    steps,
    done: active === 0,
  };
}

/** Human label for an orchestration pattern + variant. */
export function patternLabel(type?: ExecutionPattern, variant?: GroupVariant): string {
  if (!type) return 'Agents';
  if (type === 'relay') return 'Serialized';
  if (type === 'supervisor') return 'Hand-off';
  if (type === 'scatter-gather') return variant === 'headless' ? 'Parallel' : 'Scatter-gather';
  return 'Agents';
}

export type TopologyShape = 'pipeline' | 'tree' | 'fan' | 'swarm';

export function topologyShape(type?: ExecutionPattern, variant?: GroupVariant): TopologyShape {
  if (type === 'relay') return 'pipeline';
  if (type === 'supervisor') return 'tree';
  if (type === 'scatter-gather') return variant === 'headless' ? 'swarm' : 'fan';
  return 'swarm';
}

/**
 * True when a run expects a combiner/lead (scatter-gather or supervisor with a
 * `combiner` variant) that has not finished yet. Because the combiner is now
 * launched engine-side only after every worker is terminal, the lead session
 * may not exist in the group at all during the wait — so "pending" covers both
 * "lead not spawned yet" and "lead spawned but still active".
 */
export function isCombinerPending(group: SessionGroup, agg: GroupAggregate): boolean {
  const shape = topologyShape(group.groupType, group.groupVariant);
  const expectsCombiner = (shape === 'fan' || shape === 'tree') && group.groupVariant === 'combiner';
  if (!expectsCombiner) return false;
  if (!agg.lead) return true;
  return isActiveSession(agg.lead);
}

/**
 * True while a run is still unfolding: any session active, a combiner is
 * still owed, or a relay pipeline has more steps to spawn. Used to keep a
 * run's cluster on the board through all phases of execution.
 */
export function isGroupLive(group: SessionGroup, agg: GroupAggregate): boolean {
  if (agg.active > 0) return true;
  if (isCombinerPending(group, agg)) return true;
  // Relay: still live while the engine will spawn more steps.
  const expectedTotal = group.sessions[0]?.groupTotal;
  if (expectedTotal && group.sessions.length < expectedTotal) return true;
  return false;
}

/** Pattern-aware one-line summary of group progress for cards/popover. */
export function groupAggregateLine(group: SessionGroup, agg: GroupAggregate): string {
  const shape = topologyShape(group.groupType, group.groupVariant);
  if (shape === 'pipeline') {
    const pipelineTotal = group.sessions[0]?.groupTotal ?? agg.total;
    const idx = group.sessions.findIndex(isActiveSession);
    const stepNum = idx >= 0 ? idx + 1 : group.sessions.length;
    const active = group.sessions[idx];
    const activity = active?.currentActivity ? `: ${active.currentActivity}` : '';
    return agg.done && group.sessions.length >= pipelineTotal
      ? `Pipeline complete (${pipelineTotal} steps)`
      : `Step ${stepNum} of ${pipelineTotal}${activity}`;
  }
  if (shape === 'fan') {
    const workersDone = agg.steps.filter(s => !isActiveSession(s)).length;
    const expectsCombiner = group.groupVariant === 'combiner';
    if (agg.lead && isActiveSession(agg.lead) && agg.steps.every(s => !isActiveSession(s))) {
      return 'Synthesizing results…';
    }
    const allWorkersDone = workersDone === agg.steps.length && agg.steps.length > 0;
    if (expectsCombiner && allWorkersDone && !agg.lead) {
      return `${workersDone} of ${agg.steps.length} reviewers done · combiner starting…`;
    }
    return `${workersDone} of ${agg.steps.length} reviewers done${expectsCombiner ? ' · waiting on combiner' : ''}`;
  }
  if (shape === 'tree') {
    return agg.done ? 'Hand-off complete' : `Lead + ${agg.steps.length} delegate${agg.steps.length === 1 ? '' : 's'}`;
  }
  // swarm
  const peersDone = group.sessions.filter(s => !isActiveSession(s)).length;
  return agg.done ? `All ${agg.total} agents done` : `${peersDone} of ${agg.total} agents done`;
}

/** Tailwind text-color class for a session status dot. */
export function statusDotColor(status: CliSessionStatus): string {
  switch (status) {
    case 'running':
    case 'pending':
      return 'text-emerald-500';
    case 'waiting-input':
      return 'text-amber-500';
    case 'failed':
    case 'cancelled':
      return 'text-red-500';
    case 'completed':
    default:
      return 'text-gray-400';
  }
}

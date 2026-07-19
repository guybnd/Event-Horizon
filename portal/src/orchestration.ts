import type { CliSessionSummary, CliSessionStatus, ExecutionPattern, GroupVariant } from './types';

// FLUX-1390: 'scheduled' is a session honoring a ScheduleWakeup call — asleep, not idle or done; it
// must read as active everywhere this list gates (dots, pulses, "any active session" checks, …).
export const ACTIVE_SESSION_STATUSES: CliSessionStatus[] = ['pending', 'running', 'waiting-input', 'scheduled'];

/** FLUX-803: normalized names of the MCP tools that spawn a subagent group. Mirrors the engine's
 *  `DELEGATION_TOOLS` (projection.ts) — the projector tags these tool rows with `tool`, and the
 *  chat keys off that to find the spawn point + render the inline orchestration block in its place.
 *  Only the group-forming delegate tools belong here; `start_session` is excluded because it spawns
 *  a standalone, ungrouped session that never resolves into a 2+ run group (see projection.ts). */
export const DELEGATION_TOOLS = new Set(['delegate', 'delegate_parallel', 'delegate_to_agent']);

export function isActiveSession(s: Pick<CliSessionSummary, 'status' | 'endedAt'>): boolean {
  // FLUX-846: a session that carries an `endedAt` is terminal — the engine stamps it together
  // with the terminal status on every exit/error path, and never on a live `running`/`pending`/
  // `waiting-input` session. Treat a present `endedAt` as authoritative even if `status` is stuck
  // on 'running' (a missed terminal event / partial update), so a finished session can never show
  // as forever-'Working' with a runaway timer.
  return !s.endedAt && ACTIVE_SESSION_STATUSES.includes(s.status);
}

/** FLUX-1456: mirrors the 10-min staleness heuristic in `useCliSession.ts`'s poll-stop guard. */
export const SESSION_STALE_MS = 10 * 60 * 1000;

/**
 * FLUX-1456: whether `s` is a live target for routed input (e.g. the `finish` fallback) — distinct
 * from `isActiveSession`, which `isActiveSession` intentionally keeps broad for dots/pulses/timers
 * (FLUX-846/1390). A `waiting-input` session is a CLI process that has already exited and parked
 * (`board-core.ts`); it's only a real input target when it's both resumable and recently active —
 * otherwise routed input silently vanishes into a dead conversation (the FLUX-719 liveness gap).
 */
export function isLiveInputTarget(
  s: Pick<CliSessionSummary, 'status' | 'endedAt' | 'resumable' | 'lastOutputAt' | 'startedAt'>,
  nowMs = Date.now(),
): boolean {
  if (s.endedAt) return false;
  if (s.status === 'running' || s.status === 'pending') return true;
  if (s.status === 'waiting-input') {
    if (!s.resumable) return false;
    const last = s.lastOutputAt ?? s.startedAt;
    return !!last && nowMs - new Date(last).getTime() <= SESSION_STALE_MS;
  }
  return false;
}

/**
 * FLUX-1532: whether a live (`pending`/`running`/`waiting-input`) session has gone quiet long enough
 * that it should no longer render as "actively working" — a stalled agent otherwise sits in
 * `running`/`waiting-input` forever and looks identical to one actively producing output. Two ways
 * in: no output for longer than `SESSION_STALE_MS`, or a non-resumable `waiting-input` (mirrors the
 * parked case in `isLiveInputTarget` — that CLI process has already exited for good). `'scheduled'`
 * is deliberately asleep (FLUX-1390) and is never stale regardless of how old its last output is.
 */
export function isSessionStale(
  s: Pick<CliSessionSummary, 'status' | 'lastOutputAt' | 'startedAt' | 'resumable'>,
  nowMs = Date.now(),
): boolean {
  if (s.status === 'scheduled') return false;
  if (s.status === 'waiting-input' && s.resumable === false) return true;
  const last = s.lastOutputAt ?? s.startedAt;
  return !!last && nowMs - new Date(last).getTime() > SESSION_STALE_MS;
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
    // Supervisor groups are always multi (the lead can delegate at any time).
    const expectedTotal = head.groupTotal ?? ordered.length;
    const isSupervisor = head.groupType === 'supervisor';
    groups.push({
      groupId: head.groupId || key,
      groupType: head.groupType,
      groupVariant: head.groupVariant,
      sessions: ordered,
      isMulti: isSupervisor || expectedTotal > 1,
    });
  }

  groups.sort((a, b) => {
    const aStart = a.sessions[0]?.startedAt ?? '';
    const bStart = b.sessions[0]?.startedAt ?? '';
    return bStart.localeCompare(aStart);
  });
  return groups;
}

/** FLUX-962: token/cost totals summed across a group's sessions — same shape TokenBadge consumes,
 *  so a group card renders one aggregated badge instead of re-summing at the call site. */
export interface GroupTokenTotals {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /** True when ANY session's cost is estimated — the whole-run figure is then estimated. */
  costIsEstimated: boolean;
  cacheReadTokens: number;
  cacheCreationTokens: number;
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
  /** FLUX-962: tokens/cost summed over every session in the group. */
  tokens: GroupTokenTotals;
}

export function aggregateGroup(group: SessionGroup): GroupAggregate {
  const lead = group.sessions.find(
    s => s.patternPosition === 'lead' || s.patternPosition === 'combiner' || s.role === 'orchestrator'
  );
  const steps = group.sessions.filter(s => s !== lead);
  let active = 0, completed = 0, failed = 0, waitingInput = 0;
  const tokens: GroupTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    costIsEstimated: false,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const s of group.sessions) {
    if (s.status === 'completed') completed++;
    else if (s.status === 'failed' || s.status === 'cancelled') failed++;
    else if (s.status === 'waiting-input') { waitingInput++; active++; }
    else if (s.status === 'pending' || s.status === 'running') active++;
    tokens.inputTokens += s.inputTokens ?? 0;
    tokens.outputTokens += s.outputTokens ?? 0;
    tokens.costUSD += s.costUSD ?? 0;
    tokens.cacheReadTokens += s.cacheReadTokens ?? 0;
    tokens.cacheCreationTokens += s.cacheCreationTokens ?? 0;
    if (s.costIsEstimated) tokens.costIsEstimated = true;
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
    tokens,
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
  // Supervisor: live as long as the lead exists and the group hasn't fully terminated.
  if (group.groupType === 'supervisor' && !agg.done) return true;
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

/**
 * FLUX-803: pick the orchestration run group to surface inside a ticket chat, or null when there's
 * nothing to show. A run is "the chat lead delegated to ≥1 subagent": the group sharing the current
 * chat session's groupId with **2+** sessions (lead + at least one delegate). A solo chat — even one
 * stamped with a supervisor groupId but no delegates — yields null, so the rail/block never appear
 * for the common single-session case (the `isMulti` flag is supervisor-true even when solo, so it is
 * deliberately NOT used here). When the current chat session isn't itself a 2+ group lead, falls back
 * to the newest 2+ group regardless of whether any of its sessions are still live (FLUX-1334) — so a
 * finished hand-off run persists as the durable collapsed chip across minimize/reopen instead of
 * vanishing once its sessions terminate. `groupSessions` already orders groups newest-first, so this
 * still can't have an old run shadow a newer one. Critically, the fallback only fires when the
 * newest group *of any size* on the ticket is the 2+ one — if a later, unrelated phase started its
 * own (even solo) session since, that later group is the newest and the fallback yields null instead
 * of resurrecting the stale run. Without this, a stale durable group would shadow a later solo
 * `delegate` call's own transcript row forever (FLUX-1334 review). The live-only presence rail is
 * gated separately on `.some(isActiveSession)` at the call sites, so this relaxation does not
 * resurrect it for a dead run.
 */
export function selectChatRunGroup(
  task: { cliSession?: CliSessionSummary | null; cliSessions?: CliSessionSummary[] },
): SessionGroup | null {
  const groups = groupSessions(task.cliSessions);
  const gid = task.cliSession?.groupId;
  const byLead = gid ? groups.find((g) => g.groupId === gid && g.sessions.length >= 2) : undefined;
  if (byLead) return byLead;
  const newest = groups[0];
  return newest && newest.sessions.length >= 2 ? newest : null;
}

/** Minimal shape of the FLUX-626 live-session slice this module reads (avoids a store import). */
export interface LiveSessionActivity {
  currentActivity?: string;
  progressBySession?: Record<string, Array<{ message: string }>>;
}

/**
 * FLUX-803: freshest activity verb for a session, preferring the real-time FLUX-626 live slice over
 * the poll-cadence `currentActivity` on the summary. Delegates stream their progress keyed by their
 * own session id (`progressBySession[id]`); the chat lead's coarse verb arrives on the slice's
 * top-level `currentActivity` (keyed by task id). Returns undefined when nothing is known yet.
 */
export function liveActivityFor(
  session: CliSessionSummary,
  isLead: boolean,
  live: LiveSessionActivity | undefined,
): string | undefined {
  const prog = live?.progressBySession?.[session.id];
  const lastProg = prog && prog.length > 0 ? prog[prog.length - 1]!.message : undefined;
  return lastProg ?? (isLead ? live?.currentActivity : undefined) ?? session.currentActivity;
}

/** Tailwind text-color class for a session status dot. */
export function statusDotColor(status: CliSessionStatus): string {
  switch (status) {
    case 'running':
    case 'pending':
      return 'text-emerald-500';
    case 'waiting-input':
      return 'text-amber-500';
    case 'scheduled':
      return 'text-sky-500';
    case 'failed':
    case 'cancelled':
      return 'text-red-500';
    case 'completed':
    default:
      return 'text-gray-400';
  }
}

/**
 * Human-readable word for a status dot — pair with {@link statusDotColor} so the status isn't
 * conveyed by color alone (FLUX-807). Render as `sr-only` text beside the dot for screen readers.
 */
export function statusDotLabel(status: CliSessionStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'pending':
      return 'pending';
    case 'waiting-input':
      return 'needs input';
    case 'scheduled':
      return 'scheduled';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    default:
      return status;
  }
}

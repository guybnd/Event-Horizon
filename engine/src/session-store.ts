import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CliSessionRecord, CliSessionSummary, CliFramework, ExecutionPattern, PatternPosition, LaunchPhase } from './agents/types.js';
import { CLI_CAPABILITIES as capabilities } from './agents/types.js';
import { killProcessTree } from './kill-process-tree.js';
import { settleOpenPromptsForConversation } from './hitl-prompts.js';
import { getActiveFluxDir } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { isVirtualConversationId } from './agents/board.js';
import { broadcastEvent } from './events.js';

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

/**
 * Core resumable-session predicate (FLUX-1391): a session is resumable only when its status is in
 * the caller's allowed set AND it carries a `resumeSessionId`. Callers intentionally use different
 * status sets — e.g. furnace-stoker's `findResumeCandidate` deliberately excludes `'running'` as a
 * defensive rail (FLUX-1396 H1) while the broader chat-resumable derivation below does not — so this
 * only unifies the shared shape, not the allowed statuses. Never widen one call site's set to match
 * another's without re-checking why it was narrowed.
 */
export function isResumable(session: Pick<CliSessionRecord, 'status' | 'resumeSessionId'>, allowedStatuses: ReadonlySet<CliSessionRecord['status']>): boolean {
  return allowedStatuses.has(session.status) && !!session.resumeSessionId;
}

// Statuses the ticket-chat input route (and the summary's `resumable` flag below) can resume —
// 'completed' included per FLUX-606: a finished session with a resumeSessionId is continuable.
const INPUT_RESUMABLE_STATUSES: ReadonlySet<CliSessionRecord['status']> = new Set(['running', 'waiting-input', 'scheduled', 'completed']);

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
  // FLUX-1281: expose the launch phase — the dock tab's phase glyph prefers the ACTIVE session's
  // identity (e.g. a plan-review pass on a Grooming ticket) over the ticket's board status.
  if (session.phase) summary.phase = session.phase;
  // FLUX-1383: expose the batch-grooming member set so the portal can render "grooming N tickets".
  if (session.batchTicketIds && session.batchTicketIds.length > 0) summary.batchTicketIds = session.batchTicketIds;
  if (session.pattern) summary.pattern = session.pattern;
  if (session.patternPosition) summary.patternPosition = session.patternPosition;
  if (session.groupId) summary.groupId = session.groupId;
  if (session.groupSeq != null) summary.groupSeq = session.groupSeq;
  if (session.groupTotal != null) summary.groupTotal = session.groupTotal;
  if (session.groupType) summary.groupType = session.groupType;
  if (session.groupVariant) summary.groupVariant = session.groupVariant;
  if (session.lockedPaths) summary.lockedPaths = session.lockedPaths;
  if (session.outputData) summary.outputData = session.outputData;
  // FLUX-606: the chat can continue (`claude --resume`) any terminal-or-active session
  // that has a known resumeSessionId — including a dispatched grooming session that ended
  // `completed`. Expose a boolean (not the raw id) so the frontend resumes that thread
  // instead of starting a fresh, amnesiac chat.
  summary.resumable = isResumable(session, INPUT_RESUMABLE_STATUSES);
  if (session.wakeAt) summary.wakeAt = session.wakeAt;
  if (session.wakeReason) summary.wakeReason = session.wakeReason;
  if (session.disallowedEhTools && session.disallowedEhTools.length > 0) summary.disallowedEhTools = session.disallowedEhTools;
  // FLUX-1601: expose WHY a terminal session ended (previously stamped on the record but never
  // copied to the portal-visible summary) so the chat error card can tell an auth-expired failure
  // apart from a plain crash instead of matching on the raw error string.
  if (session.terminalReason) summary.terminalReason = session.terminalReason;
  // FLUX-1599: expose the auth self-diagnosis so the chat error card (FLUX-1601) can read a
  // structured verdict instead of re-parsing the raw provider error text.
  if (session.authDiagnosis) summary.authDiagnosis = session.authDiagnosis;
  return summary;
}

export function getCliSessionSummaryForTask(taskId: string): CliSessionSummary | undefined {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return undefined;

  // Prefer the most recent active session; fall back to the last session
  for (let i = ids.length - 1; i >= 0; i--) {
    const session = cliSessionsById.get(ids[i]!);
    if (session && ['pending', 'running', 'waiting-input', 'scheduled'].includes(session.status)) {
      return toSummary(session);
    }
  }

  const lastSession = cliSessionsById.get(ids[ids.length - 1]!);
  return lastSession ? toSummary(lastSession) : undefined;
}

/**
 * List-scoped variant of {@link getCliSessionSummaryForTask} (FLUX-1144): truncates
 * `liveOutput` to the same short tail {@link getListSessionSummariesForTask} already applies
 * to the plural `cliSessions[]` field. Board cards only ever render the last line(s) of a
 * running session; the modal fetches the untruncated summary via the dedicated
 * `/api/tasks/:id/cli-session` endpoint (still backed by the unmodified function above), so
 * this only shrinks the `GET /api/tasks` list payload.
 */
export function getListCliSessionSummaryForTask(taskId: string): CliSessionSummary | undefined {
  const summary = getCliSessionSummaryForTask(taskId);
  return summary ? truncateLiveOutput(summary) : undefined;
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

/**
 * FLUX-1378: FULL records (not client-facing summaries) for every session ever registered against
 * a task, oldest-first — engine-internal callers (`resumeOrDispatchSession`'s viability checks)
 * need fields `toSummary` deliberately drops (raw `resumeSessionId`, `executionRoot`,
 * `lastTurnContextTokens`, `contextWindow`, `sessionHistoryEntry`). Do not expose this over the API.
 */
export function getAllSessionsForTask(taskId: string): CliSessionRecord[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return [];
  return ids.map(id => cliSessionsById.get(id)).filter((s): s is CliSessionRecord => !!s);
}

// Max `liveOutput` length (chars) retained per session on the LIST endpoint.
// Cards only need a short preview; the detail endpoint keeps the full buffer.
const LIST_LIVE_OUTPUT_TAIL = 2048;
// FLUX-1390: 'scheduled' (a sleeping, honored-ScheduleWakeup session) is active/alive — no live proc,
// but not terminal either; it must survive list-scoping and eviction the same way 'waiting-input' does.
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting-input', 'scheduled']);

function truncateLiveOutput(summary: CliSessionSummary): CliSessionSummary {
  if (summary.liveOutput && summary.liveOutput.length > LIST_LIVE_OUTPUT_TAIL) {
    summary.liveOutput = summary.liveOutput.slice(-LIST_LIVE_OUTPUT_TAIL);
  }
  return summary;
}

/**
 * Slim a session summary for agent consumption (MCP `get_ticket`). Drops
 * `args` — `args[1]` is the full launch prompt, which embeds the entire ticket
 * body plus mission boilerplate, so shipping it returns the ticket body twice —
 * along with `command` and `pid`, which only matter to the engine/portal.
 * `argsChars` preserves a size hint. Also truncates `liveOutput`.
 */
export function slimSessionSummaryForAgent(summary: CliSessionSummary): Omit<CliSessionSummary, 'args' | 'command' | 'pid'> & { argsChars?: number } {
  const { args, command: _command, pid: _pid, ...rest } = truncateLiveOutput(summary);
  const argsChars = args.reduce((total, arg) => total + arg.length, 0);
  return { ...rest, ...(argsChars > 0 ? { argsChars } : {}) };
}

/**
 * List-scoped session summaries: bounds the payload of `GET /api/tasks` so it
 * doesn't grow with completed-session history. Returns every **active** session
 * plus only the **most-recent completed group** (or solo session), with each
 * `liveOutput` truncated to a short tail. The detail endpoint (`/:id`) still
 * uses {@link getAllSessionSummariesForTask} for the full set.
 */
export function getListSessionSummariesForTask(taskId: string): CliSessionSummary[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return [];
  const sessions = ids
    .map(id => cliSessionsById.get(id))
    .filter((s): s is CliSessionRecord => !!s);
  if (sessions.length === 0) return [];

  const inactive = sessions.filter(s => !ACTIVE_STATUSES.has(s.status));

  // Most-recent completed group, keyed by groupId (solo sessions key on their id).
  const keyOf = (s: CliSessionRecord) => s.groupId ?? `__solo__:${s.id}`;
  const tsOf = (s: CliSessionRecord) => Date.parse(s.endedAt ?? s.startedAt) || 0;
  let latestKey: string | undefined;
  let latestTs = -1;
  for (const s of inactive) {
    const ts = tsOf(s);
    if (ts > latestTs) {
      latestTs = ts;
      latestKey = keyOf(s);
    }
  }

  const include = new Set<string>();
  for (const s of sessions) {
    if (ACTIVE_STATUSES.has(s.status) || (latestKey && keyOf(s) === latestKey)) {
      include.add(s.id);
    }
  }

  const result: CliSessionSummary[] = [];
  for (const s of sessions) {
    if (include.has(s.id)) result.push(truncateLiveOutput(toSummary(s)));
  }
  return result;
}

export function getActiveSessionsForTask(taskId: string): CliSessionRecord[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids) return [];
  return ids
    .map(id => cliSessionsById.get(id))
    .filter((s): s is CliSessionRecord => !!s && ['pending', 'running', 'waiting-input', 'scheduled'].includes(s.status));
}

// Positions marking a session as a group SUBORDINATE — spawned to serve another session (a
// supervisor delegate or a scatter-gather/relay step), never the thread the user is addressing.
// 'standalone' is stripped at registration (cli-session.ts createPendingSession), so solo
// sessions carry no patternPosition at all; leads and combiners keep theirs.
const SUBORDINATE_POSITIONS: ReadonlySet<string> = new Set(['assistant', 'step']);

/**
 * The session a no-target ticket-chat message should land on. Raw registration order
 * (`cliSessionIdByTaskId.get`) is wrong for orchestration runs: a supervisor lead spawns its
 * delegates AFTER itself, so "last registered" resolves the user's follow-up ("all good?") to
 * the most recently spawned worker — even a completed one — instead of the lead running the
 * show. Preference order:
 *   1. the most recently registered resumable session the user would actually address — a
 *      lead, a combiner, or a solo session (no patternPosition);
 *   2. else the most recent resumable subordinate (assistant/step — e.g. a relay mid-chain has
 *      nothing else on offer), matching the old behavior;
 *   3. else the last-registered id, so the route still 409s with that session's summary when
 *      nothing is resumable at all.
 */
export function getPreferredInputSessionId(taskId: string): string | undefined {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return undefined;
  let subordinate: string | undefined;
  for (let i = ids.length - 1; i >= 0; i--) {
    const session = cliSessionsById.get(ids[i]!);
    if (!session || !INPUT_RESUMABLE_STATUSES.has(session.status)) continue;
    if (!SUBORDINATE_POSITIONS.has(session.patternPosition ?? '')) return session.id;
    subordinate ??= session.id;
  }
  return subordinate ?? ids[ids.length - 1];
}


/**
 * FLUX-1479 (FLUX-1226 Phase E): the persistent per-ticket chat session (FLUX-602), if one exists
 * and is still in play — identified by `phase === 'chat'` (never mutated by a phase handoff; see
 * `CliSessionRecord.handoffPhase`'s doc comment) among sessions still worth resuming
 * (`INPUT_RESUMABLE_STATUSES`, same set `getPreferredInputSessionId` uses). Most-recently-registered
 * match wins — mirrors that function's iteration order. Returns undefined when the ticket has never
 * had a chat session, or its only one has fully aged out of resumability.
 */
export function getChatSessionForTask(taskId: string): CliSessionRecord | undefined {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids || ids.length === 0) return undefined;
  for (let i = ids.length - 1; i >= 0; i--) {
    const session = cliSessionsById.get(ids[i]!);
    if (!session || session.phase !== 'chat') continue;
    if (!INPUT_RESUMABLE_STATUSES.has(session.status)) continue;
    return session;
  }
  return undefined;
}

// Narrow selector for the merge guard: only sessions that are actively executing work.
// Do NOT use this for file-lock / conflict checks — those must include waiting-input.
export function getBlockingSessionsForTask(taskId: string): CliSessionRecord[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids) return [];
  return ids
    .map(id => cliSessionsById.get(id))
    .filter((s): s is CliSessionRecord => !!s && ['pending', 'running'].includes(s.status));
}

/**
 * FLUX-1333: sessions that must block a working-tree mutation (file discard) in the checkout
 * `ref` resolves to. Blocking = actively executing ('pending'/'running', via
 * {@link getBlockingSessionsForTask}) — a parked 'waiting-input' session isn't writing, and the
 * persistent per-ticket chat rests there, so including it would permanently disable discard on
 * any ticket that has ever chatted. Tree matching: the session's captured `executionRoot` is
 * authoritative when present (it covers e.g. grooming sessions that run in the shared checkout
 * regardless of the ticket's branch, FLUX-1214); otherwise fall back to the owning task's branch
 * (`ref === 'main'` → branchless tasks run in the shared main tree).
 */
export function getBlockingSessionsForRef(
  ref: string,
  resolvedRoot: string,
  tasks: Array<{ id: string; branch?: string | null }>,
): CliSessionRecord[] {
  const normalize = (p: string) => {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const target = normalize(resolvedRoot);
  const out: CliSessionRecord[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    for (const s of getBlockingSessionsForTask(t.id)) {
      if (seen.has(s.id)) continue;
      const matches = s.executionRoot
        ? normalize(s.executionRoot) === target
        : (ref === 'main' ? !t.branch : t.branch === ref);
      if (matches) {
        seen.add(s.id);
        out.push(s);
      }
    }
  }
  return out;
}

// FLUX-1235: the roleless running/pending ("live") session on a task, if any. This is exactly the
// session the per-ticket start guard (cli-session.ts) refuses a roleless dispatch against — a Furnace
// dispatch is roleless, so a live standalone session is what makes it 409 (whereas an IDLE
// waiting-input one is taken over via `supersedeParked`). furnace_build soft-flags a candidate carrying
// one BEFORE ignite so the drawer surfaces "resolve this chat first" instead of a mid-burn park.
export function getLiveStandaloneSessionForTask(taskId: string): CliSessionRecord | undefined {
  return getBlockingSessionsForTask(taskId).find(s => !s.role);
}

export function getParkedSessionsForTask(taskId: string): CliSessionRecord[] {
  const ids = cliSessionsByTaskId.get(taskId);
  if (!ids) return [];
  return ids
    .map(id => cliSessionsById.get(id))
    .filter((s): s is CliSessionRecord => !!s && s.status === 'waiting-input');
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

// ── Relay pipeline (sequential step barrier) ────────────────────────────────
// In a relay run, steps execute one-at-a-time: step N must finish before step
// N+1 launches. The portal registers the full step chain at launch, then only
// starts step 0. When each step reaches a terminal state, the barrier spawns
// the next step with the previous step's output prepended to its prompt.

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

export interface PendingCombinerSpec {
  taskId: string;
  groupId: string;
  framework: CliFramework;
  role: string;
  appendPrompt: string;
  skipPermissions: boolean;
  groupType?: ExecutionPattern | undefined;
  groupVariant?: 'combiner' | 'headless' | undefined;
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
 * Called by adapters when a session reaches a terminal state. Dispatches to:
 * - Scatter-gather combiner barrier (all workers done → launch combiner)
 * - Relay pipeline barrier (current step done → launch next step)
 */
export async function notifyGroupSessionTerminal(taskId: string, groupId: string | undefined): Promise<void> {
  if (!groupId) return;

  // ── Scatter-gather combiner barrier ──────────────────────────────────────
  const combinerSpec = pendingCombinersByGroup.get(groupId);
  if (combinerSpec) {
    const workers = getSessionGroup(taskId, groupId).filter(s => s.patternPosition === 'step');
    if (workers.length === 0) return;
    if (workers.length < combinerSpec.expectedWorkers) return;
    const allTerminal = workers.every(s => TERMINAL_STATUSES.has(s.status));
    if (!allTerminal) return;

    pendingCombinersByGroup.delete(groupId);
    const anyWorkerSucceeded = workers.some(s => s.status === 'completed');

    if (!combinerLauncher) {
      console.warn(`No combiner launcher registered; pending combiner for group ${groupId} dropped.`);
      return;
    }
    try {
      await combinerLauncher(combinerSpec, anyWorkerSucceeded);
    } catch (error) {
      console.error(`Failed to launch deferred combiner for group ${groupId}:`, error);
    }
    return;
  }

  // ── Relay pipeline step barrier ──────────────────────────────────────────
  const relaySpec = pendingRelaysByGroup.get(groupId);
  if (relaySpec) {
    const sessions = getSessionGroup(taskId, groupId);
    const currentSession = sessions.find(s => s.groupSeq === relaySpec.currentStep);
    if (!currentSession || !TERMINAL_STATUSES.has(currentSession.status)) return;

    const nextIndex = relaySpec.currentStep + 1;
    if (nextIndex >= relaySpec.steps.length) {
      // Pipeline complete — clean up.
      pendingRelaysByGroup.delete(groupId);
      return;
    }

    // Advance the chain pointer before launching to prevent double-spawn.
    relaySpec.currentStep = nextIndex;
    const previousOutput = currentSession.outputData || currentSession.cumulativeOutput || '';
    const previousSucceeded = currentSession.status === 'completed';

    if (!relayStepLauncher) {
      console.warn(`No relay step launcher registered; pending relay for group ${groupId} dropped.`);
      pendingRelaysByGroup.delete(groupId);
      return;
    }
    try {
      await relayStepLauncher(relaySpec, previousOutput, previousSucceeded);
    } catch (error) {
      console.error(`Failed to launch relay step ${nextIndex} for group ${groupId}:`, error);
      pendingRelaysByGroup.delete(groupId);
    }
  }
}


// ── Relay pipeline sequencing ────────────────────────────────────────────────

export interface RelayStep {
  personaId: string;
  role: string;
  focusComment?: string;
}

export interface PendingRelaySpec {
  taskId: string;
  groupId: string;
  framework: CliFramework;
  skipPermissions: boolean;
  effortOverride: string;
  groupType: ExecutionPattern;
  /** Ordered chain of steps to execute. */
  steps: RelayStep[];
  /** Index of the step currently running. */
  currentStep: number;
  /** FLUX-1170: launch phase shared by every step — picks each step's persona
   *  prompt contract at resolve time (steps 1+ resolve lazily in the barrier). */
  phase?: LaunchPhase;
}

const pendingRelaysByGroup = new Map<string, PendingRelaySpec>();

export type RelayStepLauncher = (spec: PendingRelaySpec, previousOutput: string, previousSucceeded: boolean) => Promise<void>;
let relayStepLauncher: RelayStepLauncher | null = null;
export function setRelayStepLauncher(fn: RelayStepLauncher): void {
  relayStepLauncher = fn;
}

export function registerPendingRelay(spec: PendingRelaySpec): void {
  pendingRelaysByGroup.set(spec.groupId, spec);
}

export function getPendingRelay(groupId: string): PendingRelaySpec | undefined {
  return pendingRelaysByGroup.get(groupId);
}

export function unregisterPendingRelay(groupId: string): boolean {
  return pendingRelaysByGroup.delete(groupId);
}

// ── Supervisor delegation completion tracking ───────────────────────────────
// When a supervisor lead delegates to a child agent, the HTTP request blocks
// until the child finishes. We store a resolve callback per child session ID
// so that `notifyGroupSessionTerminal` (or direct session-end) can unblock it.

export interface DelegationResult {
  sessionId: string;
  status: string;
  output: string;
  succeeded: boolean;
}

type DelegationResolver = (result: DelegationResult) => void;
const pendingDelegations = new Map<string, DelegationResolver>();

/**
 * Register a pending delegation: returns a Promise that resolves when the
 * child session reaches a terminal state. Called by the delegation endpoint
 * before spawning the child.
 */
export function awaitDelegation(sessionId: string): Promise<DelegationResult> {
  return new Promise<DelegationResult>((resolve) => {
    pendingDelegations.set(sessionId, resolve);
  });
}

/**
 * Called when any session reaches terminal state. If this session is a pending
 * delegation, resolve its awaiter with the output.
 */
export function notifyDelegationComplete(session: CliSessionRecord): void {
  const resolver = pendingDelegations.get(session.id);
  if (!resolver) return;
  pendingDelegations.delete(session.id);
  resolver({
    sessionId: session.id,
    status: session.status,
    output: session.outputData || session.cumulativeOutput || '',
    succeeded: session.status === 'completed',
  });
}

/**
 * Cancel a pending delegation (e.g. on timeout). Resolves with a failure result.
 */
export function cancelDelegation(sessionId: string, reason: string): void {
  const resolver = pendingDelegations.get(sessionId);
  if (!resolver) return;
  pendingDelegations.delete(sessionId);
  resolver({
    sessionId,
    status: 'cancelled',
    output: reason,
    succeeded: false,
  });
}

// ── Dispatch idempotency (FLUX-842) ─────────────────────────────────────────
// delegate_parallel / delegate_to_agent are spawn-then-ack with no dedupe key.
// If the MCP transport drops the response AFTER the engine spawned the child but
// BEFORE the orchestrator saw it, the orchestrator treats the call as failed and
// retries — re-launching the whole fleet against already-running sessions (~3×
// token cost). We dedupe by a stable hash of (taskId, personaId, task, effort):
// a retry with the same inputs attaches to the in-flight delegation (or its
// freshly-cached result) instead of spawning a fresh child.

interface DispatchEntry {
  sessionId: string;
  promise: Promise<DelegationResult>;
}

// How long a settled dispatch's result stays dedupable, so a retry that lands
// just after the child finished returns the cached result instead of re-spawning.
const DISPATCH_RESULT_TTL_MS = 90_000;
const dispatchRegistry = new Map<string, DispatchEntry>();

/** Stable idempotency key for a delegation request. */
export function dispatchKey(taskId: string, personaId: string, task: string, effort: string): string {
  return createHash('sha1').update(JSON.stringify([taskId, personaId, task, effort])).digest('hex');
}

/** Returns the in-flight (or recently-settled) dispatch for this key, if any. */
export function findDispatch(key: string): DispatchEntry | undefined {
  return dispatchRegistry.get(key);
}

/** Schedule TTL eviction of a settled dispatch entry (no-op if already replaced). */
function scheduleDispatchEviction(key: string, entry: DispatchEntry): void {
  const timer = setTimeout(() => {
    if (dispatchRegistry.get(key) === entry) dispatchRegistry.delete(key);
  }, DISPATCH_RESULT_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Handles for a pre-spawn dispatch reservation (FLUX-844). */
export interface DispatchReservation {
  /** Fill in the real child sessionId once spawnSession() resolves. */
  setSessionId(sessionId: string): void;
  /** Resolve attached retries with the delegation result, then TTL-evict. */
  settle(result: DelegationResult): void;
  /** Release the reservation and reject attached retries (spawn itself failed). */
  fail(error: unknown): void;
}

/**
 * Reserve an idempotency key BEFORE spawn so a retry that lands *during*
 * spawnSession() attaches to this in-flight reservation instead of launching a
 * second child (FLUX-844 — closes the spawn-duration window left by the old
 * post-spawn registration: findDispatch ran before spawn but the key wasn't
 * recorded until spawn resolved, so a client-timeout retract shorter than spawn
 * latency could still double-launch).
 *
 * The reservation holds a deferred promise that attached retries await. The
 * caller fills in the real sessionId and `settle()`s it once the delegation
 * resolves, or `fail()`s it (releasing the key) if spawn itself errors — so a
 * genuinely later retry after a failed spawn can start fresh rather than attach
 * to a dead reservation.
 */
export function reserveDispatch(key: string): DispatchReservation {
  let resolveResult!: (result: DelegationResult) => void;
  let rejectResult!: (error: unknown) => void;
  const promise = new Promise<DelegationResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // If fail() rejects and no retry happened to attach, the rejection would
  // surface as an unhandledRejection. Swallow it here; real awaiters still
  // observe the rejection through their own await of entry.promise.
  void promise.catch(() => {});
  const entry: DispatchEntry = { sessionId: '', promise };
  dispatchRegistry.set(key, entry);
  return {
    setSessionId(sessionId: string) { entry.sessionId = sessionId; },
    settle(result: DelegationResult) {
      resolveResult(result);
      scheduleDispatchEviction(key, entry);
    },
    fail(error: unknown) {
      if (dispatchRegistry.get(key) === entry) dispatchRegistry.delete(key);
      rejectResult(error);
    },
  };
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

// FLUX-846: grace margin before a dead-process active session is force-terminalized. The `exit`
// handler finalizes status within milliseconds of the child exiting (it sets status only after an
// `await session.writeQueue`); this margin keeps the lazy reaper from racing that brief window while
// still healing a session whose `exit` event never finalized (lost event / zombie child) so it can
// never linger as forever-'running' with a runaway timer.
const DEAD_SESSION_GRACE_MS = 15_000;

/**
 * FLUX-846: lazily reconcile in-memory sessions whose child process has already exited but whose
 * status was never flipped to terminal — a missed/incomplete `exit` handler otherwise leaves the
 * card stuck on 'running' (runaway timer) while the engine should report the session done. Called
 * on the active-session read paths (board state, task list) so a poll/refresh self-heals the record
 * and `get_board_state` agrees with the portal panel.
 *
 * Only touches 'running'/'pending' sessions with a spawned-but-now-dead process (a real `proc` whose
 * exit/signal code is non-null) whose last sign of life predates the grace margin. A null `proc` is
 * NOT treated as dead: the only running/pending session without a `proc` is one still in the pre-spawn
 * window (`startedAt` is stamped before worktree creation + the spawn does `npm prefix -g`, which can
 * exceed the grace on a cold Windows start), and reaping it would stamp a bogus `endedAt` that the
 * later `status='running'` transition leaves behind — making a genuinely-live session read as inactive
 * forever (FLUX-846, the same bug from the opposite direction). Never 'waiting-input' (those
 * intentionally keep a dead `proc` between resumable turns) and never a live process. The lost-exit
 * scenario this heals always retains the now-dead child `proc`, so requiring one loses no coverage.
 *
 * FLUX-1144: broadcasts `taskUpdated` per reaped session. This is the ONLY path that self-heals a
 * missed exit (a clean exit already broadcasts on its own), so without this a reap would silently
 * bump nothing — leaving `/api/tasks`'s version-keyed ETag stale and the ticket's card stuck
 * reporting 'running' behind a 304 until unrelated board activity happens to bump the version. It
 * also fixes the pre-existing gap where other connected tabs never learned of a reap via SSE, only
 * their own next poll.
 */
export function reconcileDeadSessions(now: number = Date.now()): number {
  let reaped = 0;
  for (const session of cliSessionsById.values()) {
    if (session.status !== 'running' && session.status !== 'pending') continue;
    const proc = session.proc;
    const procDead = !!proc && (proc.exitCode !== null || proc.signalCode !== null);
    if (!procDead) {
      reapHungSilentSpawn(session, proc, now);
      continue;
    }
    const lastBeat = Date.parse(session.lastOutputAt ?? session.startedAt) || 0;
    if (now - lastBeat < DEAD_SESSION_GRACE_MS) continue;
    session.status = proc.exitCode === 0 ? 'completed' : 'failed';
    session.endedAt = new Date(now).toISOString();
    reaped++;
    // Best-effort display healing only: unlike the real `exit` handler this does NOT notify
    // scatter-gather/relay barriers or launch the combiner, so a truly-lost exit on a grouped worker
    // clears the card but can still leave the group/combiner stalled (acceptable — lost exits are rare).
    console.warn(`[session] reaped stale ${session.taskId} session ${session.id} (process exited, terminal event missed) → ${session.status}`);
    broadcastEvent('taskUpdated', { id: session.taskId });
  }
  return reaped;
}

// Silent-spawn watchdog: how long a spawned child may run with ZERO output (stdout or stderr —
// `lastOutputAt` stamps on both, appendSessionOutput in agents/shared.ts) before it is presumed
// hung and killed. Deliberately scoped to NEVER-output-this-turn only: a healthy CLI emits its
// stream-json init event within seconds of every turn (fresh spawn or resume), while a turn that
// HAS produced output can then legitimately go silent for many minutes inside one long-running
// tool call — so "any silence > N" would false-positive, but "no output at all since the turn
// started" cannot. 3 minutes comfortably clears a cold first launch (MCP handshakes are capped
// pre-spawn; the CLI's own init lands well under a minute even cold).
const SILENT_SPAWN_TIMEOUT_MS = 180_000;

/**
 * FLUX-1596: kill a spawned-but-silent child — the fresh-install wedge (1.8.1, macOS): a `claude` that is
 * installed but was never onboarded/logged-in can hang headless forever writing NOTHING. The
 * session then sits 'running' with a live proc, which reconcileDeadSessions' dead-proc clause can
 * never touch (proc alive) — unreapable, 409-ing every subsequent start ("… session already
 * active" / "Task already has a live CLI session") until the engine restarts, with no response
 * ever shown to the user.
 *
 * Detection: proc spawned and alive, and NO output has EVER landed for the current turn — i.e.
 * `lastOutputAt` is unset (first turn) or predates the turn's own start (`lastInputAt`, a hung
 * resume) — for more than SILENT_SPAWN_TIMEOUT_MS since the turn began. Equality counts as output
 * (a turn whose only output landed the same instant it started is alive, matching the existing
 * reconcile tests). Pre-spawn sessions (no `proc`) stay untouched for the FLUX-846 reasons above.
 *
 * Action: seed `stderrCapture` with an actionable hint, then tree-kill the child. Status is NOT
 * set here — the kill fires the normal `exit` handler (signal → non-zero path), which owns the
 * terminal bookkeeping every adapter already has: per-ticket `finalizeTerminalSession` surfaces
 * the ⚠️ line (with this stderr hint) inline in chat + raises needsAction; the board/Furnace exit
 * handler appends the transcript error event (board-core.ts). If that exit event is ever lost,
 * the next reconcile pass reaps the now-dead proc via the FLUX-846 clause above — belt and braces.
 * `hungSpawnKilledAt` latches so the lazy reaper (called from every active-session read) never
 * stacks repeat kills while the exit is still in flight.
 */
function reapHungSilentSpawn(session: CliSessionRecord, proc: CliSessionRecord['proc'], now: number): void {
  if (!proc || session.hungSpawnKilledAt) return;
  const turnStart = Math.max(
    Date.parse(session.startedAt) || 0,
    session.lastInputAt ? Date.parse(session.lastInputAt) || 0 : 0,
  );
  if (!turnStart || now - turnStart < SILENT_SPAWN_TIMEOUT_MS) return;
  const lastOutput = session.lastOutputAt ? Date.parse(session.lastOutputAt) || 0 : 0;
  if (lastOutput >= turnStart) return; // the turn HAS produced output — a long tool call, not a hang
  session.hungSpawnKilledAt = new Date(now).toISOString();
  const minutes = Math.round(SILENT_SPAWN_TIMEOUT_MS / 60_000);
  // Framework-neutral wording (adapter-boundary rule: no per-CLI literals outside agents/) — the
  // framework name itself is data off the session record, not a hardcoded CLI branch.
  const hint =
    `The agent process produced no output for ${minutes} minutes and was terminated by Event Horizon. ` +
    `This usually means the "${session.framework}" CLI cannot run headless on this machine — check that it is ` +
    `logged in and replies from a plain terminal in non-interactive (print) mode, then send your message again.`;
  session.stderrCapture = ((session.stderrCapture ?? '') + `\n${hint}`).slice(-500);
  console.warn(`[session] killing hung silent ${session.taskId} session ${session.id} (pid ${session.pid ?? proc.pid ?? '?'}) — no output since turn start ${new Date(turnStart).toISOString()}`);
  killProcessTree(proc, 'SIGKILL', { label: `hung-spawn ${session.taskId}` });
}

/** FLUX-604: all currently-active sessions across the whole board (orchestrator situational awareness). */
export function getAllActiveSessions(): CliSessionRecord[] {
  reconcileDeadSessions();
  const out: CliSessionRecord[] = [];
  for (const session of cliSessionsById.values()) {
    if (session.status === 'running' || session.status === 'waiting-input' || session.status === 'pending') {
      out.push(session);
    }
  }
  return out;
}

export function getActiveSessionCount(): number {
  reconcileDeadSessions();
  let count = 0;
  for (const session of cliSessionsById.values()) {
    if (session.status === 'running' || session.status === 'waiting-input' || session.status === 'pending') {
      count++;
    }
  }
  return count;
}

// FLUX-1338: sessions that are genuinely in flight — a live OS process, or a dispatch still in the
// pre-spawn window (createPendingSession registers the record before worktree creation + spawn
// attach a `proc`, a multi-second gap on cold Windows starts — see reconcileDeadSessions). Distinct
// from getActiveSessionCount, which also counts proc-less `waiting-input` sessions: those are
// resumable resting sessions rehydrated from on-disk stubs at boot (rehydratedRecord, no `proc`),
// so the workspace-switch guard using the broader count warned "N agent sessions running" when
// nothing was actually running. That guard must use THIS count; getActiveSessionCount stays as-is
// for checkAutoRestart's "board is idle" test (where a resumable waiting-input session legitimately
// means "not idle, don't auto-restart").
export function getLiveProcessSessionCount(): number {
  reconcileDeadSessions();
  let count = 0;
  for (const session of cliSessionsById.values()) {
    if (session.status !== 'running' && session.status !== 'waiting-input' && session.status !== 'pending') continue;
    const proc = session.proc;
    // No `proc` on a running/pending session = pre-spawn window: a switch now would strand the
    // spawn in a switched-out workspace, so it counts. No `proc` on waiting-input = rehydrated
    // resumable stub (the phantom this function exists to exclude) — never counted.
    if (proc ? proc.exitCode === null && proc.signalCode === null : session.status !== 'waiting-input') count++;
  }
  return count;
}

/**
 * FLUX-1531 (multi-workspace S13, mirrors `batchBelongsToWorkspaceRoot` — models/furnace.ts): a
 * session tagged with its own `workspaceRoot` belongs to that root; an untagged legacy/rehydrated
 * session falls back to `defaultWorkspaceRoot`.
 */
export function sessionBelongsToWorkspaceRoot(
  session: CliSessionSummary,
  workspaceRoot: string | null,
  defaultWorkspaceRoot: string | null,
): boolean {
  return (session.workspaceRoot ?? defaultWorkspaceRoot) === workspaceRoot;
}

/**
 * FLUX-1548: `getActiveSessionsForTask` narrowed to sessions belonging to `workspaceRoot`. Two boards
 * sharing a ticket id (both use the `FLUX-` prefix) each track a same-id ticket independently — without
 * this, Temper's/the gate runner's reconcile loop (`getActiveSessionsForTask(ticketId)`, keyed by bare
 * ticket id only) could adopt the OTHER board's live session for that id as its own. Mirrors
 * `getLiveProcessSessionCountForWorkspace`'s use of `sessionBelongsToWorkspaceRoot`.
 */
export function getActiveSessionsForTaskInWorkspace(
  taskId: string,
  workspaceRoot: string | null,
  defaultWorkspaceRoot: string | null,
): CliSessionRecord[] {
  return getActiveSessionsForTask(taskId).filter((s) => sessionBelongsToWorkspaceRoot(s, workspaceRoot, defaultWorkspaceRoot));
}

/** FLUX-1531: `getLiveProcessSessionCount()` narrowed to sessions belonging to `workspaceRoot`. */
export function getLiveProcessSessionCountForWorkspace(workspaceRoot: string | null, defaultWorkspaceRoot: string | null): number {
  reconcileDeadSessions();
  let count = 0;
  for (const session of cliSessionsById.values()) {
    if (session.status !== 'running' && session.status !== 'waiting-input' && session.status !== 'pending') continue;
    if (!sessionBelongsToWorkspaceRoot(session, workspaceRoot, defaultWorkspaceRoot)) continue;
    const proc = session.proc;
    if (proc ? proc.exitCode === null && proc.signalCode === null : session.status !== 'waiting-input') count++;
  }
  return count;
}

// ── Persistent active-session stubs — restart-safe worktree reclaim (FLUX-1060) ──
//
// `cliSessionsById` is in-memory only, so an engine restart (update / crash / dev reload) wipes
// every session record. The worktree-reclaim guard (`isWorktreeReclaimable`, pr-cleanup.ts) reads
// that map to answer "is a live session still on this branch?" — after a restart it sees none, so a
// ticket resting at Ready with a `waiting-input` session (the normal between-turns state, which can
// persist for hours) looks idle and the next reclaim sweep deletes its worktree out from under the
// still-resumable session (incident FLUX-1053). We persist a tiny stub per RUNNING/WAITING-INPUT
// task session under `<activeFluxDir>/sessions/<id>.json` and rehydrate them at boot as
// `waiting-input` (resumable) records, so the guard — and the chat's resume — see them again.
//
// Stubs are LOCAL runtime state: gitignored in the repo checkout and excluded from the orphan
// `flux-data` sync (storage-sync `STORE_LOCAL_IGNORES`), so they never travel between machines.
// `getActiveFluxDir()` is pinned to the engine workspace root, so a worktree agent can't redirect
// the write. Everything here is best-effort — a disk error never throws into a caller.

/** Statuses worth persisting: a live turn (`running`) or the resumable resting state
 *  (`waiting-input`). `pending` (pre-spawn) is skipped — no resume id / committed work yet, and its
 *  ticket is In Progress, which is never reclaimable. Terminal states are never persisted. */
// FLUX-1390: 'scheduled' persists too, so a sleeping session's wakeAt survives an engine restart
// (rehydratedRecord below restores it verbatim instead of collapsing it to the generic resting state).
const STUB_PERSIST_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting-input', 'scheduled']);

interface SessionStub {
  id: string;
  taskId: string;
  framework: CliFramework;
  label: string;
  startedAt: string;
  // Always rehydrated as the resumable resting state (the proc is dead) — EXCEPT 'scheduled'
  // (FLUX-1390), which carries a `wakeAt` the wake ticker still needs to honor post-restart.
  status: 'waiting-input' | 'scheduled';
  resumeSessionId?: string;
  lastOutputAt?: string;
  phase?: LaunchPhase;
  role?: string;
  /** Persisted so `getPreferredInputSessionId`'s lead-over-worker preference survives a
   *  restart — a rehydrated delegate/step stub must not read as an addressable solo session. */
  patternPosition?: PatternPosition;
  /** FLUX-1378: the live-context gauge, persisted so `resumeOrDispatchSession`'s viability check
   *  survives an engine restart (else a rehydrated stub always looks like "no usage recorded" and
   *  falls back to the turn-count proxy instead of the real gauge). */
  lastTurnContextTokens?: number;
  contextWindow?: number;
  /** FLUX-1390: only set when status === 'scheduled'. */
  wakeAt?: string;
}

// Guard so a sync can't wipe the on-disk stubs before boot rehydration has read them back: an
// empty pre-rehydrate `cliSessionsById` would otherwise look like "no active sessions → delete all".
// FLUX-1556: per-workspace-root, not a single boolean — each live board rehydrates from its own
// watcher's `ready` event independently, so board A finishing its rehydrate must not flip the guard
// for a board B that hasn't rehydrated yet (that would let B's first sync tick prune B's own unread
// on-disk stubs before B ever reads them back).
const rehydratedWorkspaceRoots = new Set<string | null>();

function sessionStubsDir(): string {
  return path.join(getActiveFluxDir(), 'sessions');
}
function sessionStubFileName(id: string): string {
  // Session ids are UUIDs; sanitize as defence-in-depth so an id can never escape the dir.
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}
function sessionStubPath(id: string): string {
  return path.join(sessionStubsDir(), sessionStubFileName(id));
}

/** The stub payload for a session, or null when it must not be persisted (terminal/pending, or a
 *  virtual conversation — the board orchestrator or Furnace chat — neither owns a task worktree,
 *  so the reclaim guard never asks about either). */
function stubFor(session: CliSessionRecord): SessionStub | null {
  if (!STUB_PERSIST_STATUSES.has(session.status)) return null;
  if (!session.taskId || isVirtualConversationId(session.taskId)) return null;
  // FLUX-1390: preserve a genuine sleep across the stub round-trip; anything else (running, or a
  // scheduled session that somehow lost its wakeAt) still collapses to the resumable resting state.
  const isScheduled = session.status === 'scheduled' && !!session.wakeAt;
  const stub: SessionStub = {
    id: session.id,
    taskId: session.taskId,
    framework: session.framework,
    label: session.label,
    startedAt: session.startedAt,
    status: isScheduled ? 'scheduled' : 'waiting-input',
  };
  if (isScheduled && session.wakeAt) stub.wakeAt = session.wakeAt;
  if (session.resumeSessionId) stub.resumeSessionId = session.resumeSessionId;
  if (session.lastOutputAt) stub.lastOutputAt = session.lastOutputAt;
  if (session.phase) stub.phase = session.phase;
  if (session.role) stub.role = session.role;
  if (session.patternPosition) stub.patternPosition = session.patternPosition;
  if (session.lastTurnContextTokens != null) stub.lastTurnContextTokens = session.lastTurnContextTokens;
  if (session.contextWindow != null) stub.contextWindow = session.contextWindow;
  return stub;
}

async function writeStub(stub: SessionStub): Promise<void> {
  const file = sessionStubPath(stub.id);
  const body = JSON.stringify(stub, null, 2);
  const tmp = `${file}.tmp`;
  try {
    await fs.writeFile(tmp, body, 'utf-8');
    await fs.rename(tmp, file);
  } catch {
    // rename can fail on some FS setups — fall back to a direct write.
    await fs.writeFile(file, body, 'utf-8').catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

function rehydratedRecord(stub: SessionStub): CliSessionRecord {
  // FLUX-1390: a rehydrated 'scheduled' stub stays asleep — the wake ticker resumes it once wakeAt
  // passes, same as it would have pre-restart. Anything else (including a 'scheduled' stub that
  // somehow lost its wakeAt) falls back to the original resumable resting state.
  const scheduled = stub.status === 'scheduled' && !!stub.wakeAt;
  return {
    id: stub.id,
    taskId: stub.taskId,
    framework: stub.framework,
    status: scheduled ? 'scheduled' : 'waiting-input',
    command: stub.framework,
    args: [],
    startedAt: stub.startedAt,
    label: stub.label,
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    ...(stub.resumeSessionId ? { resumeSessionId: stub.resumeSessionId } : {}),
    ...(stub.lastOutputAt ? { lastOutputAt: stub.lastOutputAt } : {}),
    ...(stub.phase ? { phase: stub.phase } : {}),
    ...(stub.role ? { role: stub.role } : {}),
    ...(stub.patternPosition ? { patternPosition: stub.patternPosition } : {}),
    ...(stub.lastTurnContextTokens != null ? { lastTurnContextTokens: stub.lastTurnContextTokens } : {}),
    ...(stub.contextWindow != null ? { contextWindow: stub.contextWindow } : {}),
    ...(scheduled ? { wakeAt: stub.wakeAt } : {}),
  };
}

/**
 * Reconcile the on-disk stub directory with the current in-memory active set (FLUX-1060). Writes a
 * stub for every running/waiting-input task session BELONGING TO `workspaceRoot` (FLUX-1556 —
 * `cliSessionsById` is engine-global across all live boards, so without this filter every board's
 * sessions would land in whichever workspace's dir `sessionStubsDir()` ambiently resolves to) and
 * deletes any stub in that board's own dir whose session is no longer active (it ended since the
 * last sweep — so a genuinely dead session leaves no stub to rehydrate, preserving FLUX-1031's
 * "reclaim Ready tickets with dead sessions"). Callers must wrap this call in
 * `runWithWorkspace(ws, …)` so `sessionStubsDir()`/`getActiveFluxDir()` resolve to `workspaceRoot`'s
 * own store, not whichever board happens to be ambiently active. No-op until `workspaceRoot` has
 * rehydrated at boot. Best-effort; never throws.
 */
export async function syncActiveSessionStubs(workspaceRoot: string | null, defaultWorkspaceRoot: string | null): Promise<void> {
  if (!rehydratedWorkspaceRoots.has(workspaceRoot)) return;
  try {
    const dir = sessionStubsDir();
    const stubs: SessionStub[] = [];
    const keep = new Set<string>();
    for (const session of cliSessionsById.values()) {
      if (!sessionBelongsToWorkspaceRoot(session, workspaceRoot, defaultWorkspaceRoot)) continue;
      const stub = stubFor(session);
      if (!stub) continue;
      stubs.push(stub);
      keep.add(sessionStubFileName(stub.id));
    }
    await fs.mkdir(dir, { recursive: true });
    for (const stub of stubs) await writeStub(stub);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json') || keep.has(file)) continue;
      await fs.unlink(path.join(dir, file)).catch(() => {});
    }
  } catch {
    /* best-effort — a stub-sync failure must never break the reconcile tick */
  }
}

/**
 * Boot recovery (FLUX-1060): load persisted stubs back into `cliSessionsById` as `waiting-input`
 * (resumable) records so the reclaim guard and chat resume see pre-restart sessions again. Marks
 * rehydration done so a later {@link syncActiveSessionStubs} can safely prune. Best-effort; never
 * throws. Returns the number of stubs rehydrated.
 */
export async function rehydrateSessionStubs(): Promise<number> {
  let count = 0;
  try {
    const dir = sessionStubsDir();
    if (existsSync(dir)) {
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(dir, file), 'utf-8');
          const stub = JSON.parse(raw) as SessionStub;
          if (!stub || typeof stub.id !== 'string' || typeof stub.taskId !== 'string') continue;
          if (isVirtualConversationId(stub.taskId)) continue;
          if (cliSessionsById.has(stub.id)) continue; // a live session already owns this id
          cliSessionsById.set(stub.id, rehydratedRecord(stub));
          registerSession(stub.taskId, stub.id);
          count++;
        } catch {
          /* skip a malformed stub rather than abort the whole rehydrate */
        }
      }
    }
  } catch {
    /* best-effort */
  }
  // FLUX-1556: mark THIS call's own workspace root rehydrated, not every board — this runs bound
  // inside `runWithWorkspace(ws, …)` (task-store.ts's watcher `ready` handler), so `getWorkspace()`
  // resolves to the board whose stubs were just read back.
  rehydratedWorkspaceRoots.add(getWorkspace().root);
  return count;
}

// ── Post-restart reclaim grace (FLUX-1060, belt-and-suspenders) ───────────────
// A short window after boot during which the worktree-reclaim guard also honors a ticket's OWN
// recent session history (pr-cleanup `hasRecentSessionActivity`). It covers the narrow gap where a
// session entered `waiting-input` AFTER the last stub sweep but BEFORE the restart, so no stub was
// ever written for it. Armed once at boot (right after rehydration); inert otherwise, so steady-
// state reclaim timing (FLUX-1031) is unchanged.
export const RECLAIM_GRACE_MS = 5 * 60_000;
let reclaimGraceUntil = 0;
export function armReclaimGrace(now: number = Date.now()): void {
  reclaimGraceUntil = now + RECLAIM_GRACE_MS;
}
export function isWithinReclaimGrace(now: number = Date.now()): boolean {
  return now < reclaimGraceUntil;
}

// Test-only: reset the stub/grace module state between cases.
export function __resetSessionStubStateForTests(): void {
  rehydratedWorkspaceRoots.clear();
  reclaimGraceUntil = 0;
}

export function stopAllCliSessions(reason: string) {
  for (const session of cliSessionsById.values()) {
    if (!session.proc) continue;
    if (session.status === 'running' || session.status === 'waiting-input' || session.status === 'pending') {
      session.requestedStop = true;
      try {
        killProcessTree(session.proc);
      } catch (error) {
        console.warn(`Failed to stop CLI session ${session.id} during ${reason}:`, error);
      }
    }
  }
}

/**
 * FLUX-1531: `stopAllCliSessions()` narrowed to sessions belonging to `workspaceRoot` — leaves
 * other workspaces' sessions running. NOT a replacement for `stopAllCliSessions`, which the
 * engine-wide shutdown/signal/crash teardown paths must keep calling.
 */
export function stopCliSessionsForWorkspace(workspaceRoot: string | null, defaultWorkspaceRoot: string | null, reason: string) {
  for (const session of cliSessionsById.values()) {
    if (!session.proc) continue;
    if (!sessionBelongsToWorkspaceRoot(session, workspaceRoot, defaultWorkspaceRoot)) continue;
    if (session.status === 'running' || session.status === 'waiting-input' || session.status === 'pending') {
      session.requestedStop = true;
      try {
        killProcessTree(session.proc);
      } catch (error) {
        console.warn(`Failed to stop CLI session ${session.id} during ${reason}:`, error);
      }
    }
  }
}

// ── Auto-restart on idle ─────────────────────────────────────────────────────

type AutoRestartCallback = () => void;
let autoRestartCallback: AutoRestartCallback | null = null;

export function setAutoRestartCallback(fn: AutoRestartCallback): void {
  autoRestartCallback = fn;
}

export function checkAutoRestart(): void {
  if (autoRestartCallback && getActiveSessionCount() === 0) {
    autoRestartCallback();
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
        killProcessTree(session.proc);
      } catch (error) {
        console.warn(`Failed to stop session ${session.id} for task ${taskId} during ${reason}:`, error);
      }
    }
  }
  // FLUX-985: every session for this task is being torn down (worktree detach / ticket delete /
  // stop&merge), so any HITL prompt still parked on this conversation can never be answered — settle
  // it now instead of letting it linger to its full timeout (which would fire a spurious needsAction
  // on a deliberately-stopped ticket and res.json() a closed socket). Not done in stopAllCliSessions
  // (shutdown), where the durable index must survive for rehydrateOpenPrompts.
  try {
    settleOpenPromptsForConversation(taskId);
  } catch (error) {
    console.warn(`Failed to settle open prompts for task ${taskId} during ${reason}:`, error);
  }
}

// Terminalize STALE PARKED PHASE sessions for a task (status 'waiting-input', phase !== 'chat').
// A parked phase session waits for input relevant to the ticket's PRIOR status; once the ticket
// advances (by another actor or a sibling session), that question is abandoned and the session
// would otherwise linger forever — "active" enough to gate merges (FLUX-636 Tier-2) and 409 new
// starts (FLUX-667). Unlike stopAllSessionsForTask this is deliberately narrow:
//   • only 'waiting-input' → never kills the live calling agent / an active group (they're 'running').
//   • only phase !== 'chat' → the persistent per-ticket chat conversation (FLUX-602) must survive
//     status changes; it is not bound to a single phase.
// Idempotent: reaped sessions are no longer 'waiting-input', so a second call is a no-op.
// Returns the sessions it terminalized so callers can record an activity note (FLUX-721).
export function reapStaleParkedSessions(taskId: string, reason: string): CliSessionRecord[] {
  const reaped = getParkedSessionsForTask(taskId).filter(s => s.phase !== 'chat');
  const now = new Date().toISOString();
  for (const session of reaped) {
    session.requestedStop = true;
    session.status = 'cancelled';
    session.endedAt = now;
    if (session.proc) {
      try {
        killProcessTree(session.proc);
      } catch (error) {
        console.warn(`Failed to reap stale parked session ${session.id} for task ${taskId} during ${reason}:`, error);
      }
    }
  }
  return reaped;
}

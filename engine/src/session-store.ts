import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CliSessionRecord, CliSessionSummary, CliFramework, ExecutionPattern, PatternPosition, LaunchPhase } from './agents/types.js';
import { CLI_CAPABILITIES as capabilities } from './agents/types.js';
import { killProcessTree } from './kill-process-tree.js';
import { settleOpenPromptsForConversation } from './hitl-prompts.js';
import { getActiveFluxDir } from './workspace.js';
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
  if (session.groupTotal != null) summary.groupTotal = session.groupTotal;
  if (session.groupType) summary.groupType = session.groupType;
  if (session.groupVariant) summary.groupVariant = session.groupVariant;
  if (session.lockedPaths) summary.lockedPaths = session.lockedPaths;
  if (session.outputData) summary.outputData = session.outputData;
  // FLUX-606: the chat can continue (`claude --resume`) any terminal-or-active session
  // that has a known resumeSessionId — including a dispatched grooming session that ended
  // `completed`. Expose a boolean (not the raw id) so the frontend resumes that thread
  // instead of starting a fresh, amnesiac chat.
  summary.resumable = ['running', 'waiting-input', 'completed'].includes(session.status) && !!session.resumeSessionId;
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

// Max `liveOutput` length (chars) retained per session on the LIST endpoint.
// Cards only need a short preview; the detail endpoint keeps the full buffer.
const LIST_LIVE_OUTPUT_TAIL = 2048;
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting-input']);

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
    .filter((s): s is CliSessionRecord => !!s && ['pending', 'running', 'waiting-input'].includes(s.status));
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
    if (!procDead) continue;
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
const STUB_PERSIST_STATUSES: ReadonlySet<string> = new Set(['running', 'waiting-input']);

interface SessionStub {
  id: string;
  taskId: string;
  framework: CliFramework;
  label: string;
  startedAt: string;
  status: 'waiting-input'; // always rehydrated as the resumable resting state (the proc is dead)
  resumeSessionId?: string;
  lastOutputAt?: string;
  phase?: LaunchPhase;
  role?: string;
}

// Guard so a sync can't wipe the on-disk stubs before boot rehydration has read them back: an
// empty pre-rehydrate `cliSessionsById` would otherwise look like "no active sessions → delete all".
let stubsRehydrated = false;

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
  const stub: SessionStub = {
    id: session.id,
    taskId: session.taskId,
    framework: session.framework,
    label: session.label,
    startedAt: session.startedAt,
    status: 'waiting-input',
  };
  if (session.resumeSessionId) stub.resumeSessionId = session.resumeSessionId;
  if (session.lastOutputAt) stub.lastOutputAt = session.lastOutputAt;
  if (session.phase) stub.phase = session.phase;
  if (session.role) stub.role = session.role;
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
  return {
    id: stub.id,
    taskId: stub.taskId,
    framework: stub.framework,
    status: 'waiting-input',
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
  };
}

/**
 * Reconcile the on-disk stub directory with the current in-memory active set (FLUX-1060). Writes a
 * stub for every running/waiting-input task session and deletes any stub whose session is no longer
 * active (it ended since the last sweep — so a genuinely dead session leaves no stub to rehydrate,
 * preserving FLUX-1031's "reclaim Ready tickets with dead sessions"). Called on the engine reconcile
 * tick. No-op until stubs have been rehydrated at boot. Best-effort; never throws.
 */
export async function syncActiveSessionStubs(): Promise<void> {
  if (!stubsRehydrated) return;
  try {
    const dir = sessionStubsDir();
    const stubs: SessionStub[] = [];
    const keep = new Set<string>();
    for (const session of cliSessionsById.values()) {
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
  stubsRehydrated = true;
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
  stubsRehydrated = false;
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

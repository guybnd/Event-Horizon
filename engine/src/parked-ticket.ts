/**
 * FLUX-651 — "agent sat on its hands" backstop.
 *
 * Agents working a ticket in chat routinely finish the work but end the turn with only a
 * chat summary, never calling `change_status`. The ticket then sits in a working status
 * (Grooming / In Progress) with completed — often uncommitted — work, and nothing on the
 * board signals it: the user can't tell a parked agent from a working one.
 *
 * Prompt instructions alone don't fix this (the agent ignores "move to Ready" when it judges
 * the turn "discussion"), so enforcement is engine-side: at every clean turn end we compare
 * the ticket's state against a snapshot taken at turn start. If the ticket is still in a
 * working status and the agent took NO board action this turn (status unchanged, no
 * Require-Input swimlane, no new subtask), we SURFACE it — a deduped notification plus a
 * persisted `needsAction` flag the board renders as a "Needs Action" group (decision: surface
 * to the user, do NOT auto-resume).
 */
import { getWorkspace } from './workspace-context.js';
import { getConfig } from './config.js';
import { updateTaskWithHistory } from './task-store.js';
import { generateNeedsActionNotification } from './notifications.js';
import { isAgentAuthor } from './history.js';
import { broadcastEvent } from './events.js';
import type { CliSessionRecord } from './agents/types.js';

/** The subset of a ticket's shape this module reads/writes. Tickets are loosely-typed
 *  gray-matter frontmatter records validated at runtime (schema.ts) — this covers only the
 *  fields this module actually touches. */
interface HistoryEntry {
  type?: string;
  user?: unknown;
}

interface ParkableTask {
  status?: string;
  swimlane?: string | null;
  subtasks?: unknown[];
  history?: HistoryEntry[];
  needsAction?: string | null;
  title?: string;
}

/** Statuses where an agent turn is expected to END on a board action. Grooming should leave
 *  for Todo/Require Input; In Progress should leave for Ready/Require Input. Resting columns
 *  (Todo/Backlog/Ready/Done/…) are not HARD-flagged — nothing is "stuck" there — but FLUX-826
 *  adds a SOFT backstop for them (see {@link isParked}). */
function workingStatuses(): Set<string> {
  return new Set(['Grooming', 'In Progress']);
}

/** Count agent-authored `comment` entries in a ticket's history. Used to detect a NEW agent
 *  comment posted during a turn (the FLUX-826 soft backstop signal). User comments are excluded
 *  via {@link isAgentAuthor} so a human replying mid-turn never trips the nudge. */
export function countAgentComments(task: ParkableTask | undefined): number {
  const history = Array.isArray(task?.history) ? task.history : [];
  let n = 0;
  for (const e of history) {
    if (e && e.type === 'comment' && isAgentAuthor(e.user)) n++;
  }
  return n;
}

export interface ParkedSnapshot {
  /** Ticket status now (turn end). */
  status: string;
  /** Ticket status when the turn began. */
  statusAtTurnStart?: string | undefined;
  /** Current swimlane (the agent raises 'require-input' when it asks a question). */
  swimlane?: string | null | undefined;
  /** Subtask count now vs. at turn start (a new subtask is a review action). */
  subtaskCount: number;
  subtaskCountAtTurnStart?: number | undefined;
  /** FLUX-826: agent-comment count now vs. at turn start. A NEW agent comment on a resting
   *  status with no board action is the soft "left an open item" signal. Optional/defaulted so
   *  callers (and tests) that only care about the working-status path can omit it. */
  commentCount?: number | undefined;
  commentCountAtTurnStart?: number | undefined;
  /** FLUX-826: did the agent raise a structured `ask_user_question` this turn? If so the
   *  question route already owns the safety net (it raises needsAction on timeout), so the soft
   *  comment backstop must NOT also fire — avoids double-surfacing one deliberative turn. */
  askedThisTurn?: boolean | undefined;
  /** Workspace's Require Input status name. */
  requireInputStatus: string;
  /** Scatter-gather / delegated member — its orchestrator owns the transition, so never flag. */
  isDelegated: boolean;
  /** FLUX-1320: a `needsAction` flag already standing at turn end. The flag is cleared at every turn
   *  start ({@link clearNeedsActionIfSet}), so a standing one was raised DURING this turn by a more
   *  specific path — the plan gate's eager verdict stop, an `ask_user_question` timeout. The generic
   *  backstop must defer to it: re-raising would keep the flag (the write is idempotent) but refresh
   *  the deduped notification with the generic message, degrading the specific one. */
  needsActionSet?: boolean | undefined;
}

/**
 * Pure decision: did the agent park? Extracted from the I/O so it can be unit-tested. "Board
 * action" = status moved, Require Input raised, or a subtask created.
 *
 * Two regimes:
 *  - **Working status (Grooming / In Progress)** — HARD backstop (FLUX-651): the turn is
 *    expected to end on a board action; absence of one parks it.
 *  - **Resting / terminal status (Todo / Ready / Done / …)** — SOFT backstop (FLUX-826): nothing
 *    is "stuck" there, BUT if the agent left a NEW comment this turn (often a decision/question
 *    in prose) and took no board action — and did not route it through `ask_user_question` —
 *    surface it, so a decision raised on a closed ticket isn't silently lost.
 */
export function isParked(s: ParkedSnapshot): boolean {
  if (s.isDelegated) return false;
  if (s.needsActionSet) return false; // already surfaced this turn with a more specific message

  const statusChanged = s.statusAtTurnStart !== undefined && s.statusAtTurnStart !== s.status;
  const raisedRequireInput = s.swimlane === 'require-input' || s.status === s.requireInputStatus;
  const createdSubtask = s.subtaskCount > (s.subtaskCountAtTurnStart ?? s.subtaskCount);
  const tookBoardAction = statusChanged || raisedRequireInput || createdSubtask;

  if (workingStatuses().has(s.status)) return !tookBoardAction;

  // Resting/terminal: only nudge when the agent actually left a fresh comment this turn.
  const addedComment = (s.commentCount ?? 0) > (s.commentCountAtTurnStart ?? s.commentCount ?? 0);
  return addedComment && !tookBoardAction && !s.askedThisTurn;
}

/** Capture the ticket's status + subtask & agent-comment counts at the start of a turn, so the
 *  turn-end backstop can tell whether the agent advanced the ticket or just parked. Also resets
 *  the per-turn `askedThisTurn` flag (set later if the agent calls `ask_user_question`). */
export function captureTurnStartState(session: CliSessionRecord, taskId: string): void {
  const task = getWorkspace().tasks[taskId] as ParkableTask | undefined;
  session.statusAtTurnStart = task?.status;
  session.subtaskCountAtTurnStart = Array.isArray(task?.subtasks) ? task.subtasks.length : 0;
  session.commentCountAtTurnStart = countAgentComments(task);
  session.askedThisTurn = false;
}

/** True for sessions that are NOT expected to drive the ticket's status themselves —
 *  scatter-gather workers / supervisor delegates. Their orchestrator owns the transition, so
 *  flagging them would be a false positive. Group LEADS (a supervisor orchestrator, a
 *  scatter-gather combiner) are deliberately NOT exempt even though they carry the same
 *  `groupId`: the lead IS the orchestrator that owns the transition, so a parked lead means
 *  nobody is driving the ticket (FLUX-1436). (Real incident: a supervisor dev-lead fanned out 11 workers,
 *  ended its turn "waiting for the stabilization signal" with no wakeup armed and no combiner
 *  registered — the old blanket `groupId` exemption silently swallowed the backstop and the
 *  ticket sat In Progress unflagged.) Exported so other pre-spawn-failure call sites (e.g.
 *  `prepareAndLaunchSession` in cli-session.ts) can apply the same guard as {@link flagIfParked}. */
export function isDelegatedMember(session: CliSessionRecord): boolean {
  return (!!session.groupId && session.patternPosition !== 'lead') || session.patternPosition === 'step';
}

/** Clear the `needsAction` flag if it is currently set — used when a fresh turn begins so a
 *  resumed/poked ticket stops showing as parked the moment work restarts. No-op (no write)
 *  when the flag isn't set, so it costs nothing on the common path. */
export async function clearNeedsActionIfSet(taskId: string): Promise<void> {
  const task = getWorkspace().tasks[taskId] as ParkableTask | undefined;
  if (!task?.needsAction) return;
  await updateTaskWithHistory(taskId, { updatedBy: 'Agent', entries: [], extraFields: { needsAction: null } });
  broadcastEvent('taskUpdated', { id: taskId });
}

/**
 * FLUX-826: raise the persistent `needsAction` flag + a deduped notification on a ticket,
 * idempotently. The single board-visible safety net shared by the turn-end parked backstop
 * ({@link flagIfParked}) and the `ask_user_question` timeout path, so a decision/question left
 * unattended on ANY status — including a resting/terminal one — surfaces instead of evaporating.
 *
 * Guards on a REAL ticket: `__board__` and unrouted ids aren't in `tasksCache`, so they no-op.
 * The flag is written only when not already set (survives engine restart); the notification is
 * (re)issued every call so a repeat keeps the existing entry fresh rather than stacking.
 */
export async function raiseNeedsAction(taskId: string, message: string): Promise<void> {
  try {
    // FLUX-908: the board orchestrator (`__board__`) is not a ticket in getWorkspace().tasks, so the
    // needsAction FLAG can't be set on it — but a timed-out board prompt MUST still pull the user
    // back. Previously this no-op'd here (the id is truthy, so it passes settle()'s guard, then bails
    // on the missing task), so an orchestrator question the user never saw vanished on timeout. Emit
    // a board-targeted notification instead (NotificationPanel routes `__board__` to "Open chat").
    // A genuinely unrouted (null/absent) id still legitimately no-ops below.
    if (taskId === '__board__') {
      generateNeedsActionNotification(taskId, 'Orchestrator', '', message);
      return;
    }
    const task = getWorkspace().tasks[taskId] as ParkableTask | undefined;
    if (!task) return;
    if (!task.needsAction) {
      await updateTaskWithHistory(taskId, {
        updatedBy: 'Agent',
        entries: [],
        extraFields: { needsAction: message },
      });
      broadcastEvent('taskUpdated', { id: taskId });
    }
    generateNeedsActionNotification(taskId, task.title || taskId, task.status ?? '', message);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[parked-ticket] raiseNeedsAction failed for ${taskId}:`, message);
  }
}

// FLUX-1432: phrases that promise the turn will resume itself once some external condition
// clears ("I'll wait for the build, then run tests"). `tryEnterScheduledWake` (claude-code.ts)
// unconditionally excludes `phase === 'chat'` from the real honored-wakeup mechanism, so a chat
// turn narrating one of these makes an empty promise — the turn just ends `waiting-input` and
// nothing polls or resumes it (real incident: FLUX-1428, a chat session sat 30+ minutes after
// promising to check back). Heuristic/best-effort by design: a false negative (unusual phrasing)
// just falls back to silent waiting-input as before; a false positive costs one extra needsAction
// nudge on a turn that already ended waiting-input, which is cheap.
// The `continu(e|ing) to wait` branch (FLUX-1436) catches the supervisor-lead incident phrasing
// ("Continuing to wait for the stabilization signal") — a self-promise with no leading
// "I'll/let me", kept deliberately narrow (requires the full "continue to wait" idiom) so
// ordinary "waiting for your reply" chat narration never matches.
const WAIT_PROMISE_RE = /\b(?:i'?ll|i will|let me|going to)\s+(?:pause|wait|hold off|sit tight|check back|come back|circle back)\b|\bcontinu(?:e|ing)\s+to\s+wait\b/i;

/** Does `text` narrate a promise to wait/pause and resume on its own? See {@link WAIT_PROMISE_RE}. */
export function narratesUnarmedWaitPromise(text: string | undefined | null): boolean {
  return !!text && WAIT_PROMISE_RE.test(text);
}

/**
 * FLUX-1432: called alongside {@link flagIfParked} for a chat-phase turn that ended
 * `waiting-input` cleanly (not a Require-Input pause, not a user stop — the only way a chat
 * session reaches `waiting-input`, since chat can never arm a real ScheduleWakeup). If the
 * agent's last message narrated an "I'll wait/pause for X" promise, that promise is empty —
 * surface it via the same needsAction + notification plumbing as the generic parked backstop,
 * with a message that names the false promise instead of the generic "no board action" one.
 * Call this BEFORE `flagIfParked` so a detected promise's message wins the flag text; the
 * generic backstop then no-ops (`needsActionSet` already true). No-op when the text doesn't
 * match — the common case, costing nothing beyond the regex test.
 */
export async function flagIfUnarmedWaitPromise(taskId: string, lastAssistantText: string | undefined): Promise<void> {
  if (!narratesUnarmedWaitPromise(lastAssistantText)) return;
  await raiseNeedsAction(
    taskId,
    'Agent ended its turn saying it would wait/pause and resume automatically, but chat sessions have no armed wakeup mechanism to honor that — nothing will continue this turn on its own. Reply to resume it.',
  );
}

/**
 * FLUX-1436 (FLUX-1432 extension for NON-chat turns): a group LEAD (supervisor orchestrator / scatter-gather
 * combiner) that ends a turn terminally — i.e. with NO wakeup armed, since `tryEnterScheduledWake`
 * already claimed any turn honoring a real ScheduleWakeup — while narrating an "I'll wait for X"
 * promise has made the same empty promise a chat session does: unless a deferred combiner is still
 * registered for its group, nothing will resume it, and (post the {@link isDelegatedMember} fix)
 * nobody else owns the transition either. Pure decision, same split as
 * isParked/narratesUnarmedWaitPromise: the adapter supplies the group/pending-combiner facts and
 * passes the returned message to {@link flagIfParked}, which uses it ONLY when the turn actually
 * parked — a lead that took a board action is never flagged just for saying "I'll wait".
 */
export function leadUnarmedWaitMessage(opts: {
  patternPosition?: string | undefined;
  groupId?: string | undefined;
  /** Is a deferred gather/combiner step still registered for this session's group?
   *  (session-store's `getPendingCombiner` — injected to avoid a module cycle via hitl-prompts.) */
  hasPendingCombiner: boolean;
  /** The turn's final assistant text. */
  lastText: string | undefined | null;
}): string | undefined {
  if (opts.patternPosition !== 'lead' || !opts.groupId) return undefined;
  if (opts.hasPendingCombiner) return undefined; // the registered gather step will resume this group
  if (!narratesUnarmedWaitPromise(opts.lastText)) return undefined;
  return 'Agent orchestrator ended its turn saying it would keep waiting, but nothing is armed to resume it — no scheduled wakeup and no pending gather step — so nothing will continue this turn on its own. Resume the session or advance the ticket.';
}

/** Build the {@link ParkedSnapshot} `isParked` decides on, from the live ticket + session-turn-start
 *  state. Extracted from {@link flagIfParked} (FLUX-1437) so a caller can ask "would this turn
 *  park?" — e.g. the claude adapter's stale-wait catch-and-resume, which must decide BEFORE
 *  `flagIfParked` raises the flag — without duplicating the snapshot-building logic. Returns
 *  undefined for an unrouted/missing task, same as `flagIfParked`'s own early return. */
function computeParkedSnapshot(session: CliSessionRecord, taskId: string): { task: ParkableTask; snapshot: ParkedSnapshot } | undefined {
  const task = getWorkspace().tasks[taskId] as ParkableTask | undefined;
  if (!task) return undefined;
  const status: string = task.status ?? '';
  return {
    task,
    snapshot: {
      status,
      statusAtTurnStart: session.statusAtTurnStart,
      swimlane: task.swimlane,
      subtaskCount: Array.isArray(task.subtasks) ? task.subtasks.length : 0,
      subtaskCountAtTurnStart: session.subtaskCountAtTurnStart,
      commentCount: countAgentComments(task),
      commentCountAtTurnStart: session.commentCountAtTurnStart,
      askedThisTurn: session.askedThisTurn,
      requireInputStatus: getConfig().requireInputStatus || 'Require Input',
      isDelegated: isDelegatedMember(session),
      needsActionSet: !!task.needsAction,
    },
  };
}

/** FLUX-1437: pure "would this turn park?" check — the same decision {@link flagIfParked} uses
 *  internally, exposed so a caller can intercept BEFORE the flag is raised (the stale-wait
 *  catch-and-resume in the claude adapter: resume the session instead of parking it). */
export function wouldPark(session: CliSessionRecord, taskId: string): boolean {
  const built = computeParkedSnapshot(session, taskId);
  return !!built && isParked(built.snapshot);
}

/**
 * Called at every CLEAN turn end (completed / waiting-input — never cancelled/failed). If the
 * agent parked — working status with no board action (HARD, FLUX-651), or a resting status left
 * with a fresh comment and no board action (SOFT, FLUX-826) — set the `needsAction` flag and
 * raise a deduped notification. Idempotent and best-effort.
 *
 * `unarmedWaitMessage` (optional): a caller-detected {@link leadUnarmedWaitMessage} — when the
 * turn parked, it replaces the generic text so the flag names the false "I'll keep waiting"
 * promise instead. It never widens the decision: a turn that took a board action stays unflagged.
 */
export async function flagIfParked(session: CliSessionRecord, taskId: string, unarmedWaitMessage?: string): Promise<void> {
  try {
    const built = computeParkedSnapshot(session, taskId);
    if (!built) return;
    const { snapshot } = built;
    if (!isParked(snapshot)) return;

    const isWorking = workingStatuses().has(snapshot.status);
    const message = unarmedWaitMessage
      ?? (isWorking
        ? `Agent ended its turn with the ticket still in "${snapshot.status}" without taking a board action (move it to Ready / Require Input, create subtasks, or resume).`
        : `Agent left a comment on this "${snapshot.status}" ticket without raising a structured prompt or taking a board action — it may contain a decision/question that needs your attention.`);
    await raiseNeedsAction(taskId, message);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[parked-ticket] flagIfParked failed for ${taskId}:`, message);
  }
}

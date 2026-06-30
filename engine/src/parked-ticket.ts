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
import { configCache } from './config.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { generateNeedsActionNotification } from './notifications.js';
import { isAgentAuthor } from './history.js';
import { broadcastEvent } from './events.js';
import type { CliSessionRecord } from './agents/types.js';

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
export function countAgentComments(task: any): number {
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
  const task = tasksCache[taskId] as any;
  session.statusAtTurnStart = task?.status;
  session.subtaskCountAtTurnStart = Array.isArray(task?.subtasks) ? task.subtasks.length : 0;
  session.commentCountAtTurnStart = countAgentComments(task);
  session.askedThisTurn = false;
}

/** True for sessions that are NOT expected to drive the ticket's status themselves —
 *  scatter-gather / delegated members. Their orchestrator owns the transition, so flagging
 *  them would be a false positive. */
function isDelegatedMember(session: CliSessionRecord): boolean {
  return !!session.groupId || session.patternPosition === 'step';
}

/** Clear the `needsAction` flag if it is currently set — used when a fresh turn begins so a
 *  resumed/poked ticket stops showing as parked the moment work restarts. No-op (no write)
 *  when the flag isn't set, so it costs nothing on the common path. */
export async function clearNeedsActionIfSet(taskId: string): Promise<void> {
  const task = tasksCache[taskId] as any;
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
    // FLUX-908: the board orchestrator (`__board__`) is not a ticket in tasksCache, so the
    // needsAction FLAG can't be set on it — but a timed-out board prompt MUST still pull the user
    // back. Previously this no-op'd here (the id is truthy, so it passes settle()'s guard, then bails
    // on the missing task), so an orchestrator question the user never saw vanished on timeout. Emit
    // a board-targeted notification instead (NotificationPanel routes `__board__` to "Open chat").
    // A genuinely unrouted (null/absent) id still legitimately no-ops below.
    if (taskId === '__board__') {
      generateNeedsActionNotification(taskId, 'Orchestrator', '', message);
      return;
    }
    const task = tasksCache[taskId] as any;
    if (!task) return;
    if (!task.needsAction) {
      await updateTaskWithHistory(taskId, {
        updatedBy: 'Agent',
        entries: [],
        extraFields: { needsAction: message },
      });
      broadcastEvent('taskUpdated', { id: taskId });
    }
    generateNeedsActionNotification(taskId, task.title || taskId, task.status, message);
  } catch (err: any) {
    console.error(`[parked-ticket] raiseNeedsAction failed for ${taskId}:`, err?.message);
  }
}

/**
 * Called at every CLEAN turn end (completed / waiting-input — never cancelled/failed). If the
 * agent parked — working status with no board action (HARD, FLUX-651), or a resting status left
 * with a fresh comment and no board action (SOFT, FLUX-826) — set the `needsAction` flag and
 * raise a deduped notification. Idempotent and best-effort.
 */
export async function flagIfParked(session: CliSessionRecord, taskId: string): Promise<void> {
  try {
    const task = tasksCache[taskId] as any;
    if (!task) return;

    const status: string = task.status;
    const isWorking = workingStatuses().has(status);
    const parked = isParked({
      status,
      statusAtTurnStart: session.statusAtTurnStart,
      swimlane: task.swimlane,
      subtaskCount: Array.isArray(task.subtasks) ? task.subtasks.length : 0,
      subtaskCountAtTurnStart: session.subtaskCountAtTurnStart,
      commentCount: countAgentComments(task),
      commentCountAtTurnStart: session.commentCountAtTurnStart,
      askedThisTurn: session.askedThisTurn,
      requireInputStatus: (configCache as any).requireInputStatus || 'Require Input',
      isDelegated: isDelegatedMember(session),
    });
    if (!parked) return;

    const message = isWorking
      ? `Agent ended its turn with the ticket still in "${status}" without taking a board action (move it to Ready / Require Input, create subtasks, or resume).`
      : `Agent left a comment on this "${status}" ticket without raising a structured prompt or taking a board action — it may contain a decision/question that needs your attention.`;
    await raiseNeedsAction(taskId, message);
  } catch (err: any) {
    console.error(`[parked-ticket] flagIfParked failed for ${taskId}:`, err?.message);
  }
}

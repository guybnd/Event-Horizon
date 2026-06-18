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
import { broadcastEvent } from './events.js';
import type { CliSessionRecord } from './agents/types.js';

/** Statuses where an agent turn is expected to END on a board action. Grooming should leave
 *  for Todo/Require Input; In Progress should leave for Ready/Require Input. Resting columns
 *  (Todo/Backlog/Ready/Done/…) are not flagged — nothing is "stuck" there. */
function workingStatuses(): Set<string> {
  return new Set(['Grooming', 'In Progress']);
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
  /** Workspace's Require Input status name. */
  requireInputStatus: string;
  /** Scatter-gather / delegated member — its orchestrator owns the transition, so never flag. */
  isDelegated: boolean;
}

/**
 * Pure decision: did the agent park (finish a turn in a working status without taking a board
 * action)? Extracted from the I/O so it can be unit-tested. "Action" = status moved, Require
 * Input raised, or a subtask created. Branchless vs. branched is irrelevant here — both reach
 * this the same way.
 */
export function isParked(s: ParkedSnapshot): boolean {
  if (s.isDelegated) return false;
  if (!workingStatuses().has(s.status)) return false;
  const statusChanged = s.statusAtTurnStart !== undefined && s.statusAtTurnStart !== s.status;
  const raisedRequireInput = s.swimlane === 'require-input' || s.status === s.requireInputStatus;
  const createdSubtask = s.subtaskCount > (s.subtaskCountAtTurnStart ?? s.subtaskCount);
  return !(statusChanged || raisedRequireInput || createdSubtask);
}

/** Capture the ticket's status + subtask count at the start of a turn, so the turn-end
 *  backstop can tell whether the agent advanced the ticket or just parked. */
export function captureTurnStartState(session: CliSessionRecord, taskId: string): void {
  const task = tasksCache[taskId] as any;
  session.statusAtTurnStart = task?.status;
  session.subtaskCountAtTurnStart = Array.isArray(task?.subtasks) ? task.subtasks.length : 0;
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
 * Called at every CLEAN turn end (completed / waiting-input — never cancelled/failed). If the
 * agent parked — ticket still in a working status, no action taken this turn — set the
 * `needsAction` flag and raise a deduped notification. Idempotent and best-effort.
 */
export async function flagIfParked(session: CliSessionRecord, taskId: string): Promise<void> {
  try {
    const task = tasksCache[taskId] as any;
    if (!task) return;

    const status: string = task.status;
    const parked = isParked({
      status,
      statusAtTurnStart: session.statusAtTurnStart,
      swimlane: task.swimlane,
      subtaskCount: Array.isArray(task.subtasks) ? task.subtasks.length : 0,
      subtaskCountAtTurnStart: session.subtaskCountAtTurnStart,
      requireInputStatus: (configCache as any).requireInputStatus || 'Require Input',
      isDelegated: isDelegatedMember(session),
    });
    if (!parked) return;

    // Parked. Persist the flag (survives engine restart) and surface it.
    if (!task.needsAction) {
      await updateTaskWithHistory(taskId, {
        updatedBy: 'Agent',
        entries: [],
        extraFields: {
          needsAction: `Agent ended its turn with the ticket still in "${status}" without taking a board action (move it to Ready / Require Input, create subtasks, or resume).`,
        },
      });
      broadcastEvent('taskUpdated', { id: taskId });
    }
    generateNeedsActionNotification(taskId, task.title || taskId, status);
  } catch (err: any) {
    console.error(`[parked-ticket] flagIfParked failed for ${taskId}:`, err?.message);
  }
}

import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';

/**
 * Deck folding rules (FLUX-580). A "deck" is a card that absorbs related tickets and hides
 * them from their own column until unwound — first shipped for PR members (FLUX-567), now
 * generalized to epic → subtasks. These helpers are the single source of truth for "is this
 * child folded into its parent", shared by Board (column exclusion) and the epic card (deck
 * contents) so the two can never drift.
 */

/**
 * Set of ticket ids folded into a PR deck (every PR ticket's members). PR membership takes
 * precedence over epic folding — a ticket that is both a PR member and an epic subtask folds
 * into the PR deck only, never both.
 */
export function collectPrMemberIds(tasks: Iterable<Task>): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.kind === 'pr') (t.members ?? []).forEach((m) => ids.add(m));
  }
  return ids;
}

/**
 * Whether a subtask folds into its epic's deck: it shares the epic's column (same status)
 * AND isn't already folded into a PR deck. Cross-column subtasks stay in their own column.
 */
export function isFoldedIntoEpic(epic: Task, subtask: Task, prMemberIds: ReadonlySet<string>): boolean {
  return subtask.status === epic.status && !prMemberIds.has(subtask.id);
}

/**
 * This epic's same-column, non-PR-folded subtasks — the contents of its board deck. `epic`
 * carries the resolved children already; pass them in (the controller/Board resolve ids → tasks).
 */
export function epicDeckSubtasks(epic: Task, resolvedSubtasks: readonly Task[], prMemberIds: ReadonlySet<string>): Task[] {
  return resolvedSubtasks.filter((s) => isFoldedIntoEpic(epic, s, prMemberIds));
}

/**
 * Every epic's folded subtask ids across the board — the union Board removes from columns.
 * Mirrors {@link collectPrMemberIds} for the epic relationship; PR-folded ids are excluded
 * (precedence). `byId` resolves a subtask id → task (Board's local task map).
 */
export function collectEpicFoldedIds(tasks: Iterable<Task>, byId: ReadonlyMap<string, Task>, prMemberIds: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const epic of tasks) {
    if (!epic.subtasks?.length) continue;
    for (const entry of epic.subtasks) {
      const childId = normalizeSubtaskId(entry);
      if (prMemberIds.has(childId)) continue; // PR precedence
      const child = byId.get(childId);
      if (child && isFoldedIntoEpic(epic, child, prMemberIds)) ids.add(childId);
    }
  }
  return ids;
}

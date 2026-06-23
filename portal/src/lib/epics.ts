import type { Config, Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { getArchiveStatus } from '../workflow';

/**
 * Epic rollup — the single source of truth for "what is an epic" and "how complete is it"
 * (FLUX-678). The board card (via useTaskCardController) and the Epics/roadmap screen both
 * route through here so done/total can never drift between the two surfaces.
 *
 * An epic is any task with ≥1 subtask. Completion is count-based: subtasks whose status is in
 * the done set (Done / Released / the configured archive status) over the total subtask count.
 */

/** True when the task has at least one subtask (i.e. it is an epic). */
export function isEpic(task: Task): boolean {
  return (task.subtasks?.length ?? 0) > 0;
}

/** Statuses that count a subtask as "done" for rollup purposes. */
export function getDoneStatuses(config?: Config | null): Set<string> {
  return new Set(['Done', 'Released', getArchiveStatus(config)].filter(Boolean));
}

export interface EpicRollup {
  /** Normalized subtask ids declared on the epic (includes any dangling references). */
  subtaskIds: string[];
  /** Subtasks that resolved to a known task (dangling references dropped — matches the card). */
  resolvedSubtasks: Task[];
  /** Count of resolved subtasks whose status is in the done set. */
  done: number;
  /** Total declared subtasks (dangling references count as not-done, matching the card). */
  total: number;
  /** Completion percentage 0–100 (0 when there are no subtasks). */
  pct: number;
}

/**
 * Compute an epic's completion rollup. Mirrors useTaskCardController's math exactly:
 * total = declared subtask count, done = resolved subtasks in the done set, missing children
 * are counted as not-done.
 */
export function computeEpicRollup(
  epic: Task,
  taskById: ReadonlyMap<string, Task>,
  doneStatuses: ReadonlySet<string>,
): EpicRollup {
  const subtaskIds = epic.subtasks?.map(normalizeSubtaskId) ?? [];
  const resolvedSubtasks = subtaskIds
    .map((id) => taskById.get(id))
    .filter((t): t is Task => !!t);
  const total = subtaskIds.length;
  const done = resolvedSubtasks.filter((t) => doneStatuses.has(t.status)).length;
  const pct = total > 0 ? (done / total) * 100 : 0;
  return { subtaskIds, resolvedSubtasks, done, total, pct };
}

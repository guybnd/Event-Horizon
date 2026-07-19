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
 * Every task id → its first epic parent (epics sorted by id so a multi-parent child resolves
 * deterministically), built from each candidate parent's `subtasks` list. Single source for
 * "does this ticket have an epic parent, and which" — Board's own column-exclusion resolution
 * (FLUX-1503: also reused per-member by the PR deck, so a PR member that is itself someone's
 * epic subtask still shows the -> epic chip, matching Board's board-level resolution exactly).
 */
export function resolveParentByChildId(tasks: Iterable<Task>): Map<string, Task> {
  const map = new Map<string, Task>();
  [...tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((candidateParent) => {
      candidateParent.subtasks?.forEach((entry) => {
        const childId = normalizeSubtaskId(entry);
        if (!map.has(childId)) {
          map.set(childId, candidateParent);
        }
      });
    });
  return map;
}

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
 * Reverse of {@link collectPrMemberIds} (FLUX-1503): PR member ticket id → its owning PR ticket
 * id. A subtask can be both an epic child and a PR member — PR precedence hides it from the
 * epic's own deck, but the epic card's full-rollup strip still needs to say "in PR-n" for it.
 */
export function collectPrTicketIdByMember(tasks: Iterable<Task>): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tasks) {
    if (t.kind === 'pr') (t.members ?? []).forEach((m) => map.set(m, t.id));
  }
  return map;
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
  const all = [...tasks];

  // FLUX-673: an epic that is ITSELF folded (a PR member, or a same-column subtask of another
  // epic) renders as a compact card whose own deck is suppressed. Folding such an epic's subtasks
  // would exclude them from their column while nothing renders them — they'd vanish. Pre-compute
  // those folded epics so we can skip them below, leaving their grandchildren in their own column.
  const foldedEpics = new Set<string>();
  for (const parent of all) {
    if (!parent.subtasks?.length) continue;
    for (const entry of parent.subtasks) {
      const childId = normalizeSubtaskId(entry);
      if (prMemberIds.has(childId)) continue;
      const child = byId.get(childId);
      if (child?.subtasks?.length && isFoldedIntoEpic(parent, child, prMemberIds)) {
        foldedEpics.add(childId);
      }
    }
  }

  const ids = new Set<string>();
  for (const epic of all) {
    if (!epic.subtasks?.length) continue;
    // FLUX-673: a folded epic doesn't hide its children (its deck won't render to show them).
    if (prMemberIds.has(epic.id) || foldedEpics.has(epic.id)) continue;
    for (const entry of epic.subtasks) {
      const childId = normalizeSubtaskId(entry);
      if (prMemberIds.has(childId)) continue; // PR precedence
      const child = byId.get(childId);
      if (child && isFoldedIntoEpic(epic, child, prMemberIds)) ids.add(childId);
    }
  }
  return ids;
}

/** Default cluster threshold (FLUX-677): group at ≥2 same-epic subtasks in a foreign column. */
export const CROSS_COLUMN_CLUSTER_THRESHOLD = 2;

/** One epic's subtasks that have piled up in a column the epic itself is NOT in. */
export interface CrossColumnCluster {
  /** The epic these subtasks belong to (lives in a different column). */
  epic: Task;
  /** This epic's subtasks sharing the foreign column (all same status, ≠ epic.status). */
  subtasks: Task[];
}

export interface CrossColumnClusterResult {
  /** Foreign column status → clusters of size ≥ threshold, rendered as proxy decks there. */
  byColumn: Map<string, CrossColumnCluster[]>;
  /** Every subtask id pulled into a proxy deck — Board excludes these from the column flow. */
  clusteredIds: Set<string>;
}

/**
 * Group cross-column subtask piles into proxy decks (FLUX-677). When ≥ `threshold` subtasks of the
 * same epic land in a column the epic is NOT in, they collapse under one proxy header there instead
 * of cluttering the column as loose cards. Mirrors {@link collectEpicFoldedIds} (same PR precedence,
 * same single-source rule) but for the *foreign*-column case the same-column fold deliberately skips.
 *
 * Each subtask is assigned to its first epic parent (epics sorted by id) so a multi-parent child
 * can't land in two clusters — matching Board's `parentByChildId` resolution. `foldedSameColumnIds`
 * (the {@link collectEpicFoldedIds} output) is excluded so a child that already folds same-column
 * under one parent never also clusters cross-column under another. Singletons (size 1) are NOT
 * returned — they stay as loose cards and get a `↳ <epic-id>` marker instead.
 */
export function collectCrossColumnClusters(
  tasks: Iterable<Task>,
  byId: ReadonlyMap<string, Task>,
  prMemberIds: ReadonlySet<string>,
  foldedSameColumnIds: ReadonlySet<string>,
  threshold: number = CROSS_COLUMN_CLUSTER_THRESHOLD,
): CrossColumnClusterResult {
  const seen = new Set<string>();
  // column status → epic id → cluster
  const grouped = new Map<string, Map<string, CrossColumnCluster>>();
  const epics = [...tasks]
    .filter((t) => t.subtasks?.length)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const epic of epics) {
    for (const entry of epic.subtasks!) {
      const childId = normalizeSubtaskId(entry);
      if (seen.has(childId)) continue; // already assigned to its first epic parent
      if (prMemberIds.has(childId)) continue; // PR precedence
      if (foldedSameColumnIds.has(childId)) continue; // folds same-column under some parent
      const child = byId.get(childId);
      if (!child) continue;
      if (child.status === epic.status) continue; // same column → epic's own deck handles it
      seen.add(childId);
      let byEpic = grouped.get(child.status);
      if (!byEpic) { byEpic = new Map(); grouped.set(child.status, byEpic); }
      let cluster = byEpic.get(epic.id);
      if (!cluster) { cluster = { epic, subtasks: [] }; byEpic.set(epic.id, cluster); }
      cluster.subtasks.push(child);
    }
  }
  const byColumn = new Map<string, CrossColumnCluster[]>();
  const clusteredIds = new Set<string>();
  for (const [col, byEpic] of grouped) {
    const clusters = [...byEpic.values()].filter((c) => c.subtasks.length >= threshold);
    if (clusters.length === 0) continue;
    byColumn.set(col, clusters);
    for (const c of clusters) for (const s of c.subtasks) clusteredIds.add(s.id);
  }
  return { byColumn, clusteredIds };
}

import { describe, it, expect } from 'vitest';
import type { Task } from '../types';
import {
  collectPrMemberIds,
  isFoldedIntoEpic,
  collectEpicFoldedIds,
  collectCrossColumnClusters,
  CROSS_COLUMN_CLUSTER_THRESHOLD,
} from './decks';

function makeTask(overrides: Partial<Task> & { id: string; status: string }): Task {
  return { title: overrides.id, ...overrides } as Task;
}

// ---------------------------------------------------------------------------
// collectPrMemberIds
// ---------------------------------------------------------------------------
describe('collectPrMemberIds', () => {
  it('returns empty set when no PR tasks', () => {
    const tasks = [makeTask({ id: 'T-1', status: 'Todo' })];
    expect(collectPrMemberIds(tasks).size).toBe(0);
  });

  it('collects members from PR tasks only', () => {
    const tasks = [
      makeTask({ id: 'PR-1', status: 'In Progress', kind: 'pr', members: ['T-1', 'T-2'] } as Partial<Task> & { id: string; status: string }),
      makeTask({ id: 'T-3', status: 'Todo' }),
    ];
    const ids = collectPrMemberIds(tasks);
    expect(ids).toEqual(new Set(['T-1', 'T-2']));
  });

  it('ignores PR tasks with no members', () => {
    const tasks = [makeTask({ id: 'PR-1', status: 'Todo', kind: 'pr' } as Partial<Task> & { id: string; status: string })];
    expect(collectPrMemberIds(tasks).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isFoldedIntoEpic
// ---------------------------------------------------------------------------
describe('isFoldedIntoEpic', () => {
  it('returns true when subtask shares epic column and is not a PR member', () => {
    const epic = makeTask({ id: 'E-1', status: 'In Progress' });
    const sub = makeTask({ id: 'T-1', status: 'In Progress' });
    expect(isFoldedIntoEpic(epic, sub, new Set())).toBe(true);
  });

  it('returns false when subtask is in a different column', () => {
    const epic = makeTask({ id: 'E-1', status: 'Todo' });
    const sub = makeTask({ id: 'T-1', status: 'Done' });
    expect(isFoldedIntoEpic(epic, sub, new Set())).toBe(false);
  });

  it('returns false when subtask is a PR member even in same column', () => {
    const epic = makeTask({ id: 'E-1', status: 'Todo' });
    const sub = makeTask({ id: 'T-1', status: 'Todo' });
    expect(isFoldedIntoEpic(epic, sub, new Set(['T-1']))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectEpicFoldedIds
// ---------------------------------------------------------------------------
describe('collectEpicFoldedIds', () => {
  it('collects same-column subtask ids', () => {
    const epic = makeTask({ id: 'E-1', status: 'Todo', subtasks: ['T-1', 'T-2'] });
    const t1 = makeTask({ id: 'T-1', status: 'Todo' });
    const t2 = makeTask({ id: 'T-2', status: 'In Progress' }); // cross-column — excluded
    const byId = new Map([['T-1', t1], ['T-2', t2]]);
    const ids = collectEpicFoldedIds([epic], byId, new Set());
    expect(ids).toEqual(new Set(['T-1']));
  });

  it('excludes PR members even when same column', () => {
    const epic = makeTask({ id: 'E-1', status: 'Todo', subtasks: ['T-1'] });
    const t1 = makeTask({ id: 'T-1', status: 'Todo' });
    const byId = new Map([['T-1', t1]]);
    const ids = collectEpicFoldedIds([epic], byId, new Set(['T-1']));
    expect(ids.size).toBe(0);
  });

  it('skips epics with no subtasks', () => {
    const plain = makeTask({ id: 'T-1', status: 'Todo' });
    expect(collectEpicFoldedIds([plain], new Map(), new Set()).size).toBe(0);
  });

  it('FLUX-673: does not fold a nested epic\'s grandchildren (folded epic deck is suppressed)', () => {
    // Epic B → [A]; Epic A → [X]; all in the same column. A folds into B, but X must NOT fold:
    // A renders compact inside B's deck with its own deck suppressed, so a folded X would vanish.
    const epicB = makeTask({ id: 'E-B', status: 'Todo', subtasks: ['E-A'] });
    const epicA = makeTask({ id: 'E-A', status: 'Todo', subtasks: ['X-1'] });
    const x1 = makeTask({ id: 'X-1', status: 'Todo' });
    const byId = new Map<string, Task>([['E-B', epicB], ['E-A', epicA], ['X-1', x1]]);
    const ids = collectEpicFoldedIds([epicB, epicA, x1], byId, new Set());
    expect(ids).toEqual(new Set(['E-A'])); // A folds; X stays in its column
  });

  it('FLUX-673: does not fold subtasks of a PR-member epic', () => {
    // E-1 is itself folded into a PR deck → its children must not also fold (its deck won't render).
    const epic = makeTask({ id: 'E-1', status: 'Todo', subtasks: ['T-1'] });
    const t1 = makeTask({ id: 'T-1', status: 'Todo' });
    const byId = new Map<string, Task>([['E-1', epic], ['T-1', t1]]);
    const ids = collectEpicFoldedIds([epic, t1], byId, new Set(['E-1']));
    expect(ids.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectCrossColumnClusters
// ---------------------------------------------------------------------------

function makeEpicWithSubs(
  epicId: string,
  epicStatus: string,
  subtaskDefs: Array<{ id: string; status: string }>,
): { epic: Task; subtasks: Task[] } {
  const subtasks = subtaskDefs.map((d) => makeTask(d));
  const epic = makeTask({ id: epicId, status: epicStatus, subtasks: subtaskDefs.map((d) => d.id) });
  return { epic, subtasks };
}

describe('collectCrossColumnClusters', () => {
  it('CONSTANT: CROSS_COLUMN_CLUSTER_THRESHOLD is 2', () => {
    expect(CROSS_COLUMN_CLUSTER_THRESHOLD).toBe(2);
  });

  it('clusters ≥2 same-epic subtasks that are in a foreign column', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const result = collectCrossColumnClusters([epic], byId, new Set(), new Set());

    expect(result.clusteredIds).toEqual(new Set(['T-1', 'T-2']));
    const col = result.byColumn.get('In Progress');
    expect(col).toHaveLength(1);
    expect(col![0].epic.id).toBe('E-1');
    expect(col![0].subtasks.map((s) => s.id).sort()).toEqual(['T-1', 'T-2']);
  });

  it('drops singleton (size < threshold) — not returned as a cluster', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const result = collectCrossColumnClusters([epic], byId, new Set(), new Set());

    expect(result.clusteredIds.size).toBe(0);
    expect(result.byColumn.size).toBe(0);
  });

  it('PR member never clusters regardless of column', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const prMemberIds = new Set(['T-1', 'T-2']);
    const result = collectCrossColumnClusters([epic], byId, prMemberIds, new Set());

    expect(result.clusteredIds.size).toBe(0);
  });

  it('same-column subtask is not cross-column clustered', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'Todo' }, // same column as epic
      { id: 'T-2', status: 'Todo' }, // same column as epic
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const result = collectCrossColumnClusters([epic], byId, new Set(), new Set());

    expect(result.clusteredIds.size).toBe(0);
  });

  it('foldedSameColumnIds are excluded from cross-column clustering', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    // both are already folded same-column under another parent
    const foldedSameColumnIds = new Set(['T-1', 'T-2']);
    const result = collectCrossColumnClusters([epic], byId, new Set(), foldedSameColumnIds);

    expect(result.clusteredIds.size).toBe(0);
  });

  it('multi-parent child lands in exactly one cluster (first epic by id)', () => {
    // E-1 < E-2 lexicographically — T-1 should go to E-1
    const { epic: e1 } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
    ]);
    const { epic: e2 } = makeEpicWithSubs('E-2', 'Todo', [
      { id: 'T-1', status: 'In Progress' }, // shared child
      { id: 'T-3', status: 'In Progress' },
    ]);
    const allTasks = [
      makeTask({ id: 'T-1', status: 'In Progress' }),
      makeTask({ id: 'T-2', status: 'In Progress' }),
      makeTask({ id: 'T-3', status: 'In Progress' }),
    ];
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const result = collectCrossColumnClusters([e1, e2], byId, new Set(), new Set());

    // T-1 assigned to E-1 (first by id); E-2 only has T-3 → 1 member → singleton → dropped
    expect(result.clusteredIds).toEqual(new Set(['T-1', 'T-2']));
    const col = result.byColumn.get('In Progress')!;
    const epicIds = col.map((c) => c.epic.id);
    expect(epicIds).toContain('E-1');
    expect(epicIds).not.toContain('E-2'); // singleton after T-1 dedup
  });

  it('threshold=3 suppresses a 2-member cluster', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const result = collectCrossColumnClusters([epic], byId, new Set(), new Set(), 3);

    expect(result.clusteredIds.size).toBe(0);
    expect(result.byColumn.size).toBe(0);
  });

  it('threshold=3 passes a 3-member cluster', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
      { id: 'T-3', status: 'In Progress' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const result = collectCrossColumnClusters([epic], byId, new Set(), new Set(), 3);

    expect(result.clusteredIds).toEqual(new Set(['T-1', 'T-2', 'T-3']));
  });

  it('returns empty result when no tasks have subtasks', () => {
    const tasks = [makeTask({ id: 'T-1', status: 'Todo' })];
    const byId = new Map([['T-1', tasks[0]]]);
    const result = collectCrossColumnClusters(tasks, byId, new Set(), new Set());
    expect(result.byColumn.size).toBe(0);
    expect(result.clusteredIds.size).toBe(0);
  });

  it('clusters in multiple foreign columns independently', () => {
    const { epic, subtasks } = makeEpicWithSubs('E-1', 'Todo', [
      { id: 'T-1', status: 'In Progress' },
      { id: 'T-2', status: 'In Progress' },
      { id: 'T-3', status: 'Done' },
      { id: 'T-4', status: 'Done' },
    ]);
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const result = collectCrossColumnClusters([epic], byId, new Set(), new Set());

    expect(result.byColumn.has('In Progress')).toBe(true);
    expect(result.byColumn.has('Done')).toBe(true);
    expect(result.clusteredIds).toEqual(new Set(['T-1', 'T-2', 'T-3', 'T-4']));
  });
});

import { describe, it, expect } from 'vitest';
import { filterAndSortTasks, type TaskFilterState } from './taskSearch';
import type { Config, Task } from './types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'FLUX-1',
    status: 'Todo',
    title: 'A task',
    body: '',
    assignee: 'Guy',
    priority: 'None',
    tags: [],
    ...overrides,
  } as Task;
}

const CONFIG: Config = {
  columns: [{ name: 'Todo' }],
  hiddenStatuses: [],
  users: [],
  tags: [],
  priorities: [{ name: 'High', color: '#f00' }, { name: 'None', color: '#888' }],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: false,
};

function baseFilters(overrides: Partial<TaskFilterState> = {}): TaskFilterState {
  return {
    searchQuery: '',
    sortOption: 'updated',
    filterAssignee: 'all',
    filterPriority: 'all',
    filterTag: 'all',
    ...overrides,
  };
}

describe('filterAndSortTasks — FLUX-1300 top-pin', () => {
  it('sorts a pinned task first regardless of the configured sort option', () => {
    const old = makeTask({ id: 'FLUX-1', priority: 'None' });
    const highPriority = makeTask({ id: 'FLUX-2', priority: 'High' });
    const justCreated = makeTask({ id: 'FLUX-3', priority: 'None' });

    const result = filterAndSortTasks([old, highPriority, justCreated], CONFIG, baseFilters({
      sortOption: 'priority',
      pinnedTasks: { 'FLUX-3': Date.now() + 15_000 },
    }));

    expect(result.map((t) => t.id)).toEqual(['FLUX-3', 'FLUX-2', 'FLUX-1']);
  });

  it('ignores an expired pin and falls back to the normal sort', () => {
    const a = makeTask({ id: 'FLUX-1' });
    const b = makeTask({ id: 'FLUX-2' });

    const result = filterAndSortTasks([a, b], CONFIG, baseFilters({
      pinnedTasks: { 'FLUX-2': Date.now() - 1_000 },
    }));

    // No live pin left — falls back to the default (id) tiebreak of the 'updated' sort.
    expect(result.map((t) => t.id)).toEqual(['FLUX-1', 'FLUX-2']);
  });

  it('orders multiple pinned tasks most-recently-created first', () => {
    const older = makeTask({ id: 'FLUX-1' });
    const newer = makeTask({ id: 'FLUX-2' });

    const result = filterAndSortTasks([older, newer], CONFIG, baseFilters({
      pinnedTasks: {
        'FLUX-1': Date.now() + 5_000,
        'FLUX-2': Date.now() + 15_000,
      },
    }));

    expect(result.map((t) => t.id)).toEqual(['FLUX-2', 'FLUX-1']);
  });

  it('is a no-op when pinnedTasks is omitted', () => {
    const a = makeTask({ id: 'FLUX-1', priority: 'High' });
    const b = makeTask({ id: 'FLUX-2', priority: 'None' });

    const result = filterAndSortTasks([b, a], CONFIG, baseFilters({ sortOption: 'priority' }));

    expect(result.map((t) => t.id)).toEqual(['FLUX-1', 'FLUX-2']);
  });
});

import { describe, it, expect } from 'vitest';
import { getActiveBoardSlice, type AppStoreState, type BoardSlice } from './appStore';

function boardSlice(overrides: Partial<BoardSlice> = {}): BoardSlice {
  return {
    tasks: [],
    taskById: new Map(),
    prByBranch: new Map(),
    prMemberIds: new Set(),
    worktreeBranches: new Set(),
    worktrees: [],
    liveSessions: {},
    engineEvents: [],
    taskLiveEvents: {},
    columnLiveEvents: {},
    pinnedTasks: {},
    readComments: {},
    notifications: [],
    config: null,
    ...overrides,
  };
}

// getActiveBoardSlice only reads activeBoardId/boardsById — a minimal partial state stands in for
// the full AppStoreState so tests don't need to fill 30+ unrelated fields.
function state(overrides: Pick<AppStoreState, 'activeBoardId' | 'boardsById'>): AppStoreState {
  return overrides as AppStoreState;
}

/**
 * S9 (epic FLUX-1230): the portal's board-id state dimension. `boardsById` must hold ≥2 boards'
 * slices without one overwriting the other — the actual cross-board id-collision fix this ticket
 * exists for (AC2) — even though S9 itself only ever populates the active board's entry.
 */
describe('boardsById (S9 per-board slice isolation)', () => {
  it('holds two distinct board slices under two keys without collision', () => {
    const sliceA = boardSlice({ tasks: [{ id: 'FLUX-1' } as never] });
    const sliceB = boardSlice({ tasks: [{ id: 'FLUX-1' } as never, { id: 'FLUX-2' } as never] });
    const boardsById = { '/repo/a': sliceA, '/repo/b': sliceB };

    expect(boardsById['/repo/a'].tasks).toHaveLength(1);
    expect(boardsById['/repo/b'].tasks).toHaveLength(2);
    // Same ticket id ('FLUX-1') exists independently in both slices — no cross-board leakage.
    expect(boardsById['/repo/a'].tasks[0]).not.toBe(boardsById['/repo/b'].tasks[0]);
  });
});

describe('getActiveBoardSlice', () => {
  it('returns null when no board is active yet', () => {
    expect(getActiveBoardSlice(state({ activeBoardId: null, boardsById: {} }))).toBeNull();
  });

  it('returns null when the active id has no cached slice', () => {
    expect(getActiveBoardSlice(state({ activeBoardId: '/repo/a', boardsById: {} }))).toBeNull();
  });

  it('returns the slice keyed by activeBoardId, not any other cached board', () => {
    const sliceA = boardSlice({ tasks: [{ id: 'FLUX-1' } as never] });
    const sliceB = boardSlice({ tasks: [{ id: 'FLUX-2' } as never] });
    const s = state({ activeBoardId: '/repo/b', boardsById: { '/repo/a': sliceA, '/repo/b': sliceB } });
    expect(getActiveBoardSlice(s)).toBe(sliceB);
  });
});

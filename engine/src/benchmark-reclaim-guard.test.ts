// FLUX-1739: `worktreeUnreclaimableReason` must refuse to reclaim a benchmark run's worktree while
// its evidence collection is in flight.
//
// The two racing callers this defends against, both real:
//   • the ~90s reconcile sweep, and
//   • another run of the SAME suite hitting the worktree cap, whose backstop calls in with
//     `honorReadyGrace: false` — deliberately bypassing the Ready grace buffer. That path is the
//     likelier one, because it fires precisely when a sibling run wants the slot.
//
// A finished run sits at Ready with no live session, which is `null` (reclaimable) under every other
// rule in this function — so without the guard the common case deletes the tree mid-measurement.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const tasks: Record<string, Record<string, unknown>> = {};
const ws = { root: 'C:/board', tasks };

vi.mock('./workspace-context.js', () => ({
  getWorkspace: () => ws,
  getDefaultWorkspace: () => ws,
}));
vi.mock('./session-store.js', () => ({
  stopAllSessionsForTask: vi.fn(),
  getActiveSessionsForTaskInWorkspace: () => [],
  isWithinReclaimGrace: () => false,
  isSessionStale: () => true,
  RECLAIM_GRACE_MS: 0,
  STALE_SESSION_RECLAIM_MS: 0,
  NON_TERMINAL_STALE_RECLAIM_MS: 0,
}));
vi.mock('./background-process-holds.js', () => ({
  getHoldsForBranch: () => [],
  getHoldsForTask: () => [],
  clearHoldsForBranch: vi.fn(),
  forceKillHeldSubtree: vi.fn(),
}));
vi.mock('./config.js', () => ({ getConfig: () => ({ readyForMergeStatus: 'Ready' }) }));

const { worktreeUnreclaimableReason, isWorktreeReclaimable } = await import('./pr-cleanup.js');
const { beginCollection, endCollection, resetCollectionGuard } = await import('./benchmark-collection-guard.js');

function seed(id: string, extra: Record<string, unknown> = {}) {
  tasks[id] = { id, status: 'Ready', branch: `flux/${id}`, ...extra };
}

beforeEach(() => {
  resetCollectionGuard();
  for (const k of Object.keys(tasks)) delete tasks[k];
});
afterEach(() => vi.useRealTimers());

describe('benchmark-collecting reclaim guard', () => {
  it('refuses reclaim while collection is in flight', () => {
    seed('BENCH-1', { kind: 'benchmark' });
    beginCollection('BENCH-1');
    expect(worktreeUnreclaimableReason('BENCH-1')).toBe('benchmark-collecting');
    expect(isWorktreeReclaimable('BENCH-1')).toBe(false);
  });

  it('still refuses under honorReadyGrace:false — the cap backstop must not override it', () => {
    // This is the case that matters most: `reclaimOnCapAndRetry` passes false specifically to
    // bypass READY_WORKTREE_GRACE_MS, and it fires when a sibling run of the same suite wants a slot.
    seed('BENCH-2', { kind: 'benchmark' });
    beginCollection('BENCH-2');
    expect(worktreeUnreclaimableReason('BENCH-2', { honorReadyGrace: false })).toBe('benchmark-collecting');
    expect(isWorktreeReclaimable('BENCH-2', { honorReadyGrace: false })).toBe(false);
  });

  it('allows reclaim once endCollection has run', () => {
    seed('BENCH-3', { kind: 'benchmark' });
    beginCollection('BENCH-3');
    endCollection('BENCH-3');
    expect(worktreeUnreclaimableReason('BENCH-3', { honorReadyGrace: false })).not.toBe('benchmark-collecting');
  });

  it('allows reclaim once the TTL lapses — a crashed runner cannot hold a slot forever', () => {
    vi.useFakeTimers();
    seed('BENCH-4', { kind: 'benchmark' });
    beginCollection('BENCH-4', 1000);
    expect(worktreeUnreclaimableReason('BENCH-4', { honorReadyGrace: false })).toBe('benchmark-collecting');
    vi.advanceTimersByTime(1001);
    expect(worktreeUnreclaimableReason('BENCH-4', { honorReadyGrace: false })).not.toBe('benchmark-collecting');
  });

  it('is byte-identical for a non-benchmark ticket with no window open', () => {
    seed('FLUX-1');
    expect(worktreeUnreclaimableReason('FLUX-1', { honorReadyGrace: false })).toBeNull();
  });

  it('does not leak protection to a sibling ticket on the same board', () => {
    seed('BENCH-5', { kind: 'benchmark' });
    seed('BENCH-6', { kind: 'benchmark' });
    beginCollection('BENCH-5');
    expect(worktreeUnreclaimableReason('BENCH-6', { honorReadyGrace: false })).not.toBe('benchmark-collecting');
  });

  it('still reports unknown-ticket ahead of the guard for an id not on the board', () => {
    beginCollection('GHOST-1');
    expect(worktreeUnreclaimableReason('GHOST-1')).toBe('unknown-ticket');
  });
});

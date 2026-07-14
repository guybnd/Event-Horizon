// FLUX-1411 — `reclaimReadyWorktrees`' `onStuck` handler (wired in pr-cleanup.ts) used to fire a
// fresh board notification + ticket-history entry on EVERY reconcile tick for a persistently stuck
// worktree slot (the exact steady state FLUX-1405 introduced: a dirty terminal worktree whose
// detach keeps failing), and used a hardcoded "still has uncommitted changes" message even when the
// failure was actually a CLEAN worktree's `removeTaskWorktree` call failing (e.g. a transient
// Windows file lock). This pins both fixes: dedup per stuck slot, and an accurate message per
// failure kind ('detach' vs 'remove').
//
// `reclaimWorktrees` (task-worktree.js) is mocked to drive `onStuck` directly with scripted events —
// isolates this test from real git failure injection, which FLUX-1411's underlying scenarios (a
// stash lock, an EBUSY file lock) can't portably reproduce in CI.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reclaimReadyWorktrees } from './pr-cleanup.js';
import { clearNotifications, getNotifications } from './notifications.js';

type OnStuckFn = (ticketId: string, worktreePath: string, error: unknown, kind: 'detach' | 'remove') => void;
interface StuckEvent { ticketId: string; worktreePath: string; error: unknown; kind: 'detach' | 'remove' }

let stuckEvents: StuckEvent[] = [];

vi.mock('./task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-worktree.js')>();
  return {
    ...actual,
    reclaimWorktrees: async (_root: string, _isReclaimable: unknown, opts: { onStuck?: OnStuckFn } = {}) => {
      for (const e of stuckEvents) opts.onStuck?.(e.ticketId, e.worktreePath, e.error, e.kind);
      return [] as string[];
    },
  };
});

beforeEach(() => {
  clearNotifications();
  stuckEvents = [];
});

describe('reclaimReadyWorktrees onStuck notification (FLUX-1411)', () => {
  it('surfaces a detach failure with the uncommitted-changes message', async () => {
    stuckEvents = [{ ticketId: 'FLUX-1', worktreePath: '/wt/FLUX-1', error: new Error('lock'), kind: 'detach' }];

    await reclaimReadyWorktrees('/fake/root');

    const notes = getNotifications().filter((n) => n.ticketId === 'FLUX-1');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toContain('uncommitted changes');
    expect(notes[0]!.message).toContain('detached');
  });

  it('surfaces a remove failure with an accurate clean-worktree message (not "uncommitted changes")', async () => {
    stuckEvents = [{ ticketId: 'FLUX-2', worktreePath: '/wt/FLUX-2', error: new Error('EBUSY'), kind: 'remove' }];

    await reclaimReadyWorktrees('/fake/root');

    const notes = getNotifications().filter((n) => n.ticketId === 'FLUX-2');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).not.toContain('uncommitted changes');
    expect(notes[0]!.message).toContain('clean');
  });

  it('dedupes a persistently stuck slot across repeated sweeps — one notification, not one per tick', async () => {
    stuckEvents = [{ ticketId: 'FLUX-3', worktreePath: '/wt/FLUX-3', error: new Error('lock'), kind: 'detach' }];

    await reclaimReadyWorktrees('/fake/root');
    await reclaimReadyWorktrees('/fake/root');
    await reclaimReadyWorktrees('/fake/root');

    expect(getNotifications().filter((n) => n.ticketId === 'FLUX-3')).toHaveLength(1);
  });

  it('re-notifies once a stuck slot clears and later gets stuck again', async () => {
    stuckEvents = [{ ticketId: 'FLUX-4', worktreePath: '/wt/FLUX-4', error: new Error('lock'), kind: 'detach' }];
    await reclaimReadyWorktrees('/fake/root');

    stuckEvents = []; // the slot cleared on this sweep
    await reclaimReadyWorktrees('/fake/root');

    stuckEvents = [{ ticketId: 'FLUX-4', worktreePath: '/wt/FLUX-4', error: new Error('lock again'), kind: 'detach' }];
    await reclaimReadyWorktrees('/fake/root');

    expect(getNotifications().filter((n) => n.ticketId === 'FLUX-4')).toHaveLength(2);
  });

  it('tracks detach and remove as distinct episodes on the same slot (no cross-kind suppression)', async () => {
    stuckEvents = [{ ticketId: 'FLUX-5', worktreePath: '/wt/FLUX-5', error: new Error('lock'), kind: 'detach' }];
    await reclaimReadyWorktrees('/fake/root');

    stuckEvents = [{ ticketId: 'FLUX-5', worktreePath: '/wt/FLUX-5', error: new Error('EBUSY'), kind: 'remove' }];
    await reclaimReadyWorktrees('/fake/root');

    expect(getNotifications().filter((n) => n.ticketId === 'FLUX-5')).toHaveLength(2);
  });
});

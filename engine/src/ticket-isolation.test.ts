import { describe, it, expect, beforeEach, vi } from 'vitest';

// FLUX-852: unit-test the canonical ticket-isolation chokepoint (FLUX-845) in isolation — stub the
// git/worktree/store collaborators so the branch-reuse, live-cache-patch, and non-fatal worktree
// failure behaviours are exercised without a real repo. Mock factories define their own vi.fn()s
// (hoist-safe) and the test configures them via the imported binding + vi.mocked (mirrors
// board-reprime.test.ts).
vi.mock('./branch-manager.js', () => ({ createTicketBranch: vi.fn() }));
vi.mock('./task-worktree.js', () => ({ createTaskWorktree: vi.fn(), reclaimWorktrees: vi.fn(async () => []) }));
// FLUX-1031: ticket-isolation now sources its reclaimability predicate from pr-cleanup. Stub it so
// this unit test doesn't pull in pr-cleanup's whole graph; the under-pressure test mocks
// reclaimWorktrees anyway, so the predicate body is never exercised here.
vi.mock('./pr-cleanup.js', () => ({ isWorktreeReclaimable: vi.fn(() => true) }));
vi.mock('./task-store.js', () => ({ tasksCache: {}, updateTaskWithHistory: vi.fn(async () => {}) }));
vi.mock('./events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('./history.js', () => ({
  buildActivityEntry: vi.fn((message: string, user: string, date: string) => ({ type: 'activity', comment: message, user, date })),
}));
vi.mock('./workspace.js', () => ({ workspaceRoot: '/fake/workspace' }));

import { ensureTicketIsolation } from './ticket-isolation.js';
import { createTicketBranch } from './branch-manager.js';
import { createTaskWorktree } from './task-worktree.js';
import { reclaimWorktrees } from './task-worktree.js';
import { isWorktreeReclaimable } from './pr-cleanup.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { buildActivityEntry } from './history.js';

/** Minimal shape of the fields this suite reads/writes on a cached task. */
interface FakeTask {
  id: string;
  title: string;
  branch?: string;
}

const cache = tasksCache as Record<string, FakeTask>;

describe('ensureTicketIsolation (FLUX-845 chokepoint, FLUX-852 hardening)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(cache)) delete cache[k];
  });

  it('throws when the ticket is not in cache', async () => {
    await expect(ensureTicketIsolation('FLUX-404', { worktree: false })).rejects.toThrow('not found');
  });

  it('reuses an existing task.branch — never re-creates it', async () => {
    cache['FLUX-1'] = { id: 'FLUX-1', title: 'Already branched', branch: 'flux/FLUX-1-already' };

    const res = await ensureTicketIsolation('FLUX-1', { worktree: false });

    expect(res.branch).toBe('flux/FLUX-1-already');
    expect(createTicketBranch).not.toHaveBeenCalled();
    // no branch write-back when the existing branch is reused (idempotent)
    expect(updateTaskWithHistory).not.toHaveBeenCalled();
    expect(broadcastEvent).toHaveBeenCalledWith('taskUpdated', { id: 'FLUX-1' });
  });

  it('creates a branch and patches it onto the LIVE cache object (in-tick visibility guard)', async () => {
    const task: FakeTask = { id: 'FLUX-2', title: 'Add the thing' };
    cache['FLUX-2'] = task;
    vi.mocked(createTicketBranch).mockResolvedValue('flux/FLUX-2-add-the-thing');

    const res = await ensureTicketIsolation('FLUX-2', { worktree: false });

    expect(createTicketBranch).toHaveBeenCalledWith('FLUX-2', 'Add the thing', undefined);
    expect(res.branch).toBe('flux/FLUX-2-add-the-thing');
    // the SAME cache object a same-tick resolveTaskExecutionRoot holds must see the new branch —
    // updateTaskWithHistory replaces the cache entry, so ticket-isolation also mutates the live ref.
    expect(task.branch).toBe('flux/FLUX-2-add-the-thing');
    expect(updateTaskWithHistory).toHaveBeenCalledWith(
      'FLUX-2',
      expect.objectContaining({ extraFields: { branch: 'flux/FLUX-2-add-the-thing' } }),
    );
    expect(createTaskWorktree).not.toHaveBeenCalled();
  });

  it('returns the worktree path when worktree creation succeeds', async () => {
    cache['FLUX-5'] = { id: 'FLUX-5', title: 'Worktree ok' };
    vi.mocked(createTicketBranch).mockResolvedValue('flux/FLUX-5-worktree-ok');
    vi.mocked(createTaskWorktree).mockResolvedValue('/fake/.eh-worktrees/FLUX-5');

    const res = await ensureTicketIsolation('FLUX-5', { worktree: true });

    expect(res).toEqual({ branch: 'flux/FLUX-5-worktree-ok', worktree: '/fake/.eh-worktrees/FLUX-5' });
    expect(res.worktreeError).toBeUndefined();
  });

  it('is non-fatal when the worktree fails: returns the branch + worktreeError and records history', async () => {
    cache['FLUX-3'] = { id: 'FLUX-3', title: 'Limit hit' };
    vi.mocked(createTicketBranch).mockResolvedValue('flux/FLUX-3-limit-hit');
    vi.mocked(createTaskWorktree).mockRejectedValue(new Error('Task worktree limit reached (4/4).'));

    const res = await ensureTicketIsolation('FLUX-3', { worktree: true });

    expect(res.branch).toBe('flux/FLUX-3-limit-hit'); // branch still created
    expect(res.worktree).toBeUndefined();
    expect(res.worktreeError).toContain('worktree limit reached');
    // two writes: the branch field, then the lost-isolation history entry
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(2);
  });

  it('self-heals a full cap: reclaims stale terminal worktrees then retries once (FLUX-1018)', async () => {
    cache['FLUX-6'] = { id: 'FLUX-6', title: 'Cap self-heal' };
    vi.mocked(createTicketBranch).mockResolvedValue('flux/FLUX-6-cap-self-heal');
    // First attempt hits the cap; after reclaim frees a slot the retry succeeds.
    vi.mocked(createTaskWorktree)
      .mockRejectedValueOnce(new Error('Task worktree limit reached (4/4).'))
      .mockResolvedValueOnce('/fake/.eh-worktrees/FLUX-6');
    vi.mocked(reclaimWorktrees).mockResolvedValueOnce(['FLUX-998']);

    const res = await ensureTicketIsolation('FLUX-6', { worktree: true });

    expect(reclaimWorktrees).toHaveBeenCalledTimes(1);
    expect(createTaskWorktree).toHaveBeenCalledTimes(2); // original + retry
    expect(res.worktree).toBe('/fake/.eh-worktrees/FLUX-6');
    expect(res.worktreeError).toBeUndefined();

    // FLUX-1119: prove the cap-backstop actually bypasses the Ready-worktree grace — invoke the
    // predicate ticket-isolation.ts handed to reclaimWorktrees and assert it forwards
    // { honorReadyGrace: false } to isWorktreeReclaimable, not just that SOME predicate was passed.
    const predicate = vi.mocked(reclaimWorktrees).mock.calls[0]![1];
    predicate('FLUX-998');
    expect(isWorktreeReclaimable).toHaveBeenCalledWith('FLUX-998', { honorReadyGrace: false });
  });

  it('attributes the worktree-error history entry to the resolved updatedBy, not a hardcoded "Agent" (FLUX-852)', async () => {
    cache['FLUX-4'] = { id: 'FLUX-4', title: 'Author check' };
    vi.mocked(createTicketBranch).mockResolvedValue('flux/FLUX-4-author-check');
    vi.mocked(createTaskWorktree).mockRejectedValue(new Error('boom'));

    await ensureTicketIsolation('FLUX-4', { worktree: true, updatedBy: 'qa-correctness' });

    // the worktree-error entry is built via buildActivityEntry(message, author, date)
    expect(buildActivityEntry).toHaveBeenCalledTimes(1);
    const author = vi.mocked(buildActivityEntry).mock.calls[0]![1];
    expect(author).toBe('qa-correctness');
  });
});

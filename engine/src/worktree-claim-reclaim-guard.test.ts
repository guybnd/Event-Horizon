// FLUX-1771: `worktreeUnreclaimableReason` must refuse to reclaim a worktree held by an active
// worktree claim — the shield for a `branch(action:'create')` worktree being used by a non-EH
// session, which every other guard in that function is blind to (no verified EH session id).
//
// Mirrors benchmark-reclaim-guard.test.ts's shape: the claim check must hold under BOTH
// honorReadyGrace values (the cap backstop passes false specifically to bypass the Ready grace
// buffer — the likeliest caller to race a live claim), and it must close the FLUX-1214 zero-commit
// backstop (isWorktreeReclaimableForSweep), which is the exact path the towero incident hit.
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

const { worktreeUnreclaimableReason, isWorktreeReclaimable, isWorktreeReclaimableForSweep } = await import('./pr-cleanup.js');
const { claimWorktree, releaseClaim, __resetWorktreeClaimsForTest } = await import('./worktree-claims.js');
const { getTicketBranchStatus } = await import('./branch-manager.js');

vi.mock('./branch-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./branch-manager.js')>();
  return { ...actual, getTicketBranchStatus: vi.fn() };
});

function seed(id: string, extra: Record<string, unknown> = {}) {
  tasks[id] = { id, status: 'In Progress', branch: `flux/${id}`, history: [], ...extra };
}

beforeEach(() => {
  __resetWorktreeClaimsForTest();
  for (const k of Object.keys(tasks)) delete tasks[k];
  vi.mocked(getTicketBranchStatus).mockResolvedValue({ exists: true, aheadCount: 0, behindCount: 0 } as never);
});
afterEach(() => vi.useRealTimers());

describe('worktree-claim reclaim guard', () => {
  it('refuses reclaim while a claim is active', () => {
    seed('FLUX-1');
    claimWorktree({ workspaceRoot: ws.root, ticketId: 'FLUX-1', branch: 'flux/FLUX-1', worktreePath: '/wt/FLUX-1', ownerId: 'unbound' });
    expect(worktreeUnreclaimableReason('FLUX-1')).toBe('worktree-claim');
    expect(isWorktreeReclaimable('FLUX-1')).toBe(false);
  });

  it('still refuses under honorReadyGrace:false — the cap backstop must not override it', () => {
    seed('FLUX-2');
    claimWorktree({ workspaceRoot: ws.root, ticketId: 'FLUX-2', branch: 'flux/FLUX-2', worktreePath: '/wt/FLUX-2', ownerId: 'unbound' });
    expect(worktreeUnreclaimableReason('FLUX-2', { honorReadyGrace: false })).toBe('worktree-claim');
    expect(isWorktreeReclaimable('FLUX-2', { honorReadyGrace: false })).toBe(false);
  });

  it('holds at Ready status too, not only mid-implementation', () => {
    seed('FLUX-3', { status: 'Ready' });
    claimWorktree({ workspaceRoot: ws.root, ticketId: 'FLUX-3', branch: 'flux/FLUX-3', worktreePath: '/wt/FLUX-3', ownerId: 'unbound' });
    expect(worktreeUnreclaimableReason('FLUX-3')).toBe('worktree-claim');
  });

  it('closes the FLUX-1214 zero-commit backstop for a claimed, never-committed branch', async () => {
    seed('FLUX-4');
    claimWorktree({ workspaceRoot: ws.root, ticketId: 'FLUX-4', branch: 'flux/FLUX-4', worktreePath: '/wt/FLUX-4', ownerId: 'unbound' });
    // Without the claim this would be reclaimable: status refuses ('status'), branch is at
    // aheadCount 0, and the worktree-creation grace has (in this scenario) already lapsed.
    const result = await isWorktreeReclaimableForSweep('FLUX-4');
    expect(result).toBe(false);
  });

  it('releasing the claim restores ordinary reclaimability', () => {
    seed('FLUX-5');
    claimWorktree({ workspaceRoot: ws.root, ticketId: 'FLUX-5', branch: 'flux/FLUX-5', worktreePath: '/wt/FLUX-5', ownerId: 'unbound' });
    releaseClaim(ws.root, 'FLUX-5');
    expect(worktreeUnreclaimableReason('FLUX-5')).not.toBe('worktree-claim');
  });

  it('does not leak protection to a sibling ticket on the same board', () => {
    seed('FLUX-6');
    seed('FLUX-7');
    claimWorktree({ workspaceRoot: ws.root, ticketId: 'FLUX-6', branch: 'flux/FLUX-6', worktreePath: '/wt/FLUX-6', ownerId: 'unbound' });
    expect(worktreeUnreclaimableReason('FLUX-7')).not.toBe('worktree-claim');
  });

  it('a claim on a different workspace root does not protect this board', () => {
    seed('FLUX-8');
    claimWorktree({ workspaceRoot: 'C:/other-board', ticketId: 'FLUX-8', branch: 'flux/FLUX-8', worktreePath: '/wt/FLUX-8', ownerId: 'unbound' });
    expect(worktreeUnreclaimableReason('FLUX-8')).not.toBe('worktree-claim');
  });
});

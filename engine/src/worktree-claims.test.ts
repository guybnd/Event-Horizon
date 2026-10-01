// FLUX-1771: the registry behind the worktree claim that shields a `branch(action:'create')`
// worktree from reclaim while a non-EH session is working in it — see worktree-claims.ts's module
// header for the full rationale (the towero incident, why a 2h idle TTL, why persisted).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WORKTREE_CLAIM_IDLE_TTL_MS,
  claimWorktree,
  renewClaim,
  hasActiveClaim,
  getClaim,
  releaseClaim,
  releaseClaimsForBranch,
  releaseClaimsForWorktree,
  sweepClaims,
  setClaimHistoryWriter,
  __resetWorktreeClaimsForTest,
} from './worktree-claims.js';

function baseParams(overrides: Partial<Parameters<typeof claimWorktree>[0]> = {}) {
  return {
    workspaceRoot: 'ws-1',
    ticketId: 'FLUX-1',
    branch: 'flux/FLUX-1-thing',
    worktreePath: '/wt/FLUX-1',
    ownerId: 'mcp-sess-a',
    ...overrides,
  };
}

beforeEach(() => __resetWorktreeClaimsForTest());
afterEach(() => {
  vi.useRealTimers();
  setClaimHistoryWriter(() => {});
});

describe('claim lifecycle', () => {
  it('protects a ticket once claimed', () => {
    expect(hasActiveClaim('ws-1', 'FLUX-1')).toBe(false);
    claimWorktree(baseParams());
    expect(hasActiveClaim('ws-1', 'FLUX-1')).toBe(true);
  });

  it('scopes protection to the (workspaceRoot, ticketId) pair', () => {
    claimWorktree(baseParams());
    expect(hasActiveClaim('ws-1', 'FLUX-2')).toBe(false);
    expect(hasActiveClaim('ws-2', 'FLUX-1')).toBe(false);
  });

  it('a second claimWorktree renews rather than duplicating', () => {
    const first = claimWorktree(baseParams({ now: 1000 }));
    const second = claimWorktree(baseParams({ now: 2000 }));
    expect(second.createdAt).toBe(first.createdAt); // createdAt preserved across renew
    expect(second.expiresAt).not.toBe(first.expiresAt);
  });

  it('releaseClaim removes it and returns the released entry', () => {
    claimWorktree(baseParams());
    const released = releaseClaim('ws-1', 'FLUX-1');
    expect(released?.ticketId).toBe('FLUX-1');
    expect(hasActiveClaim('ws-1', 'FLUX-1')).toBe(false);
  });

  it('releaseClaim on a ticket with no claim is a no-op, not a throw', () => {
    expect(() => releaseClaim('ws-1', 'NOPE')).not.toThrow();
    expect(releaseClaim('ws-1', 'NOPE')).toBeUndefined();
  });
});

describe('renewClaim — heartbeat semantics (never creates, only extends)', () => {
  it('does nothing when no claim exists for the ticket', () => {
    renewClaim('ws-1', 'FLUX-1');
    expect(hasActiveClaim('ws-1', 'FLUX-1')).toBe(false);
    expect(getClaim('ws-1', 'FLUX-1')).toBeUndefined();
  });

  it('extends an existing claim past what the original TTL alone would have covered', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    claimWorktree(baseParams({ now: 0 }));
    vi.setSystemTime(WORKTREE_CLAIM_IDLE_TTL_MS - 1000);
    renewClaim('ws-1', 'FLUX-1', Date.now());
    vi.setSystemTime(WORKTREE_CLAIM_IDLE_TTL_MS + 500); // past the ORIGINAL deadline
    expect(hasActiveClaim('ws-1', 'FLUX-1', Date.now())).toBe(true); // renewed deadline still holds
  });
});

describe('expiry', () => {
  it('hasActiveClaim lazily evicts an expired entry', () => {
    const claim = claimWorktree(baseParams({ now: 0 }));
    expect(hasActiveClaim('ws-1', 'FLUX-1', Date.parse(claim.expiresAt) + 1)).toBe(false);
    expect(getClaim('ws-1', 'FLUX-1')).toBeUndefined(); // evicted, not just reported stale
  });

  it('sweepClaims drops every claim past its expiresAt and reports it', () => {
    const claim = claimWorktree(baseParams({ now: 0 }));
    const outcomes = sweepClaims(Date.parse(claim.expiresAt) + 1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.claim.ticketId).toBe('FLUX-1');
    expect(getClaim('ws-1', 'FLUX-1')).toBeUndefined();
  });

  it('sweepClaims leaves a still-live claim untouched', () => {
    claimWorktree(baseParams({ now: 0 }));
    const outcomes = sweepClaims(1000); // well inside the TTL
    expect(outcomes).toHaveLength(0);
    expect(hasActiveClaim('ws-1', 'FLUX-1', 1000)).toBe(true);
  });

  it('sweepClaims writes exactly one history entry per expired claim via the injected writer', () => {
    const written: Array<[string | null, string, string]> = [];
    setClaimHistoryWriter((workspaceRoot, taskId, message) => written.push([workspaceRoot, taskId, message]));
    const claim = claimWorktree(baseParams({ now: 0 }));
    sweepClaims(Date.parse(claim.expiresAt) + 1);
    expect(written).toHaveLength(1);
    expect(written[0]?.[0]).toBe('ws-1');
    expect(written[0]?.[1]).toBe('FLUX-1');
  });

  it('sweepClaims never throws when no history writer is registered', () => {
    const claim = claimWorktree(baseParams({ now: 0 }));
    expect(() => sweepClaims(Date.parse(claim.expiresAt) + 1)).not.toThrow();
  });

  // FLUX-1778: hasActiveClaim's lazy eviction (called by the reclaim reconcile via
  // worktreeUnreclaimableReason, on PR_RECONCILE_INTERVAL_MS) used to delete the claim silently —
  // only sweepClaims (on the slower BACKGROUND_HOLD_SWEEP_INTERVAL_MS) wrote the history entry, so
  // whichever tick observed the expiry first decided whether the entry existed at all. Both now
  // route through the same expireClaim helper.
  it('hasActiveClaim writes the same "claim expired" history entry sweepClaims would have', () => {
    const written: Array<[string | null, string, string]> = [];
    setClaimHistoryWriter((workspaceRoot, taskId, message) => written.push([workspaceRoot, taskId, message]));
    const claim = claimWorktree(baseParams({ now: 0 }));
    expect(hasActiveClaim('ws-1', 'FLUX-1', Date.parse(claim.expiresAt) + 1)).toBe(false);
    expect(written).toHaveLength(1);
    expect(written[0]?.[1]).toBe('FLUX-1');
    expect(written[0]?.[2]).toContain('Worktree claim expired');
  });

  it('writes exactly one history entry per expiry regardless of which caller observes it first', () => {
    const written: Array<[string | null, string, string]> = [];
    setClaimHistoryWriter((workspaceRoot, taskId, message) => written.push([workspaceRoot, taskId, message]));
    const claim = claimWorktree(baseParams({ now: 0 }));
    const expiredAt = Date.parse(claim.expiresAt) + 1;

    // hasActiveClaim observes the expiry first (simulating the faster reconcile tick) and evicts it;
    // a subsequent sweepClaims pass must find nothing left to report or re-log.
    expect(hasActiveClaim('ws-1', 'FLUX-1', expiredAt)).toBe(false);
    const outcomes = sweepClaims(expiredAt);
    expect(outcomes).toHaveLength(0);
    expect(written).toHaveLength(1);
  });
});

describe('bulk release', () => {
  it('releaseClaimsForBranch releases every claim on that (workspaceRoot, branch)', () => {
    claimWorktree(baseParams({ ticketId: 'FLUX-1', branch: 'flux/shared', worktreePath: '/wt/FLUX-1' }));
    claimWorktree(baseParams({ ticketId: 'FLUX-2', branch: 'flux/shared', worktreePath: '/wt/FLUX-1' }));
    claimWorktree(baseParams({ ticketId: 'FLUX-3', branch: 'flux/other', worktreePath: '/wt/FLUX-3' }));
    const released = releaseClaimsForBranch('ws-1', 'flux/shared');
    expect(released.map((c) => c.ticketId).sort()).toEqual(['FLUX-1', 'FLUX-2']);
    expect(hasActiveClaim('ws-1', 'FLUX-3')).toBe(true);
  });

  it('releaseClaimsForBranch does not cross workspaces', () => {
    claimWorktree(baseParams({ workspaceRoot: 'ws-1', branch: 'flux/shared' }));
    claimWorktree(baseParams({ workspaceRoot: 'ws-2', branch: 'flux/shared' }));
    releaseClaimsForBranch('ws-1', 'flux/shared');
    expect(hasActiveClaim('ws-2', 'FLUX-1')).toBe(true);
  });

  it('releaseClaimsForWorktree releases every claim at that physical path', () => {
    claimWorktree(baseParams({ ticketId: 'FLUX-1', worktreePath: '/wt/shared' }));
    claimWorktree(baseParams({ ticketId: 'FLUX-2', worktreePath: '/wt/shared' }));
    const released = releaseClaimsForWorktree('/wt/shared');
    expect(released).toHaveLength(2);
    expect(hasActiveClaim('ws-1', 'FLUX-1')).toBe(false);
    expect(hasActiveClaim('ws-1', 'FLUX-2')).toBe(false);
  });
});

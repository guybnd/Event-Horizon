import { describe, it, expect } from 'vitest';
import { evaluateWorktreeReadyRefusal } from './mcp-server.js';

/**
 * FLUX-731: regression coverage for the FLUX-730 commit-before-Ready refusal. The decision
 * is factored out of the `change_status` MCP handler into `evaluateWorktreeReadyRefusal` so it
 * can be exercised as a pure function. These four cases pin the exact scope of the refusal:
 * ONLY a worktree branch that exists with 0 commits ahead is refused; everything else allows.
 */
describe('evaluateWorktreeReadyRefusal (FLUX-730 commit-before-Ready)', () => {
  const base = {
    ticketId: 'FLUX-1',
    branch: 'flux/FLUX-1-demo',
    readyStatus: 'Ready',
  };

  it('REFUSES a worktree branch that exists with 0 commits ahead', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 2,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('FLUX-1');
    expect(r.message).toContain('Ready');
    expect(r.message).toContain('no commits ahead of base');
    // changeCount > 0 → message names the uncommitted work (pluralized).
    expect(r.message).toContain('2 uncommitted changes');
    expect(r.message).toContain('Status left unchanged');
  });

  it('REFUSES with the "no changes yet" phrasing when changeCount is 0', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 0,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('no changes yet');
  });

  it('uses the singular form for exactly one uncommitted change', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 1,
    });
    expect(r.message).toContain('1 uncommitted change');
    expect(r.message).not.toContain('1 uncommitted changes');
  });

  it('ALLOWS a worktree branch with commits ahead (falls through to PR)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 3 },
    });
    expect(r.refuse).toBe(false);
    expect(r.message).toBeUndefined();
  });

  it('ALLOWS a plain branch with 0 commits ahead (no worktree → soft warning, not refused)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: null,
      branchStatus: { exists: true, aheadCount: 0 },
    });
    expect(r.refuse).toBe(false);
  });

  it('ALLOWS a branchless ticket (no branch status, unaffected)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: null,
      branchStatus: null,
    });
    expect(r.refuse).toBe(false);
  });

  it('ALLOWS when the worktree branch does not exist (exists:false)', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: false, aheadCount: 0 },
    });
    expect(r.refuse).toBe(false);
  });

  // FLUX-1267: noDiffExpected escape hatch for legitimately zero-diff (verification-only) tickets.
  it('ALLOWS a worktree branch with 0 commits ahead when noDiffAcknowledged and the tree is clean', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 0,
      noDiffAcknowledged: true,
    });
    expect(r.refuse).toBe(false);
    expect(r.message).toBeUndefined();
  });

  it('STILL REFUSES when noDiffAcknowledged is true but the worktree has uncommitted changes', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 3,
      noDiffAcknowledged: true,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('3 uncommitted changes');
  });

  it('mentions the noDiffExpected escape hatch in the refusal message', () => {
    const r = evaluateWorktreeReadyRefusal({
      ...base,
      worktreePath: 'C:/wt/EventHorizon-FLUX-1',
      branchStatus: { exists: true, aheadCount: 0 },
      changeCount: 0,
    });
    expect(r.refuse).toBe(true);
    expect(r.message).toContain('noDiffExpected:true');
  });
});

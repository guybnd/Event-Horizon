import { describe, it, expect } from 'vitest';
import { shouldFlagUnownedChangesRequested } from './mcp-server.js';

/**
 * FLUX-1681 (Fix B): a `changes-requested` verdict bouncing a ticket off Ready with no engine-owned
 * continuation driver (Temper not looping it, no active Furnace batch) must be flagged Needs-Action
 * instead of sitting silently unattended in In Progress (the reported ANZUBRAI-51 stall).
 * `shouldFlagUnownedChangesRequested` is the pure decision extracted from the `change_status` handler
 * (mirrors the `resolveReviewStateOnMove`/`evaluatePlanGateTrigger` idiom) — the impure ownership check
 * itself (`isChangesRequestedBounceOwned`) is exercised separately in temper.test.ts.
 */
describe('shouldFlagUnownedChangesRequested (FLUX-1681 Fix B)', () => {
  const READY = 'Ready';

  it('flags a changes-requested bounce off Ready when nothing owns it', () => {
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: 'changes-requested', priorStatus: READY, newStatus: 'In Progress', readyStatus: READY, owned: false,
    })).toBe(true);
  });

  it('does not flag when Temper or an active Furnace batch owns the ticket', () => {
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: 'changes-requested', priorStatus: READY, newStatus: 'In Progress', readyStatus: READY, owned: true,
    })).toBe(false);
  });

  it('does not flag an approval (stays at Ready, never bounces away)', () => {
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: 'approved', priorStatus: READY, newStatus: READY, readyStatus: READY, owned: false,
    })).toBe(false);
  });

  it('does not flag when no verdict was recorded on this move', () => {
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: undefined, priorStatus: READY, newStatus: 'In Progress', readyStatus: READY, owned: false,
    })).toBe(false);
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: null, priorStatus: READY, newStatus: 'In Progress', readyStatus: READY, owned: false,
    })).toBe(false);
  });

  it('does not flag a move that never left Ready in the first place', () => {
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: 'changes-requested', priorStatus: 'In Progress', newStatus: 'In Progress', readyStatus: READY, owned: false,
    })).toBe(false);
  });

  it('honors a custom Ready label (config-driven, mirrors resolveReviewStateOnMove)', () => {
    expect(shouldFlagUnownedChangesRequested({
      reviewStateThisMove: 'changes-requested', priorStatus: 'Shipped', newStatus: 'In Progress', readyStatus: 'Shipped', owned: false,
    })).toBe(true);
  });
});

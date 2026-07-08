import { describe, it, expect } from 'vitest';
import { resolvePlanReviewStateOnMove, evaluatePlanGateTrigger, planGateRedirectSucceeded, resolvePlanGateMode } from './mcp-server.js';

/**
 * FLUX-1263: `resolvePlanReviewStateOnMove` is the `planReviewState` analog of `resolveReviewStateOnMove`
 * (FLUX-1089), keyed to `Grooming` instead of `Ready`. `evaluatePlanGateTrigger` is the pure decision behind
 * the `change_status` guard that redirects a Grooming -> Todo move into the plan-review gate instead of
 * letting it through directly, per the gate's policy value.
 */
describe('resolvePlanReviewStateOnMove (FLUX-1263)', () => {
  const GROOMING = 'Grooming';

  it('clears a stale verdict when a Grooming ticket leaves with no explicit verdict', () => {
    expect(resolvePlanReviewStateOnMove(undefined, GROOMING, 'Todo', GROOMING)).toEqual({ planReviewState: null });
  });

  it('an explicit verdict on the same move always wins over the auto-clear', () => {
    expect(resolvePlanReviewStateOnMove('changes-requested', GROOMING, GROOMING, GROOMING)).toEqual({ planReviewState: 'changes-requested' });
    expect(resolvePlanReviewStateOnMove('approved', GROOMING, GROOMING, GROOMING)).toEqual({ planReviewState: 'approved' });
  });

  it('an explicit null (manual clear) is also honored on a Grooming-leaving move', () => {
    expect(resolvePlanReviewStateOnMove(null, GROOMING, 'Todo', GROOMING)).toEqual({ planReviewState: null });
  });

  it('is a no-op for a ticket that was never in Grooming', () => {
    expect(resolvePlanReviewStateOnMove(undefined, 'Todo', 'In Progress', GROOMING)).toEqual({});
  });

  it('is a no-op re-affirming Grooming (status unchanged, no explicit verdict)', () => {
    expect(resolvePlanReviewStateOnMove(undefined, GROOMING, GROOMING, GROOMING)).toEqual({});
  });
});

describe('evaluatePlanGateTrigger (FLUX-1263)', () => {
  const base = { priorStatus: 'Grooming', newStatus: 'Todo', groomingStatus: 'Grooming', todoStatus: 'Todo' } as const;

  it('never intercepts under the `you` gate value regardless of verdict state', () => {
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'you', planReviewState: null })).toBe(false);
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'you', planReviewState: 'approved' })).toBe(false);
  });

  it('intercepts under `auto`/`auto-then-you` when no verdict has been recorded yet', () => {
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'auto', planReviewState: null })).toBe(true);
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'auto-then-you', planReviewState: null })).toBe(true);
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'auto', planReviewState: undefined })).toBe(true);
  });

  it('lets the move through once a verdict already exists (the human/agent confirm)', () => {
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'auto-then-you', planReviewState: 'approved' })).toBe(false);
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'auto-then-you', planReviewState: 'changes-requested' })).toBe(false);
    expect(evaluatePlanGateTrigger({ ...base, gateValue: 'auto', planReviewState: 'approved' })).toBe(false);
  });

  it('never intercepts a move that is not Grooming -> Todo', () => {
    expect(evaluatePlanGateTrigger({ ...base, priorStatus: 'In Progress', gateValue: 'auto', planReviewState: null })).toBe(false);
    expect(evaluatePlanGateTrigger({ ...base, newStatus: 'Archived', gateValue: 'auto', planReviewState: null })).toBe(false);
    expect(evaluatePlanGateTrigger({ ...base, newStatus: 'Grooming', gateValue: 'auto', planReviewState: null })).toBe(false);
  });

  it('honors a custom Todo label (config-driven, mirrors nextStepForStatus)', () => {
    expect(evaluatePlanGateTrigger({ ...base, todoStatus: 'Backlog', newStatus: 'Backlog', gateValue: 'auto', planReviewState: null })).toBe(true);
    expect(evaluatePlanGateTrigger({ ...base, todoStatus: 'Backlog', newStatus: 'Todo', gateValue: 'auto', planReviewState: null })).toBe(false);
  });
});

/**
 * FLUX-1269: `startPlanGateNow` can return `ok: false` for reasons that mean wildly different things —
 * a duplicate trigger (`already-running`) means the gate genuinely IS running, so the "runs instead"
 * message is still true; a Furnace-batch-ownership refusal means NOTHING started, so reporting the same
 * success message would strand the ticket in Grooming behind a false claim. `planGateRedirectSucceeded`
 * is the pure decision the `change_status` redirect uses to tell these apart.
 */
describe('planGateRedirectSucceeded (FLUX-1269)', () => {
  it('is true when a pass was freshly dispatched', () => {
    expect(planGateRedirectSucceeded({ ok: true, message: 'dispatched' })).toBe(true);
  });

  it('is true for the benign "already in flight" duplicate-trigger case despite ok:false', () => {
    expect(planGateRedirectSucceeded({ ok: false, message: 'already running', reason: 'already-running' })).toBe(true);
  });

  it('is false when the ticket is owned by an active Furnace batch — nothing started', () => {
    expect(planGateRedirectSucceeded({ ok: false, message: 'furnace owns it', reason: 'furnace-owned' })).toBe(false);
  });

  it('is false for the other (practically unreachable here) refusal reasons', () => {
    expect(planGateRedirectSucceeded({ ok: false, message: 'not found', reason: 'not-found' })).toBe(false);
    expect(planGateRedirectSucceeded({ ok: false, message: 'wrong status', reason: 'wrong-status' })).toBe(false);
  });
});

/**
 * FLUX-1288: gate value -> the loop shape `startPlanGateNow` should run. `auto` loops and auto-moves on
 * approval (`loop-auto`); `auto-then-you` loops the same way but always stops on approval to flag a human
 * to confirm (`loop-confirm`). `you` is included for completeness even though `evaluatePlanGateTrigger`
 * never calls this for it (a manual `start_plan_review` call always passes `one-pass` directly instead).
 */
describe('resolvePlanGateMode (FLUX-1288)', () => {
  it('maps `auto` to `loop-auto`', () => {
    expect(resolvePlanGateMode('auto')).toBe('loop-auto');
  });

  it('maps `auto-then-you` to `loop-confirm`', () => {
    expect(resolvePlanGateMode('auto-then-you')).toBe('loop-confirm');
  });

  it('maps `you` to `loop-confirm` (never actually reached via the trigger — `you` never intercepts)', () => {
    expect(resolvePlanGateMode('you')).toBe('loop-confirm');
  });
});

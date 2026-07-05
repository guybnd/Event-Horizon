import { describe, it, expect } from 'vitest';
import { resolveReviewStateOnMove } from './mcp-server.js';

/**
 * FLUX-1089: `change_status` must not leave a stale `reviewState` on a ticket that was approved
 * (or flagged changes-requested) and then bounced back out of Ready without a fresh verdict — the
 * prior review no longer describes a ticket that's active work again. `resolveReviewStateOnMove` is
 * the pure decision extracted from the handler (mirrors the `evaluateWorktreeReadyRefusal` idiom).
 */
describe('resolveReviewStateOnMove (FLUX-1089 stale-reviewState clear)', () => {
  const READY = 'Ready';

  it('clears an approved verdict when a Ready ticket bounces to In Progress with no explicit verdict', () => {
    expect(resolveReviewStateOnMove(undefined, READY, 'In Progress', READY)).toEqual({ reviewState: null });
  });

  it('clears a stale changes-requested verdict the same way', () => {
    expect(resolveReviewStateOnMove(undefined, READY, 'In Progress', READY)).toEqual({ reviewState: null });
  });

  it('an explicit verdict on the same move always wins over the auto-clear', () => {
    expect(resolveReviewStateOnMove('changes-requested', READY, 'In Progress', READY)).toEqual({ reviewState: 'changes-requested' });
    expect(resolveReviewStateOnMove('approved', READY, 'Done', READY)).toEqual({ reviewState: 'approved' });
  });

  it('an explicit null (manual clear) is also honored on a Ready-leaving move', () => {
    expect(resolveReviewStateOnMove(null, READY, 'In Progress', READY)).toEqual({ reviewState: null });
  });

  it('is a no-op for a ticket that was never Ready', () => {
    expect(resolveReviewStateOnMove(undefined, 'In Progress', 'Require Input', READY)).toEqual({});
    expect(resolveReviewStateOnMove(undefined, 'Todo', 'In Progress', READY)).toEqual({});
  });

  it('is a no-op re-affirming Ready (status unchanged)', () => {
    expect(resolveReviewStateOnMove(undefined, READY, READY, READY)).toEqual({});
  });

  it('honors a custom Ready label (config-driven, mirrors nextStepForStatus)', () => {
    expect(resolveReviewStateOnMove(undefined, 'Shipped', 'In Progress', 'Shipped')).toEqual({ reviewState: null });
    expect(resolveReviewStateOnMove(undefined, 'Ready', 'In Progress', 'Shipped')).toEqual({});
  });
});

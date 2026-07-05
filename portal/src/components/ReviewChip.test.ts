import { describe, it, expect } from 'vitest';
import type { Task } from '../types';
import { aggregateMemberReviews, selectPrReviewChip } from './ReviewChip';

function member(overrides: Partial<Task> & { id: string; status: string }): Task {
  return { title: overrides.id, ...overrides } as Task;
}

/**
 * FLUX-1089: the PR-card review signal is derived from `aggregateMemberReviews` at render time.
 * Pins the stale-approval guard (an 'approved' member only counts while it's still Ready) and the
 * shrinking-membership edge case decided in the ticket (the live member set is the truth).
 */
describe('aggregateMemberReviews (FLUX-1089 member-derived review signal)', () => {
  it('returns zeroed stats for no members', () => {
    expect(aggregateMemberReviews([])).toEqual({ approvedCount: 0, total: 0, anyChangesRequested: false });
  });

  it('counts a Ready + approved member as approved', () => {
    const members = [member({ id: 'FLUX-1', status: 'Ready', reviewState: 'approved' })];
    expect(aggregateMemberReviews(members)).toEqual({ approvedCount: 1, total: 1, anyChangesRequested: false });
  });

  it('stale-approval guard: an approved member bounced to In Progress no longer counts', () => {
    const members = [member({ id: 'FLUX-1', status: 'In Progress', reviewState: 'approved' })];
    expect(aggregateMemberReviews(members).approvedCount).toBe(0);
  });

  it('flags anyChangesRequested from a single member regardless of the others', () => {
    const members = [
      member({ id: 'FLUX-1', status: 'Ready', reviewState: 'approved' }),
      member({ id: 'FLUX-2', status: 'In Progress', reviewState: 'changes-requested' }),
    ];
    const agg = aggregateMemberReviews(members);
    expect(agg.anyChangesRequested).toBe(true);
    expect(agg.approvedCount).toBe(1);
    expect(agg.total).toBe(2);
  });

  it('a never-reviewed member counts toward total but not approvedCount', () => {
    const members = [
      member({ id: 'FLUX-1', status: 'Ready', reviewState: 'approved' }),
      member({ id: 'FLUX-2', status: 'In Progress' }),
    ];
    const agg = aggregateMemberReviews(members);
    expect(agg.total).toBe(2);
    expect(agg.approvedCount).toBe(1);
  });

  it('single-member PR collapses to the internal-approved chip, not the progress chip', () => {
    const members = [member({ id: 'FLUX-1', status: 'Ready', reviewState: 'approved' })];
    const agg = aggregateMemberReviews(members);
    const task = { reviewDecision: null, reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, agg)).toEqual({ kind: 'internal-approved' });
  });
});

/**
 * FLUX-1092: pins the 5-branch precedence order PrDeckCard renders its review badge with — this
 * exercises the actual decision point (which chip wins), not just the aggregate arithmetic above.
 */
describe('selectPrReviewChip (FLUX-1089 precedence, FLUX-1092 extraction)', () => {
  const noMembers = { approvedCount: 0, total: 0, anyChangesRequested: false };

  it('a member changes-requested wins over everything else', () => {
    const agg = { approvedCount: 2, total: 3, anyChangesRequested: true };
    const task = { reviewDecision: 'APPROVED', reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, agg)).toEqual({ kind: 'changes-requested' });
  });

  it('suppresses the changes-requested chip when the swimlane pill already shows it (dedupe)', () => {
    const agg = { approvedCount: 0, total: 1, anyChangesRequested: true };
    const task = { reviewDecision: null, reviewState: null, swimlane: 'changes-requested' };
    expect(selectPrReviewChip(task, agg)).toEqual({ kind: 'none' });
  });

  it('GitHub CHANGES_REQUESTED wins over an unrelated member signal', () => {
    const task = { reviewDecision: 'CHANGES_REQUESTED', reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, noMembers)).toEqual({ kind: 'changes-requested' });
  });

  it('GitHub APPROVED wins over a partially-approved member set', () => {
    const agg = { approvedCount: 1, total: 2, anyChangesRequested: false };
    const task = { reviewDecision: 'APPROVED', reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, agg)).toEqual({ kind: 'approved' });
  });

  it('every current member approved, GitHub silent → internal-approved', () => {
    const agg = { approvedCount: 3, total: 3, anyChangesRequested: false };
    const task = { reviewDecision: '', reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, agg)).toEqual({ kind: 'internal-approved' });
  });

  it('some but not all members approved → progress chip with counts', () => {
    const agg = { approvedCount: 1, total: 3, anyChangesRequested: false };
    const task = { reviewDecision: null, reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, agg)).toEqual({ kind: 'progress', approvedCount: 1, total: 3 });
  });

  it('falls back to the GitHub reviewDecision when no members have reviewed', () => {
    const task = { reviewDecision: 'REVIEW_REQUIRED', reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, noMembers)).toEqual({ kind: 'fallback', signal: 'REVIEW_REQUIRED' });
  });

  it('falls back to the ticket reviewState when reviewDecision is absent', () => {
    const task = { reviewDecision: null, reviewState: 'approved', swimlane: null } as const;
    expect(selectPrReviewChip(task, noMembers)).toEqual({ kind: 'fallback', signal: 'approved' });
  });

  it('suppresses the fallback chip when it would duplicate the swimlane changes-requested pill', () => {
    const task = { reviewDecision: null, reviewState: 'changes-requested', swimlane: 'changes-requested' } as const;
    expect(selectPrReviewChip(task, noMembers)).toEqual({ kind: 'none' });
  });

  it('no signal anywhere → fallback with a null signal', () => {
    const task = { reviewDecision: null, reviewState: null, swimlane: null };
    expect(selectPrReviewChip(task, noMembers)).toEqual({ kind: 'fallback', signal: null });
  });
});

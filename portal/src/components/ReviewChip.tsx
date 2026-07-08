import type { JSX } from 'react';
import { Check, X, Clock, ShieldCheck, ListChecks } from 'lucide-react';
import type { Task } from '../types';

/**
 * Shared review badge (FLUX-816). One visual vocabulary for BOTH review signals:
 *  - GitHub-synced `reviewDecision` (PR tickets only): APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED
 *  - internal EH `reviewState` (any ticket): 'approved' / 'changes-requested'
 * Lifted out of PrDeckCard's local `reviewChip()` so normal cards and PR cards render identically.
 * Returns null for any falsy / unrecognized value, so a never-reviewed ticket shows no badge.
 */
type ReviewVariant = 'approved' | 'changes-requested' | 'review-required';

/** Aggregate of member-ticket review verdicts, computed at render time — see {@link aggregateMemberReviews}. */
export interface MemberReviewAggregate {
  approvedCount: number;
  total: number;
  anyChangesRequested: boolean;
}

/**
 * FLUX-1089: the PR-card review signal is DERIVED from its member tickets' `reviewState` at
 * render time — never propagated onto the PR ticket itself. `members` is recomputed dynamically
 * (`selectMembers` in pr-tickets.ts: tickets on this branch currently In Progress/Ready), so a
 * copied field would go stale the moment a ticket joins the branch or a member bounces; deriving
 * on every render self-heals instead.
 *
 * Stale-approval guard: a member counts as approved only when `reviewState === 'approved'` AND its
 * status is currently Ready. `change_status` writes `reviewState` only when explicitly passed and
 * (as of FLUX-1089) clears it on leaving Ready without a fresh verdict — this status check is
 * belt-and-braces against any other bounce path that predates or bypasses that engine-side clear.
 */
export function aggregateMemberReviews(members: readonly Task[]): MemberReviewAggregate {
  let approvedCount = 0;
  let anyChangesRequested = false;
  for (const m of members) {
    if (m.reviewState === 'changes-requested') anyChangesRequested = true;
    if (m.reviewState === 'approved' && m.status === 'Ready') approvedCount++;
  }
  return { approvedCount, total: members.length, anyChangesRequested };
}

function normalizeReview(value: string | null | undefined): ReviewVariant | null {
  switch (value) {
    case 'APPROVED':
    case 'approved':
      return 'approved';
    case 'CHANGES_REQUESTED':
    case 'changes-requested':
      return 'changes-requested';
    case 'REVIEW_REQUIRED':
    case 'review-required':
      return 'review-required';
    default:
      return null;
  }
}

const VARIANTS: Record<ReviewVariant, { cls: string; icon: JSX.Element; label: string }> = {
  approved: {
    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    icon: <Check className="h-3 w-3" />,
    label: 'approved',
  },
  'changes-requested': {
    cls: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
    icon: <X className="h-3 w-3" />,
    label: 'changes requested',
  },
  'review-required': {
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    icon: <Clock className="h-3 w-3" />,
    label: 'review required',
  },
};

export function reviewChip(value: string | null | undefined): JSX.Element | null {
  const variant = normalizeReview(value);
  if (!variant) return null;
  const m = VARIANTS[variant];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${m.cls}`}>
      {m.icon}{m.label}
    </span>
  );
}

/**
 * FLUX-1089: every current member approved internally but GitHub hasn't recorded an APPROVED
 * review (e.g. a sequential batch's earlier members post comment-only approvals — only the FINAL
 * member's approval becomes a real `--approve`, see `isFinalSequentialApproval` in
 * furnace-stoker.ts). Deliberately teal, not emerald — a human must be able to tell this apart
 * from a GitHub-recorded approval at a glance.
 */
export function internalApprovedChip(): JSX.Element {
  return (
    <span
      title="All current member tickets approved internally — not yet reflected as a GitHub review"
      className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-semibold text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"
    >
      <ShieldCheck className="h-3 w-3" /> Reviewed (internal)
    </span>
  );
}

/** FLUX-1089: progress toward internal approval across current members — mid-batch, or not yet
 *  started (0/N, FLUX-1310) so the chip is visible as soon as a PR has members. */
export function reviewProgressChip(approvedCount: number, total: number): JSX.Element {
  return (
    <span
      title={`${approvedCount} of ${total} member ticket(s) approved internally`}
      className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
    >
      <ListChecks className="h-3 w-3" /> {approvedCount}/{total} reviewed
    </span>
  );
}

/**
 * FLUX-1092: named precedence decision for the PR-card review badge — extracted from PrDeckCard's
 * inline IIFE so the branch order is pin-testable without a full component render, mirroring the
 * `resolveReviewStateOnMove`/`evaluateWorktreeReadyRefusal` idiom (return plain data, not JSX; the
 * caller maps the selection onto the actual chip element).
 *
 * Precedence order (FLUX-1089, red wins):
 *  1. a member's internal changes-requested OR GitHub CHANGES_REQUESTED → 'changes-requested'
 *     (suppressed to 'none' when the dedicated "Changes requested" pill is already showing for the
 *     GitHub-sourced case — FLUX-594).
 *  2. GitHub APPROVED → 'approved' (the existing green chip, FLUX-816, unchanged).
 *  3. every CURRENT member approved internally (≥1), GitHub silent → 'internal-approved' — an
 *     agent-internal approval must never be mistaken for a GitHub-recorded one (this is what makes
 *     mid-batch Furnace progress visible: a sequential batch's earlier members post comment-only
 *     approvals, so GitHub itself stays quiet until the final member's real `--approve`).
 *  4. any current members exist and aren't all approved → 'progress' — shown from the moment a
 *     PR has members, even at 0 approved (FLUX-1310), not just once the first approval lands.
 *  5. otherwise → 'fallback' (the pre-FLUX-1089 signal: GitHub `reviewDecision` — e.g.
 *     REVIEW_REQUIRED — falling back to the PR ticket's own `reviewState`).
 */
export type PrReviewChipSelection =
  | { kind: 'none' }
  | { kind: 'changes-requested' }
  | { kind: 'approved' }
  | { kind: 'internal-approved' }
  | { kind: 'progress'; approvedCount: number; total: number }
  | { kind: 'fallback'; signal: string | null };

export function selectPrReviewChip(
  task: Pick<Task, 'reviewDecision' | 'reviewState' | 'swimlane'>,
  memberReview: MemberReviewAggregate,
): PrReviewChipSelection {
  const changesRequested = task.swimlane === 'changes-requested';
  // reviewDecision is stored as "" (not null) when GitHub has no review, so `||` (not `??`) is
  // required to fall through past an empty string (FLUX-816).
  const ghDecision = task.reviewDecision || null;
  if (memberReview.anyChangesRequested || ghDecision === 'CHANGES_REQUESTED') {
    return changesRequested ? { kind: 'none' } : { kind: 'changes-requested' };
  }
  if (ghDecision === 'APPROVED') return { kind: 'approved' };
  if (memberReview.total > 0 && memberReview.approvedCount === memberReview.total) {
    return { kind: 'internal-approved' };
  }
  if (memberReview.total > 0) {
    return { kind: 'progress', approvedCount: memberReview.approvedCount, total: memberReview.total };
  }
  const signal = task.reviewDecision || task.reviewState || null;
  if (changesRequested && (signal === 'CHANGES_REQUESTED' || signal === 'changes-requested')) return { kind: 'none' };
  return { kind: 'fallback', signal };
}

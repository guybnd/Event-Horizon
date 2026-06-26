import type { JSX } from 'react';
import { Check, X, Clock } from 'lucide-react';

/**
 * Shared review badge (FLUX-816). One visual vocabulary for BOTH review signals:
 *  - GitHub-synced `reviewDecision` (PR tickets only): APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED
 *  - internal EH `reviewState` (any ticket): 'approved' / 'changes-requested'
 * Lifted out of PrDeckCard's local `reviewChip()` so normal cards and PR cards render identically.
 * Returns null for any falsy / unrecognized value, so a never-reviewed ticket shows no badge.
 */
type ReviewVariant = 'approved' | 'changes-requested' | 'review-required';

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

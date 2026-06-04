import { Search } from 'lucide-react';
import { REVIEW_PERSONAS, type ReviewPersona } from '../agentActions';

export type { ReviewPersona };
export { REVIEW_PERSONAS };

interface Props {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  compact?: boolean;
}

export function CodeReviewButton({ onClick, disabled, busy, compact }: Props) {
  const isDisabled = disabled || busy;

  if (compact) {
    return (
      <button
        type="button"
        disabled={isDisabled}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        className="flex items-center gap-1 rounded-md border border-gray-200 bg-white/80 px-2 py-1 text-[10px] font-semibold text-gray-600 transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:border-primary/40 dark:hover:text-primary"
      >
        <Search className="w-3 h-3" />
        {busy ? '…' : 'Review'}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
    >
      <Search className="h-4 w-4" />
      {busy ? 'Starting review…' : 'Send for Code Review'}
    </button>
  );
}

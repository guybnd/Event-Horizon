import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { REVIEW_PERSONAS, type ReviewPersona } from '../agentActions';

export type { ReviewPersona };
export { REVIEW_PERSONAS };

interface Props {
  onReview: (persona: ReviewPersona) => void;
  disabled?: boolean;
  busy?: boolean;
}

export function CodeReviewButton({ onReview, disabled, busy }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const isDisabled = disabled || busy;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex">
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center justify-center gap-2 rounded-l-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
        >
          <Search className="h-4 w-4" />
          {busy ? 'Starting review…' : 'Send for Code Review'}
        </button>
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-center rounded-r-lg border border-l-gray-300 border-gray-200 px-2 py-2 text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
          aria-label="Choose reviewer persona"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 bottom-full z-50 mb-1 w-72 rounded-xl border border-gray-200 bg-white py-1 shadow-xl dark:border-white/10 dark:bg-[#1e1f2a]">
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">Choose reviewer</div>
          {REVIEW_PERSONAS.map((persona) => (
            <button
              key={persona.id}
              type="button"
              onClick={() => { setOpen(false); onReview(persona); }}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
            >
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{persona.label}</span>
              <span className="text-xs text-gray-500 dark:text-gray-400">{persona.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

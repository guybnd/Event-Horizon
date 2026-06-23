import { useEffect, useRef } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import type { TranscriptFind } from './useTranscriptFind';

/**
 * FLUX-686: the find overlay — a compact bar floating at the top-right of the transcript scroll
 * region. Input + "N/M" counter + prev/next + close. Enter / Shift+Enter cycle matches; Escape
 * closes. State + highlighting live in {@link useTranscriptFind}; this is the pure view.
 */
export function FindBar({ find }: { find: TranscriptFind }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus + select on open (the bar unmounts when closed, so mount-focus is sufficient).
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const { query, count, active, setQuery, next, prev, close } = find;
  const hasMatches = count > 0;
  const btn =
    'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-white/10';

  return (
    <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border border-[var(--eh-border)] bg-[var(--eh-surface)] px-1.5 py-1 shadow-lg">
      <Search className="h-3.5 w-3.5 flex-shrink-0 text-[var(--eh-text-muted)]" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Find in chat…"
        aria-label="Find in chat"
        className="w-32 bg-transparent text-[12px] text-[var(--eh-text-primary)] placeholder:text-[var(--eh-text-muted)] focus:outline-none"
      />
      <span className="min-w-[40px] flex-shrink-0 text-right text-[10px] tabular-nums text-[var(--eh-text-muted)]">
        {query ? `${hasMatches ? active + 1 : 0}/${count}` : ''}
      </span>
      <button type="button" onClick={prev} disabled={!hasMatches} title="Previous match (Shift+Enter)" className={btn}>
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={next} disabled={!hasMatches} title="Next match (Enter)" className={btn}>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={close} title="Close (Esc)" className={btn}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import type { Task } from '../types';
import { TaskCard } from './TaskCard';

export type DeckAccent = 'violet' | 'indigo';

// Accent theming is just a prop (FLUX-580): PR decks are violet, epic decks indigo. Module-level
// so the class strings are allocated once, not per render.
const ACCENT: Record<DeckAccent, { button: string; border: string }> = {
  violet: {
    button: 'text-violet-700 hover:bg-violet-100/60 dark:text-violet-300 dark:hover:bg-violet-500/10',
    border: 'border-violet-200 dark:border-violet-500/30',
  },
  indigo: {
    button: 'text-indigo-700 hover:bg-indigo-100/60 dark:text-indigo-300 dark:hover:bg-indigo-500/10',
    border: 'border-indigo-200 dark:border-indigo-500/30',
  },
};

/**
 * Fold/unwind deck primitive (FLUX-580 — extracted from the FLUX-567 PR deck). A collapsible
 * pile of compact member cards behind a "N items" toggle (Layers icon), defaulting to folded.
 * Backs BOTH the PR members deck (violet) and the epic subtasks deck (indigo) so the
 * fold/unwind UI lives in exactly one place. Renders nothing when there are no items.
 */
export function TaskDeck({ id, items, label, accent = 'violet' }: {
  /** Stable id for the unwound container (aria-controls target). */
  id: string;
  /** The folded tickets to reveal on unwind, rendered as compact member cards. */
  items: Task[];
  /** Toggle label, given the item count (e.g. `n => \`${n} subtask${n === 1 ? '' : 's'}\``). */
  label: (count: number) => string;
  accent?: DeckAccent;
}) {
  const [unwound, setUnwound] = useState(false);
  if (items.length === 0) return null;
  const a = ACCENT[accent];
  return (
    <div className="mb-1">
      <button
        // Stop the click bubbling to the host card body (FLUX-677): the epic TaskCard opens its
        // full view on body click, so without this the toggle both unwinds the deck AND opens the
        // ticket. Harmless for the PR deck (its card body doesn't open a full view).
        onClick={(e) => { e.stopPropagation(); setUnwound((u) => !u); }}
        aria-expanded={unwound}
        aria-controls={id}
        className={`flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] font-semibold transition-colors ${a.button}`}
      >
        {unwound ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Layers className="h-3.5 w-3.5" />
        {label(items.length)}
      </button>
      {unwound && (
        <div id={id} className={`mt-1.5 border-l-2 pl-2 ${a.border}`}>
          {items.map((m) => (
            <TaskCard key={m.id} task={m} compact hideStatusBadge />
          ))}
        </div>
      )}
    </div>
  );
}

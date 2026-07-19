import { useState } from 'react';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import type { Task } from '../types';
import { getMemberState, PINNED_MEMBER_STATES } from '../lib/memberState';
import { useAppSelector } from '../store/useAppSelector';
import { MemberLine } from './MemberLine';

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
 * Fold/unwind deck primitive (FLUX-580 — extracted from the FLUX-567 PR deck; FLUX-1503 — replaced
 * the all-or-nothing compact-card render with a two-tier pin/hide system). Members with a live or
 * actionable state (tempering/implementing/parked/failed) render as a pinned `MemberLine` ABOVE the
 * toggle, always — the rest (done/ready/queued) hide behind a "N more…" toggle, unwinding to their
 * own `MemberLine`s. Backs BOTH the PR members deck (violet) and the epic subtasks deck (indigo) so
 * the fold/unwind UI lives in exactly one place. Renders nothing when there are no items.
 */
export function TaskDeck({ id, items, label, accent = 'violet', parentTask, order }: {
  /** Stable id for the unwound container (aria-controls target). */
  id: string;
  /** The folded tickets, partitioned into pinned (live/actionable) + hidden-behind-toggle. */
  items: Task[];
  /** Toggle label, given the HIDDEN count (e.g. `n => \`${n} more subtask${n === 1 ? '' : 's'}\``). */
  label: (hiddenCount: number) => string;
  accent?: DeckAccent;
  /**
   * Threaded to every rendered `MemberLine` — the epic (if any) each member itself belongs to.
   * Either a single shared parent (epic deck: every subtask shares the epic) or a per-member
   * resolver (PR deck: each member independently belongs to its OWN epic, if any — FLUX-1503).
   */
  parentTask?: Task | ((task: Task) => Task | undefined);
  /** Sort order for both the pinned and hidden lists (PR = burn order); omit to use input order. */
  order?: (task: Task) => number;
}) {
  const [unwound, setUnwound] = useState(false);
  const resolveParentTask = typeof parentTask === 'function' ? parentTask : () => parentTask;
  // FLUX-1503: one coarse subscription for the pin/hide partition + toggle count — a `.map()`
  // can't call `useFurnaceTicket` per-iteration (rules-of-hooks, the list can change length across
  // renders), and this single aggregate decision doesn't need per-id isolation the way the
  // individual line/segment rendering does (that isolation lives in `MemberLine`/`MemberStateStrip`
  // themselves, which resolve their own batch ticket independently).
  const furnaceTicketById = useAppSelector((s) => s.furnaceTicketById);
  if (items.length === 0) return null;
  const a = ACCENT[accent];

  const pinned: Task[] = [];
  const hidden: Task[] = [];
  for (const m of items) {
    const state = getMemberState(m, furnaceTicketById[m.id]);
    (PINNED_MEMBER_STATES.has(state) ? pinned : hidden).push(m);
  }
  const sortedPinned = order ? [...pinned].sort((x, y) => order(x) - order(y)) : pinned;
  const sortedHidden = order ? [...hidden].sort((x, y) => order(x) - order(y)) : hidden;

  return (
    <div className="mb-1">
      {sortedPinned.map((m) => (
        <MemberLine key={m.id} task={m} parentTask={resolveParentTask(m)} />
      ))}
      {sortedHidden.length > 0 && (
        <>
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
            {label(sortedHidden.length)}
          </button>
          {unwound && (
            <div id={id} className={`mt-1.5 border-l-2 pl-2 ${a.border}`}>
              {sortedHidden.map((m) => (
                <MemberLine key={m.id} task={m} parentTask={resolveParentTask(m)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronRight } from 'lucide-react';
import { fetchTicketHealth, type TicketHealthData } from '../../api';

/**
 * Per-ticket health (FLUX-1739 follow-on) — how did this ticket's execution actually go?
 *
 * Complements the AttentionDock rather than duplicating it: that says "act now, this is blocked",
 * this says "that went badly, your process may need a look". Retrospective, not escalation.
 *
 * The panel deliberately renders NOTHING for a clean ticket. A health surface that shows a green
 * badge on every ticket trains you to stop looking at it, and the only thing worth your attention
 * here is the exception.
 */

const GRADE: Record<string, { label: string; cls: string; dot: string }> = {
  clean: { label: 'Clean', cls: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/15', dot: '#10b981' },
  noisy: { label: 'Noisy', cls: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/15', dot: '#f59e0b' },
  rough: { label: 'Rough', cls: 'text-orange-700 bg-orange-50 dark:text-orange-300 dark:bg-orange-500/15', dot: '#f97316' },
  broken: { label: 'Needs a look', cls: 'text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-500/15', dot: '#f43f5e' },
};

export function TicketHealthPanel({ ticketId }: { ticketId: string }) {
  const [health, setHealth] = useState<TicketHealthData | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!ticketId) return;
    fetchTicketHealth(ticketId).then(setHealth).catch(() => setHealth(null));
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);

  // Nothing to say about a ticket that ran cleanly — see the panel doc above.
  if (!health || health.grade === 'clean') return null;

  const g = GRADE[health.grade] ?? GRADE.noisy!;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1c1d26] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-white/5"
      >
        <Activity className="w-4 h-4 flex-none" style={{ color: g.dot }} />
        <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold flex-none ${g.cls}`}>{g.label}</span>
        <span className="text-[12.5px] text-gray-600 dark:text-gray-300 truncate flex-1">{health.summary}</span>
        <ChevronRight className={`w-3.5 h-3.5 flex-none text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="px-3.5 pb-3.5 pt-1 border-t border-gray-200 dark:border-white/10 flex flex-col gap-3">
          {health.unambiguous.length > 0 && (
            <Group
              title="Platform issues"
              hint="Bad regardless of what this ticket was — these set the grade."
              signals={health.unambiguous}
              emphasis
            />
          )}
          {health.contextual.length > 0 && (
            <Group
              title="Context"
              hint="Reported, not graded — a large ticket earns these honestly."
              signals={health.contextual}
            />
          )}
          <div className="text-[11px] text-gray-400 dark:text-gray-500">
            {health.sessionCount} session{health.sessionCount === 1 ? '' : 's'} on this ticket.
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  title, hint, signals, emphasis,
}: {
  title: string;
  hint: string;
  signals: TicketHealthData['unambiguous'];
  emphasis?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">{title}</div>
      <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-1.5">{hint}</div>
      <div className="flex flex-col">
        {signals.map((s) => (
          <div key={s.key} className="flex gap-3 items-baseline py-1.5 border-b last:border-b-0 border-gray-200 dark:border-white/10 text-[12.5px]">
            <span className={`tabular-nums font-mono text-[11.5px] w-7 text-right flex-none ${emphasis ? 'text-rose-600 dark:text-rose-400 font-semibold' : 'text-gray-400 dark:text-gray-500'}`}>
              {s.count}
            </span>
            <span className="text-gray-700 dark:text-gray-300 flex-1">{s.label}</span>
            {s.locators[0] && (
              <span className="font-mono text-[10.5px] text-gray-400 dark:text-gray-500 truncate max-w-[40%]" title={s.locators.join(', ')}>
                {s.locators[0]}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

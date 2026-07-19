import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radio, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { fetchBoardActivity, BOARD_CONVERSATION_ID, type TranscriptMessage } from '../api';
import type { Task } from '../types';
import { formatRelative } from '../lib/relativeTime';
import {
  DISPATCH_STAGE_LABEL,
  DISPATCH_PHASE_LABEL,
  DISPATCH_PHASES,
  DISPATCH_LIFECYCLES,
} from '../lib/dispatch';
import { FilterDropdown, DropdownItem } from './TaskViewControls';
import { SkeletonRow } from './ui/Skeleton';

/**
 * FLUX-885: Board Activity/History as a header popover. Re-homed from the full-screen `ActivityScreen`
 * route (FLUX-867) into a dropdown next to the notifications bell / pending-interaction cluster — the
 * three event feeds ("what just happened" vs "what needs me") now sit together. This is a presentational
 * re-home: the data layer is unchanged. It still replays the durable `kind:'dispatch'` lifecycle rows
 * the board orchestrator thread accumulates (FLUX-849) into a filterable, newest-first feed — "what ran,
 * in what phase, with what outcome, over time." No new store: it reads the same `__board__` transcript
 * the chat dock does, via the read-only `/api/tasks/__board__/activity` endpoint.
 *
 * Filtering: the **phase / outcome / time** filters are pushed **server-side** so the newest-N cap
 * applies AFTER narrowing — a phase/outcome/time filter therefore reaches the *full* history, not just
 * the capped window (review M2). The **ticket** filter stays client-side so its dropdown keeps deriving
 * its option list from the windowed result and never collapses to the single selected ticket. The two
 * "Unknown" buckets ask for rows where `phase`/`lifecycle` is *absent* — which the server query param
 * can't express — so they omit the param and resolve client-side in `filtered`. Filter state is local to
 * the panel (it resets when the popover closes, mirroring the NotificationPanel pattern). Live: debounced
 * refetch on the board's `taskUpdated` SSE event (the tee broadcasts it for `__board__` on every
 * lifecycle transition).
 */

type TimeRange = 'all' | '1h' | '24h' | '7d';

const TIME_RANGE_LABEL: Record<TimeRange, string> = {
  all: 'All time',
  '1h': 'Last hour',
  '24h': 'Last 24h',
  '7d': 'Last 7 days',
};

const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

// Server-side newest-N cap requested per load. Mirrors the route's accepted max (2000) headroom while
// keeping the payload bounded; when a load returns exactly this many rows the window is truncated and
// the truncation banner is shown (review M2 — no silent cap).
const LIMIT = 1000;

// Trailing debounce on the SSE-driven refetch, coalescing the dispatch bursts a multi-ticket board
// emits into one transcript re-read. Matches ChatDiffPanel's LIVE_REFRESH_DEBOUNCE_MS.
const LIVE_REFRESH_DEBOUNCE_MS = 700;

// Sentinels for the "field absent" buckets — rows predating FLUX-865 (or non-phase sessions) carry no
// `phase`, and an unusual/legacy dispatch row can lack `lifecycle`. The phase/outcome filters offer an
// explicit "Unknown" option rather than dropping them. These ask for *absent* fields, so they're
// filtered client-side (the server `phase`/`lifecycle` params only match concrete values).
const UNKNOWN_PHASE = '__none__';
const UNKNOWN_OUTCOME = '__none__';

// Natural ticket ordering so FLUX-2 sorts before FLUX-10 (not lexicographic FLUX-10 < FLUX-2).
const compareTickets = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Lightweight per-lifecycle accent (a colored dot + the colored outcome word). Deliberately simpler
// than the chat DispatchChip's full treatment — this is a dense log row, not a chat chip — but the
// color language (working=primary, completed=emerald, failed=rose, waiting=amber, cancelled=zinc)
// is kept in sync so the two surfaces read the same.
const LIFECYCLE_DOT: Record<string, string> = {
  started: 'bg-primary/60',
  working: 'bg-primary',
  completed: 'bg-emerald-500',
  failed: 'bg-rose-500',
  cancelled: 'bg-zinc-400 dark:bg-zinc-500',
  'waiting-input': 'bg-amber-500',
};
const LIFECYCLE_TEXT: Record<string, string> = {
  started: 'text-primary/80',
  working: 'text-primary',
  completed: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-rose-600 dark:text-rose-400',
  cancelled: 'text-zinc-500 dark:text-zinc-400',
  'waiting-input': 'text-amber-600 dark:text-amber-400',
};

interface ActivityFilters {
  ticket: string;
  phase: string;
  outcome: string;
  range: TimeRange;
}

const DEFAULTS: ActivityFilters = { ticket: 'all', phase: 'all', outcome: 'all', range: 'all' };

interface Props {
  onClose: () => void;
  /** FLUX-898: render inline inside the unified attention surface's Activity tab — drop the floating
   *  popover chrome (fixed position, outside-click-to-close) and fill the host instead. */
  embedded?: boolean;
}

export const ActivityPanel = memo(function ActivityPanel({ onClose, embedded = false }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  const [ticketFilter, setTicketFilter] = useState(DEFAULTS.ticket);
  const [phaseFilter, setPhaseFilter] = useState(DEFAULTS.phase);
  const [outcomeFilter, setOutcomeFilter] = useState(DEFAULTS.outcome);
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULTS.range);

  const [rows, setRows] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);

  const taskById = useAppSelector((s) => s.taskById);
  const { subscribeToEvent, openTaskModal } = useAppActions();

  // FLUX-885: close on outside-click / Escape, mirroring NotificationPanel. Clicks on the header
  // trigger are ignored ([data-activity-toggle]) so the toggle can close the panel itself instead of
  // the outside-mousedown closing it and the toggle's onClick immediately re-opening it (stuck open).
  useEffect(() => {
    // FLUX-898: embedded inside the attention surface the host owns open/close — don't self-close.
    if (embedded) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Element;
      if (target?.closest?.('[data-activity-toggle]')) return;
      if (panelRef.current && !panelRef.current.contains(target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, embedded]);

  // Monotonic request id: a slow earlier load() must not overwrite a newer snapshot (rapid SSE bursts
  // or quick filter changes fire overlapping loads). Each load tags itself; only the latest commits.
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      // Recompute `from` at call time (NOT memoized on range) so a long-open "Last hour/24h/7d" window
      // slides with the clock instead of freezing at selection time (review M5).
      const from = timeRange === 'all' ? undefined : new Date(Date.now() - RANGE_MS[timeRange]).toISOString();
      const data = await fetchBoardActivity({
        // Concrete phase/outcome push server-side (filter-then-cap → full history). The Unknown buckets
        // want *absent* fields the param can't express, so omit them here and filter client-side below.
        phase: phaseFilter !== 'all' && phaseFilter !== UNKNOWN_PHASE ? phaseFilter : undefined,
        lifecycle: outcomeFilter !== 'all' && outcomeFilter !== UNKNOWN_OUTCOME ? outcomeFilter : undefined,
        from,
        limit: LIMIT,
      });
      if (seq !== reqSeq.current) return; // superseded by a newer load()
      setRows(data);
      setCapped(data.length >= LIMIT);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load activity');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [phaseFilter, outcomeFilter, timeRange]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Live tail: the dispatch teeing (FLUX-849) broadcasts `taskUpdated` for `__board__` on every
  // lifecycle event. Debounced refetch coalesces the burst a multi-ticket board emits. (The `activity`
  // SSE event carries the *dispatched* task's id, never `__board__`, so it would never match here — it
  // is deliberately not subscribed; `taskUpdated` covers every tee.) load() never sets loading=true, so
  // background refetches don't flicker the list.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === BOARD_CONVERSATION_ID || o.id === BOARD_CONVERSATION_ID);
    };
    const on = (d: unknown) => {
      if (!matches(d)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), LIVE_REFRESH_DEBOUNCE_MS);
    };
    const unsub = subscribeToEvent('taskUpdated', on);
    return () => { if (timer) clearTimeout(timer); unsub(); };
  }, [subscribeToEvent, load]);

  // Ticket options derive from the distinct source tickets present in the windowed result, plus the
  // active selection (so a selection outside the current window stays selectable).
  const ticketOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.sourceTask) set.add(r.sourceTask);
    if (ticketFilter !== 'all') set.add(ticketFilter);
    return Array.from(set).sort(compareTickets);
  }, [rows, ticketFilter]);

  const filtered = useMemo(
    () => rows.filter((r) => {
      if (ticketFilter !== 'all' && r.sourceTask !== ticketFilter) return false;
      if (phaseFilter !== 'all') {
        if (phaseFilter === UNKNOWN_PHASE) { if (r.phase) return false; }
        else if (r.phase !== phaseFilter) return false;
      }
      if (outcomeFilter !== 'all') {
        if (outcomeFilter === UNKNOWN_OUTCOME) { if (r.lifecycle) return false; }
        else if (r.lifecycle !== outcomeFilter) return false;
      }
      return true;
    }),
    [rows, ticketFilter, phaseFilter, outcomeFilter],
  );

  const hasActiveFilters =
    ticketFilter !== DEFAULTS.ticket || phaseFilter !== DEFAULTS.phase ||
    outcomeFilter !== DEFAULTS.outcome || timeRange !== DEFAULTS.range;

  const clearFilters = () => {
    setTicketFilter(DEFAULTS.ticket);
    setPhaseFilter(DEFAULTS.phase);
    setOutcomeFilter(DEFAULTS.outcome);
    setTimeRange(DEFAULTS.range);
  };

  const phaseDisplay =
    phaseFilter === 'all' ? 'All phases'
    : phaseFilter === UNKNOWN_PHASE ? 'Unknown'
    : (DISPATCH_PHASE_LABEL[phaseFilter] ?? phaseFilter);
  const outcomeDisplay =
    outcomeFilter === 'all' ? 'All outcomes'
    : outcomeFilter === UNKNOWN_OUTCOME ? 'Unknown'
    : (DISPATCH_STAGE_LABEL[outcomeFilter] ?? outcomeFilter);

  const showSkeleton = loading && rows.length === 0;
  const showInitialError = !!error && rows.length === 0;

  const inner = (
    <>
      {/* Sticky header: title + filter controls. Sits outside the scroll container, so it stays put
          while the event list scrolls beneath it. */}
      <div className="shrink-0 border-b border-gray-100 dark:border-white/5">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4" style={{ color: '#06b6d4' }} />
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Activity</h3>
            <span className="text-xs text-gray-500">
              {showSkeleton ? 'loading…' : `${filtered.length} event${filtered.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 transition-colors hover:text-primary"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}
            {!embedded && (
              <button onClick={onClose} className="rounded p-1 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 px-3 pb-3">
          <FilterDropdown label="Ticket" displayValue={ticketFilter === 'all' ? 'All tickets' : ticketFilter}>
            <DropdownItem selected={ticketFilter === 'all'} onClick={() => setTicketFilter('all')}>All tickets</DropdownItem>
            {ticketOptions.map((t) => (
              <DropdownItem key={t} selected={ticketFilter === t} onClick={() => setTicketFilter(t)}>{t}</DropdownItem>
            ))}
          </FilterDropdown>

          <FilterDropdown label="Phase" displayValue={phaseDisplay}>
            <DropdownItem selected={phaseFilter === 'all'} onClick={() => setPhaseFilter('all')}>All phases</DropdownItem>
            {DISPATCH_PHASES.map((p) => (
              <DropdownItem key={p} selected={phaseFilter === p} onClick={() => setPhaseFilter(p)}>{DISPATCH_PHASE_LABEL[p]}</DropdownItem>
            ))}
            <DropdownItem selected={phaseFilter === UNKNOWN_PHASE} onClick={() => setPhaseFilter(UNKNOWN_PHASE)}>Unknown</DropdownItem>
          </FilterDropdown>

          <FilterDropdown label="Outcome" displayValue={outcomeDisplay}>
            <DropdownItem selected={outcomeFilter === 'all'} onClick={() => setOutcomeFilter('all')}>All outcomes</DropdownItem>
            {DISPATCH_LIFECYCLES.map((l) => (
              <DropdownItem key={l} selected={outcomeFilter === l} onClick={() => setOutcomeFilter(l)}>{DISPATCH_STAGE_LABEL[l]}</DropdownItem>
            ))}
            <DropdownItem selected={outcomeFilter === UNKNOWN_OUTCOME} onClick={() => setOutcomeFilter(UNKNOWN_OUTCOME)}>Unknown</DropdownItem>
          </FilterDropdown>

          <FilterDropdown label="When" displayValue={TIME_RANGE_LABEL[timeRange]}>
            {(Object.keys(TIME_RANGE_LABEL) as TimeRange[]).map((r) => (
              <DropdownItem key={r} selected={timeRange === r} onClick={() => setTimeRange(r)}>{TIME_RANGE_LABEL[r]}</DropdownItem>
            ))}
          </FilterDropdown>
        </div>
      </div>

      {/* Scrolling event list. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {showSkeleton ? (
          <ul className="space-y-1.5" aria-busy="true" aria-label="Loading activity">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="rounded-lg border border-gray-100 bg-white px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                <SkeletonRow />
              </li>
            ))}
          </ul>
        ) : showInitialError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        ) : (
          <>
            {/* A background-refetch failure keeps the populated history and surfaces the error
                non-destructively, instead of blanking the view (review M3). */}
            {error && (
              <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
                Live update failed ({error}) — showing the last loaded activity.
              </div>
            )}
            {capped && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
                Showing the newest {LIMIT.toLocaleString()} events. Older activity isn't shown — narrow the phase, outcome, or time range to reach it.
              </div>
            )}
            {filtered.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 px-4 py-10 text-center text-sm text-gray-500 dark:border-white/10 dark:text-gray-400">
                {!hasActiveFilters && rows.length === 0
                  ? 'No dispatch activity yet — events appear here as unattended sessions run.'
                  : 'No activity matches the current filters.'}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {filtered.map((r) => (
                  <ActivityRow
                    key={`${r.ts}-${r.sourceTask ?? ''}-${r.lifecycle ?? ''}-${r.phase ?? ''}-${(r.text || '').slice(0, 48)}`}
                    row={r}
                    task={r.sourceTask ? taskById.get(r.sourceTask) : undefined}
                    onOpen={openTaskModal}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );

  if (embedded) {
    return <div ref={panelRef} className="flex h-full min-h-0 flex-col">{inner}</div>;
  }

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="absolute right-0 top-full mt-2 z-50 flex max-h-[560px] w-[480px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#1a1b26]"
    >
      {inner}
    </motion.div>
  );
});

const ActivityRow = memo(function ActivityRow({
  row,
  task,
  onOpen,
}: {
  row: TranscriptMessage;
  task: Task | undefined;
  onOpen: (task?: Task) => void;
}) {
  const lifecycle = row.lifecycle;
  const stageLabel = (lifecycle && DISPATCH_STAGE_LABEL[lifecycle]) ?? lifecycle ?? 'activity';
  const phaseLabel = row.phase ? (DISPATCH_PHASE_LABEL[row.phase] ?? row.phase) : null;
  const dot = (lifecycle && LIFECYCLE_DOT[lifecycle]) ?? 'bg-gray-300 dark:bg-gray-600';
  const textColor = (lifecycle && LIFECYCLE_TEXT[lifecycle]) ?? 'text-gray-500 dark:text-gray-400';
  // Only `working` rows carry real narration; the bracketing markers carry text that just repeats the
  // lifecycle label, so suppress it there to keep the log scannable. A phase-less/legacy row with an
  // unknown lifecycle falls back to showing its text.
  const narration = (lifecycle === 'working' || !lifecycle) ? (row.text || '').trim() : '';

  return (
    <li className="flex items-start gap-3 rounded-lg border border-gray-100 bg-white px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${dot}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {row.sourceTask && (
            <button
              type="button"
              disabled={!task}
              onClick={() => task && onOpen(task)}
              className={`rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-gray-700 dark:bg-white/10 dark:text-gray-200 ${task ? 'cursor-pointer hover:bg-gray-200 dark:hover:bg-white/15' : 'cursor-default'}`}
              title={task ? task.title : 'Not on the board'}
            >
              {row.sourceTask}
            </button>
          )}
          {phaseLabel && (
            <span className="rounded-md bg-cyan-500/10 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-cyan-600 dark:text-cyan-400">
              {phaseLabel}
            </span>
          )}
          <span className={`text-sm font-medium ${textColor}`}>{stageLabel}</span>
          <span className="ml-auto flex-none text-xs text-gray-500" title={new Date(row.ts).toLocaleString()}>{formatRelative(row.ts)}</span>
        </div>
        {narration && (
          <p className="mt-1 truncate text-sm text-gray-600 dark:text-gray-300" title={narration}>
            {narration}
          </p>
        )}
      </div>
    </li>
  );
});

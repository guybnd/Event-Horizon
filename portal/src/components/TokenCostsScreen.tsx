import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Coins, AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchTokenStats, type TokenStatsTaskRow } from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { getStatusColorClass } from '../statusStyles';
import { normalizeStatus, getArchiveStatus } from '../workflow';
import { TokenBadge } from './TokenBadge';
import type { Config, Task } from '../types';

interface CostRow {
  task: Task;
  stats: TokenStatsTaskRow;
}

type SortMode = 'cost' | 'savings';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'cost', label: 'Cost (desc)' },
  { value: 'savings', label: 'Digest savings % (desc)' },
];

/**
 * Board-level ranked-cost view (FLUX-1512): every ticket with recorded token/cost data, ranked by
 * spend, with the FLUX-501/503 history-digest savings and oversized-body/history flags surfaced
 * per row. Modeled on EpicsScreen.tsx's idiom (header + filter chips + sort select + row-click →
 * openTask). Fetches `/api/stats/tokens` once on mount — no live/streaming refresh, since token
 * totals only change on session activity, not board polling.
 */
export function TokenCostsScreen() {
  const tasks = useAppSelector((s) => s.tasks);
  const config = useAppSelector((s) => s.config);
  const { openTask } = useAppActions();

  const archiveStatus = useMemo(() => getArchiveStatus(config), [config]);

  const [byTask, setByTask] = useState<Record<string, TokenStatsTaskRow> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hideArchived, setHideArchived] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('cost');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchTokenStats()
      .then((data) => setByTask(data.byTask))
      .catch(() => setError('Failed to load token stats'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint's exhaustive-deps intentionally doesn't flag `load` here — it closes over
    // `fetchTokenStats` (a module-level import) and state setters (stable identity), so there's
    // no reactive value it could go stale on. Mount-only fetch (no live/streaming refresh).
  }, []);

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  // Join byTask rows with the live task list by id. Dangling ids (deleted/archived-out tickets)
  // are dropped silently — the ticket they refer to no longer exists to open or display.
  // Rows with no meaningful cost/token data are excluded from the ranking entirely (per the
  // ticket's stated edge case: "excluded from ranking, not a false zero"), not rendered as $0.00.
  const allRows = useMemo<CostRow[]>(() => {
    if (!byTask) return [];
    const rows: CostRow[] = [];
    for (const [id, stats] of Object.entries(byTask)) {
      const task = taskById.get(id);
      if (!task) continue;
      if (stats.costUSD === 0 && stats.inputTokens === 0 && stats.outputTokens === 0) continue;
      rows.push({ task, stats });
    }
    return rows;
  }, [byTask, taskById]);

  const rows = useMemo<CostRow[]>(() => {
    const filtered = allRows.filter(({ task }) => {
      if (hideArchived && task.status === archiveStatus) return false;
      return true;
    });
    const sorted = [...filtered];
    switch (sortMode) {
      case 'cost':
        sorted.sort((a, b) => b.stats.costUSD - a.stats.costUSD || a.task.id.localeCompare(b.task.id));
        break;
      case 'savings':
        sorted.sort((a, b) => (b.stats.pctSaved ?? 0) - (a.stats.pctSaved ?? 0) || a.task.id.localeCompare(b.task.id));
        break;
    }
    return sorted;
  }, [allRows, hideArchived, archiveStatus, sortMode]);

  const hiddenByFilters = allRows.length - rows.length;

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="flex items-center gap-3 mb-4">
        <Coins className="w-7 h-7 text-emerald-500" />
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Token Costs</h1>
        {rows.length > 0 && (
          <span className="text-sm text-gray-400 dark:text-gray-500">
            {rows.length} {rows.length === 1 ? 'ticket' : 'tickets'}
          </span>
        )}
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title="Refresh"
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:bg-[#252630] dark:text-gray-400 dark:hover:bg-white/5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {allRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <FilterChip active={hideArchived} onClick={() => setHideArchived((v) => !v)}>
            Hide archived
          </FilterChip>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="token-cost-sort" className="text-xs text-gray-400 dark:text-gray-500">
              Sort
            </label>
            <select
              id="token-cost-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="bg-white dark:bg-[#252630] border border-gray-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-medium focus:border-primary outline-none cursor-pointer"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {loading && !byTask && <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>}
      {error && <div className="text-sm text-red-500">{error}</div>}

      {!loading && byTask && allRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <Coins className="w-8 h-8 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400 font-medium">No token data yet</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
            Tickets show up here once an agent session has recorded input/output tokens or cost.
          </p>
        </div>
      ) : !loading && byTask && rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <Coins className="w-8 h-8 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400 font-medium">
            {hiddenByFilters} {hiddenByFilters === 1 ? 'ticket' : 'tickets'} hidden by filters
          </p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
            Adjust the filters above to reveal them.
          </p>
        </div>
      ) : rows.length > 0 ? (
        <div className="space-y-1.5">
          {rows.map(({ task, stats }) => (
            <CostRowView key={task.id} task={task} stats={stats} config={config} onOpen={() => openTask(task)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
        active
          ? 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-500/15 dark:border-indigo-500/30 dark:text-indigo-300'
          : 'bg-white border-gray-200 text-gray-500 dark:bg-[#252630] dark:border-white/10 dark:text-gray-400'
      }`}
    >
      {children}
    </button>
  );
}

function CostRowView({
  task,
  stats,
  config,
  onOpen,
}: {
  task: Task;
  stats: TokenStatsTaskRow;
  config: Config | null;
  onOpen: () => void;
}) {
  const savedLabel =
    stats.pctSaved != null && stats.pctSaved > 0 ? `${stats.pctSaved}% saved` : '—';

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left hover:border-primary/40 hover:bg-primary/5 dark:border-gray-800 dark:bg-gray-800/50 dark:hover:border-primary/30 dark:hover:bg-primary/10 transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-gray-800 dark:text-gray-200 truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-300 transition-colors">
            {task.title || task.id}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          <span className="font-mono text-[10px] text-gray-500 dark:text-gray-500">{task.id}</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${getStatusColorClass(config, task.status)}`}>
            {normalizeStatus(task.status)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {(stats.bodyOversized || stats.historyOversized) && (
          <span
            title={[stats.bodyOversized ? 'Oversized body' : null, stats.historyOversized ? 'Oversized history' : null]
              .filter(Boolean)
              .join(' · ')}
            className="text-amber-600 dark:text-amber-400"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
          </span>
        )}
        <span className="w-24 text-right text-xs text-gray-500 dark:text-gray-400 tabular-nums">{savedLabel}</span>
        <div className="w-28 text-right">
          <TokenBadge data={stats} config={config} variant="panel" />
        </div>
      </div>
    </button>
  );
}

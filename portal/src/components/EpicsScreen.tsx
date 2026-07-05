import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Target, CheckCircle2, AlertTriangle, MousePointerClick } from 'lucide-react';
import type { Config, Task } from '../types';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { CardChatButton } from './task-card/CardChatButton';
import { isEpic, getDoneStatuses, computeEpicRollup, type EpicRollup } from '../lib/epics';
import { getArchiveStatus, normalizeStatus } from '../workflow';
import { getStatusColorClass } from '../statusStyles';
import { EpicProgressBar } from './EpicProgressBar';

interface EpicRow {
  epic: Task;
  rollup: EpicRollup;
  /** Most recent history entry date (ms epoch); 0 when the epic has no history. */
  lastActivity: number;
}

type SortMode = 'closest' | 'least' | 'recent';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'closest', label: 'Closest to done' },
  { value: 'least', label: 'Least complete' },
  { value: 'recent', label: 'Recently active' },
];

/** Recency for the "Recently active" sort — derived from history since Task has no updatedAt.
 *  FLUX-725: the max-activity date is pre-computed on the list digest (was a scan over full history). */
function lastActivityDate(task: Task): number {
  const t = Date.parse(task.historyDigest?.lastActivityAt ?? '');
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Epic / roadmap view (FLUX-678). Lists every epic (task with ≥1 subtask) with its count-based
 * completion rate, and drills in to the remaining (non-done) subtasks grouped by board status.
 * Completion math is shared with the board card via lib/epics so the two never drift.
 */
export function EpicsScreen() {
  const tasks = useAppSelector((s) => s.tasks);
  const taskById = useAppSelector((s) => s.taskById);
  const config = useAppSelector((s) => s.config);
  const { openTask } = useAppActions();

  const doneStatuses = useMemo(() => getDoneStatuses(config), [config]);
  const archiveStatus = useMemo(() => getArchiveStatus(config), [config]);

  // Filters & sort — default to surfacing live, near-done work (FLUX-696).
  const [hideArchived, setHideArchived] = useState(true);
  const [hideCompleted, setHideCompleted] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>('closest');

  // Status order from board config (columns first, then hidden statuses) so custom boards
  // group remaining work in their own column order rather than a hardcoded list.
  const statusOrder = useMemo(() => {
    const order = new Map<string, number>();
    [...(config?.columns ?? []), ...(config?.hiddenStatuses ?? [])].forEach((s, i) => {
      if (!order.has(s.name)) order.set(s.name, i);
    });
    return order;
  }, [config]);

  // Every epic, enriched with its rollup. Unfiltered/unsorted base — filtering & sorting derive
  // from this so the "N hidden by filters" count knows the true total.
  const allEpicRows = useMemo<EpicRow[]>(() => {
    return tasks
      .filter(isEpic)
      .map((epic) => ({
        epic,
        rollup: computeEpicRollup(epic, taskById, doneStatuses),
        lastActivity: lastActivityDate(epic),
      }));
  }, [tasks, taskById, doneStatuses]);

  // Apply the default-on filters (hide archived, hide completed) then the chosen sort.
  const epicRows = useMemo<EpicRow[]>(() => {
    const filtered = allEpicRows.filter(({ epic, rollup }) => {
      if (hideArchived && epic.status === archiveStatus) return false;
      if (hideCompleted && rollup.pct === 100) return false;
      return true;
    });
    const sorted = [...filtered];
    switch (sortMode) {
      case 'closest': // almost-finished work first
        sorted.sort((a, b) => b.rollup.pct - a.rollup.pct || a.epic.id.localeCompare(b.epic.id));
        break;
      case 'least': // FLUX-678's original ordering, kept as an option
        sorted.sort((a, b) => a.rollup.pct - b.rollup.pct || a.epic.id.localeCompare(b.epic.id));
        break;
      case 'recent': // most recent history activity first
        sorted.sort((a, b) => b.lastActivity - a.lastActivity || a.epic.id.localeCompare(b.epic.id));
        break;
    }
    return sorted;
  }, [allEpicRows, hideArchived, hideCompleted, archiveStatus, sortMode]);

  const hiddenByFilters = allEpicRows.length - epicRows.length;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="flex items-center gap-3 mb-4">
        <Target className="w-7 h-7 text-indigo-500" />
        <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Epics</h1>
        {epicRows.length > 0 && (
          <span className="text-sm text-gray-400 dark:text-gray-500">
            {epicRows.length} {epicRows.length === 1 ? 'epic' : 'epics'}
          </span>
        )}
      </div>

      {allEpicRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-6">
          <FilterChip active={hideArchived} onClick={() => setHideArchived((v) => !v)}>
            Hide archived
          </FilterChip>
          <FilterChip active={hideCompleted} onClick={() => setHideCompleted((v) => !v)}>
            Hide completed
          </FilterChip>
          <div className="ml-auto flex items-center gap-2">
            <label htmlFor="epic-sort" className="text-xs text-gray-400 dark:text-gray-500">
              Sort
            </label>
            <select
              id="epic-sort"
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

      {allEpicRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <Target className="w-8 h-8 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400 font-medium">No epics yet</p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
            Any ticket with at least one subtask shows up here with its completion rate.
          </p>
        </div>
      ) : epicRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-12 text-center">
          <Target className="w-8 h-8 mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400 font-medium">
            {hiddenByFilters} {hiddenByFilters === 1 ? 'epic' : 'epics'} hidden by filters
          </p>
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
            Adjust the filters above to reveal them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {epicRows.map(({ epic, rollup }) => (
            <EpicCard
              key={epic.id}
              epic={epic}
              rollup={rollup}
              config={config}
              doneStatuses={doneStatuses}
              statusOrder={statusOrder}
              isCollapsed={!expanded.has(epic.id)}
              onToggle={() => toggle(epic.id)}
              onOpenTask={openTask}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A compact toggle chip for the filter bar; active = filter applied (matches portal control styling). */
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

function EpicCard({
  epic,
  rollup,
  config,
  doneStatuses,
  statusOrder,
  isCollapsed,
  onToggle,
  onOpenTask,
}: {
  epic: Task;
  rollup: EpicRollup;
  config: Config | null;
  doneStatuses: ReadonlySet<string>;
  statusOrder: Map<string, number>;
  isCollapsed: boolean;
  onToggle: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const { done, total, pct, resolvedSubtasks } = rollup;
  const pctLabel = Math.round(pct);
  // Declared subtasks that didn't resolve to a known task (deleted/archived out of taskById).
  // They count toward `total` (as not-done) but can't appear in the grouped list below, so we
  // surface them explicitly — otherwise the drill-in's numbers wouldn't reconcile with the bar.
  const unresolved = total - resolvedSubtasks.length;

  // Remaining (non-done) subtasks grouped by status, in board-column order.
  const remainingGroups = useMemo(() => {
    const remaining = resolvedSubtasks.filter((t) => !doneStatuses.has(t.status));
    const byStatus = new Map<string, Task[]>();
    for (const t of remaining) {
      const status = normalizeStatus(t.status);
      const bucket = byStatus.get(status) ?? [];
      bucket.push(t);
      byStatus.set(status, bucket);
    }
    return [...byStatus.entries()].sort(
      ([a], [b]) => (statusOrder.get(a) ?? 999) - (statusOrder.get(b) ?? 999) || a.localeCompare(b),
    );
  }, [resolvedSubtasks, doneStatuses, statusOrder]);

  const priorityColor = config?.priorities?.find((p) => p.name === epic.priority)?.color;
  const effortLabel = epic.effort && epic.effort !== 'None' ? epic.effort : null;

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-800/50">
      {/* Expand/collapse affordance. Kept a role="button" div rather than a real <button>
          because it wraps the title/bar buttons, and nesting interactive elements in a
          <button> is invalid HTML. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        aria-controls={`epic-drill-${epic.id}`}
        className="relative flex items-center gap-3 p-4 cursor-pointer select-none rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 dark:focus-visible:ring-indigo-500"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <ChevronDown
          aria-hidden="true"
          className={`w-5 h-5 shrink-0 text-gray-400 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
        />

        <div className="min-w-0 flex-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenTask(epic);
            }}
            className="group/title flex items-center gap-2 text-left max-w-full rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            title="Open epic"
          >
            <span className="font-semibold text-gray-800 dark:text-gray-200 truncate group-hover/title:text-indigo-600 group-focus-visible/title:text-indigo-600 dark:group-hover/title:text-indigo-300 dark:group-focus-visible/title:text-indigo-300 transition-colors">
              {epic.title || epic.id}
            </span>
            <MousePointerClick className="w-3.5 h-3.5 shrink-0 text-indigo-400 opacity-0 group-hover/title:opacity-100 group-focus-visible/title:opacity-100 transition-opacity" />
          </button>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span className="font-mono text-[10px] text-gray-500 dark:text-gray-500">{epic.id}</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${getStatusColorClass(config, epic.status)}`}>
              {normalizeStatus(epic.status)}
            </span>
            {epic.priority && epic.priority !== 'None' && (
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${priorityColor || 'text-gray-500'}`}>
                {epic.priority}
              </span>
            )}
            {effortLabel && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {effortLabel}
              </span>
            )}
          </div>
        </div>

        <CardChatButton task={epic} />

        {/* Completion bar — clicks fall through to the header toggle (no own action).
            Fill colour is completion-driven on this surface (at-risk signal). The
            EpicProgressBar default stays emerald so board cards remain neutral. */}
        <div className="flex items-center gap-2.5 w-48 shrink-0">
          <EpicProgressBar
            done={done}
            total={total}
            fillClass={
              pct >= 75
                ? 'bg-emerald-500 dark:bg-emerald-400'
                : pct >= 40
                  ? 'bg-amber-400 dark:bg-amber-400'
                  : 'bg-red-400 dark:bg-red-500'
            }
          />
          <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap tabular-nums">
            {done}/{total} · {pctLabel}%
          </span>
        </div>
      </div>

      {!isCollapsed && (
        <div id={`epic-drill-${epic.id}`} className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-800/80">
          {remainingGroups.length === 0 && unresolved === 0 ? (
            <div className="flex items-center gap-2 py-3 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              {total > 0 ? 'All subtasks complete' : 'No subtasks to show'}
            </div>
          ) : (
            <div className="space-y-4 pt-3">
              {remainingGroups.map(([status, subtasks]) => (
                <div key={status}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${getStatusColorClass(config, status)}`}>
                      {status}
                    </span>
                    <span className="text-[10px] text-gray-500 dark:text-gray-500">
                      {subtasks.length}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {subtasks.map((sub) => (
                      <button
                        key={sub.id}
                        onClick={() => onOpenTask(sub)}
                        className="group/sub flex items-center gap-2 w-full text-left rounded-md px-2 py-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 transition-colors"
                        title="Open subtask"
                      >
                        <span className="font-mono text-[10px] text-gray-500 dark:text-gray-500 shrink-0">
                          {sub.id}
                        </span>
                        <span className="text-sm text-gray-700 dark:text-gray-300 truncate group-hover/sub:text-indigo-600 group-focus-visible/sub:text-indigo-600 dark:group-hover/sub:text-indigo-300 dark:group-focus-visible/sub:text-indigo-300 transition-colors">
                          {sub.title || sub.id}
                        </span>
                        <MousePointerClick className="w-3 h-3 shrink-0 ml-auto text-indigo-400 opacity-0 group-hover/sub:opacity-100 group-focus-visible/sub:opacity-100 transition-opacity" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {unresolved > 0 && (
                <div className="flex items-center gap-2 pt-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {unresolved} unresolved subtask{unresolved === 1 ? '' : 's'} (deleted or archived) — counted as not done
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

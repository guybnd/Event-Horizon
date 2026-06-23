import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TaskCard } from './TaskCard';
import { EpicStackDeck } from './EpicStackDeck';
import type { ColumnLiveEvent, Task, TaskLiveEvent } from '../types';
import type { CrossColumnCluster } from '../lib/decks';
import { computeEpicRollup, getDoneStatuses } from '../lib/epics';
import { Plus, CirclePause, Bot, Clock, Terminal, GitPullRequest, HandHelping, X } from 'lucide-react';
import { updateTask } from '../api';
import { useAppSelector, useAppActions, useLiveSession } from '../store/useAppSelector';
import { getStatusTint, tintColumnWash } from '../statusStyles';
import { isTaskAwaitingInput, needsAction } from '../workflow';

/** Compact running-duration label, e.g. "4s", "3m 12s", "1h 04m". */
function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '';
  const ms = now - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSecs = Math.floor(ms / 1000);
  const secs = totalSecs % 60;
  const mins = Math.floor(totalSecs / 60) % 60;
  const hours = Math.floor(totalSecs / 3600);
  if (hours > 0) return `${hours}h ${String(mins).padStart(2, '0')}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

/**
 * Ambient live readout pinned to the bottom of a column that has running
 * sessions. Fills the empty vertical space (e.g. a sparse In Progress column)
 * with current step + elapsed + streaming last line, reinforcing the column
 * as the live working surface. Only mounts when there are running tasks, so it
 * never affects idle columns.
 */
const LiveFooterRow = memo(function LiveFooterRow({ task, now }: { task: Task; now: number }) {
  // FLUX-626: the activity label reads the SSE-fed live slice (instant) and falls back to the
  // polled cliSession summary; elapsed + last-output line stay on the polled summary.
  const live = useLiveSession(task.id);
  const session = task.cliSession!;
  const currentActivity = live?.currentActivity ?? session.currentActivity;
  const elapsed = formatElapsed(session.startedAt, now);
  const lastLine = session.liveOutput
    ? session.liveOutput.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
    : '';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.id}</span>
        {currentActivity && (
          <span className="min-w-0 truncate text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
            {currentActivity}
          </span>
        )}
        {elapsed && (
          <span className="ml-auto flex items-center gap-0.5 text-[9px] font-semibold tabular-nums text-gray-400 dark:text-gray-500">
            <Clock className="h-2.5 w-2.5" />
            {elapsed}
          </span>
        )}
      </div>
      {lastLine && (
        <div className="flex items-start gap-1.5 rounded-lg bg-gray-900 p-2 font-mono text-[9px] leading-relaxed text-gray-300 dark:bg-black/40">
          <Terminal className="mt-0.5 h-2.5 w-2.5 shrink-0 text-emerald-400" />
          <span className="line-clamp-2">{lastLine}</span>
        </div>
      )}
    </div>
  );
});

const ColumnLiveFooter = memo(function ColumnLiveFooter({ runningTasks }: { runningTasks: Task[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="mt-auto pt-3">
      <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/40 p-3 dark:border-emerald-500/20 dark:bg-emerald-500/5">
        <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">
          <Bot className="h-3 w-3" />
          <span>Live</span>
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        </div>
        <div className="flex flex-col gap-2.5">
          {runningTasks.map((task) => (
            <LiveFooterRow key={task.id} task={task} now={now} />
          ))}
        </div>
      </div>
    </div>
  );
});

/**
 * Proxy deck for a cross-column subtask cluster (FLUX-677). When ≥2 subtasks of one epic pile up
 * in a column the epic isn't in, they group here under a reduced "mirror" of the epic card
 * (icon · title · overall progress, click-through to the real epic), with the subtasks themselves
 * grouped in the shared {@link EpicStackDeck} — collapsed they peek as a card stack, expanded they
 * fan out as full TaskCards. The mirror reads as "these belong to that epic, which lives elsewhere".
 */
const ProxyDeck = memo(function ProxyDeck({ epic, subtasks, column, openEpic }: {
  epic: Task;
  subtasks: Task[];
  column: string;
  openEpic: (task: Task) => void;
}) {
  const taskById = useAppSelector((s) => s.taskById);
  const config = useAppSelector((s) => s.config);
  // The mirror shows the epic's OVERALL completion (all its subtasks), not just this column's
  // cluster — shared with the board card + Epics screen via lib/epics, so the number never drifts.
  const epicProgress = useMemo(() => {
    const rollup = computeEpicRollup(epic, taskById, getDoneStatuses(config));
    return { done: rollup.done, total: rollup.total };
  }, [epic, taskById, config]);
  return (
    <EpicStackDeck
      idPrefix={`epic-cluster-${epic.id}-${column}`}
      items={subtasks}
      epic={epic}
      epicProgress={epicProgress}
      openEpic={openEpic}
    />
  );
});

interface ColumnProps {
  id: string;
  title: string;
  tasks: Task[];
  /** Cross-column epic clusters (FLUX-677) to render as proxy decks in this column. */
  clusters?: CrossColumnCluster[];
  /** Same-column epic decks (FLUX-699): epic id → its folded subtasks, rendered as a peeking
   *  card stack directly below the epic card (the epic is the deck's top card). */
  foldedByEpic?: Map<string, Task[]>;
  parentByChildId: Map<string, Task>;
  liveEvent?: ColumnLiveEvent;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  getTaskTravelDirection: (taskId: string) => -1 | 0 | 1;
}

export const Column = memo(function Column({ id, title, tasks, clusters, foldedByEpic, parentByChildId, liveEvent, taskLiveEvents, getTaskTravelDirection }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { openTask, openTaskModal, markAllCommentsRead } = useAppActions();
  const config = useAppSelector((s) => s.config);
  const readComments = useAppSelector((s) => s.readComments);
  const prByBranch = useAppSelector((s) => s.prByBranch);

  const openTaskByMode = useCallback((task: Task) => openTask(task), [openTask]);

  const columnUnreadByTask = useMemo(() => tasks.map(task => {
    const readIds = new Set(readComments[task.id] ?? []);
    const ids = (task.history ?? [])
      .filter(e => e.type === 'comment' && e.id && !readIds.has(e.id))
      .map(e => e.id!);
    return { taskId: task.id, ids };
  }).filter(t => t.ids.length > 0), [tasks, readComments]);
  const hasColumnUnread = columnUnreadByTask.length > 0;

  // Tasks with a live agent session in this column. When the column is sparse,
  // we surface a live readout footer that fills the empty space (#4).
  const runningTasks = useMemo(
    () => tasks.filter(t => t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status)),
    [tasks]
  );
  // Only fill space when the column is not already crowded — a packed column has
  // no empty space to reclaim, and the running cards already show their own state.
  const showLiveFooter = runningTasks.length > 0 && tasks.length <= 4;

  const tint = getStatusTint(config, title);
  const boardFx = config?.boardFx;
  const allTasks = useAppSelector((s) => s.tasks);

  const doneStreakCount = useMemo(() => {
    if (boardFx?.doneStreak === false || id !== 'Done') return 0;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let count = 0;
    for (const task of allTasks) {
      for (const e of task.history ?? []) {
        if (e.type !== 'status_change') continue;
        const to = (e as { to?: string }).to ?? '';
        if (!/done/i.test(to)) continue;
        if (new Date(e.date).getTime() >= todayMs) { count++; break; }
      }
    }
    return count;
  }, [allTasks, boardFx?.doneStreak, id]);

  const streakTier = doneStreakCount >= 15 ? { icon: '💎', label: 'Diamond', cls: 'text-cyan-400' }
    : doneStreakCount >= 10 ? { icon: '🏆', label: 'Platinum', cls: 'text-violet-400' }
    : doneStreakCount >= 5  ? { icon: '🥇', label: 'Gold', cls: 'text-amber-400' }
    : doneStreakCount >= 3  ? { icon: '🥉', label: 'Bronze', cls: 'text-orange-500' }
    : null;

  return (
    <div className="flex flex-col w-[320px] min-w-[280px] flex-1 max-w-[420px]">
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2.5">
          {/* Column identity: hue accent bar + pronounced title */}
          <span className={`h-5 w-1 shrink-0 rounded-full ${tint.accent}`} aria-hidden />
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-700 dark:text-gray-200">
            {title}
          </h2>
          <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${liveEvent ? 'column-live-badge' : ''} ${
            boardFx?.columnFire !== false && tasks.length >= 20
              ? 'column-fire-3'
              : boardFx?.columnFire !== false && tasks.length >= 13
                ? 'column-fire-2'
                : boardFx?.columnFire !== false && tasks.length >= 7
                  ? 'column-fire-1'
                  : 'bg-gray-200 text-gray-600 dark:bg-white/10 dark:text-gray-400'
          }`}>
            {tasks.length}
          </span>
          {hasColumnUnread && (
            <button
              onClick={() => columnUnreadByTask.forEach(({ taskId, ids }) => markAllCommentsRead(taskId, ids))}
              className="text-[10px] font-semibold text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
            >
              Mark all read
            </button>
          )}
        </div>
        {id === 'Done' && (
          <div className="flex items-center gap-2">
            {streakTier && (
              <span
                title={`${streakTier.label} streak — ${doneStreakCount} tickets done today`}
                className={`select-none text-sm leading-none ${streakTier.cls}`}
              >
                {streakTier.icon} {doneStreakCount}
              </span>
            )}
            {tasks.length > 0 && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent('flux:open-release-modal', { detail: { tasks } }))}
                className="text-xs font-bold bg-primary/10 text-primary hover:bg-primary/20 px-2 py-1 rounded"
              >
                Release
              </button>
            )}
          </div>
        )}
      </div>
      
      <div
        ref={setNodeRef}
        style={isOver ? undefined : { backgroundImage: tintColumnWash(tint, 0.08) }}
        className={`flex-1 flex flex-col rounded-2xl p-4 min-h-[500px] transition-all duration-200 border border-transparent ${
          isOver ? 'bg-primary/5 border-primary/20 shadow-[inset_0_0_0_1px_var(--eh-border-accent)]' : 'eh-column'
        } ${liveEvent ? 'column-live-receiving' : ''} ${boardFx?.idleDust !== false && tasks.length === 0 ? 'column-idle-dust' : ''}`}
      >
        {id === 'Grooming' && (
          <button 
            onClick={() => openTaskModal({ status: id })}
            className="sticky top-3 z-10 w-full flex items-center justify-center gap-2 py-2 mb-3 rounded-lg border border-dashed border-gray-300 dark:border-white/20 text-gray-500 dark:text-gray-400 hover:text-primary hover:border-primary shadow-sm backdrop-blur-md bg-white/80 dark:bg-black/60 transition-colors text-sm font-medium cursor-pointer shrink-0"
          >
            <Plus className="w-4 h-4" />
            New Task
          </button>
        )}

        {/* Cross-column subtask clusters (FLUX-677): same-epic subtasks (≥2) that piled up in a
            column the epic ISN'T in, grouped under a reduced epic "mirror" deck. Rendered at the
            TOP of the column (not buried below the column's own cards) and outside the
            SortableContext, so they stay visible even in a busy column. */}
        {clusters && clusters.length > 0 && (
          <div className="mb-2">
            {clusters.map((cluster) => (
              <ProxyDeck
                key={cluster.epic.id}
                epic={cluster.epic}
                subtasks={cluster.subtasks}
                column={id}
                openEpic={openTaskByMode}
              />
            ))}
          </div>
        )}

        {tasks.length > 0 && (() => {
          const runningTasks = tasks.filter(
            t => t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status)
          );
          const isRunning = (t: Task) => !!t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status);
          const isPr = (t: Task) => t.kind === 'pr';
          // Only OPEN PR decks belong under the "Open PRs" header — a merged/closed (Done) PR
          // still renders as a deck card, but in its normal column with no Open-PRs header
          // (FLUX-567: don't show a Done PR under "Open PRs").
          const isOpenPr = (t: Task) => isPr(t) && t.status !== 'Done';
          const swimlaneTasks = tasks.filter(t => isTaskAwaitingInput(t) && !isRunning(t) && !isPr(t));
          // Only the `PR-<n>` deck cards group under "Open PRs" now — the FLUX-558 glow that
          // pulled normal tickets in via the `open-pr` swimlane is retired (FLUX-569).
          const openPrTasks = tasks.filter(t => isOpenPr(t) && !isRunning(t) && !isTaskAwaitingInput(t));
          // FLUX-651: agent parked without taking an action — surfaced as its own group. Excludes
          // running (it's working again) and awaiting-input (that's a real question, shown above).
          const needsActionTasks = tasks.filter(t => needsAction(t) && !isRunning(t) && !isPr(t) && !isTaskAwaitingInput(t));
          // rest = the literal COMPLEMENT of the grouped sets, so no task can ever be silently
          // dropped by a future swimlane value (FLUX-567 QA hardening).
          const groupedIds = new Set([...runningTasks, ...swimlaneTasks, ...needsActionTasks, ...openPrTasks].map(t => t.id));
          const restTasks = tasks.filter(t => !groupedIds.has(t.id));
          const sortedTasks = [...runningTasks, ...swimlaneTasks, ...needsActionTasks, ...openPrTasks, ...restTasks];
          // Everything renders through TaskCard now — PR tickets (kind:'pr') render their
          // PR-specific body inside the same card shell (FLUX-567 pivot). A non-PR ticket whose
          // branch belongs to a PR (but isn't folded — a Todo/Grooming/Backlog "pile" ticket)
          // gets a subtle `→ PR-n` marker above it, so it's clearly linked without leaving its
          // column (FLUX-565 decision #4).
          const renderTask = (task: Task) => {
            const card = (
              <TaskCard
                task={task}
                parentTask={parentByChildId.get(task.id)}
                liveEvent={taskLiveEvents[task.id]}
                travelDirection={getTaskTravelDirection(task.id)}
                columnTint={tint}
                hideStatusBadge
              />
            );
            const prLink = task.kind !== 'pr' && task.branch ? prByBranch.get(task.branch) : undefined;
            // FLUX-699: an epic's same-column subtasks render as a peeking deck directly BELOW its
            // card — the epic card is the deck's top card. (A lone cross-column orphan subtask keeps
            // only the amber `→ <epic>` chip from CardMetadataRow; ≥2 cross-column siblings are
            // pulled into a ProxyDeck by the Board before they reach here.)
            const epicDeck = task.kind !== 'pr' ? foldedByEpic?.get(task.id) : undefined;
            const hasDeck = !!(epicDeck && epicDeck.length > 0);
            if (!prLink && !hasDeck) return <div key={task.id}>{card}</div>;
            return (
              <div key={task.id}>
                {prLink && (
                  <div className="mb-0.5 ml-1 flex items-center gap-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300" title={`Linked to ${prLink} (not folded — start work to fold it in)`}>
                    <GitPullRequest className="h-2.5 w-2.5" /> linked to {prLink}
                  </div>
                )}
                {card}
                {hasDeck && (
                  <EpicStackDeck idPrefix={`epic-deck-${task.id}`} items={epicDeck!} />
                )}
              </div>
            );
          };
          return (
            <SortableContext items={sortedTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
              {runningTasks.map(renderTask)}
              {runningTasks.length > 0 && (swimlaneTasks.length > 0 || restTasks.length > 0) && (
                <div className="flex items-center gap-2 my-1 px-1 shrink-0">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">Queued</span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                </div>
              )}
              {swimlaneTasks.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 my-1 px-1 shrink-0">
                    <CirclePause className="w-3 h-3 text-amber-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-500 dark:text-amber-400">Awaiting Input</span>
                    <div className="flex-1 h-px bg-amber-200 dark:bg-amber-800/40" />
                  </div>
                  <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10 p-1.5 mb-1">
                    {swimlaneTasks.map(renderTask)}
                  </div>
                </>
              )}
              {needsActionTasks.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 my-1 px-1 shrink-0">
                    <HandHelping className="w-3 h-3 text-rose-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-rose-500 dark:text-rose-400">Needs Action</span>
                    <div className="flex-1 h-px bg-rose-200 dark:bg-rose-800/40" />
                    <button
                      type="button"
                      title="Dismiss all needs-action flags"
                      onClick={() => needsActionTasks.forEach(t => updateTask(t.id, { needsAction: null } as any))}
                      className="flex items-center justify-center rounded p-0.5 text-rose-400 hover:bg-rose-100 hover:text-rose-600 dark:hover:bg-rose-800/30 dark:hover:text-rose-300 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="rounded-lg border border-rose-200 dark:border-rose-800/40 bg-rose-50/50 dark:bg-rose-900/10 p-1.5 mb-1">
                    {needsActionTasks.map(renderTask)}
                  </div>
                </>
              )}
              {openPrTasks.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 my-1 px-1 shrink-0">
                    <GitPullRequest className="w-3 h-3 text-violet-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">Open PRs</span>
                    <div className="flex-1 h-px bg-violet-200 dark:bg-violet-800/40" />
                  </div>
                  <div className="rounded-lg border border-violet-200 dark:border-violet-800/40 bg-violet-50/50 dark:bg-violet-900/10 p-1.5 mb-1">
                    {openPrTasks.map(renderTask)}
                  </div>
                </>
              )}
              {restTasks.map(renderTask)}
            </SortableContext>
          );
        })()}

        {showLiveFooter && <ColumnLiveFooter runningTasks={runningTasks} />}
      </div>
    </div>
  );
});

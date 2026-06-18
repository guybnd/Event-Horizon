import { memo, useEffect, useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TaskCard } from './TaskCard';
import type { ColumnLiveEvent, Task, TaskLiveEvent } from '../types';
import { Plus, CirclePause, Bot, Clock, Terminal, GitPullRequest } from 'lucide-react';
import { useApp } from '../AppContext';
import { getStatusTint, tintColumnWash } from '../statusStyles';
import { isTaskAwaitingInput, hasOpenPr } from '../workflow';

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
          {runningTasks.map((task) => {
            const session = task.cliSession!;
            const elapsed = formatElapsed(session.startedAt, now);
            const lastLine = session.liveOutput
              ? session.liveOutput.trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
              : '';
            return (
              <div key={task.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{task.id}</span>
                  {session.currentActivity && (
                    <span className="min-w-0 truncate text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                      {session.currentActivity}
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
          })}
        </div>
      </div>
    </div>
  );
});

interface ColumnProps {
  id: string;
  title: string;
  tasks: Task[];
  parentByChildId: Map<string, Task>;
  liveEvent?: ColumnLiveEvent;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  getTaskTravelDirection: (taskId: string) => -1 | 0 | 1;
}

export const Column = memo(function Column({ id, title, tasks, parentByChildId, liveEvent, taskLiveEvents, getTaskTravelDirection }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { openTaskModal, config, readComments, markAllCommentsRead, prByBranch } = useApp();

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

  return (
    <div className="flex flex-col w-[320px] min-w-[280px] flex-1 max-w-[420px]">
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2.5">
          {/* Column identity: hue accent bar + pronounced title */}
          <span className={`h-5 w-1 shrink-0 rounded-full ${tint.accent}`} aria-hidden />
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-gray-700 dark:text-gray-200">
            {title}
          </h2>
          <span className={`bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-400 text-xs px-2.5 py-0.5 rounded-full font-medium ${liveEvent ? 'column-live-badge' : ''}`}>
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
        {id === 'Done' && tasks.length > 0 && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('flux:open-release-modal', { detail: { tasks } }))}
            className="text-xs font-bold bg-primary/10 text-primary hover:bg-primary/20 px-2 py-1 rounded"
          >
            Release
          </button>
        )}
      </div>
      
      <div
        ref={setNodeRef}
        style={isOver ? undefined : { backgroundImage: tintColumnWash(tint, 0.08) }}
        className={`flex-1 flex flex-col rounded-2xl p-4 min-h-[500px] transition-all duration-200 border border-transparent ${
          isOver ? 'bg-primary/5 border-primary/20 shadow-[inset_0_0_0_1px_var(--eh-border-accent)]' : 'eh-column'
        } ${liveEvent ? 'column-live-receiving' : ''}`}
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
          const openPrTasks = tasks.filter(t => (isOpenPr(t) || hasOpenPr(t)) && !isRunning(t) && !isTaskAwaitingInput(t));
          // rest = the literal COMPLEMENT of the first three groups, so no task can ever be
          // silently dropped by a future swimlane value (FLUX-567 QA hardening).
          const groupedIds = new Set([...runningTasks, ...swimlaneTasks, ...openPrTasks].map(t => t.id));
          const restTasks = tasks.filter(t => !groupedIds.has(t.id));
          const sortedTasks = [...runningTasks, ...swimlaneTasks, ...openPrTasks, ...restTasks];
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
            if (!prLink) return <div key={task.id}>{card}</div>;
            return (
              <div key={task.id}>
                <div className="mb-0.5 ml-1 flex items-center gap-1 text-[10px] font-semibold text-violet-600 dark:text-violet-300" title={`Linked to ${prLink} (not folded — start work to fold it in)`}>
                  <GitPullRequest className="h-2.5 w-2.5" /> linked to {prLink}
                </div>
                {card}
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

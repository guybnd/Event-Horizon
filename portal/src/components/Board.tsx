import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { Column } from './Column';
import { StatusBadge } from './StatusBadge';
import { TaskCardInner } from './TaskCard';
import { updateTask } from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { buildStatusChangeHistory } from '../lib/ticketActions';
import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { Loader2, Upload } from 'lucide-react';
import { TaskViewControls } from './TaskViewControls';
import { filterAndSortTasks } from '../taskSearch';
import { getStatusColorClass } from '../statusStyles';
import { ReleaseModal } from './ReleaseModal';
import { getArchiveStatus, getRequireInputStatus } from '../workflow';
import { collectPrMemberIds, collectEpicFoldedIds, collectCrossColumnClusters } from '../lib/decks';
import { ParseErrorButton } from './ParseErrorButton';
import { BootstrapPreview } from './BootstrapPreview';

// Stable empty array so columns with no tasks get a referentially-stable prop (memo-friendly).
const EMPTY_TASKS: Task[] = [];

export function Board() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [releaseModalTasks, setReleaseModalTasks] = useState<Task[] | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const { triggerRefresh } = useAppActions();
  const liveTasks = useAppSelector((s) => s.tasks);
  const tasksLoading = useAppSelector((s) => s.tasksLoading);
  const taskLiveEvents = useAppSelector((s) => s.taskLiveEvents);
  const columnLiveEvents = useAppSelector((s) => s.columnLiveEvents);
  const config = useAppSelector((s) => s.config);
  const boardFx = config?.boardFx;
  const currentUser = useAppSelector((s) => s.currentUser);
  const searchQuery = useAppSelector((s) => s.searchQuery);
  const sortOption = useAppSelector((s) => s.sortOption);
  const filterAssignee = useAppSelector((s) => s.filterAssignee);
  const filterPriority = useAppSelector((s) => s.filterPriority);
  const filterTag = useAppSelector((s) => s.filterTag);
  const filterUnreadOnly = useAppSelector((s) => s.filterUnreadOnly);
  const filterWorktree = useAppSelector((s) => s.filterWorktree);
  const worktreeBranches = useAppSelector((s) => s.worktreeBranches);
  const readComments = useAppSelector((s) => s.readComments);
  const parseErrors = useAppSelector((s) => s.parseErrors);

  const scrollerRef = useRef<HTMLDivElement>(null);

  const [pendingStatusChange, setPendingStatusChange] = useState<{taskId: string, newStatus: string, oldStatus: string} | null>(null);
  const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
  const [optimisticTasks, setOptimisticTasks] = useState<Record<string, Task>>({});
  const [commentText, setCommentText] = useState('');

  // Sync local tasks with liveTasks + optimistic overrides.
  // FLUX-619 / drag perf: while a drag is in progress, DON'T re-sync — a poll/SSE update
  // mid-drag re-renders every (heavy) card under the cursor, tanking drag to a crawl and
  // making cards jump. The effect re-runs when `activeTask` clears (drop), so it catches up.
  useEffect(() => {
    if (activeTask) return;
    setTasks(liveTasks.map(task => {
      if (movingTaskIds.has(task.id) && optimisticTasks[task.id]) {
        return optimisticTasks[task.id];
      }
      return task;
    }));
  }, [liveTasks, movingTaskIds, optimisticTasks, activeTask]);

  // Clean up movingTaskIds once liveTasks catches up to the optimistic state
  useEffect(() => {
    if (movingTaskIds.size === 0) return;

    const tasksToRemove: string[] = [];
    for (const taskId of movingTaskIds) {
      const liveTask = liveTasks.find(t => t.id === taskId);
      const optimisticTask = optimisticTasks[taskId];
      if (liveTask && optimisticTask && liveTask.status === optimisticTask.status && liveTask.order === optimisticTask.order) {
        tasksToRemove.push(taskId);
      }
    }

    if (tasksToRemove.length > 0) {
      setMovingTaskIds(prev => {
        const next = new Set(prev);
        tasksToRemove.forEach(id => next.delete(id));
        return next;
      });
      setOptimisticTasks(prev => {
        const next = { ...prev };
        tasksToRemove.forEach(id => delete next[id]);
        return next;
      });
    }
  }, [liveTasks, optimisticTasks, movingTaskIds]);

  useEffect(() => {
    const fn = (e: Event) => {
      setReleaseModalTasks((e as CustomEvent<{ tasks: Task[] | null }>).detail.tasks);
    };
    window.addEventListener('flux:open-release-modal', fn);
    return () => window.removeEventListener('flux:open-release-modal', fn);
  }, []);

  const archiveStatus = config ? getArchiveStatus(config) : null;
  const requireInputStatus = config ? getRequireInputStatus(config) : null;
  const hasSwimlanes = config?.swimlanes && config.swimlanes.length > 0;
  // Memoized so the filter (and the whole chain keyed off it) only re-runs when tasks/config
  // actually change — not on every Board re-render (e.g. each SSE activity tick). (FLUX-611)
  // Flow arrows: count status_change history entries in last 24h for each column→column pair.
  const columnFlowCounts = useMemo(() => {
    if (boardFx?.columnFlowArrows === false) return null;
    const cutoff = Date.now() - 86_400_000;
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      for (const entry of task.history ?? []) {
        if (entry.type !== 'status_change') continue;
        const from = (entry as { from?: string }).from;
        const to = (entry as { to?: string }).to;
        if (!from || !to || new Date(entry.date).getTime() < cutoff) continue;
        const key = `${from}→${to}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [tasks, boardFx?.columnFlowArrows]);

  // Done-streak count (tickets that reached a done-ish status today). A board-level aggregate —
  // computed ONCE here instead of inside every Column via a whole-`s.tasks` subscription that
  // re-rendered all columns on any task change (FLUX-724). Only the Done column renders it.
  const doneStreakCount = useMemo(() => {
    if (boardFx?.doneStreak === false) return 0;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let count = 0;
    for (const task of tasks) {
      for (const entry of task.history ?? []) {
        if (entry.type !== 'status_change') continue;
        const to = (entry as { to?: string }).to ?? '';
        if (!/done/i.test(to)) continue;
        if (new Date(entry.date).getTime() >= todayMs) { count++; break; }
      }
    }
    return count;
  }, [tasks, boardFx?.doneStreak]);

  const boardTasks = useMemo(() => config ? tasks.filter((task) =>
    task.status !== 'Released' &&
    task.status !== archiveStatus &&
    !config.hiddenStatuses?.some((hiddenStatus) => hiddenStatus.name === task.status)
  ) : [], [tasks, config, archiveStatus]);
  const allColumns = useMemo(() => {
    if (!config) return [];
    const extraStatuses = Array.from(new Set(boardTasks.map(t => t.status)))
      .filter(s => !config.columns?.find(c => c.name === s) && !config.hiddenStatuses?.find(h => h.name === s));
    const cols = [...(config.columns?.map(c => c.name).filter(c => c !== archiveStatus) || []), ...extraStatuses];
    // Hide the "Require Input" column when swimlanes are active — tickets stay in their workflow column.
    // Safety: keep the column visible if any tasks still have that status (pre-migration).
    if (hasSwimlanes) {
      const anyTasksStillInRIStatus = boardTasks.some(t => t.status === requireInputStatus);
      if (!anyTasksStillInRIStatus) {
        return cols.filter(c => c !== requireInputStatus);
      }
    }
    return cols;
  }, [boardTasks, config, archiveStatus, requireInputStatus, hasSwimlanes]);
  const columnOrder = useMemo(() => new Map(allColumns.map((columnId, index) => [columnId, index])), [allColumns]);
  const parentByChildId = useMemo(() => {
    const map = new Map<string, Task>();
    [...tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach((candidateParent) => {
        candidateParent.subtasks?.forEach((entry) => {
          const childId = normalizeSubtaskId(entry);
          if (!map.has(childId)) {
            map.set(childId, candidateParent);
          }
        });
      });
    return map;
  }, [tasks]);
  // Union of every PR ticket's work-gated members — these fold into the PR deck and are
  // excluded from their own columns. Memoized so the Set isn't rebuilt every Board render
  // (FLUX-567 perf review).
  const foldedMemberIds = useMemo(() => collectPrMemberIds(tasks), [tasks]);
  // Epic deck (FLUX-580): a subtask in the SAME column as its epic folds into the epic's card,
  // mirroring PR members. PR membership wins (a PR-folded subtask is never also epic-folded).
  // Memoized alongside the rest of the chain (FLUX-611 perf).
  const epicFoldedIds = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return collectEpicFoldedIds(tasks, byId, foldedMemberIds);
  }, [tasks, foldedMemberIds]);
  // Everything pulled out of its own column into a deck (PR members ∪ epic subtasks).
  const deckedIds = useMemo(() => {
    if (foldedMemberIds.size === 0 && epicFoldedIds.size === 0) return null;
    const ids = new Set(foldedMemberIds);
    epicFoldedIds.forEach((id) => ids.add(id));
    return ids;
  }, [foldedMemberIds, epicFoldedIds]);

  // Filter + sort once per input change (was recomputed on EVERY render — incl. each SSE
  // activity/progress tick during agent sessions, the main board-sluggishness cause). (FLUX-611)
  const visibleTasks = useMemo(() => config ? filterAndSortTasks(boardTasks, config, {
    searchQuery,
    sortOption,
    filterAssignee,
    filterPriority,
    filterTag,
    filterUnreadOnly,
    filterWorktree,
    worktreeBranches,
    readComments,
    requireInputStatus: getRequireInputStatus(config),
  }) : [], [boardTasks, config, searchQuery, sortOption, filterAssignee, filterPriority, filterTag, filterUnreadOnly, filterWorktree, worktreeBranches, readComments]);

  // Cross-column subtask clusters (FLUX-677): ≥2 subtasks of one epic that piled up in a column
  // the epic isn't in collapse under a proxy deck there. Computed over visibleTasks so search/
  // filters apply, and excluding the same-column-folded set (epicFoldedIds) + PR members so a
  // child can't both fold and cluster — shared rule with the column exclusion below, no drift.
  const crossColumnClusters = useMemo(() => {
    const byId = new Map(visibleTasks.map((t) => [t.id, t]));
    return collectCrossColumnClusters(visibleTasks, byId, foldedMemberIds, epicFoldedIds);
  }, [visibleTasks, foldedMemberIds, epicFoldedIds]);

  // Decked tasks (FLUX-567 PR members + FLUX-580 epic subtasks + FLUX-677 cross-column clusters)
  // fold INTO a deck, so they don't render as loose cards in their own columns. Memoized alongside
  // the chain.
  const deckedTasks = useMemo(() => {
    const clustered = crossColumnClusters.clusteredIds;
    if (!deckedIds && clustered.size === 0) return visibleTasks;
    return visibleTasks.filter(t => !deckedIds?.has(t.id) && !clustered.has(t.id));
  }, [visibleTasks, deckedIds, crossColumnClusters]);

  // Same-column epic decks (FLUX-699): per epic, its same-column folded subtasks — rendered as a
  // peeking card stack directly BELOW the epic card (the epic is the deck's top card, not a
  // container). Resolved over visibleTasks so a filtered-out subtask's peek is hidden too; same
  // `epicFoldedIds` set that excludes them from the column flow, so no drift. Keyed by epic id.
  const foldedByEpic = useMemo(() => {
    const m = new Map<string, Task[]>();
    if (epicFoldedIds.size === 0) return m;
    const byId = new Map(visibleTasks.map((t) => [t.id, t]));
    for (const epic of visibleTasks) {
      if (!epic.subtasks?.length) continue;
      const kids: Task[] = [];
      for (const entry of epic.subtasks) {
        const cid = normalizeSubtaskId(entry);
        if (!epicFoldedIds.has(cid)) continue;
        const child = byId.get(cid);
        if (child && child.status === epic.status) kids.push(child);
      }
      if (kids.length) m.set(epic.id, kids);
    }
    return m;
  }, [visibleTasks, epicFoldedIds]);

  // Bucket tasks by column ONCE, instead of `deckedTasks.filter(...)` per-column on every
  // render (was O(columns × tasks) per render and handed Column a fresh array each time,
  // defeating its memo). (FLUX-611)
  const columnTasksByStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of deckedTasks) {
      const arr = map.get(t.status);
      if (arr) arr.push(t);
      else map.set(t.status, [t]);
    }
    return map;
  }, [deckedTasks]);

  const getTaskTravelDirection = useCallback((taskId: string) => {
    const liveEvent = taskLiveEvents[taskId];
    if (!liveEvent || liveEvent.kind !== 'moved' || !liveEvent.fromStatus || !liveEvent.toStatus) {
      return 0;
    }

    const fromIndex = columnOrder.get(liveEvent.fromStatus);
    const toIndex = columnOrder.get(liveEvent.toStatus);

    if (fromIndex == null || toIndex == null) {
      return 0;
    }

    return Math.sign(toIndex - fromIndex) as -1 | 0 | 1;
  }, [taskLiveEvents, columnOrder]);

  if ((tasksLoading && tasks.length === 0) || !config) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find(t => t.id === active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    const activeTaskObj = tasks.find(t => t.id === activeTaskId);
    if (!activeTaskObj) return;

    // Check if overId is a task or a column
    const overTask = tasks.find(t => t.id === overId);
    const targetStatus = overTask ? overTask.status : overId;

    // Case 1: Moving to a DIFFERENT column
    if (activeTaskObj.status !== targetStatus) {
      // Respect the config setting for status change comments.
      // If disabled, we try to move silently and only prompt if the backend requires it (e.g. for Ready/Require Input)
      if (config.requireCommentOnStatusChange) {
        setPendingStatusChange({ taskId: activeTaskId, newStatus: targetStatus, oldStatus: activeTaskObj.status });
        return;
      }
      
      // Calculate order for the new column (append to end)
      const targetColumnTasks = tasks.filter(t => t.status === targetStatus);
      const maxOrder = targetColumnTasks.reduce((max, t) => Math.max(max, t.order ?? 0), -1);
      const newOrder = maxOrder + 1;

      await applyStatusChange(activeTaskId, targetStatus, activeTaskObj.status, undefined, newOrder);
    }
    // Case 2: Reordering within SAME column
    else if (overTask && activeTaskId !== overId) {
      const columnTasks = tasks
        .filter(t => t.status === targetStatus)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const oldIndex = columnTasks.findIndex(t => t.id === activeTaskId);
      const newIndex = columnTasks.findIndex(t => t.id === overId);

      const newOrderedTasks = arrayMove(columnTasks, oldIndex, newIndex);
      const changedTasks = newOrderedTasks.map((t, index) => ({ ...t, order: index }));

      // Update local state optimistically
      setMovingTaskIds(prev => {
        const next = new Set(prev);
        changedTasks.forEach(t => next.add(t.id));
        return next;
      });
      setOptimisticTasks(prev => {
        const next = { ...prev };
        changedTasks.forEach(t => next[t.id] = t);
        return next;
      });

      // Persist changes
      try {
        await Promise.all(changedTasks.map((t) =>
          updateTask(t.id, { order: t.order, updatedBy: currentUser })
        ));
        triggerRefresh();
      } catch (err) {
        console.error('Failed to persist reorder:', err);
        setMovingTaskIds(prev => {
          const next = new Set(prev);
          changedTasks.forEach(t => next.delete(t.id));
          return next;
        });
        setOptimisticTasks(prev => {
          const next = { ...prev };
          changedTasks.forEach(t => delete next[t.id]);
          return next;
        });
        triggerRefresh();
      }
    }
  };

  const applyStatusChange = async (taskId: string, newStatus: string, oldStatus: string, comment?: string, newOrder?: number) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // Shared with the chat action bar (FLUX-610) — `from` pinned to the explicit oldStatus
    // so optimistic state never skews the recorded transition.
    const newHistory = buildStatusChangeHistory({ ...task, status: oldStatus }, newStatus, currentUser, comment);

    const finalOrder = newOrder ?? (task.order || 0);
    const optimisticTask = { ...task, status: newStatus, order: finalOrder, history: newHistory };

    setMovingTaskIds(prev => new Set(prev).add(taskId));
    setOptimisticTasks(prev => ({ ...prev, [taskId]: optimisticTask }));

    try {
      await updateTask(taskId, { status: newStatus, order: finalOrder, history: newHistory, updatedBy: currentUser });
      triggerRefresh();
    } catch (err) {
      console.error(err);

      const errMessage = err instanceof Error ? err.message : '';
      // Reactive prompting: If backend requires a comment, show the modal
      if (errMessage.includes('comment is required') || errMessage.includes('_MISSING_COMMENT')) {
        setMovingTaskIds(prev => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
        setOptimisticTasks(prev => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        setPendingStatusChange({ taskId, newStatus, oldStatus });
        return;
      }

      setMovingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      setOptimisticTasks(prev => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      alert('Failed to update task: ' + errMessage);
    }
    setPendingStatusChange(null);
    setCommentText('');
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-0">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <TaskViewControls
              title="Board filters"
              searchPlaceholder="Filter cards in this board"
              visibleCount={visibleTasks.length}
              totalCount={boardTasks.length}
              itemLabel="board tickets"
            />
          </div>
          <ParseErrorButton errors={parseErrors} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {boardTasks.length === 0 && !tasksLoading && (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <p className="text-sm text-gray-500 dark:text-gray-400">No tickets yet.</p>
              <button
                onClick={() => setShowBootstrap(true)}
                className="board-accent-button flex items-center gap-2 rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover"
              >
                <Upload className="h-4 w-4" />
                Import from project
              </button>
            </div>
          )}
          <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={pointerWithin}>
            <div ref={scrollerRef} className="flex min-h-full gap-2 pb-4 items-stretch">
              {allColumns.map((columnId, idx) => {
                const prevCol = idx > 0 ? allColumns[idx - 1] : null;
                const nextCol = idx < allColumns.length - 1 ? allColumns[idx + 1] : null;
                // Outbound flow in the last 24h: tickets that moved back to the previous column
                // (left) vs forward to the next column (right) — chips flanking the title (FLUX-723).
                const flowLeft = prevCol && columnFlowCounts ? (columnFlowCounts[`${columnId}→${prevCol}`] ?? 0) : 0;
                const flowRight = nextCol && columnFlowCounts ? (columnFlowCounts[`${columnId}→${nextCol}`] ?? 0) : 0;
                // Uniform hue-bar width across all columns ≈ the widest title (FLUX-723).
                const maxTitleChars = Math.max(1, ...allColumns.map((c) => c.length));
                return (
                  <Column
                    key={columnId}
                    id={columnId}
                    title={columnId}
                    tasks={columnTasksByStatus.get(columnId) ?? EMPTY_TASKS}
                    clusters={crossColumnClusters.byColumn.get(columnId)}
                    foldedByEpic={foldedByEpic}
                    parentByChildId={parentByChildId}
                    liveEvent={columnLiveEvents[columnId]}
                    taskLiveEvents={taskLiveEvents}
                    getTaskTravelDirection={getTaskTravelDirection}
                    flowLeft={flowLeft}
                    flowRight={flowRight}
                    titleChars={maxTitleChars}
                    doneStreakCount={doneStreakCount}
                  />
                );
              })}
            </div>
            <DragOverlay>
              {activeTask
                ? <div className={boardFx?.dragTrail !== false ? 'drag-trail-overlay' : undefined}><TaskCardInner task={activeTask} parentTask={parentByChildId.get(activeTask.id)} isOverlay /></div>
                : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

      {pendingStatusChange && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="eh-surface-overlay p-6 rounded-xl shadow-2xl w-[400px] border eh-border">
            <h3 className="text-lg font-bold mb-2">Update Status</h3>
            <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span>Moving task to</span>
              <StatusBadge
                status={pendingStatusChange.newStatus}
                colorClass={getStatusColorClass(config, pendingStatusChange.newStatus)}
                className="text-[10px] font-bold uppercase tracking-[0.16em]"
              />
              <span>Add a quick note?</span>
            </p>
            <textarea
              autoFocus
              className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary resize-none text-sm mb-4 h-24"
              placeholder="Optional comment..."
              value={commentText} onChange={e => setCommentText(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setPendingStatusChange(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
              >Cancel</button>
              <button
                onClick={() => applyStatusChange(pendingStatusChange.taskId, pendingStatusChange.newStatus, pendingStatusChange.oldStatus, commentText)}
                className="board-accent-button px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
              >Save Update</button>
            </div>
          </div>
        </div>
      )}
      {releaseModalTasks && (
        <ReleaseModal tasks={releaseModalTasks} onClose={() => setReleaseModalTasks(null)} />
      )}
      {showBootstrap && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="eh-surface-overlay p-6 rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto border eh-border">
            <h3 className="text-lg font-bold mb-4 text-gray-900 dark:text-white">Import from project</h3>
            <BootstrapPreview
              onComplete={() => { setShowBootstrap(false); triggerRefresh(); }}
              onSkip={() => setShowBootstrap(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}

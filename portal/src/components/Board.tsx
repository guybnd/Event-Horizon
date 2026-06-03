import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { Column } from './Column';
import { StatusBadge } from './StatusBadge';
import { TaskCard } from './TaskCard';
import { updateTask } from '../api';
import { useApp } from '../AppContext';
import type { Task, HistoryEntry } from '../types';
import { normalizeSubtaskId } from '../types';
import { Loader2 } from 'lucide-react';
import { TaskViewControls } from './TaskViewControls';
import { filterAndSortTasks } from '../taskSearch';
import { getStatusColorClass } from '../statusStyles';
import { ReleaseModal } from './ReleaseModal';
import { getArchiveStatus, getRequireInputStatus } from '../workflow';
import { ParseErrorButton } from './ParseErrorButton';

export function Board() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [releaseModalTasks, setReleaseModalTasks] = useState<Task[] | null>(null);
  const {
    tasks: liveTasks,
    tasksLoading,
    taskLiveEvents,
    columnLiveEvents,
    config,
    currentUser,
    triggerRefresh,
    searchQuery,
    sortOption,
    filterAssignee,
    filterPriority,
    filterTag,
    filterUnreadOnly,
    readComments,
    parseErrors,
  } = useApp();

  const scrollerRef = useRef<HTMLDivElement>(null);

  const [pendingStatusChange, setPendingStatusChange] = useState<{taskId: string, newStatus: string, oldStatus: string} | null>(null);
  const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
  const [optimisticTasks, setOptimisticTasks] = useState<Record<string, Task>>({});
  const [commentText, setCommentText] = useState('');

  // Sync local tasks with liveTasks + optimistic overrides
  useEffect(() => {
    setTasks(liveTasks.map(task => {
      if (movingTaskIds.has(task.id) && optimisticTasks[task.id]) {
        return optimisticTasks[task.id];
      }
      return task;
    }));
  }, [liveTasks, movingTaskIds, optimisticTasks]);

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
    const fn = (e: any) => {
      setReleaseModalTasks(e.detail.tasks);
    };
    window.addEventListener('flux:open-release-modal', fn);
    return () => window.removeEventListener('flux:open-release-modal', fn);
  }, []);

  const archiveStatus = config ? getArchiveStatus(config) : null;
  const boardTasks = config ? tasks.filter((task) =>
    task.status !== 'Released' &&
    task.status !== archiveStatus &&
    !config.hiddenStatuses?.some((hiddenStatus) => hiddenStatus.name === task.status)
  ) : [];
  const allColumns = useMemo(() => {
    if (!config) return [];
    const extraStatuses = Array.from(new Set(boardTasks.map(t => t.status)))
      .filter(s => !config.columns?.find(c => c.name === s) && !config.hiddenStatuses?.find(h => h.name === s));
    return [...(config.columns?.map(c => c.name).filter(c => c !== archiveStatus) || []), ...extraStatuses];
  }, [boardTasks, config, archiveStatus]);
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

  const visibleTasks = filterAndSortTasks(boardTasks, config, {
    searchQuery,
    sortOption,
    filterAssignee,
    filterPriority,
    filterTag,
    filterUnreadOnly,
    readComments,
    requireInputStatus: getRequireInputStatus(config),
  });

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
          updateTask(t.id, { order: t.order, updatedBy: currentUser } as any)
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

    const timestamp = new Date().toISOString();
    const newHistory: HistoryEntry[] = [...(task.history || [])];

    // If a comment is provided, add it as a separate entry to satisfy engine validation for Ready/Require Input
    if (comment?.trim()) {
      newHistory.push({
        type: 'comment',
        user: currentUser,
        date: timestamp,
        comment: comment.trim()
      });
    }

    newHistory.push({
      type: 'status_change',
      from: oldStatus,
      to: newStatus,
      user: currentUser,
      date: timestamp,
      comment: comment?.trim() ? 'Included with comment' : undefined
    });

    const finalOrder = newOrder ?? (task.order || 0);
    const optimisticTask = { ...task, status: newStatus, order: finalOrder, history: newHistory as any };

    setMovingTaskIds(prev => new Set(prev).add(taskId));
    setOptimisticTasks(prev => ({ ...prev, [taskId]: optimisticTask }));

    try {
      await updateTask(taskId, { status: newStatus, order: finalOrder, history: newHistory, updatedBy: currentUser } as any);
      triggerRefresh();
    } catch (err: any) {
      console.error(err);
      
      // Reactive prompting: If backend requires a comment, show the modal
      if (err.message?.includes('comment is required') || err.message?.includes('_MISSING_COMMENT')) {
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
      alert('Failed to update task: ' + err.message);
    }
    setPendingStatusChange(null);
    setCommentText('');
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-6">
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

        <div className="min-h-0 flex-1">
          <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={pointerWithin}>
            <div ref={scrollerRef} className="flex h-full min-h-0 gap-6 overflow-x-auto pb-4 items-start">
              {allColumns.map(columnId => (
                <Column
                  key={columnId}
                  id={columnId}
                  title={columnId}
                  tasks={visibleTasks.filter(t => t.status === columnId)}
                  parentByChildId={parentByChildId}
                  liveEvent={columnLiveEvents[columnId]}
                  taskLiveEvents={taskLiveEvents}
                  getTaskTravelDirection={getTaskTravelDirection}
                />
              ))}
            </div>
            <DragOverlay>{activeTask ? <TaskCard task={activeTask} parentTask={parentByChildId.get(activeTask.id)} isOverlay /> : null}</DragOverlay>
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
                className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
              >Save Update</button>
            </div>
          </div>
        </div>
      )}
      {releaseModalTasks && (
        <ReleaseModal tasks={releaseModalTasks} onClose={() => setReleaseModalTasks(null)} />
      )}    </>
  );
}

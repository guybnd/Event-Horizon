import { useEffect, useRef, useState } from 'react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { Column } from './Column';
import { StatusBadge } from './StatusBadge';
import { TaskCard } from './TaskCard';
import { updateTask } from '../api';
import { useApp } from '../AppContext';
import type { Task } from '../types';
import { Loader2 } from 'lucide-react';
import { TaskViewControls } from './TaskViewControls';
import { filterAndSortTasks } from '../taskSearch';
import { getStatusColorClass } from '../statusStyles';
import { ReleaseModal } from './ReleaseModal';
import { getArchiveStatus, getRequireInputStatus } from '../workflow';

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
  } = useApp();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const savedScrollRef = useRef<number>(0);

  const [pendingStatusChange, setPendingStatusChange] = useState<{taskId: string, newStatus: string, oldStatus: string} | null>(null);
  const [commentText, setCommentText] = useState('');

  useEffect(() => {
    setTasks(liveTasks);
  }, [liveTasks]);

  useEffect(() => {
    const fn = (e: any) => {
      setReleaseModalTasks(e.detail.tasks);
    };
    window.addEventListener('flux:open-release-modal', fn);
    return () => window.removeEventListener('flux:open-release-modal', fn);
  }, []);

  if ((tasksLoading && tasks.length === 0) || !config) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const archiveStatus = getArchiveStatus(config);
  const boardTasks = tasks.filter((task) => 
    task.status !== 'Released' && 
    task.status !== archiveStatus &&
    !config.hiddenStatuses?.some((hiddenStatus) => hiddenStatus.name === task.status)
  );
  const extraStatuses = Array.from(new Set(boardTasks.map(t => t.status)))
    .filter(s => !config.columns?.find(c => c.name === s) && !config.hiddenStatuses?.find(h => h.name === s));

  const allColumns = [...(config.columns?.map(c => c.name).filter(c => c !== archiveStatus) || []), ...extraStatuses];
  const columnOrder = new Map(allColumns.map((columnId, index) => [columnId, index]));
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
  const parentByChildId = new Map<string, Task>();

  [...tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach((candidateParent) => {
      candidateParent.subtasks?.forEach((childId) => {
        if (!parentByChildId.has(childId)) {
          parentByChildId.set(childId, candidateParent);
        }
      });
    });

  const getTaskTravelDirection = (taskId: string) => {
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
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find(t => t.id === active.id);
    if (task) setActiveTask(task);
    savedScrollRef.current = scrollerRef.current?.scrollLeft ?? 0;
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    const savedScroll = savedScrollRef.current;
    requestAnimationFrame(() => {
      if (scrollerRef.current) scrollerRef.current.scrollLeft = savedScroll;
    });
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
      
      // Update local state optimistically
      setTasks(prev => prev.map(t => {
        const foundIdx = newOrderedTasks.findIndex(ot => ot.id === t.id);
        if (foundIdx !== -1) {
          return { ...t, order: foundIdx };
        }
        return t;
      }));

      // Persist changes
      try {
        await Promise.all(newOrderedTasks.map((t, index) => 
          updateTask(t.id, { order: index, updatedBy: currentUser } as any)
        ));
      } catch (err) {
        console.error('Failed to persist reorder:', err);
        triggerRefresh();
      }
    }
  };

  const applyStatusChange = async (taskId: string, newStatus: string, oldStatus: string, comment?: string, newOrder?: number) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const newHistory = [...(task.history || []), {
      type: 'status_change',
      from: oldStatus,
      to: newStatus,
      user: currentUser,
      date: new Date().toISOString(),
      comment
    }];

    const finalOrder = newOrder ?? (task.order || 0);

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus, order: finalOrder, history: newHistory as any } : t));

    try {
      await updateTask(taskId, { status: newStatus, order: finalOrder, history: newHistory, updatedBy: currentUser } as any);
      triggerRefresh();
    } catch (err) {
      console.error(err);
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: oldStatus, order: task.order } : t));
    }
    setPendingStatusChange(null);
    setCommentText('');
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-6">
        <TaskViewControls
          title="Board filters"
          searchPlaceholder="Filter cards in this board"
          visibleCount={visibleTasks.length}
          totalCount={boardTasks.length}
          itemLabel="board tickets"
        />

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
          <div className="bg-white dark:bg-[#1a1b23] p-6 rounded-xl shadow-2xl w-[400px] border border-gray-200 dark:border-white/10">
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

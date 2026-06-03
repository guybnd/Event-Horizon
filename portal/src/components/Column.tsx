import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TaskCard } from './TaskCard';
import { StatusBadge } from './StatusBadge';
import type { ColumnLiveEvent, Task, TaskLiveEvent } from '../types';
import { Plus } from 'lucide-react';
import { useApp } from '../AppContext';
import { getStatusColorClass } from '../statusStyles';

interface ColumnProps {
  id: string;
  title: string;
  tasks: Task[];
  parentByChildId: Map<string, Task>;
  liveEvent?: ColumnLiveEvent;
  taskLiveEvents: Record<string, TaskLiveEvent>;
  getTaskTravelDirection: (taskId: string) => -1 | 0 | 1;
}

export function Column({ id, title, tasks, parentByChildId, liveEvent, taskLiveEvents, getTaskTravelDirection }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { openTaskModal, config, readComments, markAllCommentsRead } = useApp();

  // Collect all unread comment IDs across every task in this column
  const columnUnreadByTask = tasks.map(task => {
    const readIds = new Set(readComments[task.id] ?? []);
    const ids = (task.history ?? [])
      .filter(e => e.type === 'comment' && e.id && !readIds.has(e.id))
      .map(e => e.id!);
    return { taskId: task.id, ids };
  }).filter(t => t.ids.length > 0);
  const hasColumnUnread = columnUnreadByTask.length > 0;

  return (
    <div className="flex flex-col w-[320px] shrink-0">
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <StatusBadge
            status={title}
            colorClass={getStatusColorClass(config, title)}
            className="text-[10px] font-bold uppercase tracking-[0.16em]"
          />
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
        className={`flex-1 flex flex-col rounded-2xl p-3 min-h-[500px] transition-all duration-200 border border-transparent ${
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
          const restTasks = tasks.filter(
            t => !(t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status))
          );
          const sortedTasks = [...runningTasks, ...restTasks];
          return (
            <SortableContext items={sortedTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
              {runningTasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  parentTask={parentByChildId.get(task.id)}
                  liveEvent={taskLiveEvents[task.id]}
                  travelDirection={getTaskTravelDirection(task.id)}
                />
              ))}
              {runningTasks.length > 0 && restTasks.length > 0 && (
                <div className="flex items-center gap-2 my-1 px-1 shrink-0">
                  <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">Queued</span>
                  <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                </div>
              )}
              {restTasks.map(task => (
                <TaskCard
                  key={task.id}
                  task={task}
                  parentTask={parentByChildId.get(task.id)}
                  liveEvent={taskLiveEvents[task.id]}
                  travelDirection={getTaskTravelDirection(task.id)}
                />
              ))}
            </SortableContext>
          );
        })()}
      </div>
    </div>
  );
}

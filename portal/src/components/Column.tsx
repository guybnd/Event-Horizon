import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { TaskCard } from './TaskCard';
import type { Task } from '../types';
import { Plus } from 'lucide-react';
import { useApp } from '../AppContext';

interface ColumnProps {
  id: string;
  title: string;
  tasks: Task[];
  parentByChildId: Map<string, Task>;
}

export function Column({ id, title, tasks, parentByChildId }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { openTaskModal } = useApp();

  return (
    <div className="flex flex-col w-[320px] shrink-0">
      <div className="flex items-center justify-between mb-4 px-1">
        <h3 className="font-medium text-gray-700 dark:text-gray-300 tracking-wider text-xs uppercase">
          {title}
        </h3>
        <span className="bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-400 text-xs px-2.5 py-0.5 rounded-full font-medium">
          {tasks.length}
        </span>
      </div>
      
      <div
        ref={setNodeRef}
        className={`flex-1 flex flex-col rounded-2xl p-3 min-h-[500px] transition-all border border-transparent ${
          isOver ? 'bg-primary/5 border-primary/30 ring-1 ring-primary/20' : 'bg-gray-100/50 dark:bg-black/20'
        }`}
      >
        <button 
          onClick={() => openTaskModal({ status: id })}
          className="w-full flex items-center justify-center gap-2 py-2 mb-3 rounded-lg border border-dashed border-gray-300 dark:border-white/20 text-gray-500 dark:text-gray-400 hover:text-primary hover:border-primary hover:bg-primary/5 transition-colors text-sm font-medium cursor-pointer shrink-0"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>

        {tasks.length > 0 && (
          <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
            {tasks
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map(task => (
                <TaskCard key={task.id} task={task} parentTask={parentByChildId.get(task.id)} />
              ))}
          </SortableContext>
        )}
      </div>
    </div>
  );
}

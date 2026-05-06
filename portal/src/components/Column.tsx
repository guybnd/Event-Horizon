import { useDroppable } from '@dnd-kit/core';
import { TaskCard } from './TaskCard';
import type { Task } from '../types';

interface ColumnProps {
  id: string;
  title: string;
  tasks: Task[];
}

export function Column({ id, title, tasks }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

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
        className={`flex-1 rounded-2xl p-3 min-h-[500px] transition-all border border-transparent ${
          isOver ? 'bg-primary/5 border-primary/30 ring-1 ring-primary/20' : 'bg-gray-100/50 dark:bg-black/20'
        }`}
      >
        {tasks.map(task => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}

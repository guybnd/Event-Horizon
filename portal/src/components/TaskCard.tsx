import { useDraggable } from '@dnd-kit/core';
import type { Task } from '../types';
import { User, Tag } from 'lucide-react';

export function TaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
    data: task,
  });

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined;

  // Extract a snippet from the body (ignoring markdown headers)
  const snippet = task.body?.split('\n').find(line => line.trim() && !line.startsWith('#')) || 'No description provided';

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className="bg-white/80 dark:bg-[#252630]/80 backdrop-blur-md p-4 rounded-xl shadow-sm border border-gray-200/50 dark:border-white/5 hover:border-primary/50 hover:shadow-md transition-all cursor-grab active:cursor-grabbing mb-3 group"
    >
      <div className="flex justify-between items-start mb-2">
        <h4 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-primary transition-colors text-sm">
          {task.id}
        </h4>
      </div>
      
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 line-clamp-2">
        {snippet}
      </p>

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-500 mt-auto">
        <div className="flex items-center gap-1.5 bg-gray-100 dark:bg-black/20 px-2 py-1 rounded-md">
          <User className="w-3 h-3" />
          <span className="font-medium">{task.assignee || 'Unassigned'}</span>
        </div>
        {task.tags && task.tags.length > 0 && (
          <div className="flex items-center gap-1.5 text-primary">
            <Tag className="w-3 h-3" />
            <span className="font-medium">{task.tags.length}</span>
          </div>
        )}
      </div>
    </div>
  );
}

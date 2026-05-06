import { useDraggable } from '@dnd-kit/core';
import type { Task } from '../types';
import { User, GripVertical } from 'lucide-react';
import { useApp } from '../AppContext';

export function TaskCard({ task, isOverlay }: { task: Task, isOverlay?: boolean }) {
  const { openTaskModal, config } = useApp();
  
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: task.id,
    data: task,
  });

  const style = transform && !isOverlay ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
  } : undefined;

  const snippet = task.body?.split('\n').find(line => line.trim() && !line.startsWith('#')) || 'No description provided';

  const getTagColor = (tagName: string) => {
    const tagObj = config?.tags.find(t => t.name === tagName);
    return tagObj?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white/80 dark:bg-[#252630]/80 backdrop-blur-md p-0 rounded-xl shadow-sm border border-gray-200/50 dark:border-white/5 hover:border-primary/50 hover:shadow-md transition-all mb-3 group flex flex-col ${isOverlay ? 'shadow-2xl rotate-2 scale-105' : ''}`}
    >
      <div className="flex flex-1">
        <div 
          {...listeners} 
          {...attributes} 
          className="w-8 flex items-center justify-center cursor-grab active:cursor-grabbing border-r border-transparent group-hover:border-gray-100 dark:group-hover:border-white/5 text-gray-300 hover:text-gray-500 transition-colors shrink-0"
        >
          <GripVertical className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>

        <div 
          className="flex-1 p-3 pl-2 cursor-pointer flex flex-col"
          onClick={() => openTaskModal(task)}
        >
          <div className="flex flex-col items-start mb-2">
            <h4 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-primary transition-colors text-sm mb-0.5 leading-snug">
              {task.title || 'Untitled Task'}
            </h4>
            <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 tracking-wider">
              {task.id}
            </span>
          </div>
          
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">
            {snippet}
          </p>

          <div className="flex flex-wrap items-center justify-between gap-2 mt-auto">
            <div className="flex flex-wrap gap-1.5">
              {task.tags?.map(tag => (
                <span key={tag} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getTagColor(tag)}`}>
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 ml-auto bg-gray-100 dark:bg-black/20 px-1.5 py-0.5 rounded">
              <User className="w-3 h-3" />
              <span className="font-medium text-[10px]">{task.assignee || 'Unassigned'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

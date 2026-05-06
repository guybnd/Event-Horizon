import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '../types';
import { User, GripVertical, AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import { useApp } from '../AppContext';
import { updateTask } from '../api';

export function TaskCard({ task, isOverlay }: { task: Task, isOverlay?: boolean }) {
  const { openTaskModal, config, currentUser, triggerRefresh } = useApp();
  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const [priorityName, setPriorityName] = useState(task.priority || 'None');
  const priorityMenuRef = useRef<HTMLDivElement | null>(null);
  
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: task,
  });

  useEffect(() => {
    setPriorityName(task.priority || 'None');
  }, [task.priority]);

  useEffect(() => {
    if (!priorityMenuOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!priorityMenuRef.current?.contains(event.target as Node)) {
        setPriorityMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPriorityMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [priorityMenuOpen]);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const snippet = task.body?.split('\n').find(line => line.trim() && !line.startsWith('#')) || 'No description provided';

  const isRequireInput = task.status === 'Require Input';

  const getTagColor = (tagName: string) => {
    const tagObj = config?.tags?.find(t => t.name === tagName);
    return tagObj?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  };

  const getPriorityIcon = (priorityName: string) => {
    const p = config?.priorities?.find(p => p.name === priorityName);
    const color = p?.color || 'text-gray-400';
    switch (p?.icon) {
      case 'AlertCircle': return <AlertCircle className={`w-3.5 h-3.5 ${color}`} />;
      case 'ChevronUp': return <ChevronUp className={`w-3.5 h-3.5 ${color}`} />;
      case 'ChevronDown': return <ChevronDown className={`w-3.5 h-3.5 ${color}`} />;
      case 'Equals': return <Equal className={`w-3.5 h-3.5 ${color}`} />;
      default: return null;
    }
  };

  const handlePriorityChange = async (nextPriority: string) => {
    const previousPriority = priorityName;
    setPriorityName(nextPriority);
    setPriorityMenuOpen(false);
    try {
      await updateTask(task.id, { priority: nextPriority, updatedBy: currentUser } as any);
      triggerRefresh();
    } catch (error) {
      console.error('Failed to update priority:', error);
      setPriorityName(previousPriority);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white/80 dark:bg-[#252630]/80 backdrop-blur-md p-0 rounded-xl shadow-sm border hover:border-primary/50 hover:shadow-md transition-all mb-3 group flex flex-col relative ${priorityMenuOpen ? 'z-40' : ''} ${isOverlay ? 'shadow-2xl rotate-2 scale-105' : ''} ${isRequireInput ? 'border-amber-300 dark:border-amber-500/40 ring-1 ring-amber-200/50 dark:ring-amber-500/20' : 'border-gray-200/50 dark:border-white/5'}`}
    >
      {isRequireInput && (
        <div className="absolute -top-1.5 -right-1.5 z-10">
          <div className="relative">
            <AlertCircle className="w-5 h-5 text-amber-500 fill-amber-50 dark:fill-amber-950" />
            <div className="absolute inset-0 animate-ping">
              <AlertCircle className="w-5 h-5 text-amber-500 opacity-40" />
            </div>
          </div>
        </div>
      )}
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
            <div ref={priorityMenuRef} className="flex items-center gap-1.5 relative">
              <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 tracking-wider">
                {task.id}
              </span>
              {!isOverlay && config?.priorities?.length ? (
                <>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setPriorityMenuOpen(open => !open);
                    }}
                    className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 transition-colors hover:bg-gray-200 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-black/30"
                  >
                    {getPriorityIcon(priorityName)}
                    <span>{priorityName}</span>
                  </button>
                  {priorityMenuOpen && (
                    <div
                      className="absolute left-0 top-full z-[90] mt-1 min-w-32 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {config.priorities.map(priority => (
                        <button
                          key={priority.name}
                          onClick={() => handlePriorityChange(priority.name)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                        >
                          {getPriorityIcon(priority.name)}
                          <span>{priority.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                getPriorityIcon(priorityName)
              )}
            </div>
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

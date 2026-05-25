import { useState, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { searchTasks } from '../taskSearch';
import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import type { Config, Task } from '../types';

interface TicketPickerProps {
  tasks: Task[];
  config: Config | null;
  excludeIds: string[];
  placeholder?: string;
  onSelect: (taskId: string) => void;
}

export function TicketPicker({ tasks, config, excludeIds, placeholder = 'Search tickets...', onSelect }: TicketPickerProps) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredTasks = tasks.filter((t) => !excludeIds.includes(t.id));
  const results = query.trim()
    ? searchTasks(filteredTasks, query, 7)
    : [];

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const handleSelect = (taskId: string) => {
    onSelect(taskId);
    setQuery('');
    setFocused(false);
  };

  return (
    <div ref={containerRef} className="relative flex-1">
      <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${
        focused ? 'border-primary' : 'border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-black/20'
      }`}>
        <Search className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-200"
        />
        {query && (
          <button onClick={() => setQuery('')} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {focused && query.trim() && (
        <div className="absolute left-0 right-0 top-full z-[60] mt-1 max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#252630]">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-500">No matching tickets.</p>
          ) : (
            results.map(({ task }) => (
              <div
                key={task.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(task.id);
                }}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-gray-100 dark:hover:bg-white/5"
              >
                <span className="shrink-0 text-xs font-bold text-gray-400">{task.id}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-gray-800 dark:text-gray-200">{task.title || 'Untitled'}</span>
                <StatusBadge
                  status={task.status}
                  colorClass={getStatusColorClass(config, task.status)}
                  className="text-[10px] font-bold uppercase tracking-[0.12em]"
                />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

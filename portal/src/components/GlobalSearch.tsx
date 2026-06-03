import { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { useApp } from '../AppContext';
import { searchTasks } from '../taskSearch';
import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import type { Task } from '../types';

export function GlobalSearch() {
  const { tasks, config } = useApp();
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  const searchResults = globalSearchQuery.trim() ? searchTasks(tasks, globalSearchQuery, 7) : [];

  const getTaskHref = (task: Task) => {
    const path = task.status.toLowerCase() === 'backlog' ? '/backlog' : '/board';
    const params = new URLSearchParams({ ticket: task.id, view: 'full' });
    return `${path}?${params.toString()}`;
  };

  const getResultPreview = (task: Task) => {
    const body = (task.body || '').replace(/\s+/g, ' ').trim();
    if (!body) {
      return 'Open ticket details';
    }
    return body.length > 96 ? `${body.slice(0, 96).trimEnd()}...` : body;
  };

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!searchContainerRef.current?.contains(event.target as Node)) {
        setIsSearchOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  return (
    <div ref={searchContainerRef} className="relative min-w-[140px] flex-1 max-w-[380px]">
      <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white/80 px-3 py-1.5 text-sm text-gray-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
        <Search className="h-4 w-4 text-gray-400 shrink-0" />
        <input
          value={globalSearchQuery}
          onChange={(event) => setGlobalSearchQuery(event.target.value)}
          onFocus={() => setIsSearchOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setIsSearchOpen(false);
              return;
            }
            if (event.key === 'Enter' && searchResults.length > 0) {
              event.preventDefault();
              window.location.assign(getTaskHref(searchResults[0].task));
            }
          }}
          placeholder="Search tickets…"
          className="w-full bg-transparent outline-none placeholder:text-gray-400 text-sm"
        />
        {globalSearchQuery && (
          <button
            onClick={() => {
              setGlobalSearchQuery('');
              setIsSearchOpen(false);
            }}
            className="rounded-full px-1.5 py-0.5 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
          >
            Clear
          </button>
        )}
      </div>

      {isSearchOpen && globalSearchQuery.trim() && (
        <div className="absolute left-0 w-max min-w-full max-w-[600px] top-[calc(100%+0.5rem)] z-20 overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-xl dark:border-white/10 dark:bg-[#15161d]/95">
          <div className="border-b border-gray-200 px-4 py-3 text-xs font-medium text-gray-500 dark:border-white/10 dark:text-gray-400">
            Fuzzy search across all tickets. Results deep-link into full view, so browser tab actions work normally.
          </div>
          <div className="max-h-[420px] overflow-y-auto p-2">
            {searchResults.length > 0 ? searchResults.map(({ task }) => (
              <a
                key={task.id}
                href={getTaskHref(task)}
                className="flex w-full flex-col gap-1 rounded-xl px-3 py-3 text-left transition-colors hover:bg-gray-100 focus:bg-gray-100 focus:outline-none dark:hover:bg-white/5 dark:focus:bg-white/5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-white">{task.title || 'Untitled ticket'}</span>
                  <StatusBadge
                    status={task.status}
                    colorClass={getStatusColorClass(config, task.status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                </div>
                <div className="text-xs font-semibold tracking-[0.18em] text-gray-400">{task.id}</div>
                <div className="text-sm text-gray-500 dark:text-gray-400">{getResultPreview(task)}</div>
              </a>
            )) : (
              <div className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
                No matching tickets.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

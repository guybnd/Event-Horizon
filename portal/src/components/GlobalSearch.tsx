import { useState, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import { Search } from 'lucide-react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { searchTasks } from '../taskSearch';
import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import type { Task } from '../types';

export function GlobalSearch() {
  const tasks = useAppSelector((s) => s.tasks);
  const config = useAppSelector((s) => s.config);
  // FLUX-744: opening a result follows the board open mode (default 'chat' → chat-aligned view with the
  // ticket panel open). Routed through openTask so it stays consistent with cards / any other surface.
  const { openTask } = useAppActions();
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  // FLUX-744: open a search result (honoring the open mode) and dismiss the dropdown. Left-click and
  // Enter route here; the result keeps its href so middle-click / open-in-new-tab still deep-link.
  const openResult = (task: Task) => {
    openTask(task);
    setIsSearchOpen(false);
    setGlobalSearchQuery('');
  };

  // FLUX-791: defer the query + memoize so the per-character subsequence scan over every ticket's
  // full body doesn't run on every keystroke render. The input stays responsive; results catch up.
  const deferredQuery = useDeferredValue(globalSearchQuery);
  const searchResults = useMemo(
    () => (deferredQuery.trim() ? searchTasks(tasks, deferredQuery, 7) : []),
    [tasks, deferredQuery],
  );

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
              openResult(searchResults[0].task);
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
        <div className="absolute left-0 top-[calc(100%+0.625rem)] z-30 w-max min-w-full max-w-[640px] overflow-hidden rounded-2xl border border-gray-200/90 bg-white/95 shadow-[0_24px_60px_rgba(28,25,23,0.22)] ring-1 ring-white/70 backdrop-blur-xl dark:border-white/10 dark:bg-[#12131a]/96 dark:ring-white/5">
          <div className="border-b border-gray-200/90 bg-gradient-to-r from-gray-50/90 to-white/40 px-4 py-3 text-xs font-semibold tracking-[0.01em] text-gray-600 dark:border-white/10 dark:from-white/[0.04] dark:to-transparent dark:text-gray-300">
            Fuzzy search across all tickets. Results open the ticket's chat view; middle-click to deep-link in a new tab.
          </div>
          <div className="max-h-[430px] overflow-y-auto px-2 py-2.5">
            {searchResults.length > 0 ? searchResults.map(({ task }) => (
              <a
                key={task.id}
                href={getTaskHref(task)}
                onClick={(e) => {
                  // Left-click opens the in-app chat view; let modified clicks (new tab / window) and
                  // middle-click fall through to the href so deep-linking still works.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  openResult(task);
                }}
                className="group flex w-full flex-col gap-1.5 rounded-xl border border-transparent px-3 py-3 text-left transition-all duration-200 hover:border-gray-200 hover:bg-white hover:shadow-sm focus:border-gray-200 focus:bg-white focus:outline-none dark:hover:border-white/10 dark:hover:bg-white/[0.03] dark:focus:border-white/10 dark:focus:bg-white/[0.03]"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-sm font-semibold text-gray-900 transition-colors group-hover:text-gray-950 dark:text-white">{task.title || 'Untitled ticket'}</span>
                  <StatusBadge
                    status={task.status}
                    colorClass={getStatusColorClass(config, task.status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                </div>
                <div className="text-[11px] font-semibold tracking-[0.18em] text-gray-400 dark:text-gray-500">{task.id}</div>
                <div className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">{getResultPreview(task)}</div>
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

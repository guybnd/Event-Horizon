import { useEffect, useRef, useState } from 'react';
import { Bell, Rocket, ListTodo, KanbanSquare, Settings as SettingsIcon, Search, FileText, Tag, Plus, Power } from 'lucide-react';
import { useApp } from '../AppContext';
import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import { getPromptableStatuses } from '../workflow';
import type { Task } from '../types';
import { searchTasks } from '../taskSearch';

export function Header() {
  const {
    view,
    setView,
    currentUser,
    setCurrentUser,
    currentProject,
    setCurrentProject,
    tasks,
    config,
    isConnected,
    openTaskModal,
  } = useApp();
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
  const [isStoppingService, setIsStoppingService] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const promptableStatuses = getPromptableStatuses(config);
  const promptCount = tasks.filter((task) => promptableStatuses.includes(task.status)).length;
  const searchResults = globalSearchQuery.trim() ? searchTasks(tasks, globalSearchQuery, 7) : [];
  const previousPromptCountRef = useRef(promptCount);

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
    if (promptCount === previousPromptCountRef.current) {
      return;
    }

    previousPromptCountRef.current = promptCount;
    setIsPromptPulseActive(true);
    const timeoutId = window.setTimeout(() => {
      setIsPromptPulseActive(false);
    }, 1600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [promptCount]);

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

  async function handleStopService() {
    if (!window.confirm('Stop the Event Horizon service? The portal will disconnect.')) return;
    setIsStoppingService(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Expected — the server closes the connection as it exits.
    }
  }

  return (
    <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/65 px-8 py-4 backdrop-blur-md dark:border-white/5 dark:bg-black/20">
      <div className="flex items-center justify-between gap-4 overflow-x-auto pb-1 -mb-1">
      <div className="flex shrink-0 items-center gap-4 xl:gap-6">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 p-2 rounded-lg">
            <Rocket className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight leading-none mb-1">Event Horizon</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">Local-first Integration</p>
          </div>
        </div>

        <div className="h-8 w-px bg-gray-200 dark:bg-white/10 mx-2"></div>

        <div className="flex items-center gap-2 bg-gray-100 dark:bg-black/40 p-1 rounded-lg">
          <button 
            onClick={() => setView('board')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'board' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <KanbanSquare className="w-4 h-4" /> Board
          </button>
          <button 
            onClick={() => setView('backlog')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'backlog' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <ListTodo className="w-4 h-4" /> Backlog
          </button>
          <button 
            onClick={() => setView('releases')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'releases' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <Tag className="w-4 h-4" /> Releases
          </button>
          <button 
            onClick={() => setView('docs')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'docs' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <FileText className="w-4 h-4" /> Docs
          </button>
          <button 
            onClick={() => setView('settings')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all cursor-pointer ${view === 'settings' ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
          >
            <SettingsIcon className="w-4 h-4" /> Settings
          </button>
        </div>
      </div>
      
      <div className="flex items-center gap-3 min-w-0 flex-1 justify-end">
        <button
          onClick={() => openTaskModal({ status: 'Grooming' })}
          className="flex h-[38px] items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover focus:outline-none cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New ticket</span>
        </button>
        <div ref={searchContainerRef} className="relative min-w-[160px] flex-1 max-w-[420px]">
          <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white/80 px-3 py-2 text-sm text-gray-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
            <Search className="h-4 w-4 text-gray-400" />
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
              placeholder="Search any ticket, backlog item, or ID"
              className="w-full bg-transparent outline-none placeholder:text-gray-400"
            />
            {globalSearchQuery && (
              <button
                onClick={() => {
                  setGlobalSearchQuery('');
                  setIsSearchOpen(false);
                }}
                className="rounded-full px-2 py-1 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/10 dark:hover:text-gray-200"
              >
                Clear
              </button>
            )}
          </div>

          {isSearchOpen && globalSearchQuery.trim() && (
            <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-20 overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-xl dark:border-white/10 dark:bg-[#15161d]/95">
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
        <button
          onClick={() => setView('board')}
          className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${promptCount > 0 ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'} ${isPromptPulseActive ? 'header-live-prompts' : ''}`}
          title="Open board to review tickets waiting for input or merge review"
        >
          <div className="relative">
            <Bell className="h-4 w-4" />
            {promptCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500" />}
          </div>
          <div className="flex flex-col items-start leading-none">
            <span className="text-[10px] font-bold uppercase tracking-wider">User Prompts</span>
            <span className="mt-1 text-sm font-semibold">{promptCount}</span>
          </div>
        </button>

        <div className={`flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${!isConnected ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300' : 'border-transparent bg-transparent text-gray-500 dark:text-gray-400'}`}>
          <div className="relative flex items-center justify-center">
            {isConnected ? (
              <div className="h-2 w-2 rounded-full bg-emerald-500/70" />
            ) : (
              <div className="h-2.5 w-2.5 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse" />
            )}
          </div>
          <div className="flex flex-col items-start leading-none">
            <span className="text-[10px] font-bold uppercase tracking-wider">{!isConnected ? 'Engine Status' : 'Engine'}</span>
            <span className="mt-1 text-sm font-semibold">{isConnected ? 'Connected' : 'Offline'}</span>
          </div>
        </div>

        <button
          onClick={handleStopService}
          disabled={isStoppingService || !isConnected}
          title="Stop the Event Horizon service"
          className="flex shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white/60 p-2 text-gray-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-gray-500 dark:hover:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
        >
          <Power className="h-4 w-4" />
        </button>

        <div className="flex flex-col items-end">
          <label className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Project Key</label>
          <input 
            value={currentProject} 
            onChange={e => setCurrentProject(e.target.value.toUpperCase())}
            className="bg-transparent text-sm font-semibold outline-none text-right w-24 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
          />
        </div>
        <div className="flex flex-col items-end">
          <label className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1">Current User</label>
          <input 
            value={currentUser} 
            onChange={e => setCurrentUser(e.target.value)}
            className="bg-transparent text-sm font-semibold outline-none text-right w-32 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
          />
        </div>
      </div>
      </div>
    </header>
  );
}

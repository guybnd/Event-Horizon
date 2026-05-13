import { useEffect, useRef, useState } from 'react';
import { Bell, Rocket, ListTodo, KanbanSquare, Settings as SettingsIcon, Search, FileText, Tag, Plus, Power, Bot, Sun, Moon } from 'lucide-react';
import { useApp } from '../AppContext';
import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import { getPromptableStatuses } from '../workflow';
import type { Task } from '../types';
import { searchTasks } from '../taskSearch';
import { SyncStatusIndicator } from './SyncStatusIndicator';

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
    saveConfig,
    isConnected,
    openTaskModal,
    theme,
    toggleTheme,
  } = useApp();
  const [globalSearchQuery, setGlobalSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
  const [isStoppingService, setIsStoppingService] = useState(false);
  const [lifetimeCostUSD, setLifetimeCostUSD] = useState<number | null>(null);
  const [lifetimeTokens, setLifetimeTokens] = useState<{ input: number; output: number; estimated: boolean } | null>(null);
  const [costStatsLoaded, setCostStatsLoaded] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const promptableStatuses = getPromptableStatuses(config);
  const promptCount = tasks.filter((task) => promptableStatuses.includes(task.status)).length;
  const activeSessionStatuses = new Set(['pending', 'running', 'waiting-input']);
  const activeSessionCount = tasks.filter((task) => task.cliSession && activeSessionStatuses.has(task.cliSession.status)).length;
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

  useEffect(() => {
    async function loadTokenStats() {
      try {
        const res = await fetch('/api/stats/tokens');
        if (!res.ok) return;
        const data = await res.json();
        setLifetimeCostUSD(data.lifetime?.costUSD ?? 0);
        setCostStatsLoaded(true);
        const lTok = data.lifetime;
        if (lTok && ((lTok.inputTokens ?? 0) > 0 || (lTok.outputTokens ?? 0) > 0)) {
          setLifetimeTokens({ input: lTok.inputTokens ?? 0, output: lTok.outputTokens ?? 0, estimated: lTok.costIsEstimated ?? false });
        } else {
          setLifetimeTokens(null);
        }
      } catch {
        // non-critical
      }
    }
    loadTokenStats();
  }, [tasks]);

  async function handleStopService() {
    if (!window.confirm('Stop the Event Horizon service? The portal will disconnect.')) return;
    setIsStoppingService(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Expected — the server closes the connection as it exits.
    }
  }

  const navItem = (v: typeof view, icon: React.ReactNode, label: string) => {
    const isActive = view === v;
    return (
      <button
        onClick={() => setView(v)}
        className={`group flex items-center py-1.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer overflow-hidden ${isActive ? 'bg-white dark:bg-[#2a2b36] shadow-sm text-primary px-3' : 'px-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
      >
        <span className="shrink-0">{icon}</span>
        <span
          className={`whitespace-nowrap transition-all duration-200 overflow-hidden ${isActive ? 'max-w-[80px] opacity-100 ml-2' : 'max-w-0 opacity-0 group-hover:max-w-[80px] group-hover:opacity-100 group-hover:ml-2'}`}
        >
          {label}
        </span>
      </button>
    );
  };

  return (
    <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/65 px-4 py-3 backdrop-blur-md dark:border-white/5 dark:bg-black/20">
      <div className="flex items-center justify-between gap-3">

        {/* Left: branding + nav */}
        <div className="flex shrink-0 items-center gap-3">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="bg-primary/10 p-1.5 rounded-lg">
              <Rocket className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-none">Event Horizon</h1>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 font-medium leading-none mt-0.5">Local-first</p>
            </div>
          </div>

          <div className="h-6 w-px bg-gray-200 dark:bg-white/10" />

          {/* Nav pills */}
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-black/40 p-1 rounded-lg">
            {navItem('board', <KanbanSquare className="w-4 h-4" />, 'Board')}
            {navItem('backlog', <ListTodo className="w-4 h-4" />, 'Backlog')}
            {navItem('releases', <Tag className="w-4 h-4" />, 'Releases')}
            {navItem('docs', <FileText className="w-4 h-4" />, 'Docs')}
            {navItem('settings', <SettingsIcon className="w-4 h-4" />, 'Settings')}
          </div>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">

          {/* New ticket */}
          <button
            onClick={() => openTaskModal({ status: 'Grooming' })}
            className="flex h-[34px] items-center justify-center gap-1.5 rounded-2xl bg-primary px-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover focus:outline-none cursor-pointer shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New ticket</span>
          </button>

          {/* Search */}
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

          {/* User Prompts — compact stat card */}
          <button
            onClick={() => setView('board')}
            className={`group flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-all duration-200 overflow-hidden ${promptCount > 0 ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'} ${isPromptPulseActive ? 'header-live-prompts' : ''}`}
            title="Open board to review tickets waiting for input or merge review"
          >
            <div className="relative shrink-0">
              <Bell className="h-3.5 w-3.5" />
              {promptCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
            </div>
            <span className="text-sm font-semibold leading-none">{promptCount}</span>
            <span className="max-w-0 overflow-hidden opacity-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider transition-all duration-200 group-hover:max-w-[80px] group-hover:opacity-100 group-hover:ml-0.5">
              Prompts
            </span>
          </button>

          {/* Agent Sessions — compact stat card */}
          <button
            onClick={() => setView('board')}
            className={`group flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-all duration-200 overflow-hidden ${activeSessionCount > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'}`}
            title="Active Claude Code agent sessions running on tickets"
          >
            <div className="relative shrink-0">
              <Bot className="h-3.5 w-3.5" />
              {activeSessionCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
            </div>
            <span className="text-sm font-semibold leading-none">{activeSessionCount}</span>
            <span className="max-w-0 overflow-hidden opacity-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider transition-all duration-200 group-hover:max-w-[80px] group-hover:opacity-100 group-hover:ml-0.5">
              Agents
            </span>
          </button>

          {/* Lifetime Cost / Tokens — compact stat card */}
          {costStatsLoaded && (
            <button
              type="button"
              onClick={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
              className="group flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-200 bg-white/60 px-2.5 py-1.5 text-gray-500 transition-all duration-200 overflow-hidden dark:border-white/10 dark:bg-white/5 dark:text-gray-400 hover:border-primary/40 hover:bg-primary/5 dark:hover:border-primary/30 dark:hover:bg-primary/10 cursor-pointer"
              title={config?.tokenDisplayMode === 'tokens'
                ? `Lifetime tokens · ↑ ${(lifetimeTokens?.input ?? 0).toLocaleString()} / ↓ ${(lifetimeTokens?.output ?? 0).toLocaleString()} · Click to switch to cost`
                : `Lifetime Claude API cost across all tickets${lifetimeTokens ? ` · ↑ ${lifetimeTokens.input.toLocaleString()} / ↓ ${lifetimeTokens.output.toLocaleString()} tokens` : ''}${lifetimeTokens?.estimated ? ' (estimated)' : ''} · Click to switch to tokens`}
            >
              <Bot className="h-3.5 w-3.5 shrink-0" />
              {config?.tokenDisplayMode === 'tokens' ? (
                <span className="text-sm font-semibold leading-none">
                  ↑{((lifetimeTokens?.input ?? 0) / 1000).toFixed(1)}k ↓{((lifetimeTokens?.output ?? 0) / 1000).toFixed(1)}k
                </span>
              ) : (lifetimeCostUSD ?? 0) > 0 ? (
                <span className="text-sm font-semibold leading-none">
                  ${lifetimeCostUSD!.toFixed(2)}{lifetimeTokens?.estimated ? '~' : ''}
                </span>
              ) : lifetimeTokens ? (
                <span className="text-sm font-semibold leading-none">
                  ↑{(lifetimeTokens.input / 1000).toFixed(1)}k ↓{(lifetimeTokens.output / 1000).toFixed(1)}k
                </span>
              ) : (
                <span className="text-sm font-semibold leading-none">$0.00</span>
              )}
              <span className="max-w-0 overflow-hidden opacity-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider transition-all duration-200 group-hover:max-w-[60px] group-hover:opacity-100 group-hover:ml-0.5">
                {config?.tokenDisplayMode === 'tokens' ? 'Tokens' : 'Cost'}
              </span>
            </button>
          )}

          {/* Sync Status */}
          <SyncStatusIndicator />

          {/* Engine indicator — dot only when connected, full pill when offline */}
          <div
            className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 transition-all duration-200 ${!isConnected ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300' : 'border-transparent bg-transparent text-gray-400 dark:text-gray-500'}`}
            title={isConnected ? 'Engine connected' : 'Engine offline'}
          >
            {isConnected ? (
              <div className="h-2 w-2 rounded-full bg-emerald-500/70" />
            ) : (
              <>
                <div className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse shrink-0" />
                <div className="flex flex-col items-start leading-none">
                  <span className="text-[10px] font-bold uppercase tracking-wider">Engine</span>
                  <span className="text-xs font-semibold">Offline</span>
                </div>
              </>
            )}
          </div>

          {/* Power + theme — grouped */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={handleStopService}
              disabled={isStoppingService || !isConnected}
              title="Stop the Event Horizon service"
              className="flex items-center justify-center rounded-xl border border-gray-200 bg-white/60 p-1.5 text-gray-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-gray-500 dark:hover:border-red-500/30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <Power className="h-3.5 w-3.5" />
            </button>

            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex items-center justify-center rounded-xl border border-gray-200 bg-white/60 p-1.5 text-gray-400 transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-500 dark:hover:border-primary/30 dark:hover:bg-primary/10 dark:hover:text-primary cursor-pointer"
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </button>
          </div>

          {/* User + Project stacked */}
          <div className="flex shrink-0 flex-col items-end gap-0.5 min-w-0">
            <div className="flex items-center gap-1">
              <label className="text-[9px] text-gray-400 font-bold uppercase tracking-wider shrink-0">Key</label>
              <input
                value={currentProject}
                onChange={e => setCurrentProject(e.target.value.toUpperCase())}
                className="bg-transparent text-xs font-semibold outline-none text-right w-14 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
              />
            </div>
            <div className="flex items-center gap-1">
              <label className="text-[9px] text-gray-400 font-bold uppercase tracking-wider shrink-0">User</label>
              <input
                value={currentUser}
                onChange={e => setCurrentUser(e.target.value)}
                className="bg-transparent text-xs font-semibold outline-none text-right w-20 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
              />
            </div>
          </div>

        </div>
      </div>
    </header>
  );
}

import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { Bell, Rocket, ListTodo, KanbanSquare, Settings as SettingsIcon, FileText, Tag, Plus, Power, Bot, Sun, Moon } from 'lucide-react';
import { useApp, type AppView } from '../AppContext';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import { ActiveSessionsPopover } from './ActiveSessionsPopover';
import { NotificationPanel } from './NotificationPanel';
import { AnimatePresence } from 'framer-motion';
import { GlobalSearch } from './GlobalSearch';
import { LifetimeTokenStats } from './LifetimeTokenStats';

const NavItem = memo(function NavItem({ 
  view, 
  target, 
  icon, 
  label, 
  onClick 
}: { 
  view: AppView, 
  target: AppView, 
  icon: React.ReactNode, 
  label: string, 
  onClick: (v: AppView) => void 
}) {
  const isActive = view === target;
  return (
    <button
      onClick={() => onClick(target)}
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
});

const Branding = memo(function Branding() {
  return (
    <div className="flex items-center gap-2">
      <div className="bg-primary/10 p-1.5 rounded-lg">
        <Rocket className="w-4 h-4 text-primary" />
      </div>
      <div>
        <h1 className="text-base font-bold tracking-tight leading-none">Event Horizon</h1>
        <p className="text-[10px] text-gray-500 dark:text-gray-400 font-medium leading-none mt-0.5">Local-first</p>
      </div>
    </div>
  );
});

export function Header() {
  const {
    view,
    setView,
    currentUser,
    setCurrentUser,
    currentProject,
    setCurrentProject,
    tasks,
    isConnected,
    openTaskModal,
    openTaskFullView,
    theme,
    toggleTheme,
    notifications,
    notificationUnreadCount,
    refreshNotifications,
  } = useApp();

  const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
  const [isStoppingService, setIsStoppingService] = useState(false);
  const [isSessionsPopoverOpen, setIsSessionsPopoverOpen] = useState(false);
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);

  const activeSessionStatuses = new Set(['pending', 'running', 'waiting-input']);
  const activeSessionCount = tasks.filter((task) => task.cliSession && activeSessionStatuses.has(task.cliSession.status)).length;
  const previousUnreadRef = useRef(notificationUnreadCount);

  useEffect(() => {
    if (notificationUnreadCount === previousUnreadRef.current) {
      return;
    }

    previousUnreadRef.current = notificationUnreadCount;
    if (notificationUnreadCount > 0) {
      setIsPromptPulseActive(true);
      const timeoutId = window.setTimeout(() => {
        setIsPromptPulseActive(false);
      }, 1600);
      return () => { window.clearTimeout(timeoutId); };
    }
  }, [notificationUnreadCount]);

  const handleStopService = useCallback(async () => {
    if (!window.confirm('Stop the Event Horizon service? The portal will disconnect.')) return;
    setIsStoppingService(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Expected — the server closes the connection as it exits.
    }
  }, []);

  const handleCloseSessionsPopover = useCallback(() => setIsSessionsPopoverOpen(false), []);
  const handleCloseNotificationPanel = useCallback(() => setIsNotificationPanelOpen(false), []);
  const handleOpenTaskFromSessions = useCallback((t: any) => openTaskFullView(t), [openTaskFullView]);
  const handleSetView = useCallback((v: AppView) => setView(v), [setView]);
  const handleOpenNewTicket = useCallback(() => openTaskModal({ status: 'Grooming' }), [openTaskModal]);
  const toggleSessionsPopover = useCallback(() => setIsSessionsPopoverOpen(prev => !prev), []);
  const toggleNotificationPanel = useCallback(() => setIsNotificationPanelOpen(prev => !prev), []);

  return (
    <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/65 px-4 py-3 backdrop-blur-md dark:border-white/5 dark:bg-black/20">
      <div className="flex items-center justify-between gap-3">

        {/* Left: branding + nav */}
        <div className="flex shrink-0 items-center gap-3">
          <Branding />

          <div className="h-6 w-px bg-gray-200 dark:bg-white/10" />

          {/* Nav pills */}
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-black/40 p-1 rounded-lg">
            <NavItem view={view} target="board" icon={<KanbanSquare className="w-4 h-4" />} label="Board" onClick={handleSetView} />
            <NavItem view={view} target="backlog" icon={<ListTodo className="w-4 h-4" />} label="Backlog" onClick={handleSetView} />
            <NavItem view={view} target="releases" icon={<Tag className="w-4 h-4" />} label="Releases" onClick={handleSetView} />
            <NavItem view={view} target="docs" icon={<FileText className="w-4 h-4" />} label="Docs" onClick={handleSetView} />
            <NavItem view={view} target="settings" icon={<SettingsIcon className="w-4 h-4" />} label="Settings" onClick={handleSetView} />
          </div>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">

          {/* New ticket */}
          <button
            onClick={handleOpenNewTicket}
            className="flex h-[34px] items-center justify-center gap-1.5 rounded-2xl bg-primary px-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover focus:outline-none cursor-pointer shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New ticket</span>
          </button>

          <GlobalSearch />

          {/* Notifications dropdown */}
          <div className="relative">
            <button
              onClick={toggleNotificationPanel}
              className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-all duration-200 overflow-hidden ${
                notifications.some(n => n.type === 'error' && !n.read)
                  ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                  : notificationUnreadCount > 0
                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
                    : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'
              } ${isPromptPulseActive ? 'header-live-prompts' : ''} ${isNotificationPanelOpen ? 'ring-2 ring-primary/30' : ''}`}
              title="Notifications"
            >
              <div className="relative shrink-0">
                <Bell className="h-3.5 w-3.5" />
                {notificationUnreadCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />}
              </div>
              <span className="text-sm font-semibold leading-none">{notificationUnreadCount}</span>
              <span className="max-w-0 overflow-hidden opacity-0 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider transition-all duration-200 group-hover:max-w-[80px] group-hover:opacity-100 group-hover:ml-0.5">
                Alerts
              </span>
            </button>
            <AnimatePresence>
              {isNotificationPanelOpen && (
                <NotificationPanel
                  notifications={notifications}
                  onClose={handleCloseNotificationPanel}
                  onUpdate={refreshNotifications}
                />
              )}
            </AnimatePresence>
          </div>

          {/* Agent Sessions — compact stat card */}
          <div className="relative">
            <button
              onClick={toggleSessionsPopover}
              className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-left transition-all duration-200 overflow-hidden ${activeSessionCount > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 agent-session-active' : 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'} ${isSessionsPopoverOpen ? 'ring-2 ring-primary/30' : ''}`}
              title="Active agent sessions running on tickets"
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
            <AnimatePresence>
              {isSessionsPopoverOpen && (
                <ActiveSessionsPopover
                  tasks={tasks}
                  onClose={handleCloseSessionsPopover}
                  openTask={handleOpenTaskFromSessions}
                />
              )}
            </AnimatePresence>
          </div>

          <LifetimeTokenStats />

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

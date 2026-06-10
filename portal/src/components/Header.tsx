import { useCallback, useEffect, useRef, useState, memo } from 'react';
import { Bell, Rocket, ListTodo, KanbanSquare, Settings as SettingsIcon, FileText, Tag, Plus, Power, Sun, Moon, Workflow, Palette } from 'lucide-react';
import { useApp, THEMES, type AppView } from '../AppContext';
import { NotificationPanel } from './NotificationPanel';
import { AnimatePresence } from 'framer-motion';
import { GlobalSearch } from './GlobalSearch';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

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
      className={`group flex items-center py-1.5 rounded-lg text-[13px] font-semibold transition-all duration-200 cursor-pointer overflow-hidden active:scale-95 ${isActive ? 'shadow-sm px-3' : 'px-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'}`}
      style={isActive ? { background: 'var(--eh-surface-raised)', color: 'var(--eh-accent)', boxShadow: '0 1px 3px var(--eh-shadow-color)' } : { color: 'var(--eh-text-muted)' }}
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
    <div className="flex items-center gap-2.5">
      <div className="bg-primary/10 p-1.5 rounded-lg">
        <Rocket className="w-4 h-4 text-primary" />
      </div>
      <div>
        <h1 className="text-[15px] font-extrabold tracking-[-0.03em] leading-none">Event Horizon</h1>
        <p className="text-[9px] font-medium leading-none mt-1 tracking-[0.08em] uppercase" style={{ color: 'var(--eh-text-muted)' }}>Local-first tickets</p>
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
    isConnected,
    openTaskModal,
    theme,
    setAppTheme,
    notifications,
    notificationUnreadCount,
    refreshNotifications,
  } = useApp();

  const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
  const [isStoppingService, setIsStoppingService] = useState(false);
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);
  const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
  const themePickerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!isThemePickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (themePickerRef.current && !themePickerRef.current.contains(e.target as Node)) {
        setIsThemePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isThemePickerOpen]);

  const handleStopService = useCallback(async () => {
    if (!window.confirm('Stop the Event Horizon service? The portal will disconnect.')) return;
    setIsStoppingService(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Expected — the server closes the connection as it exits.
    }
  }, []);

  const handleCloseNotificationPanel = useCallback(() => setIsNotificationPanelOpen(false), []);
  const handleSetView = useCallback((v: AppView) => setView(v), [setView]);
  const handleOpenNewTicket = useCallback(() => openTaskModal({ status: 'Grooming' }), [openTaskModal]);
  const toggleNotificationPanel = useCallback(() => setIsNotificationPanelOpen(prev => !prev), []);

  return (
    <header className="eh-header sticky top-0 z-10 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-3">

        {/* Left: branding + nav */}
        <div className="flex shrink-0 items-center gap-3">
          <Branding />

          <div className="h-6 w-px bg-gray-200 dark:bg-white/10" />

          {/* Nav pills */}
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--eh-column-bg)' }}>
            <NavItem view={view} target="board" icon={<KanbanSquare className="w-4 h-4" />} label="Board" onClick={handleSetView} />
            <NavItem view={view} target="backlog" icon={<ListTodo className="w-4 h-4" />} label="Backlog" onClick={handleSetView} />
            <NavItem view={view} target="releases" icon={<Tag className="w-4 h-4" />} label="Releases" onClick={handleSetView} />
            <NavItem view={view} target="docs" icon={<FileText className="w-4 h-4" />} label="Docs" onClick={handleSetView} />
            <NavItem view={view} target="workflows" icon={<Workflow className="w-4 h-4" />} label="Workflows" onClick={handleSetView} />
            <NavItem view={view} target="settings" icon={<SettingsIcon className="w-4 h-4" />} label="Settings" onClick={handleSetView} />
          </div>
        </div>

        {/* Right cluster */}
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">

          {/* New ticket */}
          <button
            onClick={handleOpenNewTicket}
            className="matrix-accent-button eh-btn-accent flex h-[34px] items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold shadow-sm transition-all focus:outline-none cursor-pointer shrink-0"
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

            <div className="relative" ref={themePickerRef}>
              <button
                onClick={() => setIsThemePickerOpen(prev => !prev)}
                title={`Theme: ${theme}`}
                className={`matrix-accent-toggle flex items-center justify-center rounded-xl border border-gray-200 bg-white/60 p-1.5 text-gray-400 transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary dark:border-white/10 dark:bg-white/5 dark:text-gray-500 dark:hover:border-primary/30 dark:hover:bg-primary/10 dark:hover:text-primary cursor-pointer ${isThemePickerOpen ? 'ring-2 ring-primary/30' : ''}`}
              >
                {theme === 'light' ? <Sun className="h-3.5 w-3.5" /> : theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Palette className="h-3.5 w-3.5" />}
              </button>
              {isThemePickerOpen && (
                <div className="eh-dropdown absolute right-0 top-full mt-2 w-36 rounded-xl border shadow-xl overflow-hidden z-50">
                  {THEMES.map((t) => (
                    <button
                      key={t.name}
                      onClick={() => { setAppTheme(t.name); setIsThemePickerOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors ${theme === t.name ? 'text-[var(--eh-accent)]' : 'hover:bg-[var(--eh-column-bg)]'}`}
                      style={theme === t.name ? { background: 'var(--eh-accent-glow)' } : { color: 'var(--eh-text-secondary)' }}
                    >
                      <span className={`h-3 w-3 rounded-full shrink-0 ${t.name === 'light' ? 'bg-gray-200 border border-gray-300' : t.name === 'dark' ? 'bg-gray-700' : t.name === 'matrix' ? 'bg-emerald-600' : t.name === 'cyber' ? 'bg-violet-600' : 'bg-sky-800'}`} />
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Workspace switcher */}
          <WorkspaceSwitcher />

          {/* User */}
          <div className="flex shrink-0 items-center gap-1 min-w-0">
            <label className="text-[9px] text-gray-400 font-bold uppercase tracking-wider shrink-0">User</label>
            <input
              value={currentUser}
              onChange={e => setCurrentUser(e.target.value)}
              className="bg-transparent text-xs font-semibold outline-none text-right w-20 text-gray-700 dark:text-gray-200 border-b border-transparent focus:border-primary transition-colors"
            />
          </div>

        </div>
      </div>
    </header>
  );
}

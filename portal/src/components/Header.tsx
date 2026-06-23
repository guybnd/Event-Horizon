import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { Bell, Rocket, ListTodo, KanbanSquare, Settings as SettingsIcon, FileText, Tag, Plus, Workflow, Check, GitCompare, Target } from 'lucide-react';
import { THEMES, type AppTheme, type AppView } from '../AppContext';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { NotificationPanel } from './NotificationPanel';
import { AnimatePresence } from 'framer-motion';
import { GlobalSearch } from './GlobalSearch';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { UserMenu } from './UserMenu';
import { SyncStatusIndicator } from './SyncStatusIndicator';

// Per-section accent so the nav reads as a colorful selector rather than six
// identical muted glyphs. Tints are saturated enough to stay legible in light
// mode and on the dark themes.
const NAV_TINTS: Record<AppView, string> = {
  board: '#10b981',     // emerald
  backlog: '#0ea5e9',   // sky
  changes: '#14b8a6',   // teal
  epics: '#6366f1',     // indigo
  releases: '#f59e0b',  // amber
  docs: '#8b5cf6',      // violet
  workflows: '#ec4899', // pink
  settings: '#64748b',  // slate
};

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
  const tint = NAV_TINTS[target];
  return (
    <button
      onClick={() => onClick(target)}
      className={`group flex items-center py-1.5 rounded-lg text-[13px] font-semibold transition-all duration-200 cursor-pointer overflow-hidden active:scale-95 ${isActive ? 'shadow-sm px-3' : 'px-2 opacity-70 hover:opacity-100 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'}`}
      style={isActive
        ? { background: `color-mix(in srgb, ${tint} 16%, transparent)`, color: tint, boxShadow: '0 1px 3px var(--eh-shadow-color)' }
        : { color: tint }}
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

const THEME_SWATCH: Record<AppTheme, string> = {
  light: 'bg-gray-200 border border-gray-300',
  dark: 'bg-gray-700',
  matrix: 'bg-emerald-600',
  cyber: 'bg-violet-600',
  midnight: 'bg-sky-800',
};

// The logo doubles as the theme selector. It glows on a slow cadence so the
// otherwise-non-obvious "click me to theme" affordance gets noticed.
const Branding = memo(function Branding() {
  const { setAppTheme } = useAppActions();
  const theme = useAppSelector((s) => s.theme);
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen]);

  return (
    <div className="relative flex items-center gap-2.5" ref={rootRef}>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        title={`Theme: ${theme} — click to change`}
        aria-label="Change theme"
        className={`eh-logo-button rounded-lg p-1.5 transition-colors cursor-pointer ${isOpen ? 'bg-primary/15' : 'bg-primary/10 hover:bg-primary/15'}`}
      >
        <Rocket className="w-4 h-4 text-primary" />
      </button>
      <div>
        <h1 className="text-[15px] font-extrabold tracking-[-0.03em] leading-none">Event Horizon</h1>
        <p className="text-[9px] font-medium leading-none mt-1 tracking-[0.08em] uppercase" style={{ color: 'var(--eh-text-muted)' }}>Local-first agentic tickets</p>
      </div>

      {isOpen && (
        <div className="eh-dropdown absolute left-0 top-full z-50 mt-2 w-40 overflow-hidden rounded-xl border shadow-xl">
          <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--eh-text-muted)' }}>Theme</div>
          {THEMES.map((t) => {
            const active = theme === t.name;
            return (
              <button
                key={t.name}
                onClick={() => { setAppTheme(t.name); setIsOpen(false); }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-sm font-medium transition-colors ${active ? 'text-[var(--eh-accent)]' : 'hover:bg-[var(--eh-column-bg)]'}`}
                style={active ? { background: 'var(--eh-accent-glow)' } : { color: 'var(--eh-text-secondary)' }}
              >
                <span className={`h-3 w-3 shrink-0 rounded-full ${THEME_SWATCH[t.name]}`} />
                <span className="flex-1 text-left">{t.label}</span>
                {active && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

/**
 * Board health weather icon. Derives a "weather" from:
 *   - blocked/awaiting-input ratio  → stormy
 *   - overloaded columns (>15 cards) → cloudy
 *   - otherwise                      → sunny
 */
const BoardWeather = memo(function BoardWeather() {
  const tasks = useAppSelector((s) => s.tasks);
  const config = useAppSelector((s) => s.config);
  const boardFx = config?.boardFx;

  const { icon, label, color } = useMemo(() => {
    if (!tasks.length) return { icon: '☀️', label: 'All clear', color: 'text-amber-500' };
    const blocked = tasks.filter(t => t.swimlane === 'require-input' || t.cliSession?.status === 'waiting-input').length;
    const blockedRatio = blocked / tasks.length;
    const columnCounts = tasks.reduce<Record<string, number>>((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {});
    const overloaded = Object.values(columnCounts).some(n => n > 15);
    if (blockedRatio > 0.15 || blocked >= 3) return { icon: '⛈️', label: `${blocked} blocked`, color: 'text-red-500' };
    if (overloaded || blockedRatio > 0.05) return { icon: '⛅', label: 'Some congestion', color: 'text-sky-500' };
    return { icon: '☀️', label: 'Flow is good', color: 'text-amber-500' };
  }, [tasks]);

  if (boardFx?.boardWeather === false) return null;

  return (
    <span
      title={`Board health: ${label}`}
      className={`select-none text-base leading-none cursor-default ${color}`}
      aria-label={`Board health: ${label}`}
    >
      {icon}
    </span>
  );
});

/**
 * 1px heartbeat strip at the very top of the header.
 * Pulses opacity in sync with live token throughput — brighter when the agent
 * is writing fast, dim when idle, invisible when no session is running.
 */
const Heartbeat = memo(function Heartbeat() {
  const tasks = useAppSelector((s) => s.tasks);
  const config = useAppSelector((s) => s.config);

  const totalOutputTokens = useMemo(() => {
    return tasks.reduce((sum, t) => {
      if (!t.cliSession || !['running', 'pending'].includes(t.cliSession.status)) return sum;
      return sum + (t.cliSession.outputTokens ?? 0);
    }, 0);
  }, [tasks]);

  const isRunning = useMemo(() => tasks.some(t => t.cliSession && ['running', 'pending'].includes(t.cliSession.status)), [tasks]);

  if (config?.boardFx?.heartbeat === false || !isRunning) return null;

  const intensity = Math.min(1, (totalOutputTokens % 1000) / 1000);

  return (
    <div
      className="heartbeat-strip"
      style={{ '--hb-intensity': intensity } as React.CSSProperties}
      aria-hidden
    />
  );
});

export function Header() {
  const { setView, openTaskModal, refreshNotifications } = useAppActions();
  const view = useAppSelector((s) => s.view);
  const isConnected = useAppSelector((s) => s.isConnected);
  const notifications = useAppSelector((s) => s.notifications);
  const notificationUnreadCount = useAppSelector((s) => s.notificationUnreadCount);

  const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
  const [isNotificationPanelOpen, setIsNotificationPanelOpen] = useState(false);

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

  const handleCloseNotificationPanel = useCallback(() => setIsNotificationPanelOpen(false), []);
  const handleSetView = useCallback((v: AppView) => setView(v), [setView]);
  const handleOpenNewTicket = useCallback(() => openTaskModal({ status: 'Grooming' }), [openTaskModal]);
  const toggleNotificationPanel = useCallback(() => setIsNotificationPanelOpen(prev => !prev), []);

  return (
    <header className="eh-header sticky top-0 z-50 border-b px-4 py-3">
      <Heartbeat />
      <div className="relative flex items-center justify-between gap-3">

        {/* Left: branding + nav */}
        <div className="flex shrink-0 items-center gap-3">
          <Branding />

          <div className="h-6 w-px bg-gray-200 dark:bg-white/10" />

          {/* Nav pills */}
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--eh-column-bg)' }}>
            <NavItem view={view} target="board" icon={<KanbanSquare className="w-4 h-4" />} label="Board" onClick={handleSetView} />
            <NavItem view={view} target="backlog" icon={<ListTodo className="w-4 h-4" />} label="Backlog" onClick={handleSetView} />
            <NavItem view={view} target="changes" icon={<GitCompare className="w-4 h-4" />} label="Changes" onClick={handleSetView} />
            <NavItem view={view} target="epics" icon={<Target className="w-4 h-4" />} label="Epics" onClick={handleSetView} />
            <NavItem view={view} target="releases" icon={<Tag className="w-4 h-4" />} label="Releases" onClick={handleSetView} />
            <NavItem view={view} target="docs" icon={<FileText className="w-4 h-4" />} label="Docs" onClick={handleSetView} />
            <NavItem view={view} target="workflows" icon={<Workflow className="w-4 h-4" />} label="Workflows" onClick={handleSetView} />
            <NavItem view={view} target="settings" icon={<SettingsIcon className="w-4 h-4" />} label="Settings" onClick={handleSetView} />
          </div>
        </div>

        {/* Center: search + new ticket.
            Absolutely centered so expanding nav labels (left) never shove it. */}
        <div className="absolute left-1/2 top-1/2 z-20 flex w-[480px] max-w-[44vw] -translate-x-1/2 -translate-y-1/2 items-center gap-2">
          <GlobalSearch />

          {/* New ticket */}
          <button
            onClick={handleOpenNewTicket}
            className="matrix-accent-button eh-btn-accent flex h-[34px] items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold shadow-sm transition-all focus:outline-none cursor-pointer shrink-0"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New ticket</span>
          </button>
        </div>

        {/* Right cluster */}
        <div className="flex shrink-0 items-center gap-2 justify-end">

          <BoardWeather />

          {/* Sync status — global (orphan-branch store), so it lives in the top bar. */}
          <SyncStatusIndicator />

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

          {/* Workspace switcher */}
          <WorkspaceSwitcher />

          {/* User */}
          <UserMenu />

        </div>
      </div>
    </header>
  );
}

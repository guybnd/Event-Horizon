import { useState, useEffect, useRef, useCallback, useMemo, memo, lazy, Suspense } from 'react';
import { Rnd } from 'react-rnd';
import { X, Minus, Plus, Terminal, Check, MoreHorizontal } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  createTerminalSession,
  destroyTerminalSession,
  killTerminalSession,
  getTerminalSession,
  renameTerminalSession,
  getTerminalWsUrl,
} from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import type { EngineEvent } from '../store/appStore';
import { formatClockTime } from '../lib/formatClockTime';
import { FilterChipRow } from './terminal/FilterChipRow';
import { useEscapeKey } from '../hooks/useEscapeKey';
import type { TerminalCommand } from '../types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface TerminalTab {
  id: string;
  title: string;
  type: 'pty' | 'engine-events' | 'operations';
  sessionId?: string;
  initialCmd?: string;
}

// Dev-only Operations tab (S11, epic FLUX-996, FLUX-1007) — same dead-code-elimination
// precedent as App.tsx's OnboardingStudioScreen: the lazy() (and its dynamic import()) lives
// inside an `import.meta.env.DEV` branch that's statically `false` in a production build, so
// the bundler drops the import and never emits the tab's chunk into prod dist at all.
const OperationsTab = import.meta.env.DEV
  ? lazy(() => import('./terminal/OperationsTab').then((m) => ({ default: m.OperationsTab })))
  : null;

type EventCategory = 'All' | 'Session' | 'Sync' | 'SSE' | 'Git' | 'Perf' | 'Errors';

const PANEL_DEFAULT = { x: 80, y: 80, width: 700, height: 450 };
const PANEL_MIN = { width: 400, height: 250 };
const GEOM_KEY = 'eh-terminal-panel-geom';
const DRAIN_DURATION = 2500;

function loadGeom() {
  try {
    const raw = localStorage.getItem(GEOM_KEY);
    if (raw) {
      const g = JSON.parse(raw) as typeof PANEL_DEFAULT;
      // Clamp to visible viewport so a stale off-screen geometry doesn't trap the panel.
      const safeX = Math.max(0, Math.min(g.x, window.innerWidth - PANEL_MIN.width));
      const safeY = Math.max(0, Math.min(g.y, window.innerHeight - PANEL_MIN.height));
      return { ...g, x: safeX, y: safeY };
    }
  } catch {}
  return PANEL_DEFAULT;
}

function saveGeom(g: typeof PANEL_DEFAULT) {
  try { localStorage.setItem(GEOM_KEY, JSON.stringify(g)); } catch {}
}

function categorizeEvent(type: string): EventCategory {
  if (type === 'perf') return 'Perf';
  if (type.includes('error') || type.includes('fail') || type.includes('crash')) return 'Errors';
  if (type.includes('session') || type.includes('activity') || type.includes('progress')) return 'Session';
  if (type.includes('sync') || type.includes('storage')) return 'Sync';
  if (type.includes('git')) return 'Git';
  if (type === 'ping' || type.includes('sse') || type.includes('connect')) return 'SSE';
  return 'All';
}

// Module scope (FLUX-1139) — was rebuilt on every row on every render inside the .map below.
const EVENT_TAG_COLOR: Record<EventCategory, string> = {
  All: 'text-gray-500',
  Session: 'text-sky-400',
  Sync: 'text-emerald-400',
  SSE: 'text-yellow-500',
  Git: 'text-teal-400',
  Perf: 'text-orange-400',
  Errors: 'text-red-400',
};

// Memoized so an appended event only mounts one new row — existing rows keep the same `ev`
// object reference (the store appends, never mutates) and skip re-render entirely (FLUX-1139).
const EngineEventRow = memo(function EngineEventRow({ ev, category }: { ev: EngineEvent; category: EventCategory }) {
  const ts = formatClockTime(ev.timestamp);
  return (
    <div className="flex gap-2 min-w-0">
      <span className="shrink-0 text-gray-600">{ts}</span>
      <span className={`shrink-0 font-semibold ${EVENT_TAG_COLOR[category]}`}>{ev.type}</span>
      <span className="text-gray-400 whitespace-pre">{JSON.stringify(ev.data)}</span>
    </div>
  );
});

// ─── PTY Tab ─────────────────────────────────────────────────────────────────

// Guards focus wiring against stealing keystrokes from an open rename input, a modal
// dialog, or the ticket chat box — only steal focus when nothing else "important" has it.
function isSafeToFocusTerminal(container: HTMLElement | null): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return true;
  if (container?.contains(active)) return true;
  // Also bail out of open (non-dialog) dropdown/menu/listbox overlays — e.g. ChatDock's
  // model picker (role="listbox") or TicketActions' launch menu (role="menu") stay
  // interactive alongside the terminal panel, so a plain role="dialog" check misses them.
  if (active.closest('[role="dialog"],[role="menu"],[role="listbox"],[aria-expanded="true"]')) return false;
  const tag = active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return false;
  return true;
}

function PtyTab({ sessionId, isActive, initialCmd }: { sessionId: string; isActive: boolean; initialCmd?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(false);
  // Stores a command that arrived before the WS was open (e.g. a quick-launch chip that
  // opened this tab). Drained in ws.onopen so it's never silently dropped.
  const pendingCmdRef = useRef<string | undefined>(initialCmd);

  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return;
    mountedRef.current = true;

    const term = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: 'monospace' });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;
    // A freshly opened tab should accept keystrokes immediately — no click required first.
    if (isSafeToFocusTerminal(containerRef.current)) term.focus();

    // Load scrollback then connect WS
    getTerminalSession(sessionId)
      .then(info => {
        if (info.scrollback) term.write(info.scrollback);
      })
      .catch(() => {});

    const ws = new WebSocket(getTerminalWsUrl(sessionId));
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'output') term.write(msg.data as string);
        if (msg.type === 'exit') term.write('\r\n[Process exited]\r\n');
      } catch {}
    };

    ws.onopen = () => {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      // Drain any command that was queued before the WS finished connecting.
      if (pendingCmdRef.current) {
        ws.send(JSON.stringify({ type: 'input', data: pendingCmdRef.current }));
        pendingCmdRef.current = undefined;
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Command injection from QuickLaunchRow
    const cmdHandler = (e: Event) => {
      const cmd = (e as CustomEvent).detail as string;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: cmd }));
      } else {
        // WS not yet open — queue it so ws.onopen drains it.
        pendingCmdRef.current = cmd;
      }
    };
    window.addEventListener(`eh-terminal-cmd-${sessionId}`, cmdHandler);

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    ro.observe(containerRef.current);

    return () => {
      mountedRef.current = false;
      ro.disconnect();
      ws.close();
      window.removeEventListener(`eh-terminal-cmd-${sessionId}`, cmdHandler);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [sessionId]);

  // Fit + restore focus when tab becomes active (switched to)
  useEffect(() => {
    if (isActive && fitRef.current) {
      setTimeout(() => {
        fitRef.current?.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
        }
        if (isSafeToFocusTerminal(containerRef.current)) termRef.current?.focus();
      }, 50);
    }
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-hidden"
      style={{ display: isActive ? 'flex' : 'none', flexDirection: 'column', background: '#1e1e1e' }}
      // Clicking inside the terminal body re-focuses it if focus was lost elsewhere.
      onMouseDown={() => termRef.current?.focus()}
    />
  );
}

// ─── Engine Events Tab ────────────────────────────────────────────────────────

function EngineEventsTab({ isActive }: { isActive: boolean }) {
  const [filter, setFilter] = useState<EventCategory>('All');
  const containerRef = useRef<HTMLDivElement>(null);
  const isConnected = useAppSelector(s => s.isConnected);
  // FLUX-1030: the event buffer now lives in the shared store (fed by the single /api/events
  // connection in AppContext), so it accumulates from app boot and survives this panel being
  // minimized/closed/reopened. This tab is a pure consumer of that buffer + the type filter.
  const events = useAppSelector(s => s.engineEvents);
  const { clearEngineEvents } = useAppActions();

  // Skip the filter + row-rendering work entirely while this tab isn't visible. It stays
  // mounted (display:none) so its buffer survives tab switches, but without this gate it would
  // otherwise fully re-render up to ENGINE_EVENTS_MAX rows on every single SSE tick even while
  // the user is looking at a different tab.
  const filtered = useMemo(() => {
    if (!isActive) return [];
    return filter === 'All' ? events : events.filter(e => categorizeEvent(e.type) === filter);
  }, [events, filter, isActive]);

  // "Stick to bottom" — only auto-follow new events when the user is already at (or very
  // near) the bottom. Once they scroll up to read scrollback, leave the position alone and
  // surface a "jump to bottom" affordance instead of yanking them back down.
  const stuckToBottomRef = useRef(true);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  // Snapshot of the *filtered* event count at the moment the user scrolled away from the
  // bottom, so the "N new events" badge reflects the currently-visible category, not the
  // unfiltered buffer (FLUX-1127).
  const baselineCountRef = useRef(filtered.length);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stuck = distanceFromBottom < 48;
    if (stuck !== stuckToBottomRef.current) {
      stuckToBottomRef.current = stuck;
      setStuckToBottom(stuck);
      if (!stuck) baselineCountRef.current = filtered.length;
    }
  }, [filtered.length]);

  const jumpToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckToBottomRef.current = true;
    setStuckToBottom(true);
  }, []);

  useEffect(() => {
    if (isActive && stuckToBottomRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [filtered.length, isActive]);

  const unseenCount = !stuckToBottom ? Math.max(0, filtered.length - baselineCountRef.current) : 0;

  const CATS: EventCategory[] = ['All', 'Session', 'Sync', 'SSE', 'Git', 'Perf', 'Errors'];

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" style={{ display: isActive ? 'flex' : 'none' }}>
      {/* Filter chips — pill-shaped to match mockup */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b flex-wrap" style={{ borderColor: 'var(--eh-border)', background: 'var(--eh-column-bg)' }}>
        <FilterChipRow label="Filter events" options={CATS} value={filter} onChange={setFilter} />
        <div className="ml-auto flex items-center gap-1.5">
          <div className={`h-1.5 w-1.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
          <span className="text-[10px]" style={{ color: 'var(--eh-text-muted)' }}>{isConnected ? 'Connected' : 'Offline'}</span>
          <button
            onClick={clearEngineEvents}
            className="ml-2 px-2 py-0.5 rounded-full text-[10px] border border-transparent text-gray-500 hover:text-gray-300 hover:border-white/20 cursor-pointer transition-colors"
          >
            Clear
          </button>
        </div>
      </div>
      {/* Log lines — overflow-x: auto so wide JSON lines can be scrolled horizontally */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto font-mono text-[11px] p-2 space-y-0.5"
        style={{ background: '#1e1e1e', color: '#d4d4d4' }}
      >
        {filtered.length === 0 && (
          <div className="text-gray-500 italic py-4 text-center">
            {isActive ? 'No events yet — waiting for engine activity…' : ''}
          </div>
        )}
        {filtered.map((ev) => (
          <EngineEventRow key={ev.id} ev={ev} category={categorizeEvent(ev.type)} />
        ))}
      </div>
      {/* Jump-to-bottom affordance — only while scrolled up with unseen new events */}
      {!stuckToBottom && unseenCount > 0 && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[11px] font-semibold shadow-lg cursor-pointer border transition-colors"
          style={{ background: 'var(--eh-accent)', borderColor: 'var(--eh-accent)', color: '#fff' }}
        >
          ↓ {unseenCount} new event{unseenCount !== 1 ? 's' : ''}
        </button>
      )}
    </div>
  );
}

// ─── Quick-Launch Chips ───────────────────────────────────────────────────────

function QuickLaunchRow({
  commands,
  onRun,
}: {
  commands: TerminalCommand[];
  onRun: (cmd: TerminalCommand) => void;
}) {
  const [armed, setArmed] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const armTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear all pending arm timers on unmount to avoid state updates after unmount.
  useEffect(() => {
    const timers = armTimers.current;
    return () => {
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newCmd, setNewCmd] = useState('');
  const [newMode, setNewMode] = useState<'current' | 'new'>('current');

  const VISIBLE_MAX = 4;
  const visible = commands.slice(0, VISIBLE_MAX);
  const overflow = commands.slice(VISIBLE_MAX);

  function handleChipClick(cmd: TerminalCommand) {
    if (armed === cmd.id) {
      // Confirm
      clearTimeout(armTimers.current.get(cmd.id));
      armTimers.current.delete(cmd.id);
      setArmed(null);
      onRun(cmd);
    } else {
      // Arm
      if (armed) {
        clearTimeout(armTimers.current.get(armed) ?? undefined);
      }
      setArmed(cmd.id);
      const t = setTimeout(() => {
        setArmed(null);
        armTimers.current.delete(cmd.id);
      }, 2500);
      armTimers.current.set(cmd.id, t);
    }
  }

  async function handleAddShortcut() {
    if (!newLabel.trim() || !newCmd.trim()) return;
    try {
      const res = await fetch('/api/config', { method: 'GET' });
      const config = await res.json();
      const existing: TerminalCommand[] = config.terminalCommands || [];
      const updated = [...existing, { id: `custom-${Date.now()}`, label: newLabel.trim(), command: newCmd.trim(), runMode: newMode }];
      await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminalCommands: updated }),
      });
      setShowAddForm(false);
      setNewLabel('');
      setNewCmd('');
    } catch {}
  }

  function renderChip(cmd: TerminalCommand) {
    const isArmed = armed === cmd.id;
    return (
      <button
        key={cmd.id}
        title={cmd.command}
        aria-label={isArmed ? `Confirm ${cmd.label}` : cmd.label}
        aria-pressed={isArmed}
        onClick={() => handleChipClick(cmd)}
        className={`relative overflow-hidden px-3 py-1 rounded-full text-[11px] font-semibold cursor-pointer transition-all border ${
          isArmed
            ? 'border-emerald-500 text-white'
            : 'border-[var(--eh-border)] text-gray-400 hover:text-gray-200 hover:border-white/30'
        }`}
        style={{ background: 'rgba(255,255,255,0.05)' }}
      >
        {/* Drain animation overlay — shrinks left-to-right over DRAIN_DURATION */}
        {isArmed && (
          <span
            className="absolute inset-0 pointer-events-none rounded-full"
            style={{
              background: 'rgba(16,185,129,0.45)',
              animation: `eh-chip-drain ${DRAIN_DURATION}ms linear forwards`,
              transformOrigin: 'left center',
            }}
          />
        )}
        {isArmed && (
          <span className="absolute inset-0 flex items-center justify-center gap-1 text-emerald-300 z-10">
            <Check className="w-3 h-3" /> Confirm
          </span>
        )}
        <span className={isArmed ? 'invisible' : ''}>{cmd.label}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b flex-wrap relative" style={{ borderColor: 'var(--eh-border)', background: 'var(--eh-surface)' }}>
      {visible.map(renderChip)}
      {overflow.length > 0 && (
        <div className="relative">
          <button
            onClick={() => setShowMore(!showMore)}
            className="px-3 py-1 rounded-full text-[11px] font-semibold text-gray-400 hover:text-gray-200 cursor-pointer flex items-center gap-1 border border-dashed"
            style={{ background: 'rgba(255,255,255,0.05)', borderColor: 'var(--eh-border)' }}
          >
            <MoreHorizontal className="w-3.5 h-3.5" /> More
          </button>
          {showMore && (
            <div className="absolute bottom-full left-0 mb-1 z-50 rounded-lg border shadow-xl overflow-hidden" style={{ background: 'var(--eh-surface)', borderColor: 'var(--eh-border)' }}>
              {overflow.map(cmd => {
                const isArmedOverflow = armed === cmd.id;
                return (
                  <button
                    key={cmd.id}
                    title={cmd.command}
                    aria-label={isArmedOverflow ? `Confirm ${cmd.label}` : cmd.label}
                    aria-pressed={isArmedOverflow}
                    onClick={() => {
                      // On confirm, close the menu; on arm, keep it open so the user can confirm
                      if (isArmedOverflow) setShowMore(false);
                      handleChipClick(cmd);
                    }}
                    className={`relative overflow-hidden flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-left cursor-pointer transition-colors ${
                      isArmedOverflow ? 'text-emerald-300' : 'hover:bg-white/10'
                    }`}
                  >
                    {isArmedOverflow && (
                      <span
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          background: 'rgba(16,185,129,0.35)',
                          animation: `eh-chip-drain ${DRAIN_DURATION}ms linear forwards`,
                          transformOrigin: 'left center',
                        }}
                      />
                    )}
                    <span className="relative flex items-center gap-1.5">
                      {isArmedOverflow ? <><Check className="w-3 h-3" />Confirm</> : cmd.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {/* Add shortcut */}
      <div className="relative ml-auto">
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          title="Add shortcut"
          aria-label="Add shortcut"
          className="w-6 h-6 flex items-center justify-center rounded-full border text-gray-500 hover:text-gray-300 cursor-pointer transition-colors"
          style={{ borderStyle: 'dashed', borderColor: 'var(--eh-border)' }}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        {showAddForm && (
          <div
            className="absolute bottom-full right-0 mb-1 z-50 p-3 rounded-lg border shadow-xl w-64"
            style={{ background: 'var(--eh-surface)', borderColor: 'var(--eh-border)' }}
          >
            <div className="text-[11px] font-bold mb-2" style={{ color: 'var(--eh-text-primary)' }}>Add shortcut</div>
            <input
              type="text"
              placeholder="Label"
              value={newLabel}
              onChange={e => setNewLabel(e.target.value)}
              className="w-full mb-1.5 px-2 py-1 rounded text-[12px] border"
              style={{ background: 'var(--eh-base)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-primary)' }}
            />
            <input
              type="text"
              placeholder="Command"
              value={newCmd}
              onChange={e => setNewCmd(e.target.value)}
              className="w-full mb-1.5 px-2 py-1 rounded text-[12px] border"
              style={{ background: 'var(--eh-base)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-primary)' }}
            />
            <div className="flex gap-3 mb-2 text-[11px]">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" value="current" checked={newMode === 'current'} onChange={() => setNewMode('current')} />
                Current tab
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" value="new" checked={newMode === 'new'} onChange={() => setNewMode('new')} />
                New tab
              </label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleAddShortcut}
                className="flex-1 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
              >
                Add
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="flex-1 py-1 rounded text-[11px] text-gray-400 hover:text-gray-200 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function TerminalPanel({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const config = useAppSelector(s => s.config);
  const { clearEngineEvents } = useAppActions();
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    const base: TerminalTab[] = [{ id: 'engine-events', title: 'Engine events', type: 'engine-events' }];
    if (import.meta.env.DEV) base.push({ id: 'operations', title: 'Operations', type: 'operations' });
    return base;
  });
  const [activeTabId, setActiveTabId] = useState('engine-events');
  const [isMinimized, setIsMinimized] = useState(false);
  const [geom, setGeom] = useState(loadGeom);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // FLUX-1030: surface a real error when the PTY backend can't spawn a shell (e.g. node-pty native
  // addon unavailable) instead of silently swallowing it — the "+" / quick-launch used to no-op.
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const terminalCommands: TerminalCommand[] = config?.terminalCommands || [];

  const openNewTab = useCallback(async () => {
    try {
      const info = await createTerminalSession(80, 24, `Terminal ${tabs.filter(t => t.type === 'pty').length + 1}`);
      const newTab: TerminalTab = { id: info.id, title: info.title, type: 'pty', sessionId: info.id };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(info.id);
      setErrorMsg(null);
    } catch (e) {
      setErrorMsg(`Couldn't open a terminal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [tabs]);

  const closeTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || tab.type !== 'pty') return;
    if (tab.sessionId) {
      destroyTerminalSession(tab.sessionId).catch(() => {});
    }
    setTabs(prev => prev.filter(t => t.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId('engine-events');
    }
  }, [tabs, activeTabId]);

  const terminateTab = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !tab.sessionId) return;
    // Send SIGTERM to the PTY process but keep the tab; the WS will receive an
    // 'exit' message and write "[Process exited]" in the terminal automatically.
    killTerminalSession(tab.sessionId).catch(() => {});
  }, [tabs]);

  const handleRunCommand = useCallback(async (cmd: TerminalCommand) => {
    const command = cmd.command + '\n';
    const activeTab = tabs.find(t => t.id === activeTabId && t.type === 'pty');

    if (cmd.runMode === 'new' || !activeTab) {
      // Open a new tab. Pass initialCmd so PtyTab sends it as soon as the WS opens —
      // no fragile setTimeout race.
      try {
        const info = await createTerminalSession(80, 24, cmd.label);
        const newTab: TerminalTab = { id: info.id, title: info.title, type: 'pty', sessionId: info.id, initialCmd: command };
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(info.id);
        setErrorMsg(null);
      } catch (e) {
        setErrorMsg(`Couldn't run "${cmd.label}": ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      // Active PTY tab exists — dispatch directly. If the WS isn't open yet (rare),
      // the cmdHandler in PtyTab will queue it in pendingCmdRef.
      window.dispatchEvent(new CustomEvent(`eh-terminal-cmd-${activeTab.id}`, { detail: command }));
    }
  }, [tabs, activeTabId]);

  // Debounce geometry saves so that dragging/resizing at 60fps doesn't
  // hammer localStorage with synchronous writes on every pixel.
  const saveGeomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveGeomTimerRef.current) clearTimeout(saveGeomTimerRef.current);
    saveGeomTimerRef.current = setTimeout(() => {
      saveGeom(geom);
      saveGeomTimerRef.current = null;
    }, 300);
    return () => {
      if (saveGeomTimerRef.current) clearTimeout(saveGeomTimerRef.current);
    };
  }, [geom]);

  // Context menu close on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // FLUX-1022: Esc minimizes (never closes) the terminal window — but only when focus is on the
  // window chrome. The default `ignoreWhenTyping` guard already excludes inputs/textareas/the
  // xterm body (`.xterm`), which is exactly "never while the shell owns the keystroke" (vim, TUIs
  // need Esc); the tab-rename input's own local Escape handler is unaffected since it lives on an
  // <input>, which this hook already skips.
  useEscapeKey(() => setIsMinimized(true), { enabled: isOpen && !isMinimized });

  if (!isOpen) return null;

  if (isMinimized) {
    return (
      <div
        className="fixed bottom-4 right-4 z-[9999] flex items-center gap-2 px-3 py-2 rounded-full shadow-lg cursor-pointer border"
        style={{ background: 'var(--eh-surface)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-primary)' }}
        onClick={() => setIsMinimized(false)}
      >
        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
        <Terminal className="w-4 h-4" />
        <span className="text-[12px] font-semibold">Terminal</span>
      </div>
    );
  }

  return (
    <>
      <Rnd
        style={{ zIndex: 9999 }}
        size={{ width: geom.width, height: geom.height }}
        position={{ x: geom.x, y: geom.y }}
        minWidth={PANEL_MIN.width}
        minHeight={PANEL_MIN.height}
        bounds="window"
        dragHandleClassName="terminal-drag-handle"
        onDragStop={(_e, d) => setGeom(g => ({ ...g, x: d.x, y: d.y }))}
        onResizeStop={(_e, _dir, _ref, delta, pos) =>
          setGeom(g => ({ ...g, width: g.width + delta.width, height: g.height + delta.height, x: pos.x, y: pos.y }))
        }
      >
        <div
          className="flex flex-col h-full rounded-xl overflow-hidden border shadow-2xl"
          style={{ background: 'var(--eh-surface)', borderColor: 'var(--eh-border)' }}
        >
          {/* ── Title bar (drag handle) ── separate from tab strip, per mockup */}
          <div
            className="terminal-drag-handle flex items-center gap-2 px-3 py-1.5 border-b cursor-grab select-none shrink-0"
            style={{ borderColor: 'var(--eh-border)', background: 'var(--eh-column-bg)' }}
          >
            <span className="text-[11px] font-mono tracking-widest select-none" style={{ color: 'var(--eh-text-muted)', letterSpacing: '0.15em' }}>⠿⠿</span>
            <span className="flex items-center gap-1.5 flex-1 text-[12px] font-semibold" style={{ color: 'var(--eh-text-primary)' }}>
              <Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--eh-accent)' }} />
              Terminal
            </span>
            <button
              onClick={() => setIsMinimized(true)}
              className="w-6 h-6 flex items-center justify-center rounded cursor-pointer text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
              title="Minimize"
              aria-label="Minimize terminal"
            >
              <Minus className="w-3 h-3" />
            </button>
            <button
              onClick={onClose}
              className="w-6 h-6 flex items-center justify-center rounded cursor-pointer text-gray-500 hover:text-red-400 hover:bg-red-500/15 transition-colors"
              title="Close"
              aria-label="Close terminal"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          {/* ── Tab strip — browser-tab style on dark ground, per mockup ── */}
          <div
            className="flex items-end gap-0.5 px-1.5 pt-1.5 shrink-0 overflow-x-auto"
            style={{ background: 'var(--eh-base)', borderBottom: '1px solid var(--eh-border)' }}
          >
            {tabs.map(tab => (
              <div
                key={tab.id}
                className="relative group shrink-0"
                onContextMenu={e => {
                  e.preventDefault();
                  if (tab.type === 'operations') return;
                  setContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
              >
                {renamingTabId === tab.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={async () => {
                      if (renameValue.trim() && tab.sessionId) {
                        await renameTerminalSession(tab.sessionId, renameValue.trim()).catch(() => {});
                        setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, title: renameValue.trim() } : t));
                      }
                      setRenamingTabId(null);
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenamingTabId(null);
                    }}
                    className="mb-0.5 px-2 py-0.5 text-[12px] rounded border w-28"
                    style={{ background: 'var(--eh-base)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-primary)' }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <button
                    onClick={() => setActiveTabId(tab.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium cursor-pointer transition-colors whitespace-nowrap rounded-t-md border border-b-0 ${
                      activeTabId === tab.id
                        ? 'border-[var(--eh-border)] text-[var(--eh-text-primary)]'
                        : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-white/5'
                    }`}
                    style={activeTabId === tab.id ? { background: 'var(--eh-surface)' } : {}}
                  >
                    {tab.type === 'engine-events'
                      ? <span className="text-[9px] font-bold" style={{ color: 'var(--eh-accent)' }}>⚡</span>
                      : tab.type === 'operations'
                      ? <span className="text-[9px] font-bold" style={{ color: 'var(--eh-accent)' }}>⚙</span>
                      : <Terminal className="w-3 h-3" />}
                    {tab.title}
                    {tab.type === 'pty' && (
                      <span
                        onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                        className="opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-red-400 cursor-pointer ml-0.5 leading-none text-[14px]"
                        aria-label={`Close ${tab.title}`}
                      >
                        ×
                      </span>
                    )}
                  </button>
                )}
              </div>
            ))}
            {/* Add tab button — dashed border, per mockup */}
            <button
              onClick={openNewTab}
              className="mb-1 ml-0.5 w-6 h-6 flex items-center justify-center rounded border text-gray-500 hover:text-gray-300 cursor-pointer shrink-0 transition-colors"
              style={{ borderStyle: 'dashed', borderColor: 'var(--eh-border)' }}
              title="New terminal tab"
              aria-label="New terminal tab"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* ── Quick-launch row ── */}
          {terminalCommands.length > 0 && (
            <QuickLaunchRow commands={terminalCommands} onRun={handleRunCommand} />
          )}

          {/* ── PTY error banner — surfaced when a shell can't be spawned (FLUX-1030) ── */}
          {errorMsg && (
            <div
              className="flex items-start gap-2 px-3 py-2 border-b text-[11px] shrink-0"
              style={{ background: 'rgba(220,38,38,0.12)', borderColor: 'var(--eh-border)', color: '#fca5a5' }}
            >
              <span className="flex-1 font-mono break-words">{errorMsg}</span>
              <button
                onClick={() => setErrorMsg(null)}
                className="shrink-0 text-red-300 hover:text-red-100 cursor-pointer"
                aria-label="Dismiss error"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* ── Tab content ── */}
          <div className="flex-1 flex flex-col overflow-hidden relative">
            <EngineEventsTab isActive={activeTabId === 'engine-events'} />
            {import.meta.env.DEV && OperationsTab && (
              <Suspense fallback={null}>
                <OperationsTab isActive={activeTabId === 'operations'} />
              </Suspense>
            )}
            {tabs.filter(t => t.type === 'pty').map(tab => (
              <PtyTab
                key={tab.id}
                sessionId={tab.sessionId!}
                isActive={activeTabId === tab.id}
                initialCmd={tab.initialCmd}
              />
            ))}
            {activeTabId !== 'engine-events' && activeTabId !== 'operations' && !tabs.find(t => t.id === activeTabId && t.type === 'pty') && (
              <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
                Tab not found
              </div>
            )}
          </div>

          {/* ── Status bar — per mockup ── */}
          <div
            className="flex items-center justify-between px-3 py-1 shrink-0 border-t text-[10px]"
            style={{ background: 'var(--eh-base)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-muted)' }}
          >
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
              bound to 127.0.0.1
            </span>
            <span className="text-[10px]" style={{ color: 'var(--eh-text-muted)' }}>
              {tabs.filter(t => t.type === 'pty').length} terminal{tabs.filter(t => t.type === 'pty').length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </Rnd>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[10000] rounded-lg border shadow-xl overflow-hidden text-[12px] py-1"
          style={{ top: contextMenu.y, left: contextMenu.x, background: 'var(--eh-surface)', borderColor: 'var(--eh-border)', color: 'var(--eh-text-primary)' }}
          onMouseDown={e => e.stopPropagation()}
        >
          {contextMenu.tabId === 'engine-events' ? (
            <button
              className="flex w-full items-center px-3 py-1.5 hover:bg-white/10 cursor-pointer"
              onClick={() => { clearEngineEvents(); setContextMenu(null); }}
            >
              Clear log
            </button>
          ) : (
            <>
              <button
                className="flex w-full items-center px-3 py-1.5 hover:bg-white/10 cursor-pointer"
                onClick={() => {
                  const tab = tabs.find(t => t.id === contextMenu.tabId);
                  if (tab) { setRenameValue(tab.title); setRenamingTabId(tab.id); }
                  setContextMenu(null);
                }}
              >
                Rename
              </button>
              <button
                className="flex w-full items-center px-3 py-1.5 hover:bg-white/10 cursor-pointer text-amber-400"
                onClick={() => { terminateTab(contextMenu.tabId); setContextMenu(null); }}
              >
                Terminate process
              </button>
              <button
                className="flex w-full items-center px-3 py-1.5 hover:bg-white/10 cursor-pointer text-red-400"
                onClick={() => { closeTab(contextMenu.tabId); setContextMenu(null); }}
              >
                Close tab
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}


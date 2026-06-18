import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, MessageSquare, Minus, X, History, Square, RotateCcw, GitBranch, FolderGit2, GitPullRequest, ListChecks, Loader2 } from 'lucide-react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { useChatSession } from '../hooks/useChatSession';
import { ChatView } from './task-modal/ChatView';
import { ChatDiffPanel } from './task-modal/ChatDiffPanel';
import { TicketContextCard, BoardSnapshotCard } from './task-modal/chatContext';
import { parseQuickReplies } from './task-modal/chatQuickReplies';
import { StatusBadge } from './StatusBadge';
import { TicketActionBar } from './TicketActionBar';
import { ChatQuestionPicker } from './AskQuestionPrompts';
import { useDock } from './DockProvider';
import { getStatusTint } from '../statusStyles';
import { getRequireInputStatus } from '../workflow';
import { BOARD_CONVERSATION_ID, fetchTaskCliSession, stopTaskCliSession, clearTaskTranscript, fetchBranchStatus, type BranchStatus } from '../api';
import type { CliSessionStatus, CliSessionSummary, Task } from '../types';

/**
 * FLUX-607: the bottom chat dock as a proper, centered taskbar (Windows-taskbar feel).
 * The orchestrator is pinned "home" at the left of the bar; every ticket with a
 * live/recent session surfaces as a card showing at-a-glance state — pulsing while an
 * agent works, a colored glow + `!` badge when a chat finished or wants input (distinct
 * treatment per state). A hover-only `x` retires a card into the always-available History
 * popover (which lists chats by title) so a finished or blocked chat is never lost and can
 * be reopened. Clicking a card toggles its floating window, which spawns anchored to the
 * clicked card's x position (FLUX-603 behavior, kept). Native-to-EH; iterate freely.
 */

// Statuses that earn a live card in the bar. `cancelled` is not surfaced as active —
// it falls through to the History section instead.
const SURFACE_STATUSES: CliSessionStatus[] = ['pending', 'running', 'waiting-input', 'completed', 'failed'];
const HISTORY_CAP = 10;
// Approx non-label width of a tab (state dot + paddings + the absolute `!`/`x` reserve) —
// subtracted from a tab's share of the strip budget to get the room left for its label.
const TAB_CHROME = 34;

type CardState = 'working' | 'needs-input' | 'finished' | 'error' | 'available' | 'idle';

/** Map a session status to the card's visual state. Acknowledging (opening) a card
 *  clears the attention states back to idle; `working` is live and ignores ack.
 *  `needsInput` distinguishes a genuine "the agent is waiting on you" pause (ticket
 *  in Require Input → gentle pulse) from a turn that merely finished and is parked &
 *  resumable (`waiting-input` → calm `available`, no pulse). Only an actively-running
 *  turn gets the live working pulse. */
function cardState(status: CliSessionStatus | undefined, acked: boolean, needsInput = false): CardState {
  switch (status) {
    case 'running':
      return 'working';
    case 'waiting-input':
      if (needsInput && !acked) return 'needs-input';
      return 'available';
    case 'completed':
      return acked ? 'idle' : 'finished';
    case 'failed':
      return acked ? 'idle' : 'error';
    default:
      return 'idle';
  }
}

const STATE_COPY: Record<CardState, string> = {
  working: 'working',
  'needs-input': 'requires input',
  finished: 'finished',
  error: 'failed',
  available: 'available',
  idle: 'idle',
};

const STATE_ANIM: Record<CardState, string> = {
  working: 'eh-taskcard-working',
  'needs-input': 'eh-taskcard-needs-input',
  finished: 'eh-taskcard-finished',
  error: 'eh-taskcard-error',
  available: 'eh-taskcard-available',
  idle: '',
};

/** `!` badge tone per attention state (working/idle show no badge). */
const BADGE_TONE: Partial<Record<CardState, string>> = {
  'needs-input': 'bg-amber-500 text-white',
  finished: 'bg-emerald-500 text-white',
  error: 'bg-red-500 text-white',
};

/** Leading state dot per tab — a compact at-a-glance status (the box-shadow glow
 *  animations still carry the live "working"/attention emphasis on top of this). */
const STATE_DOT: Record<CardState, string> = {
  working: 'bg-blue-500',
  'needs-input': 'bg-amber-500',
  finished: 'bg-emerald-500',
  error: 'bg-red-500',
  available: 'bg-slate-400',
  idle: 'bg-gray-300 dark:bg-gray-600',
};

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/** Split a ticket id like `FLUX-607` into a small prefix + the trailing number. */
function splitId(id: string): { prefix: string; short: string } {
  const idx = id.lastIndexOf('-');
  if (idx === -1) return { prefix: '', short: id };
  return { prefix: id.slice(0, idx), short: id.slice(idx + 1) };
}

export function ChatDock() {
  const { subscribeToEvent } = useAppActions();
  const tasks = useAppSelector((s) => s.tasks);
  const config = useAppSelector((s) => s.config);
  // Window/open state lives in the app-root DockProvider (FLUX-603) so a card can drive it
  // and it survives view switches. `anchors` records where each window should spawn from.
  const { open, acked, dismissed, manuallyOpened, anchors, drafts, toggle, closeCard, reopenFromHistory, setDraft } = useDock();
  const [showHistory, setShowHistory] = useState(false);
  const [boardSession, setBoardSession] = useState<CliSessionSummary | null>(null);
  // Right-click context menu (anchored at the cursor) for a single tab at a time.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Per-chat "unread": the latest agent-output timestamp we've shown the user. A closed chat
  // whose session emits newer output than this lights an unread dot. In-memory (resets on
  // reload, where everything baselines as read) — no persistence needed for v1.
  const seenRef = useRef<Record<string, string>>({});
  // Drives the adaptive tab sizing — labels shrink as the viewport narrows / tabs multiply.
  const [viewportW, setViewportW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Mouse wheel over the tab strip scrolls it left/right (the strip is one row with
  // overflow-x). A non-passive listener is required so we can preventDefault and stop the
  // page from scrolling vertically instead. Only hijacked when there's real horizontal
  // overflow to move.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (delta === 0 || el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Orchestrator has no task in the board list, so track its session here (the pinned card
  // needs live state even when its window is closed). Event-driven (FLUX-611): fetch once,
  // then refetch only on a board event — the engine streams `activity` (taskId '__board__')
  // mid-turn and `taskUpdated` (id '__board__') at turn end. No idle polling.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await fetchTaskCliSession(BOARD_CONVERSATION_ID);
        if (!cancelled) setBoardSession(s);
      } catch {
        /* ignore */
      }
    };
    void refresh();
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === BOARD_CONVERSATION_ID || o.id === BOARD_CONVERSATION_ID);
    };
    const on = (d: unknown) => { if (matches(d)) void refresh(); };
    const unsubs = [subscribeToEvent('activity', on), subscribeToEvent('taskUpdated', on)];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [subscribeToEvent]);

  const allTasks = tasks as Task[];

  const statusOf = useMemo(() => {
    const map = new Map<string, CliSessionStatus | undefined>();
    map.set(BOARD_CONVERSATION_ID, boardSession?.status);
    for (const t of allTasks) map.set(t.id, t.cliSession?.status);
    return map;
  }, [allTasks, boardSession]);

  const activityOf = (id: string): string | null =>
    id === BOARD_CONVERSATION_ID
      ? boardSession?.currentActivity ?? null
      : allTasks.find((t) => t.id === id)?.cliSession?.currentActivity ?? null;

  // Human label for a chat: the orchestrator, or the ticket's title (fallback to its id).
  const titleOf = (id: string): string =>
    id === BOARD_CONVERSATION_ID ? 'Orchestrator' : allTasks.find((t) => t.id === id)?.title ?? id;

  // Most-recent agent-output timestamp for a chat — the unread signal (no transcript load).
  const lastOutputAtOf = (id: string): string | undefined =>
    id === BOARD_CONVERSATION_ID
      ? boardSession?.lastOutputAt
      : allTasks.find((t) => t.id === id)?.cliSession?.lastOutputAt;

  // Live cards: tickets with a surfaced session OR opened manually from a board element
  // (FLUX-603), minus any the user has retired. A manually-opened ticket with no session
  // renders as an `idle` card (cardState(undefined) === 'idle').
  const activeTickets = allTasks.filter(
    (t) =>
      !dismissed.includes(t.id) &&
      ((t.cliSession && SURFACE_STATUSES.includes(t.cliSession.status)) || manuallyOpened.includes(t.id)),
  );

  // While a tab's window is OPEN, freeze its sort weight so opening a card never makes it
  // jump position. Without this, clicking a `finished`/`needs-input` card acks it, which
  // demotes its weight and slides it rightward "out from under you". We keep recording each
  // closed tab's live weight every render; an open tab reuses the weight it had just before
  // it was opened, and only re-sorts once it's minimized (sent away).
  const frozenWeightRef = useRef<Map<string, number>>(new Map());

  // Attention-first ordering: needs-input → error → working → finished → available → idle,
  // so the tabs that want you sit at the front. Ties keep a stable id order.
  const sortedTickets = useMemo(() => {
    const weight: Record<CardState, number> = {
      'needs-input': 0,
      error: 1,
      working: 2,
      finished: 3,
      available: 4,
      idle: 5,
    };
    const frozen = frozenWeightRef.current;
    const present = new Set(activeTickets.map((t) => t.id));
    for (const key of [...frozen.keys()]) if (!present.has(key)) frozen.delete(key);
    // Effective weight: closed tabs use their live weight (and keep it recorded); an open tab
    // reuses the weight it carried just before opening, so it holds its spot until minimized.
    const eff = new Map<string, number>();
    for (const t of activeTickets) {
      const live = weight[cardState(t.cliSession?.status, acked.includes(t.id), t.status === 'Require Input')];
      if (open.includes(t.id)) {
        eff.set(t.id, frozen.has(t.id) ? (frozen.get(t.id) as number) : live);
      } else {
        frozen.set(t.id, live);
        eff.set(t.id, live);
      }
    }
    return [...activeTickets].sort((a, b) => {
      const wa = eff.get(a.id) as number;
      const wb = eff.get(b.id) as number;
      return wa !== wb ? wa - wb : a.id.localeCompare(b.id);
    });
  }, [activeTickets, acked, open]);

  // Adaptive tab sizing (FLUX-603): give each ticket tab a slice of a horizontal budget so
  // the taskbar stays one row. With room, a tab shows `ID + title`; as tabs multiply the
  // title shrinks then drops (id only), and at the extreme the id collapses to its number.
  const tabCount = activeTickets.length;
  const stripBudget = Math.min(viewportW * 0.82, 1200) - 150; // less the orchestrator + history + gaps
  const perTab = tabCount > 0 ? stripBudget / tabCount : stripBudget;
  const labelRoom = Math.max(0, perTab - TAB_CHROME);
  let titleWidth = labelRoom >= 100 ? Math.min(Math.round(labelRoom - 60), 220) : 0;
  if (titleWidth < 40) titleWidth = 0; // too tight to be worth a truncated sliver
  const compactId = labelRoom < 44; // extremely crowded → show just the trailing number

  // History: explicitly-retired chats (most recent first) plus any cancelled sessions.
  const cancelledIds = allTasks.filter((t) => t.cliSession?.status === 'cancelled').map((t) => t.id);
  const historyIds = dedupe([...dismissed, ...cancelledIds]).slice(0, HISTORY_CAP);

  // Keep the "seen" marks current: an open chat is read up to its latest output; a chat we've
  // never recorded baselines as read (so it doesn't flash unread the first time it appears).
  useEffect(() => {
    const seen = seenRef.current;
    for (const id of open) seen[id] = lastOutputAtOf(id) ?? '';
    for (const t of activeTickets) if (seen[t.id] === undefined) seen[t.id] = t.cliSession?.lastOutputAt ?? '';
    if (boardSession && seen[BOARD_CONVERSATION_ID] === undefined) seen[BOARD_CONVERSATION_ID] = boardSession.lastOutputAt ?? '';
  });

  const unreadOf = (id: string): boolean => {
    const lo = lastOutputAtOf(id);
    const seen = seenRef.current[id];
    return !open.includes(id) && !!lo && seen !== undefined && lo > seen;
  };

  async function stopSession(id: string) {
    try {
      await stopTaskCliSession(id);
    } catch {
      /* session may already be done */
    }
  }

  // Reset a conversation (the orchestrator's analog of "close"): stop any live turn, then wipe
  // its transcript. The engine broadcasts `taskUpdated`, so an open window refetches to empty.
  async function resetSession(id: string) {
    try {
      await stopTaskCliSession(id);
    } catch {
      /* no live session to stop */
    }
    try {
      await clearTaskTranscript(id);
    } catch {
      /* surfaced in-window via useChatSession.reset; here it's best-effort */
    }
  }

  // Reopen from History also closes the popover (window/open state is owned by the provider).
  function handleReopen(id: string, from?: HTMLElement | null) {
    reopenFromHistory(id, from);
    setShowHistory(false);
  }

  return (
    <>
      {open.map((id) => (
        <ChatWindow
          key={id}
          id={id}
          orchestrator={id === BOARD_CONVERSATION_ID}
          task={allTasks.find((t) => t.id === id)}
          anchorX={anchors[id]}
          working={statusOf.get(id) === 'running'}
          activity={activityOf(id)}
          draft={drafts[id] ?? ''}
          onDraftChange={(t) => setDraft(id, t)}
          onMinimize={() => toggle(id)}
          onClose={id === BOARD_CONVERSATION_ID ? undefined : () => closeCard(id)}
        />
      ))}

      {/* Flat, Windows-taskbar-style strip: the orchestrator pinned "home", then one tab per
          chat. Each tab carries a fuller label (id + title) that shrinks as tabs multiply
          (titleWidth / compactId). The inner row uses py/-my so the absolute `!`/`x` aren't
          clipped under overflow-x-auto. */}
      <div className="eh-border eh-surface-overlay fixed bottom-3 left-1/2 z-40 flex max-w-[94vw] -translate-x-1/2 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 shadow-xl">
        {/* Orchestrator — pinned "home". Not retirable. */}
        <ChatTab
          id={BOARD_CONVERSATION_ID}
          label="Board"
          orchestrator
          open={open.includes(BOARD_CONVERSATION_ID)}
          state={cardState(boardSession?.status, acked.includes(BOARD_CONVERSATION_ID))}
          activity={boardSession?.currentActivity ?? null}
          onOpen={(el) => toggle(BOARD_CONVERSATION_ID, el)}
          onContextMenu={(e) => setMenu({ id: BOARD_CONVERSATION_ID, x: e.clientX, y: e.clientY })}
        />

        {activeTickets.length > 0 && (
          <div className="h-7 w-px bg-[var(--eh-border)]" aria-hidden="true" />
        )}

        <div ref={stripRef} className="flex items-center gap-1.5 overflow-x-auto px-1.5 py-2 -mx-1.5 -my-2">
          {sortedTickets.map((t) => (
            <ChatTab
              key={t.id}
              id={t.id}
              title={t.title}
              orchestrator={false}
              open={open.includes(t.id)}
              state={cardState(t.cliSession?.status, acked.includes(t.id), t.status === 'Require Input')}
              statusTint={getStatusTint(config, t.status)}
              activity={t.cliSession?.currentActivity ?? null}
              unread={unreadOf(t.id)}
              titleWidth={titleWidth}
              compactId={compactId}
              onOpen={(el) => toggle(t.id, el)}
              onClose={() => closeCard(t.id)}
              onContextMenu={(e) => setMenu({ id: t.id, x: e.clientX, y: e.clientY })}
            />
          ))}
        </div>

        {/* History — always available (so it's discoverable even before anything is closed). */}
        <div className="relative ml-1">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-label="Recent chats"
            aria-expanded={showHistory}
            title="Recent chats"
            className="eh-border flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border bg-[var(--eh-input-bg)] text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
          >
            <History className="h-4 w-4" />
          </button>
          {showHistory && (
            <div className="eh-border eh-surface absolute bottom-full right-0 mb-2 max-h-64 w-60 overflow-y-auto rounded-xl border p-1 shadow-2xl">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
                Recent chats
              </div>
              {historyIds.length === 0 ? (
                <div className="px-2 py-2 text-xs text-gray-400">No recent chats</div>
              ) : (
                historyIds.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={(e) => handleReopen(id, e.currentTarget)}
                    title={titleOf(id)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-white/10"
                  >
                    <History className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                        {titleOf(id)}
                      </span>
                      {id !== BOARD_CONVERSATION_ID && (
                        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
                          {id}
                        </span>
                      )}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {menu && (
        <DockContextMenu
          menu={menu}
          title={titleOf(menu.id)}
          isOpen={open.includes(menu.id)}
          isWorking={statusOf.get(menu.id) === 'running'}
          canClose={menu.id !== BOARD_CONVERSATION_ID}
          canReset={menu.id === BOARD_CONVERSATION_ID}
          onToggle={() => {
            toggle(menu.id);
            setMenu(null);
          }}
          onStop={() => {
            void stopSession(menu.id);
            setMenu(null);
          }}
          onReset={() => {
            if (window.confirm('Reset the orchestrator conversation? This clears its chat history.')) {
              void resetSession(menu.id);
            }
            setMenu(null);
          }}
          onCloseCard={() => {
            closeCard(menu.id);
            setMenu(null);
          }}
          dismiss={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Tiny, unobtrusive "thinking" indicator — three softly pulsing dots that show an agent is
 *  ticking away without stealing the tab's label. Inherits the tab's text color (`bg-current`)
 *  so it reads on both the blue orchestrator tab and the light/dark ticket tabs. */
function ThinkingDots() {
  return (
    <span className="flex flex-shrink-0 items-center gap-[3px] pl-0.5" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="eh-thinking-dot h-1 w-1 rounded-full bg-current"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

function ChatTab({
  id,
  label,
  title,
  orchestrator,
  open,
  state,
  statusTint,
  activity,
  unread = false,
  titleWidth = 0,
  compactId = false,
  onOpen,
  onClose,
  onContextMenu,
}: {
  id: string;
  /** Orchestrator label ("Board"). */
  label?: string;
  /** Ticket title — shown after the id when there's room. */
  title?: string;
  orchestrator: boolean;
  open: boolean;
  state: CardState;
  /** FLUX-648: ticket board-status tint for the tab surface (ticket tabs only). The live
   *  session-state dot/glow/badge stay layered on top as the fast-changing overlay. */
  statusTint?: { rgb: string };
  /** Live activity ("Editing…") — shown in place of the title while working. */
  activity?: string | null;
  /** Agent produced output this chat hasn't shown the user yet (closed tabs only). */
  unread?: boolean;
  /** Px of room for the title (0 = hide it, id only). */
  titleWidth?: number;
  /** When extremely crowded, collapse the id to just its trailing number. */
  compactId?: boolean;
  onOpen: (el: HTMLElement) => void;
  onClose?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { short } = splitId(id);
  const copy = STATE_COPY[state];
  const badgeTone = BADGE_TONE[state];
  const working = state === 'working';
  const fullLabel = orchestrator ? 'Orchestrator' : title ? `${id} — ${title}` : id;

  // Horizontal "chrome tab" — short, flat, label-bearing (vs the old square card).
  const base =
    'group relative flex h-9 flex-shrink-0 items-center gap-1.5 rounded-lg border pl-2 pr-2.5 text-left shadow-sm transition-all duration-150 ';
  // FLUX-648: ticket tabs are tinted by their board status (the slow-changing axis) via an
  // inline rgba fill/border built from the same status palette the board uses. The live
  // session-state dot/glow/badge stay layered on top as the fast-changing overlay. Open tabs
  // get a stronger wash so the focused chat still reads as "selected".
  const ticketTintStyle: React.CSSProperties | undefined =
    !orchestrator && statusTint
      ? {
          backgroundColor: `rgba(${statusTint.rgb}, ${open ? 0.3 : 0.16})`,
          borderColor: `rgba(${statusTint.rgb}, ${open ? 0.65 : 0.4})`,
        }
      : undefined;
  // Orchestrator gets a richer, gradient "home" treatment (indigo→blue→violet) with an inset
  // highlight ring so it reads as the distinct, pinned anchor of the bar rather than a flat
  // blue box. Open = brighter + stronger ring + lift; closed = slightly muted, brightens on hover.
  const surface = orchestrator
    ? open
      ? 'border-transparent bg-gradient-to-br from-indigo-500 via-blue-500 to-violet-500 text-white shadow-md shadow-blue-900/25 ring-1 ring-inset ring-white/30 '
      : 'border-transparent bg-gradient-to-br from-indigo-500/90 via-blue-500/90 to-violet-500/90 text-white ring-1 ring-inset ring-white/15 hover:from-indigo-500 hover:via-blue-500 hover:to-violet-500 hover:ring-white/25 hover:shadow-md hover:shadow-blue-900/20 '
    : ticketTintStyle
      ? // Tinted ticket tab: color comes from `ticketTintStyle`; keep only text + hover lift here.
        open
        ? 'text-gray-900 dark:text-white '
        : 'text-gray-700 hover:brightness-110 hover:shadow dark:text-gray-200 '
      : open
        ? 'border-gray-300 bg-gray-100 text-gray-900 dark:border-white/20 dark:bg-white/15 dark:text-white '
        : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10 ';

  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      style={ticketTintStyle}
      aria-label={`${fullLabel} — ${copy}`}
      title={working && activity ? `${fullLabel} — ${activity}` : `${fullLabel} — ${copy}`}
      className={base + surface + STATE_ANIM[state]}
    >
      {/* Leading: the orchestrator keeps its spark (warm-tinted with a soft glow so it pops on
          the gradient); a ticket gets a colored state dot. */}
      {orchestrator ? (
        <Sparkles className="h-4 w-4 flex-shrink-0 text-amber-200 drop-shadow-[0_0_4px_rgba(253,230,138,0.55)]" />
      ) : (
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden="true" />
      )}

      {/* Label: id (full, or just the number when crowded) + the real title. We no longer
          swap the label out for the live activity text while working — that buried the useful
          info. Instead a tiny thinking bubble (below) shows progress is ticking, and the
          current activity stays available on hover (tooltip). */}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="flex-shrink-0 text-xs font-semibold leading-none tracking-tight">
          {orchestrator ? label : compactId ? short : id}
        </span>
        {!orchestrator && titleWidth > 0 && title && (
          <span className="truncate text-[11px] leading-none opacity-70" style={{ maxWidth: titleWidth }}>
            {title}
          </span>
        )}
        {working && <ThinkingDots />}
      </span>

      {/* Windows-style indicator bar: a full underline when this window is open (focused), a
          short running pill while it works in the background. On the orchestrator's colored
          gradient a white bar reads cleanly; tickets use the accent / blue. */}
      {(open || working) && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute bottom-0 left-1/2 h-[2px] -translate-x-1/2 rounded-full transition-all ${
            open ? 'w-3/4' : 'w-3'
          } ${orchestrator ? (open ? 'bg-white/90' : 'bg-white/70') : open ? 'bg-primary' : 'bg-blue-500'}`}
        />
      )}

      {/* Unread dot — agent said something you haven't opened (only when no `!` badge). */}
      {unread && !badgeTone && (
        <span
          aria-hidden="true"
          className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-[var(--eh-surface)]"
        />
      )}

      {/* Attention `!` badge — distinct tone per state (top-left, out of the x's way). */}
      {badgeTone && (
        <span
          aria-hidden="true"
          className={`absolute -left-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold leading-none shadow ${badgeTone}`}
        >
          !
        </span>
      )}

      {/* Hover-only close (`x`) — retires the tab into History. Orchestrator is permanent. */}
      {onClose && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={`Close ${id}`}
          title={`Close ${id}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-white opacity-0 shadow transition-opacity group-hover:opacity-100 hover:bg-gray-900 dark:bg-white/30 dark:hover:bg-white/50"
        >
          <X className="h-2.5 w-2.5" />
        </span>
      )}
    </button>
  );
}

/** Cursor-anchored right-click menu for a dock tab. One open at a time (owned by ChatDock). */
function DockContextMenu({
  menu,
  title,
  isOpen,
  isWorking,
  canClose,
  canReset,
  onToggle,
  onStop,
  onReset,
  onCloseCard,
  dismiss,
}: {
  menu: { id: string; x: number; y: number };
  title: string;
  isOpen: boolean;
  isWorking: boolean;
  canClose: boolean;
  canReset: boolean;
  onToggle: () => void;
  onStop: () => void;
  onReset: () => void;
  onCloseCard: () => void;
  dismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [dismiss]);

  // Clamp into the viewport (menu is roughly 196×148).
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.min(menu.x, vw - 196);
  const top = Math.min(menu.y, vh - 148);
  const item =
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--eh-text-secondary)] transition-colors hover:bg-black/5 dark:hover:bg-white/5';

  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="eh-border eh-surface fixed z-[60] min-w-[180px] rounded-lg border p-1 shadow-2xl"
    >
      <div className="truncate px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
        {title}
      </div>
      <button type="button" onClick={onToggle} className={item}>
        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" /> {isOpen ? 'Minimize' : 'Open chat'}
      </button>
      {isWorking && (
        <button type="button" onClick={onStop} className={`${item} text-red-500`}>
          <Square className="h-3.5 w-3.5 flex-shrink-0 fill-current" /> Stop session
        </button>
      )}
      {canReset && (
        <button type="button" onClick={onReset} className={item}>
          <RotateCcw className="h-3.5 w-3.5 flex-shrink-0" /> Reset conversation
        </button>
      )}
      {canClose && (
        <button type="button" onClick={onCloseCard} className={item}>
          <X className="h-3.5 w-3.5 flex-shrink-0" /> Close
        </button>
      )}
    </div>
  );
}

const CHAT_WINDOW_WIDTH = 480;
const CHAT_WINDOW_HEIGHT = 520;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 280;

/**
 * FLUX-620: read-only ticket context strip under the dock chat window's title bar — id,
 * status pill, priority, and branch / worktree / PR info. Branch state is lazily fetched
 * only when the ticket has a branch. Ticket windows only (the orchestrator has no task).
 */
function ChatContextStrip({ task }: { task: Task }) {
  const [branch, setBranch] = useState<BranchStatus | null>(null);

  useEffect(() => {
    if (!task.branch) {
      setBranch(null);
      return;
    }
    let cancelled = false;
    fetchBranchStatus(task.id)
      .then((b) => {
        if (!cancelled) setBranch(b);
      })
      .catch(() => {
        /* transient — keep the stored branch name */
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.branch]);

  const prUrl = task.implementationLink && /\/pull\//.test(task.implementationLink) ? task.implementationLink : null;
  const branchName = branch?.name ?? task.branch ?? null;
  const ahead = branch?.aheadCount ?? 0;
  const behind = branch?.behindCount ?? 0;
  const worktree = branch?.worktree ?? null;

  return (
    <div className="eh-border-subtle flex items-center gap-2 overflow-x-auto border-b px-3.5 py-1.5 text-[11px]">
      <span className="flex-shrink-0 font-mono text-[var(--eh-text-muted)]">{task.id}</span>
      <StatusBadge status={task.status} className="flex-shrink-0 text-[10px]" />
      {task.priority && task.priority !== 'None' && (
        <span className="flex-shrink-0 text-[var(--eh-text-muted)]">{task.priority}</span>
      )}

      {branchName && (
        <span
          className="flex min-w-0 flex-shrink-0 items-center gap-1 text-[var(--eh-text-secondary)]"
          title={branchName}
        >
          <GitBranch className="h-3 w-3 flex-shrink-0" />
          <span className="max-w-[150px] truncate font-mono">{branchName}</span>
          {(ahead > 0 || behind > 0) && (
            <span
              className="flex-shrink-0 text-[var(--eh-text-muted)]"
              title={`${ahead} ahead, ${behind} behind master`}
            >
              {[ahead > 0 ? `↑${ahead}` : null, behind > 0 ? `↓${behind}` : null].filter(Boolean).join(' ')}
            </span>
          )}
        </span>
      )}

      {worktree && (
        <span className="flex flex-shrink-0 items-center gap-1 text-[var(--eh-text-muted)]" title={worktree}>
          <FolderGit2 className="h-3 w-3 flex-shrink-0" /> worktree
        </span>
      )}

      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          onPointerDown={(e) => e.stopPropagation()}
          className="ml-auto flex flex-shrink-0 items-center gap-1 font-semibold text-primary hover:underline"
        >
          <GitPullRequest className="h-3 w-3 flex-shrink-0" /> PR
        </a>
      )}
    </div>
  );
}

// Canned prompt fired by the Board-chat "Triage" quick action (FLUX-637). One board-agnostic
// message: ask the orchestrator (which already sees the whole board) to prioritize the Todo
// column. In Progress / Ready are allowed only as context so it won't recommend in-flight work.
const TRIAGE_PROMPT =
  "Triage the board's **Todo** column for me. Review every ticket currently in Todo and give a ranked, actionable prioritization:\n\n" +
  '1. Rank the Todo tickets by value-per-effort and stated priority — lead with what to pick up next and say why.\n' +
  '2. Group tickets into dependency clusters (what unblocks what); flag anything blocked by unfinished work.\n' +
  '3. Call out quick wins (low effort, clear value) separately.\n' +
  '4. Reference each ticket by its ID (link it where natural).\n\n' +
  'Stay focused on Todo. You may briefly note items already In Progress or Ready as context only, so you ' +
  "don't recommend something already in flight. Keep it concise and skimmable.";

/**
 * Board-chat-only quick action (FLUX-637): one tap seeds the orchestrator with the canned
 * triage prompt and fires it immediately, returning a ranked/clustered prioritization of the
 * Todo column. Disabled while a turn is in flight so it can't double-send mid-turn. Styled to
 * match `TicketActionBar`'s default (engine-tone) button so the two action slots feel uniform.
 */
function TriageAction({ busy, onTriage }: { busy: boolean; onTriage: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onTriage}
        disabled={busy}
        title="Prioritize the Todo column — ranks tickets by value, clusters dependencies, flags quick wins"
        className="eh-border inline-flex items-center gap-1 rounded-md border bg-[var(--eh-input-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--eh-text-primary)] transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/5"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListChecks className="h-3 w-3" />}
        Triage
      </button>
    </div>
  );
}

function ChatWindow({
  id,
  orchestrator,
  task,
  anchorX,
  working,
  activity,
  draft,
  onDraftChange,
  onMinimize,
  onClose,
}: {
  id: string;
  orchestrator: boolean;
  /** The ticket this window is bound to (absent for the orchestrator → no action bar). */
  task?: Task;
  anchorX?: number;
  working: boolean;
  activity: string | null;
  /** FLUX-623: persisted unsent composer text for this conversation (survives minimize). */
  draft: string;
  onDraftChange: (text: string) => void;
  onMinimize: () => void;
  /** Retire the card into History and close the window. Absent for the pinned orchestrator. */
  onClose?: () => void;
}) {
  const chat = useChatSession(id, true);
  const allTasks = useAppSelector((s) => s.tasks) as Task[];
  const config = useAppSelector((s) => s.config);
  const requireInputStatus = getRequireInputStatus(config);
  // FLUX-642/643: empty-chat context + Require-Input quick replies, built from data we already
  // hold and handed to the transport-free ChatView.
  const contextCard = orchestrator ? (
    <BoardSnapshotCard tasks={allTasks} requireInputStatus={requireInputStatus} />
  ) : task ? (
    <TicketContextCard task={task} />
  ) : undefined;
  const quickReplies = useMemo(
    () => (task ? parseQuickReplies(task, requireInputStatus) : []),
    [task, requireInputStatus],
  );
  const windowRef = useRef<HTMLDivElement>(null);
  // User-resizable footprint. The window is pinned bottom-left (see `bottom`/`left`), so
  // the grip lives at the top-right corner and grows the window up + right.
  const [size, setSize] = useState({ w: CHAT_WINDOW_WIDTH, h: CHAT_WINDOW_HEIGHT });
  // Dragged position as a `{left, bottom}` pair (FLUX-603) — bottom-pinned like the spawn
  // default, so the existing top-right resize math is unchanged. `null` until first drag,
  // when it falls back to the anchored spawn position below.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  // Spawn the window "out of" the clicked card: center it on the click x, clamped to the
  // viewport. No recorded anchor (e.g. unusual reopen) falls back to screen-center.
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const center = anchorX ?? viewportW / 2;
  const anchoredLeft = Math.max(8, Math.min(center - size.w / 2, viewportW - size.w - 8));
  const left = pos ? pos.left : anchoredLeft;
  const bottom = pos ? pos.bottom : 84;

  // Drag the title bar to move the window. Tracked as `{left, bottom}` (bottom-pinned) so it
  // composes with the bottom-pinned resize. Clamped to keep the window on screen.
  function startDrag(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = windowRef.current?.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const baseLeft = rect?.left ?? left;
    const baseBottom = (typeof window !== 'undefined' ? window.innerHeight : 800) - (rect?.bottom ?? 0);
    const onMove = (ev: PointerEvent) => {
      const maxLeft = (typeof window !== 'undefined' ? window.innerWidth : 1280) - size.w - 8;
      const maxBottom = (typeof window !== 'undefined' ? window.innerHeight : 800) - size.h - 8;
      const nLeft = Math.max(8, Math.min(baseLeft + (ev.clientX - startX), maxLeft));
      const nBottom = Math.max(8, Math.min(baseBottom - (ev.clientY - startY), maxBottom));
      setPos({ left: nLeft, bottom: nBottom });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // Drag the top-right grip to resize. Bottom edge stays pinned, so dragging up grows
  // height and dragging right grows width — both axes track the cursor.
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;
    const maxW = (typeof window !== 'undefined' ? window.innerWidth : 1280) - 16;
    const maxH = (typeof window !== 'undefined' ? window.innerHeight : 800) - 100;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(MIN_WINDOW_WIDTH, Math.min(startW + (ev.clientX - startX), maxW));
      const h = Math.max(MIN_WINDOW_HEIGHT, Math.min(startH - (ev.clientY - startY), maxH));
      setSize({ w, h });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      ref={windowRef}
      className="eh-surface eh-border fixed z-50 flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
      style={{ bottom, left, width: size.w, height: size.h }}
    >
      {/* Resize grip — top-right corner; subtle bracket, grabs to grow up + right. */}
      <div
        onPointerDown={startResize}
        title="Drag to resize"
        className="group/resize absolute right-0 top-0 z-10 flex h-5 w-5 cursor-nesw-resize items-start justify-end p-1"
      >
        <span className="h-2.5 w-2.5 rounded-tr border-r-2 border-t-2 border-[var(--eh-text-muted)] opacity-40 transition-opacity group-hover/resize:opacity-90" />
      </div>

      <div
        onPointerDown={startDrag}
        className="eh-border-subtle flex cursor-move select-none items-center justify-between border-b px-3.5 py-2.5 pr-9"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-[var(--eh-text-primary)]">
          {orchestrator ? (
            <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-[var(--eh-text-muted)]" />
          )}
          <span className="truncate">{orchestrator ? 'Orchestrator' : task?.title ?? id}</span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {/* Orchestrator can't be closed (it's pinned) — instead it can be reset to a clean
              slate: stop the live turn and wipe the transcript. */}
          {orchestrator && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (window.confirm('Reset the orchestrator conversation? This clears its chat history.')) {
                  void chat.reset();
                }
              }}
              title="Reset conversation (clears history)"
              className="rounded-md p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onMinimize}
            title="Minimize"
            className="rounded-md p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          {onClose && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
              title="Close (move to recent chats)"
              className="rounded-md p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500 dark:hover:bg-red-500/15"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {task && <ChatContextStrip task={task} />}
      {task && <ChatDiffPanel task={task} />}
      <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
        <ChatView
          title={orchestrator ? 'Board chat' : id}
          fill
          messages={chat.messages}
          busy={chat.busy}
          error={chat.error}
          working={working}
          activity={activity}
          emptyHint={orchestrator ? 'Talk to the board. I can see and dispatch work to tickets.' : `Chat about ${id}.`}
          contextCard={contextCard}
          quickReplies={quickReplies}
          linkifyTickets
          draft={draft}
          onDraftChange={onDraftChange}
          onSend={chat.send}
          onStop={chat.stop}
          questionPicker={<ChatQuestionPicker conversationId={id} />}
          actions={
            orchestrator ? (
              <TriageAction busy={chat.busy || working} onTriage={() => void chat.send(TRIAGE_PROMPT)} />
            ) : task ? (
              <TicketActionBar task={task} />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

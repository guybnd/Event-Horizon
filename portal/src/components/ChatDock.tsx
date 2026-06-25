import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sparkles, MessageSquare, Minus, X, History, Square, RotateCcw, GitBranch, FolderGit2, GitPullRequest, ListChecks, Loader2, MessageCircleQuestion, PanelRight, PanelRightClose, Maximize2, Tag, Link2, Gauge, Save, ChevronDown, Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { useChatSession } from '../hooks/useChatSession';
import { ChatView } from './task-modal/ChatView';
import { ChatDiffPanel } from './task-modal/ChatDiffPanel';
import { TicketSideView } from './task-modal/TicketSideView';
import { getPriorityIcon } from './task-modal/taskModalHelpers';
import { TicketContextCard, BoardSnapshotCard, SessionMeter } from './task-modal/chatContext';
import { parseQuickReplies } from './task-modal/chatQuickReplies';
import { ChatRequireInputBanner } from './task-modal/ChatRequireInputBanner';
import { TagSelector } from './TagSelector';
import { TicketActions } from './ticket-actions/TicketActions';
import { ChatPendingInteractions, PendingInteractionFallback, usePendingInteractions } from './pendingInteractions';
import { useDock, MIN_SIDEVIEW_WIDTH, MAX_SIDEVIEW_WIDTH, DEFAULT_SIDEVIEW_WIDTH, type ComposerSelections } from './DockProvider';
import { useTicketSideView } from '../hooks/useTicketSideView';
import { fireDesktopNotification } from '../hooks/useDesktopNotifications';
import { getStatusTint, getStatusColorClass } from '../statusStyles';
import { getRequireInputStatus } from '../workflow';
import { BOARD_CONVERSATION_ID, fetchTaskCliSession, fetchTaskTranscript, stopTaskCliSession, clearTaskTranscript, fetchBranchStatus, type BranchStatus } from '../api';
import { setTranscript } from '../transcriptCache';
import type { CliSessionStatus, CliSessionSummary, Config, Task } from '../types';

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
  // FLUX-720: conversations with an unresolved pending interaction (approval / question /
  // board-rebase). Drives the hard-gated tab: a chat awaiting your answer is force-pinned with a
  // distinct prompt icon and can't be closed/removed until it's resolved.
  const { pendingPromptConversationIds } = usePendingInteractions();
  // Window/open state lives in the app-root DockProvider (FLUX-603) so a card can drive it
  // and it survives view switches. `anchors` records where each window should spawn from.
  const { open, acked, dismissed, manuallyOpened, anchors, drafts, selections, order, sideviewOpen, sideviewWidth, toggle, closeCard, reopenFromHistory, setDraft, setSelections, reorder, promoteToFront, toggleSideView, setSideviewWidth, seedSideviewWidth, openTicket } = useDock();

  // FLUX-744: open-ticket bridge. `openTask` (AppContext, which lives ABOVE the DockProvider) can't
  // call dock actions directly, so for the default 'chat' open mode it dispatches a `flux:open-ticket`
  // window event; here — inside the dock — we open the chat window + sideview for that ticket. This is
  // what makes "open a ticket from any surface" (cards already call openTicket directly; notifications,
  // active-sessions, markdown links, search, etc. all flow through openTask) land in the chat view.
  useEffect(() => {
    const onOpenTicket = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (id) openTicket(id);
    };
    window.addEventListener('flux:open-ticket', onOpenTicket);
    return () => window.removeEventListener('flux:open-ticket', onOpenTicket);
  }, [openTicket]);
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

  // FLUX-695: desktop notification on the busy→idle edge for an *unattended* chat. We diff each
  // chat's session status against the previous render; a `running` → `completed`/`waiting-input`
  // transition is a finished turn. A chat is "attended" only when its window is open AND the
  // document is visible AND focused — otherwise (tabbed away, window minimized/closed) we fire an
  // OS notification. The fire is itself gated on the user setting + permission inside the hook.
  const prevStatusRef = useRef<Map<string, CliSessionStatus | undefined>>(new Map());
  useEffect(() => {
    const prev = prevStatusRef.current;
    const isFinish = (s: CliSessionStatus | undefined) => s === 'completed' || s === 'waiting-input';
    for (const [id, status] of statusOf) {
      if (prev.get(id) === 'running' && isFinish(status)) {
        const attended =
          open.includes(id) &&
          typeof document !== 'undefined' &&
          document.visibilityState === 'visible' &&
          document.hasFocus();
        if (!attended) {
          fireDesktopNotification({
            title: `${titleOf(id)} — turn complete`,
            body: status === 'waiting-input' ? 'The agent is waiting for your input.' : 'The agent finished its turn.',
            tag: `eh-turn-${id}`,
          });
        }
      }
    }
    prevStatusRef.current = new Map(statusOf);
  }, [statusOf, open]);

  // FLUX-750: keep the running-but-minimized conversation's transcript warm in the cache, so
  // reopening a *live* session shows current committed state immediately (no stale-then-jump). The
  // window's own `useChatSession` is destroyed on minimize, so without this the cache would freeze
  // at the last state seen while the window was open and the reopen would pop forward on the first
  // post-mount fetch. ChatDock is always mounted and already knows per-id running status (statusOf)
  // and which windows are open, so it refetches the durable transcript on that id's events and
  // writes it through. Bounded by design: only `running` conversations whose window is NOT mounted
  // are kept warm — a mounted window owns its own fetch (no double-fetch), idle chats cost nothing,
  // and usually at most one session runs at a time. No DOM, no per-idle-chat subscription.
  const warmIds = useMemo(() => {
    const ids: string[] = [];
    for (const [id, status] of statusOf) {
      if (status === 'running' && !open.includes(id)) ids.push(id);
    }
    return ids;
  }, [statusOf, open]);
  // Stable key so the effect re-runs only when the warm *set* changes — not on every statusOf
  // recompute (which churns on each board event). The handler reads the live set via the ref.
  const warmKey = warmIds.join('|');
  const warmIdsRef = useRef<string[]>(warmIds);
  warmIdsRef.current = warmIds;
  useEffect(() => {
    const ids = warmIdsRef.current;
    if (ids.length === 0) return;
    let cancelled = false;
    const warmOne = async (id: string) => {
      try {
        const msgs = await fetchTaskTranscript(id);
        if (!cancelled) setTranscript(id, msgs);
      } catch {
        /* transient — keep last good */
      }
    };
    // Prime once so a chat minimized while already running is warm before its next event arrives.
    for (const id of ids) void warmOne(id);
    const matchId = (d: unknown): string | null => {
      const o = d as { taskId?: string; id?: string } | null;
      const ev = o?.taskId ?? o?.id;
      return ev && warmIdsRef.current.includes(ev) ? ev : null;
    };
    const on = (d: unknown) => { const id = matchId(d); if (id) void warmOne(id); };
    const unsubs = [
      subscribeToEvent('activity', on),
      subscribeToEvent('progress', on),
      subscribeToEvent('taskUpdated', on),
    ];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
    // `warmKey` captures the warm-set identity; `warmIdsRef` supplies the live list inside.
  }, [warmKey, subscribeToEvent]);

  // Live cards: tickets with a surfaced session OR opened manually from a board element
  // (FLUX-603), minus any the user has retired. A manually-opened ticket with no session
  // renders as an `idle` card (cardState(undefined) === 'idle').
  // FLUX-720: a ticket with an unresolved pending prompt is *always* surfaced and overrides a
  // prior dismissal — its tab must stay pinned (and un-closable) until the prompt is resolved.
  // FLUX-728: memoized so its array identity is stable across renders. A bare `.filter()` produced
  // a new array every render, which fired the promote-left layout effect (its deps include this
  // list) on every render and defeated the downstream `orderedTickets`/`orderedIds` memos that key
  // off it. The deps cover every input the predicate reads, so it still recomputes whenever the
  // ticket list / dismissals / manual-opens / pending prompts actually change. Behavior is
  // identical — only identity stability changes.
  const activeTickets = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          pendingPromptConversationIds.has(t.id) ||
          (!dismissed.includes(t.id) &&
            ((t.cliSession && SURFACE_STATUSES.includes(t.cliSession.status)) || manuallyOpened.includes(t.id))),
      ),
    [allTasks, pendingPromptConversationIds, dismissed, manuallyOpened],
  );

  // FLUX-727: manual, drag-imposed tab order (replaces the old attention-weight sort + the
  // `frozenWeightRef` open-tab-jump hack). The persisted `order` is the source of truth; render
  // it filtered to the active tickets and append any active id not yet in `order` (a brand-new
  // tab on the render before the promotion effect runs) so nothing is ever dropped. Closing a
  // tab no longer reshuffles the rest — they hold position.
  const orderedTickets = useMemo(() => {
    const byId = new Map(activeTickets.map((t) => [t.id, t]));
    const activeIds = activeTickets.map((t) => t.id);
    const activeSet = new Set(activeIds);
    const known = order.filter((id) => activeSet.has(id));
    const knownSet = new Set(known);
    const appended = activeIds.filter((id) => !knownSet.has(id));
    return [...known, ...appended].map((id) => byId.get(id) as Task);
  }, [activeTickets, order]);
  const orderedIds = useMemo(() => orderedTickets.map((t) => t.id), [orderedTickets]);

  // FLUX-727: event-driven promote-left. Only two transitions move a tab to the front — a NEW tab
  // appearing, or a chat raising a prompt / entering needs-input. Every other change (turn
  // finishing, idle, ack/open, output arriving, close) leaves the order alone. We diff against
  // prev-render ref sets so it fires only on the true rising edges (guards the setState→re-render
  // loop the risks note flagged), and run it in a layout effect so a new tab is promoted to the
  // left BEFORE paint (no one-frame flash at the right). The first run only seeds the baseline —
  // existing tabs on mount are NOT promoted, so the persisted order is respected.
  const prevActiveRef = useRef<Set<string>>(new Set());
  const prevPromptRef = useRef<Set<string>>(new Set());
  const prevNeedsInputRef = useRef<Set<string>>(new Set());
  const didSeedPromoteRef = useRef(false);
  useLayoutEffect(() => {
    const nextActive = new Set<string>();
    const nextPrompt = new Set<string>();
    const nextNeeds = new Set<string>();
    const promote: string[] = [];
    for (const t of activeTickets) {
      nextActive.add(t.id);
      const hasPrompt = pendingPromptConversationIds.has(t.id);
      if (hasPrompt) nextPrompt.add(t.id);
      const needsInput =
        cardState(t.cliSession?.status, acked.includes(t.id), t.status === 'Require Input') === 'needs-input';
      if (needsInput) nextNeeds.add(t.id);
      if (didSeedPromoteRef.current) {
        const isNew = !prevActiveRef.current.has(t.id);
        const promptRose = hasPrompt && !prevPromptRef.current.has(t.id);
        const needsRose = needsInput && !prevNeedsInputRef.current.has(t.id);
        if (isNew || promptRose || needsRose) promote.push(t.id);
      }
    }
    prevActiveRef.current = nextActive;
    prevPromptRef.current = nextPrompt;
    prevNeedsInputRef.current = nextNeeds;
    didSeedPromoteRef.current = true;
    // Promote in reverse so the earliest-listed ends up leftmost when several rise at once.
    for (let i = promote.length - 1; i >= 0; i--) promoteToFront(promote[i]);
  }, [activeTickets, pendingPromptConversationIds, acked, promoteToFront]);

  // Drag-to-reorder (FLUX-727). PointerSensor with a 5px activation distance so a plain click
  // still opens the chat (and the hover-`x` / context menu still fire) — only a real drag reorders.
  // FLUX-728: a KeyboardSensor (with dnd-kit's standard sortable coordinate getter) makes the tab
  // strip keyboard-reorderable for a11y — focus a tab, Space/Enter to lift, arrows to move, Space to
  // drop. The tab is already focusable (it's a <button> spread with the sortable a11y attributes).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedIds.indexOf(active.id as string);
    const newIndex = orderedIds.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    reorder(arrayMove(orderedIds, oldIndex, newIndex));
  };

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
      {/* FLUX-720: no-orphans global fallback — pending prompts whose origin dock isn't open (or
          whose conversationId is null) surface here; deduped against the inline panels. */}
      <PendingInteractionFallback />

      {open.map((id) => (
        <ChatWindow
          key={id}
          id={id}
          orchestrator={id === BOARD_CONVERSATION_ID}
          task={allTasks.find((t) => t.id === id)}
          // FLUX-686: session totals back the quiet token meter — orchestrator from boardSession,
          // tickets from their own cliSession.
          session={id === BOARD_CONVERSATION_ID ? boardSession : allTasks.find((t) => t.id === id)?.cliSession ?? null}
          anchorX={anchors[id]}
          working={statusOf.get(id) === 'running'}
          activity={activityOf(id)}
          draft={drafts[id] ?? ''}
          onDraftChange={(t) => setDraft(id, t)}
          // FLUX-666: persist the composer's model/effort/permission chip selections across
          // minimize/reopen, the same per-id way the text draft is persisted.
          selections={selections[id]}
          onSelectionsChange={(s) => setSelections(id, s)}
          // FLUX-734: ticket sideview toggle (ticket windows only — the orchestrator has no task).
          sideViewOpen={sideviewOpen.includes(id)}
          onToggleSideView={() => toggleSideView(id)}
          // FLUX-740: live, persisted sideview width + setter for the chat↔panel resize divider.
          sideviewWidth={sideviewWidth}
          setSideviewWidth={setSideviewWidth}
          // FLUX-744: seed a proportional (~45%) width from the chat column when the panel opens.
          seedSideviewWidth={seedSideviewWidth}
          onMinimize={() => toggle(id)}
          // FLUX-720: the window's close (X) is hidden while a prompt is pending, mirroring the
          // tab gate — the chat can't be retired until you resolve it. Minimize stays available.
          onClose={
            id === BOARD_CONVERSATION_ID || pendingPromptConversationIds.has(id)
              ? undefined
              : () => closeCard(id)
          }
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
          pendingPrompt={pendingPromptConversationIds.has(BOARD_CONVERSATION_ID)}
          activity={boardSession?.currentActivity ?? null}
          onOpen={(el) => toggle(BOARD_CONVERSATION_ID, el)}
          onContextMenu={(e) => setMenu({ id: BOARD_CONVERSATION_ID, x: e.clientX, y: e.clientY })}
        />

        {activeTickets.length > 0 && (
          <div className="h-7 w-px bg-[var(--eh-border)]" aria-hidden="true" />
        )}

        {/* FLUX-727: drag-to-reorder strip. `autoScroll={false}` so dnd-kit's drag auto-scroll
            doesn't fight the wheel-scroll listener on this overflow-x container. The orchestrator
            (above) stays outside the SortableContext — pinned home, never draggable. */}
        <div ref={stripRef} className="flex items-center gap-1.5 overflow-x-auto px-1.5 py-2 -mx-1.5 -my-2">
          <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
            <SortableContext items={orderedIds} strategy={horizontalListSortingStrategy}>
              {orderedTickets.map((t) => {
                const pendingPrompt = pendingPromptConversationIds.has(t.id);
                return (
                  <SortableChatTab
                    key={t.id}
                    id={t.id}
                    title={t.title}
                    orchestrator={false}
                    open={open.includes(t.id)}
                    state={cardState(t.cliSession?.status, acked.includes(t.id), t.status === 'Require Input')}
                    pendingPrompt={pendingPrompt}
                    statusTint={getStatusTint(config, t.status)}
                    activity={t.cliSession?.currentActivity ?? null}
                    unread={unreadOf(t.id)}
                    titleWidth={titleWidth}
                    compactId={compactId}
                    onOpen={(el) => toggle(t.id, el)}
                    // FLUX-720: hard-gate close while a prompt is pending — the tab can't be retired
                    // until the user resolves it (minimize still works; resolve controls stay usable).
                    onClose={pendingPrompt ? undefined : () => closeCard(t.id)}
                    onContextMenu={(e) => setMenu({ id: t.id, x: e.clientX, y: e.clientY })}
                  />
                );
              })}
            </SortableContext>
          </DndContext>
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
          // FLUX-720: a chat with a pending prompt can't be closed from the menu either.
          canClose={menu.id !== BOARD_CONVERSATION_ID && !pendingPromptConversationIds.has(menu.id)}
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

/** FLUX-727: a ticket tab wired for drag-to-reorder. Wraps ChatTab with `useSortable` and hands it
 *  the sortable node ref, the live transform, and the drag listeners. Ticket tabs only — the
 *  orchestrator renders ChatTab directly (pinned home, never draggable, outside the SortableContext). */
function SortableChatTab(props: React.ComponentProps<typeof ChatTab>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.id });
  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <ChatTab {...props} dragRef={setNodeRef} dragStyle={dragStyle} dragHandleProps={{ ...attributes, ...listeners }} />
  );
}

function ChatTab({
  id,
  label,
  title,
  orchestrator,
  open,
  state,
  pendingPrompt = false,
  statusTint,
  activity,
  unread = false,
  titleWidth = 0,
  compactId = false,
  onOpen,
  onClose,
  onContextMenu,
  dragRef,
  dragStyle,
  dragHandleProps,
}: {
  id: string;
  /** Orchestrator label ("Board"). */
  label?: string;
  /** Ticket title — shown after the id when there's room. */
  title?: string;
  orchestrator: boolean;
  open: boolean;
  state: CardState;
  /** FLUX-720: this chat has an unresolved pending interaction (approval / question / rebase).
   *  Overlays a distinct prompt icon + pulse and outranks the live `state` for attention. */
  pendingPrompt?: boolean;
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
  /** FLUX-727: drag wiring from `useSortable` (ticket tabs only — supplied by SortableChatTab).
   *  `dragRef` is the sortable node ref, `dragStyle` carries the live transform/transition, and
   *  `dragHandleProps` are the pointer/keyboard drag listeners + a11y attributes spread on the tab. */
  dragRef?: (el: HTMLElement | null) => void;
  dragStyle?: React.CSSProperties;
  dragHandleProps?: Record<string, unknown>;
}) {
  const { short } = splitId(id);
  const copy = pendingPrompt ? 'needs your answer' : STATE_COPY[state];
  // A pending prompt overrides the `!` attention badge with its own prompt icon (below).
  const badgeTone = pendingPrompt ? undefined : BADGE_TONE[state];
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
      ref={dragRef}
      onClick={(e) => onOpen(e.currentTarget)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.(e);
      }}
      // FLUX-727: ticket-tint fill/border composed with the live drag transform (transform wins).
      style={{ ...ticketTintStyle, ...dragStyle }}
      aria-label={`${fullLabel} — ${copy}`}
      title={working && activity ? `${fullLabel} — ${activity}` : `${fullLabel} — ${copy}`}
      className={base + surface + (pendingPrompt ? 'eh-taskcard-needs-input ' : STATE_ANIM[state])}
      {...dragHandleProps}
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

      {/* FLUX-720: pending-prompt badge — a distinct "this chat needs your answer" prompt icon
          (+ pulse on the tab) that reads apart from the generic working/needs-input states and
          is used identically for all three prompt types. Sits where the `!` badge would, and
          takes precedence over it. */}
      {pendingPrompt && (
        <span
          aria-hidden="true"
          className="absolute -left-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-white shadow ring-2 ring-[var(--eh-surface)]"
        >
          <MessageCircleQuestion className="h-2.5 w-2.5" />
        </span>
      )}

      {/* Unread dot — agent said something you haven't opened (only when no `!`/prompt badge). */}
      {unread && !badgeTone && !pendingPrompt && (
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

// FLUX-727: the dock chat window spawns 2× wider / ~30% taller than the old 480×520 so a chat
// opens roomy instead of cramped. Seeded clamped to the viewport (see ChatWindow) for small screens.
const CHAT_WINDOW_WIDTH = 960;
const CHAT_WINDOW_HEIGHT = 676;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 280;

// FLUX-740: effort estimate + effort-level (override) option sets — mirror MetadataPanel so the bar
// and the legacy modal offer the same choices.
const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];
const EFFORT_LEVEL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Default effort level' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

/** FLUX-740: a compact inline `<select>` styled to sit in the metadata bar (no label chrome — the
 *  value reads as a pill). `onPointerDown` is stopped so opening it never starts a window drag. */
function BarSelect({
  value, onChange, options, title, className = '',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  title: string;
  className?: string;
}) {
  return (
    <select
      title={title}
      value={value}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      className={`flex-shrink-0 cursor-pointer rounded-md border px-1.5 py-0.5 text-[11px] font-medium outline-none transition-colors focus:border-primary ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

/** FLUX-744: a small colored dot for a status, using the board's per-status tint accent. Lets the
 *  status dropdown carry its board identity (native `<option>`s can't render color). */
function StatusDot({ config, status }: { config: Config | null | undefined; status: string }) {
  const tint = getStatusTint(config, status);
  return <span className={`h-2 w-2 flex-shrink-0 rounded-full ${tint.accent}`} aria-hidden />;
}

interface BarDropdownOption {
  value: string;
  label: string;
  /** Optional leading visual rendered before the label in each option row. */
  leading?: ReactNode;
}

/** FLUX-744: a compact custom dropdown for the metadata bar that CAN render a per-option icon/dot
 *  (unlike the native `<select>` of `BarSelect`, where `<option>`s are text-only). Reuses BarPopover's
 *  open/close contract — outside-click + Escape close it, and `onPointerDown` is stopped so opening it
 *  never starts a window drag — and adds listbox keyboard nav (↑/↓/Home/End move, Enter/click select).
 *
 *  The metadata bar has `overflow-x-auto`, which (per CSS) forces the cross axis to clip too — so the
 *  menu MUST escape it. We position it with measured `position: fixed` coordinates from the trigger
 *  rect (same approach as CardMenu) instead of `absolute`, so it overlays the chat window rather than
 *  getting trapped under the bar's fold. */
function BarDropdown({
  value, onChange, options, title, className = '', triggerLeading,
}: {
  value: string;
  onChange: (v: string) => void;
  options: BarDropdownOption[];
  title: string;
  className?: string;
  /** Optional leading visual for the trigger button (e.g. the selected priority icon / status dot). */
  triggerLeading?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  // Measure the trigger and open the fixed-positioned menu just below it.
  const toggleOpen = () => {
    if (open) { setOpen(false); return; }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setCoords({ left: r.left, top: r.bottom + 4 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Re-position on scroll/resize would be ideal, but the menu closes on any outside interaction,
    // so a fixed snapshot taken at open time is sufficient.
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Move focus to the selected (or first) option when the listbox opens, so arrow keys work at once.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]')
      ?? listRef.current?.querySelector<HTMLButtonElement>('[role="option"]');
    node?.focus();
  }, [open]);

  const choose = (v: string) => { onChange(v); setOpen(false); };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(items.length - 1, idx + 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, idx - 1)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  // Clamp the fixed menu into the viewport (the bar sits at the top of the window, so it opens down).
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const menuLeft = coords ? Math.max(8, Math.min(coords.left, vw - 220)) : 0;
  const menuTop = coords ? Math.max(8, Math.min(coords.top, vh - 280)) : 0;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        title={title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium outline-none transition-colors focus:border-primary ${className}`}
      >
        {triggerLeading}
        <span className="truncate">{selected?.label ?? value}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-60" />
      </button>
      {open && coords && (
        <div
          ref={listRef}
          role="listbox"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={onListKeyDown}
          style={{ left: menuLeft, top: menuTop }}
          className="eh-border eh-surface fixed z-[60] max-h-64 min-w-[140px] overflow-y-auto rounded-lg border p-1 shadow-2xl"
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active}
                onClick={() => choose(o.value)}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] outline-none transition-colors hover:bg-black/5 focus:bg-black/5 dark:hover:bg-white/5 dark:focus:bg-white/5 ${
                  active ? 'font-semibold text-[var(--eh-text-primary)]' : 'text-[var(--eh-text-secondary)]'
                }`}
              >
                {o.leading}
                <span className="truncate">{o.label}</span>
                {active && <Check className="ml-auto h-3 w-3 flex-shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** FLUX-740: a bar control that opens a small floating panel for fields that don't fit a one-line
 *  pill (tags / implementation link / effort level). Closes on outside-click or Escape. Opens
 *  downward (the bar sits at the top of the chat column).
 *  FLUX-744: positioned with measured `position: fixed` (not `absolute`) so it escapes the metadata
 *  bar's `overflow-x-auto` clip and overlays the chat window instead of getting trapped under the bar. */
function BarPopover({
  label, icon: Icon, active = false, title, children, align = 'left',
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  title: string;
  children: ReactNode;
  /** FLUX-742: anchor the panel's left edge to the trigger's left ('left', default) or its right edge
   *  to the trigger's right ('right'). Right-align the rightmost popover(s) so a w-64 panel can't clip
   *  off the chat column's right edge. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  // FLUX-742: capture both edges of the trigger so we can left- OR right-align the fixed panel.
  const [coords, setCoords] = useState<{ left: number; right: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggleOpen = () => {
    if (open) { setOpen(false); return; }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setCoords({ left: r.left, right: r.right, top: r.bottom + 4 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Clamp the fixed panel (w-64 = 256px) into the viewport; the bar opens it downward.
  // FLUX-742: when align='right', anchor the panel's RIGHT edge to the trigger's right edge so a
  // rightmost control's panel grows leftward and can't clip off the chat column's right edge.
  const PANEL_WIDTH = 256;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const desiredLeft = coords ? (align === 'right' ? coords.right - PANEL_WIDTH : coords.left) : 0;
  const panelLeft = coords ? Math.max(8, Math.min(desiredLeft, vw - 272)) : 0;
  const panelTop = coords ? Math.max(8, Math.min(coords.top, vh - 320)) : 0;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        title={title}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={toggleOpen}
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
          active
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-muted)] hover:text-[var(--eh-text-primary)]'
        }`}
      >
        <Icon className="h-3 w-3 flex-shrink-0" />
        {label}
      </button>
      {open && coords && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{ left: panelLeft, top: panelTop }}
          className="eh-border eh-surface fixed z-[60] w-64 rounded-lg border p-2.5 shadow-2xl"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * FLUX-620 / FLUX-740: the editable ticket metadata bar under the chat window's title bar — the
 * "metadata cockpit". Holds ALL ticket fields: status / priority / assignee / effort as inline
 * pills, and tags / implementation link / effort level as popovers, plus the read-only branch /
 * worktree / PR display. Edits flow through the shared `useTicketSideView` controller (same
 * `updateTask` write path as the sideview), and the unified dirty/save affordance lives here so it
 * stays reachable even when the sideview panel is collapsed or closed. Ticket windows only.
 */
function ChatMetadataBar({ c }: { c: ReturnType<typeof useTicketSideView> }) {
  const task = c.task;
  const config = c.config;
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
    <>
      {/* FLUX-742: only the metadata pills scroll horizontally (inner overflow-x-auto, flex-1). The
          Save/Discard (or PR) cluster is a sibling that does NOT scroll, so it stays pinned and
          reachable at the right edge even when the chat column is narrow and the pills overflow. */}
      <div className="eh-border-subtle flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px]">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <span className="flex-shrink-0 font-mono text-[var(--eh-text-muted)]">{task.id}</span>

        {/* Inline metadata pills. FLUX-744: status/priority/effort use BarDropdown so they keep their
            board identity (priority icon, status color dot) — native <option>s can't render visuals.
            Assignee stays a native select (variable-length user list, no per-option visual). */}
        <BarDropdown
          title="Status"
          value={c.status}
          onChange={c.setStatus}
          options={c.allStatuses.map((s) => ({ value: s, label: s, leading: <StatusDot config={config} status={s} /> }))}
          triggerLeading={<StatusDot config={config} status={c.status} />}
          className={getStatusColorClass(config, c.status)}
        />
        <BarDropdown
          title="Priority"
          value={c.priority}
          onChange={c.setPriority}
          options={c.availablePriorities.map((p) => ({ value: p.name, label: p.name, leading: getPriorityIcon(p.name, config, 'h-3 w-3') }))}
          triggerLeading={getPriorityIcon(c.priority, config, 'h-3 w-3')}
          className="eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)]"
        />
        <BarSelect
          title="Assignee"
          value={c.assignee}
          onChange={c.setAssignee}
          options={[{ value: 'unassigned', label: 'Unassigned' }, ...c.allUsers.map((u) => ({ value: u, label: u }))]}
          className="eh-border max-w-[120px] bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)]"
        />
        <BarDropdown
          title="Effort"
          value={c.effort}
          onChange={c.setEffort}
          options={EFFORT_OPTIONS.map((e) => ({ value: e, label: e }))}
          className="eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)]"
        />

        {/* Popover fields — don't fit a one-line pill. */}
        <BarPopover label={c.tags.length ? `Tags · ${c.tags.length}` : 'Tags'} icon={Tag} active={c.tags.length > 0} title="Edit tags">
          {config && (
            <TagSelector tags={c.tags} onChange={c.setTags} availableTags={c.allTags} configTags={config.tags} />
          )}
        </BarPopover>
        <BarPopover label="Link" icon={Link2} active={!!c.implementationLink} title="Implementation link (PR / commit URL)">
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Implementation Link</label>
          <input
            value={c.implementationLink}
            onChange={(e) => c.setImplementationLink(e.target.value)}
            placeholder="https://github.com/..."
            className="eh-border w-full rounded-md border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-primary"
          />
        </BarPopover>
        <BarPopover
          label={c.effortLevel ? `Effort · ${c.effortLevel}` : 'Effort lvl'}
          icon={Gauge}
          active={!!c.effortLevel}
          title="Agent effort level (overrides the global default)"
          align="right"
        >
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Effort Level</label>
          <select
            value={c.effortLevel}
            onChange={(e) => c.setEffortLevel(e.target.value)}
            className="eh-border w-full cursor-pointer rounded-md border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-primary"
          >
            {EFFORT_LEVEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </BarPopover>

        {/* Read-only branch / worktree display (kept from the original strip). */}
        {branchName && (
          <span
            className="flex min-w-0 flex-shrink-0 items-center gap-1 text-[var(--eh-text-secondary)]"
            title={branchName}
          >
            <GitBranch className="h-3 w-3 flex-shrink-0" />
            <span className="max-w-[120px] truncate font-mono">{branchName}</span>
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
        </div>

        {/* FLUX-740: the unified dirty/save affordance — pinned right, reachable even with the
            sideview collapsed. Falls back to the PR link when there's nothing to save.
            FLUX-742: sibling of the scroll region (not inside it), so it never scrolls out of view. */}
        {c.isDirty ? (
          <div className="flex flex-shrink-0 items-center gap-1 pl-1">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={c.discard}
              disabled={c.saving}
              title="Discard unsaved changes"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-secondary)] disabled:opacity-50 dark:hover:bg-white/5"
            >
              <RotateCcw className="h-3 w-3" /> Discard
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => void c.save()}
              disabled={c.saving}
              title="Save changes"
              className="flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
            >
              {c.saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              {c.saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ) : prUrl ? (
          <a
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            onPointerDown={(e) => e.stopPropagation()}
            className="flex flex-shrink-0 items-center gap-1 font-semibold text-primary hover:underline"
          >
            <GitPullRequest className="h-3 w-3 flex-shrink-0" /> PR
          </a>
        ) : null}
      </div>

      {c.saveError && (
        <div className="eh-border-subtle border-b border-red-500/20 bg-red-500/10 px-3 py-1 text-[11px] text-red-500">
          {c.saveError}
        </div>
      )}
    </>
  );
}

/** FLUX-740: instantiates the shared ticket controller for a ticket chat window and hands it to its
 *  children (the editable metadata bar + the sideview) via a render prop, so both surfaces drive one
 *  form state and one save flow. Only mounted for ticket windows (the orchestrator has no task). */
function TicketControllerScope({
  task, children,
}: {
  task: Task;
  children: (c: ReturnType<typeof useTicketSideView>) => ReactNode;
}) {
  const c = useTicketSideView(task);
  return <>{children(c)}</>;
}

/** FLUX-740: the draggable divider between the chat column and the ticket sideview. Dragging it
 *  rebalances the two — `onResize` is fed the live pointer delta to redistribute width while keeping
 *  the window's outer footprint fixed. */
function SideviewDivider({ onResize }: { onResize: (e: React.PointerEvent) => void }) {
  return (
    <div
      onPointerDown={onResize}
      title="Drag to resize the ticket panel"
      className="group/divider relative z-10 flex w-1.5 flex-shrink-0 cursor-col-resize items-stretch"
    >
      <span className="mx-auto w-px bg-[var(--eh-border)] transition-colors group-hover/divider:bg-primary" />
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
 * match the unified `TicketActions` default (engine-tone) button so the two action slots feel uniform.
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
  session,
  anchorX,
  working,
  activity,
  draft,
  onDraftChange,
  selections,
  onSelectionsChange,
  sideViewOpen = false,
  onToggleSideView,
  sideviewWidth = DEFAULT_SIDEVIEW_WIDTH,
  setSideviewWidth,
  seedSideviewWidth,
  onMinimize,
  onClose,
}: {
  id: string;
  orchestrator: boolean;
  /** The ticket this window is bound to (absent for the orchestrator → no action bar). */
  task?: Task;
  /** FLUX-686: the CLI session backing this conversation, for the quiet token/cost meter. */
  session?: CliSessionSummary | null;
  anchorX?: number;
  working: boolean;
  activity: string | null;
  /** FLUX-623: persisted unsent composer text for this conversation (survives minimize). */
  draft: string;
  onDraftChange: (text: string) => void;
  /** FLUX-666: persisted composer chip selections (model/effort/permission) for this
   *  conversation (survives minimize, alongside the text draft). */
  selections?: ComposerSelections;
  onSelectionsChange: (selections: ComposerSelections) => void;
  /** FLUX-734: whether the ticket sideview panel is expanded beside the chat (ticket windows only). */
  sideViewOpen?: boolean;
  /** FLUX-734: toggle the ticket sideview panel. Absent for the orchestrator (no bound task). */
  onToggleSideView?: () => void;
  /** FLUX-740: live, persisted width of the sideview panel (set by the chat↔panel divider). */
  sideviewWidth?: number;
  /** FLUX-740: commit a new sideview width (clamped + persisted in DockProvider). */
  setSideviewWidth?: (width: number) => void;
  /** FLUX-744: seed a proportional (~45%) sideview width from the chat column at open time, bounded
   *  by `maxWidth` so the grown window fits the viewport (no-op once the user has set a width). */
  seedSideviewWidth?: (chatWidth: number, maxWidth?: number) => void;
  onMinimize: () => void;
  /** Retire the card into History and close the window. Absent for the pinned orchestrator. */
  onClose?: () => void;
}) {
  // FLUX-748: pass `working` (live running session) so the hook's message queue auto-dispatches
  // on the turn-completion edge.
  const chat = useChatSession(id, true, working);
  const allTasks = useAppSelector((s) => s.tasks) as Task[];
  const config = useAppSelector((s) => s.config);
  // FLUX-744: open the legacy full-screen ticket modal from the chat header (collapsing the chat).
  const { openTaskFullView } = useAppActions();
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
  // FLUX-752: surface a board Require-Input prompt in the dock chat — guarded on a bound ticket
  // (the orchestrator board chat has none), status OR the require-input swimlane, matching the full
  // modal's `isRequireInput` predicate.
  const isRequireInput =
    !orchestrator && !!task && (task.status === requireInputStatus || task.swimlane === 'require-input');
  const windowRef = useRef<HTMLDivElement>(null);
  // User-resizable footprint. The window is pinned bottom-left (see `bottom`/`left`), so
  // the grip lives at the top-right corner and grows the window up + right.
  // FLUX-727: seed the larger default clamped to the viewport so it never spawns off-screen on a
  // small display (the resize maxW/maxH below keep it bounded once the user drags the grip).
  const [size, setSize] = useState(() => ({
    w: typeof window !== 'undefined' ? Math.min(CHAT_WINDOW_WIDTH, window.innerWidth - 16) : CHAT_WINDOW_WIDTH,
    h: typeof window !== 'undefined' ? Math.min(CHAT_WINDOW_HEIGHT, window.innerHeight - 100) : CHAT_WINDOW_HEIGHT,
  }));
  // Dragged position as a `{left, bottom}` pair (FLUX-603) — bottom-pinned like the spawn
  // default, so the existing top-right resize math is unchanged. `null` until first drag,
  // when it falls back to the anchored spawn position below.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  // FLUX-744: live viewport size, so the on-screen clamp below re-runs reactively on a window resize
  // (a resize doesn't re-render React by itself). Updated only on resize — cheap.
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // FLUX-734/740: the ticket sideview docks to the right of the chat column, growing the window's
  // outer width by the (live, divider-set) `sideviewWidth`. The chat column keeps its own resizable
  // `size.w`; all viewport clamping uses `outerW` so the expanded window never spills off-screen.
  // Orchestrator windows have no task, so the sideview never applies there.
  const showSideView = sideViewOpen && !!task && !orchestrator;
  const outerW = size.w + (showSideView ? sideviewWidth : 0);

  // FLUX-744: seed a proportional (~45%) sideview width from the live chat column when the panel
  // opens. Keyed on the open transition only (size.w read via ref so a divider drag doesn't re-seed);
  // the action itself no-ops once the user has set an explicit width.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useEffect(() => {
    if (!showSideView) return;
    const chatW = sizeRef.current.w;
    // Bound the seed so the grown window (chat + panel) still fits the viewport with an 8px gutter.
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    seedSideviewWidth?.(chatW, vw - chatW - 16);
  }, [showSideView, seedSideviewWidth]);

  // FLUX-736: when the sideview OPENS, re-clamp a dragged position so the window can't spill off the
  // right edge. The render-derived `left` (below) is already clamped, but the *persisted* `pos.left`
  // is not — opening the panel grows `outerW` to the right without re-clamping the stored value. We
  // pin it to the same bound the drag/resize handlers use (`window.innerWidth - outerW - 8`), so the
  // stored state stays correct (not just the derived render). Keyed on the open transition only;
  // `outerW` is read via a ref so a divider-drag width change doesn't re-trigger it. Untouched windows
  // (no drag yet, `pos === null`) keep the anchored path — only a dragged `pos` is re-clamped.
  const outerWRef = useRef(outerW);
  outerWRef.current = outerW;
  useEffect(() => {
    if (!showSideView) return;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const maxLeft = Math.max(8, vw - outerWRef.current - 8);
    setPos((prev) => {
      if (!prev || prev.left <= maxLeft) return prev;
      return { ...prev, left: maxLeft };
    });
  }, [showSideView]);

  // Spawn the window "out of" the clicked card: center it on the click x. FLUX-744: clamp the rendered
  // left/bottom UNCONDITIONALLY against the current outer width + (reactive) viewport — regardless of
  // whether the position came from a drag (`pos`) or the anchored spawn — so opening the sideview
  // (which grows `outerW`) or a viewport resize can no longer push the window off-screen. This is a
  // pure derived value: no effect, and the persisted `pos` is left untouched.
  const center = anchorX ?? viewport.w / 2;
  const rawLeft = pos ? pos.left : center - outerW / 2;
  const maxLeft = Math.max(8, viewport.w - outerW - 8);
  const left = Math.max(8, Math.min(rawLeft, maxLeft));
  const maxBottom = Math.max(8, viewport.h - size.h - 8);
  const rawBottom = pos ? pos.bottom : 84;
  const bottom = Math.max(8, Math.min(rawBottom, maxBottom));

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
      const maxLeft = (typeof window !== 'undefined' ? window.innerWidth : 1280) - outerW - 8;
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
    const maxW = (typeof window !== 'undefined' ? window.innerWidth : 1280) - 16 - (showSideView ? sideviewWidth : 0);
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

  // FLUX-740: drag the divider between the chat column and the sideview to rebalance the two. We keep
  // the window's outer footprint fixed: px taken from one side are handed to the other (drag left →
  // sideview grows, chat shrinks; drag right → the reverse), clamped so neither drops below its min.
  function startSideviewResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!setSideviewWidth) return;
    const startX = e.clientX;
    const startChatW = size.w;
    const startSideview = sideviewWidth;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      let nextSideview = Math.min(MAX_SIDEVIEW_WIDTH, Math.max(MIN_SIDEVIEW_WIDTH, startSideview - dx));
      let nextChat = startChatW + (startSideview - nextSideview);
      if (nextChat < MIN_WINDOW_WIDTH) {
        nextChat = MIN_WINDOW_WIDTH;
        nextSideview = startSideview + (startChatW - MIN_WINDOW_WIDTH);
      }
      setSize((s) => ({ ...s, w: nextChat }));
      setSideviewWidth(nextSideview);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // The chat surface itself is identical for orchestrator + ticket windows; only the surrounding
  // chrome (metadata bar, diff panel, sideview) differs, so it's built once and reused in both
  // branches of the body below.
  const chatViewEl = (
    <ChatView
      title={orchestrator ? 'Board chat' : id}
      fill
      // FLUX-727: dock windows open at the top of the final message, fully expanded.
      openToLastMessage
      messages={chat.messages}
      liveText={chat.liveText}
      loading={chat.loading}
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
      selections={selections}
      onSelectionsChange={onSelectionsChange}
      onSend={chat.send}
      queued={chat.queued}
      onEnqueue={chat.enqueue}
      onDequeue={chat.dequeue}
      onStop={chat.stop}
      onUploadImage={chat.uploadImage}
      awaitingInputBanner={isRequireInput && task ? <ChatRequireInputBanner task={task} /> : undefined}
      questionPicker={<ChatPendingInteractions conversationId={id} />}
      diffBranch={task?.branch}
      tickets={allTasks}
      meter={<SessionMeter session={session} config={config} />}
      actions={
        orchestrator ? (
          <TriageAction busy={chat.busy || working} onTriage={() => void chat.send(TRIAGE_PROMPT)} />
        ) : task ? (
          <TicketActions task={task} variant="compact" />
        ) : undefined
      }
    />
  );

  return (
    <div
      ref={windowRef}
      className="eh-surface eh-border fixed z-50 flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
      style={{ bottom, left, width: outerW, height: size.h }}
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
          {/* FLUX-744: open the ticket in the legacy full-screen modal (ticket windows only). Opening it
              collapses (minimizes) this chat so the two surfaces don't draw over each other. */}
          {task && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => { openTaskFullView(task); onMinimize(); }}
              title="Open in full view"
              className="rounded-md p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
          )}
          {/* FLUX-734: open/close the ticket sideview beside the chat (ticket windows only). */}
          {task && onToggleSideView && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onToggleSideView}
              title={sideViewOpen ? 'Hide ticket panel' : 'Show ticket panel'}
              aria-pressed={sideViewOpen}
              className={`rounded-md p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
                sideViewOpen ? 'text-primary' : 'text-[var(--eh-text-muted)] hover:text-[var(--eh-text-primary)]'
              }`}
            >
              {sideViewOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRight className="h-3.5 w-3.5" />}
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
      {/* FLUX-734/740: chat column on the left; the ticket sideview docks on the right when open. For
          ticket windows the shared controller is lifted (TicketControllerScope) so the editable
          metadata bar and the sideview drive one form state + one save flow. */}
      {task ? (
        <TicketControllerScope task={task}>
          {(c) => (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <ChatMetadataBar c={c} />
                <ChatDiffPanel task={task} />
                <div className="flex min-h-0 flex-1 flex-col px-3 py-3">{chatViewEl}</div>
              </div>
              {/* FLUX-740/744: the ticket sideview + the draggable divider that rebalances it vs the
                  chat. The wrapper is a flex item that STRETCHES to the body row's (definite) height,
                  then becomes a `relative` positioning context. TicketSideView fills it via
                  `absolute inset-0` (see below) instead of a flex-basis chain — that binds the scroll
                  region's height DIRECTLY to this stretched box, so it no longer depends on `flex-1`
                  propagating a definite height down two nested levels (the one structural difference
                  from the chat column, which scrolls fine). Without this the column grew past the
                  window and got clipped instead of scrolling (FLUX-744). */}
              {showSideView && (
                <>
                  <SideviewDivider onResize={startSideviewResize} />
                  <div
                    className="relative flex-shrink-0 overflow-hidden"
                    style={{ width: sideviewWidth }}
                  >
                    <TicketSideView c={c} />
                  </div>
                </>
              )}
            </div>
          )}
        </TicketControllerScope>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col px-3 py-3">{chatViewEl}</div>
          </div>
        </div>
      )}
    </div>
  );
}

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { Sparkles, MessageSquare, Minus, X, History, Square, RotateCcw, GitBranch, FolderGit2, GitPullRequest, ListChecks, Loader2, MessageCircleQuestion, PanelRight, PanelRightClose, Maximize2, Save, ChevronDown, Check, CircleHelp, TriangleAlert, Circle, CircleDashed, Archive, Eye, Ellipsis, NotebookPen, Play, Flame, Activity, Bot } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { useMotionTokens } from '../motion/tokens';
import { FURNACE_ACCENT, SmelterModeToggle } from './FurnaceDrawer';
import { useChatSession, type ChatSendOptions } from '../hooks/useChatSession';
import { ChatView } from './task-modal/ChatView';
import { ChatPresenceRail, ChatOrchestrationBlock } from './task-modal/ChatOrchestration';
import { selectChatRunGroup, isActiveSession } from '../orchestration';
import { ChatDiffPanel } from './task-modal/ChatDiffPanel';
import { TicketSideView } from './task-modal/TicketSideView';
import { PlanApprovalPanel } from './task-modal/PlanApprovalPanel';
import { FloatingPanel } from './FloatingPanel';
import { getPriorityIcon } from './task-modal/taskModalHelpers';
import { TicketContextCard, BoardSnapshotCard, SessionMeter } from './task-modal/chatContext';
import { parseQuickReplies } from './task-modal/chatQuickReplies';
import { parseRunProposal } from './task-modal/chatRunProposal';
import { ChatRequireInputBanner } from './task-modal/ChatRequireInputBanner';
import { AuthErrorCard } from './task-modal/AuthErrorCard';
import { TagSelector } from './TagSelector';
import { TicketActions } from './ticket-actions/TicketActions';
import { Skeleton } from './ui/Skeleton';
import { ChatPendingInteractions, usePendingInteractions, useComposerAnswer, isPlanApprovalPending, isPlanGateInFlight, revisePlan } from './pendingInteractions';
import { planReviewDraftCount, formatRegroomNotes, loadPlanReviewDraft, clearPlanReviewDraft } from '../lib/planAnnotations';
import { AttentionDock } from './attention/AttentionDock';
import { useDock, MIN_SIDEVIEW_WIDTH, MAX_SIDEVIEW_WIDTH, DEFAULT_SIDEVIEW_WIDTH, type ComposerSelections, type AnchorRect, type WindowGeometry } from './DockProvider';
import { useTicketSideView } from '../hooks/useTicketSideView';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { useConfirm } from '../hooks/useConfirm';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { fireDesktopNotification } from '../hooks/useDesktopNotifications';
import { getStatusTint, getStatusColorClass } from '../statusStyles';
import { DISPATCH_PHASE_ICON } from '../lib/dispatch';
import { DOCK_REVEAL_LABEL, DOCK_ICON_SLOT } from './dockReveal';
import { getRequireInputStatus } from '../workflow';
import { BOARD_CONVERSATION_ID, FURNACE_CONVERSATION_ID, createTask, updateTask, fetchTaskCliSession, fetchTaskTranscript, stopTaskCliSession, clearTaskTranscript, fetchBranchStatus, fetchTriageSignals, type BranchStatus } from '../api';
import { setTranscript } from '../transcriptCache';
import type { CliSessionStatus, CliSessionSummary, Config, Task } from '../types';

/**
 * FLUX-607: the bottom chat dock as a proper, centered taskbar (Windows-taskbar feel).
 * The orchestrator is pinned "home" at the left of the bar; every ticket with a
 * live/recent session surfaces as a card showing at-a-glance state — pulsing while an
 * agent works, a per-state glyph + colored glow when a chat finished or wants input
 * (colorblind-safe: shape carries the state, color reinforces it — FLUX-819). A hover-only
 * `x` retires a card into the always-available History
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

/** Leading state color per tab — a compact at-a-glance tint. Used as the `text-` color
 *  of the per-state glyph below (the box-shadow glow animations still carry the live
 *  "working"/attention emphasis on top of this). */
const STATE_DOT: Record<CardState, string> = {
  working: 'bg-[var(--eh-state-working)]',
  'needs-input': 'bg-[var(--eh-state-attention)]',
  finished: 'bg-[var(--eh-state-success)]',
  error: 'bg-[var(--eh-state-danger)]',
  available: 'bg-slate-400',
  idle: 'bg-gray-300 dark:bg-gray-600',
};

/** FLUX-1281: a ticket tab's leading glyph now encodes the LIFECYCLE PHASE (shape sourced from the
 *  board status, sharing `DISPATCH_PHASE_ICON` with the dispatch chips) while the run-state keeps
 *  the tint (`STATE_DOT`) + motion (spin / eye-scan while working) + glow (`STATE_ANIM`) channels.
 *  Todo deliberately reuses the implementation Code2 — Todo IS the implementation phase before any
 *  session starts; the run-state axis already tells "queued" and "being coded" apart (rev-5 table).
 *  FLUX-819's colorblind guarantee is preserved on different limbs: finished/error moved to
 *  shape-distinct corner badges (Check circle vs TriangleAlert), needs-input keeps the
 *  MessageCircleQuestion badge + its CircleHelp glyph via the Require Input status below. */
const STATUS_PHASE_ICON: Record<string, LucideIcon> = {
  Backlog: CircleDashed, // not yet groomed — no phase to show
  Grooming: DISPATCH_PHASE_ICON.grooming,
  Todo: DISPATCH_PHASE_ICON.implementation,
  'In Progress': DISPATCH_PHASE_ICON.implementation,
  'Require Input': CircleHelp,
  Ready: DISPATCH_PHASE_ICON.review,
  Done: DISPATCH_PHASE_ICON.finalize,
  Released: DISPATCH_PHASE_ICON.finalize,
  Archived: Archive,
};

/** Resolve a tab's leading glyph: prefer the ACTIVE session's own identity (`activePhase`, only
 *  passed while it runs — e.g. a plan-review-gate pass on a Grooming ticket transiently reads as
 *  the review Eye, reverting when the gate finishes), then the board status, then a plain circle
 *  for unknown/custom statuses. 'chat' sessions carry no phase identity. */
function phaseIconFor(status: string | undefined, activePhase?: string): LucideIcon {
  if (activePhase && activePhase !== 'chat') {
    const icon = DISPATCH_PHASE_ICON[activePhase as keyof typeof DISPATCH_PHASE_ICON];
    if (icon) return icon;
  }
  return (status && STATUS_PHASE_ICON[status]) || Circle;
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/** Split a ticket id like `FLUX-607` into a small prefix + the trailing number. */
function splitId(id: string): { prefix: string; short: string } {
  const idx = id.lastIndexOf('-');
  if (idx === -1) return { prefix: '', short: id };
  return { prefix: id.slice(0, idx), short: id.slice(idx + 1) };
}

/** FLUX-1209: track a virtual (non-ticket) conversation's live CLI session — the board
 *  orchestrator (`BOARD_CONVERSATION_ID`) or the Furnace Operator ("Smelter") chat
 *  (`FURNACE_CONVERSATION_ID`). Neither has an entry in the board task list, so this is the only
 *  way their pinned/flyout surfaces see live state even while their window is closed. Generalizes
 *  what used to be board-only inline effects (FLUX-611: event-driven fetch, refetch only on this
 *  conversation's own `activity`/`taskUpdated` event; FLUX-910: a bounded 3s poll backstops only
 *  while a turn is actively running/pending, in case the SSE stream stalls).
 *
 *  FLUX-1580: the engine now holds a SEPARATE `__board__`/`__furnace__` session per workspace —
 *  switching the active board must swap this hook onto the newly-active workspace's session
 *  instead of continuing to show whichever workspace's session it last fetched. `activeBoardId`
 *  is passed in purely as a refetch trigger (it's already stamped onto every `ehFetch` call via
 *  the module-level board key — see api.ts's `setActiveBoardKey` — so `fetchTaskCliSession` below
 *  already targets the right workspace once this effect re-runs); the stale session is cleared
 *  synchronously so a closed/switched conversation never renders across a workspace switch while
 *  the fresh fetch is in flight. */
function useVirtualConversationSession(conversationId: string, activeBoardId: string | null): CliSessionSummary | null {
  const { subscribeToEvent } = useAppActions();
  const [session, setSession] = useState<CliSessionSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    // FLUX-1580: drop the previous (possibly other-workspace's) session immediately rather than
    // rendering it under the newly-active board until the refetch below resolves.
    setSession(null);
    const refresh = async () => {
      try {
        const s = await fetchTaskCliSession(conversationId);
        if (!cancelled) setSession(s);
      } catch {
        /* ignore */
      }
    };
    void refresh();
    const matches = (d: unknown): boolean => {
      const o = d as { taskId?: string; id?: string } | null;
      return !!o && (o.taskId === conversationId || o.id === conversationId);
    };
    const on = (d: unknown) => { if (matches(d)) void refresh(); };
    const unsubs = [subscribeToEvent('activity', on), subscribeToEvent('taskUpdated', on)];
    return () => { cancelled = true; unsubs.forEach((u) => u()); };
  }, [conversationId, activeBoardId, subscribeToEvent]);

  const live = session?.status === 'running' || session?.status === 'pending';
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const iv = setInterval(() => {
      void (async () => {
        try {
          const s = await fetchTaskCliSession(conversationId);
          if (!cancelled) setSession(s);
        } catch { /* transient — keep last good */ }
      })();
    }, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [conversationId, live]);

  return session;
}

// FLUX-1035: the Furnace toggle rides in the dock strip as a small square icon pinned next to the
// Orchestrator ("Board") tab — the Furnace is a board-level concern, so it lives beside the board chat
// rather than as a nav pill up top. Open state is owned by App and passed through.
// FLUX-1141: memoized for the same reason as `Board` — this 2000+ line tree is a direct
// AppContent child with only stable/primitive props, so it was re-rendering in full on every
// unrelated AppContent toggle (terminal, furnace, the 5s furnace-status poll) despite its own
// dock state being read through context/hooks rather than props.
export const ChatDock = memo(function ChatDock({ onToggleFurnace, furnaceOpen, furnaceBurning, furnaceBurningCount }: { onToggleFurnace?: () => void; furnaceOpen?: boolean; furnaceBurning?: boolean; furnaceBurningCount?: number } = {}) {
  const { subscribeToEvent, triggerRefresh } = useAppActions();
  const tasks = useAppSelector((s) => s.tasks);
  const config = useAppSelector((s) => s.config);
  // FLUX-1580: the active board's key — passed to useVirtualConversationSession below so the
  // board/Furnace chat viewport swaps onto the newly-active workspace's session on switch instead
  // of continuing to show whichever workspace's session it last fetched.
  const activeBoardId = useAppSelector((s) => s.activeBoardId);
  const currentUser = useAppSelector((s) => s.currentUser);
  const currentProject = useAppSelector((s) => s.currentProject);
  // FLUX-720: conversations with an unresolved pending interaction (approval / question /
  // board-rebase). Drives the hard-gated tab: a chat awaiting your answer is force-pinned with a
  // distinct prompt icon and can't be closed/removed until it's resolved.
  // FLUX-898: the pending count + panel are now owned by the unified <AttentionDock/>; the dock taskbar
  // only needs the prompt/require-input conversation-id sets for its per-tab gating + badges.
  const { pendingPromptConversationIds, requireInputConversationIds } = usePendingInteractions();
  // Window/open state lives in the app-root DockProvider (FLUX-603) so a card can drive it
  // and it survives view switches. `anchors` records where each window should spawn from.
  const { open, acked, dismissed, manuallyOpened, anchors, anchorRects, drafts, selections, order, sideviewOpen, sideviewWidth, windowGeometry, toggle, closeCard, reopenFromHistory, setDraft, setSelections, reorder, promoteToFront, toggleSideView, openSideView, setSideviewWidth, seedSideviewWidth, setSectionOpen, setWindowGeometry, openTicket, openChat, raise, planApprovalOpen, planApprovalNonce, closePlanApproval } = useDock();
  const confirm = useConfirm();

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

  // FLUX-1225: spawn a fresh Scratch Chat straight from the dock — no ticket picker. Creating a
  // `kind:'scratch'` entity mints its own SCRATCH-n id (engine side); we then `openChat` it, which
  // both surfaces its tab (via manuallyOpened) and opens the window, and `triggerRefresh` so the
  // freshly-created task lands in the store list backing the tab. `creatingScratch` guards against a
  // double-click minting two entities.
  const [creatingScratch, setCreatingScratch] = useState(false);
  const handleNewScratch = useCallback(async () => {
    if (creatingScratch) return;
    setCreatingScratch(true);
    try {
      // FLUX-1417: the engine now names scratch chats `Scratch <n>` itself (off the same
      // `SCRATCH-n` counter it just minted from) when it sees this placeholder title, so
      // there's no follow-up rename to await before opening — open the window as soon as
      // the mint resolves.
      const task = await createTask({
        kind: 'scratch',
        title: 'Scratch',
        status: 'Todo',
        projectKey: currentProject,
        author: currentUser,
      });
      openChat(task.id);
      triggerRefresh();
      // FLUX-1241/1255: belt-and-suspenders — if the engine default wasn't taken for some
      // reason (older engine, unexpected title), fire the rename after the window is
      // already open rather than gating on it. Cosmetic only, so failure is non-fatal.
      if (task.title === 'Scratch') {
        const n = task.id.replace(/^SCRATCH-/, '');
        updateTask(task.id, { title: `Scratch ${n}` }).catch((err) => {
          console.error('Failed to set scratch chat title:', err);
        });
      }
    } catch (err) {
      console.error('Failed to create scratch chat:', err);
    } finally {
      setCreatingScratch(false);
    }
  }, [creatingScratch, currentProject, currentUser, openChat, triggerRefresh]);

  const [showHistory, setShowHistory] = useState(false);
  // FLUX-1209: the board orchestrator and the Furnace-chat both track their live session the same
  // way — see useVirtualConversationSession above.
  const boardSession = useVirtualConversationSession(BOARD_CONVERSATION_ID, activeBoardId);
  const furnaceSession = useVirtualConversationSession(FURNACE_CONVERSATION_ID, activeBoardId);
  // FLUX-1209 / FLUX-1212: the Furnace icon's hover flyout ("Open Furnace" / "Open Furnace chat").
  // Opens on hover (desktop) or via the kebab click (touch/no-hover fallback) — either sets the
  // same piece of state, so there's one source of truth for whether the popover is showing.
  const [furnaceFlyoutOpen, setFurnaceFlyoutOpen] = useState(false);
  const furnaceFlyoutRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!furnaceFlyoutOpen) return;
    const onDown = (e: PointerEvent) => {
      if (furnaceFlyoutRef.current && !furnaceFlyoutRef.current.contains(e.target as Node)) setFurnaceFlyoutOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [furnaceFlyoutOpen]);
  // Right-click context menu (anchored at the cursor) for a single tab at a time.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // Per-chat "unread": the latest agent-output timestamp we've shown the user. A closed chat
  // whose session emits newer output than this lights an unread dot. In-memory (resets on
  // reload, where everything baselines as read) — no persistence needed for v1.
  const seenRef = useRef<Record<string, string>>({});
  // FLUX-1576: `open` is app-root-global (DockProvider), so without this a window opened in one
  // workspace kept rendering — with `task={undefined}` — over every other workspace, and closing
  // it there (`closeCard`) mutated the shared `open` array and closed it everywhere. Stamp each
  // id with the board it was FIRST seen open under; `visibleOpen` below then only renders ids
  // stamped to the active board (plus the always-visible virtual conversations), while `open`
  // itself stays untouched so the window's state is preserved — just hidden — on switch-away.
  const boardOfRef = useRef<Record<string, string>>({});
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

  const allTasks = tasks as Task[];

  const statusOf = useMemo(() => {
    const map = new Map<string, CliSessionStatus | undefined>();
    map.set(BOARD_CONVERSATION_ID, boardSession?.status);
    map.set(FURNACE_CONVERSATION_ID, furnaceSession?.status);
    for (const t of allTasks) map.set(t.id, t.cliSession?.status);
    return map;
  }, [allTasks, boardSession, furnaceSession]);

  const activityOf = (id: string): string | null =>
    id === BOARD_CONVERSATION_ID
      ? boardSession?.currentActivity ?? null
      : id === FURNACE_CONVERSATION_ID
        ? furnaceSession?.currentActivity ?? null
        : allTasks.find((t) => t.id === id)?.cliSession?.currentActivity ?? null;

  // FLUX-1209: Smelter now launches on its own FURNACE_CONVERSATION_ID (never the board's), so the
  // board conversation's label/title is always the plain 'Orchestrator' identity — no more
  // in-persona override here. The Furnace-chat branch below reuses the same in-persona-label idea,
  // just scoped to its own conversation id instead of overriding the board's.
  const titleOf = (id: string): string =>
    id === BOARD_CONVERSATION_ID
      ? 'Orchestrator'
      : id === FURNACE_CONVERSATION_ID
        ? furnaceSession?.label ?? 'Furnace chat'
        : allTasks.find((t) => t.id === id)?.title ?? id;

  // Most-recent agent-output timestamp for a chat — the unread signal (no transcript load).
  const lastOutputAtOf = (id: string): string | undefined =>
    id === BOARD_CONVERSATION_ID
      ? boardSession?.lastOutputAt
      : id === FURNACE_CONVERSATION_ID
        ? furnaceSession?.lastOutputAt
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
        cardState(t.cliSession?.status, acked.includes(t.id), t.status === 'Require Input' || t.swimlane === 'require-input') === 'needs-input';
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

  // FLUX-1476: edge fades signal clipped chip-strip content in place of the (now-hidden)
  // horizontal scrollbar. Tracks which side(s) currently overflow so each fade only shows
  // when there's really more content to reveal on that side.
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setScrollEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [orderedTickets.length, titleWidth]);

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
    if (furnaceSession && seen[FURNACE_CONVERSATION_ID] === undefined) seen[FURNACE_CONVERSATION_ID] = furnaceSession.lastOutputAt ?? '';
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

  // FLUX-1209 / FLUX-1212: Furnace-chat state backing the flyout's second row.
  const furnaceChatOpen = open.includes(FURNACE_CONVERSATION_ID);
  const furnaceChatWorking = statusOf.get(FURNACE_CONVERSATION_ID) === 'running';
  const furnaceChatUnread = unreadOf(FURNACE_CONVERSATION_ID);

  // FLUX-1200: a single stable callback shared by every window (openSideView/setSectionOpen are
  // themselves stable DockActions), so it never breaks the ChatWindow memo comparator below —
  // unlike a fresh `() => {...}` closure created per-id inside the render loop.
  const handleOpenArtifact = useCallback(
    (id: string) => {
      openSideView(id);
      setSectionOpen('artifact', true);
    },
    [openSideView, setSectionOpen],
  );

  // FLUX-1576: filter `open` down to windows stamped to the active board. Stamping on first-seen
  // (rather than in an effect) is what lets a just-opened window — including a new Scratch not yet
  // in `allTasks` — render on this same pass with no one-frame flash, while a window opened under
  // another board stays stamped there and is filtered out here on every subsequent switch.
  const visibleOpen = open.filter((id) => {
    if (id === BOARD_CONVERSATION_ID || id === FURNACE_CONVERSATION_ID) return true;
    const b = boardOfRef.current[id];
    if (b === undefined) {
      boardOfRef.current[id] = activeBoardId ?? '';
      return true;
    }
    return b === activeBoardId;
  });

  return (
    <>
      {/* FLUX-801: AnimatePresence gives each window an exit animation (shrink back toward its
          origin card) when it leaves `open`. mode defaults to "sync" so multiple windows coexist. */}
      <AnimatePresence>
      {visibleOpen.map((id) => (
        <ChatWindow
          key={id}
          id={id}
          orchestrator={id === BOARD_CONVERSATION_ID}
          // FLUX-1022: only the frontmost (last in paint order) window collapses on ESC.
          isTopmost={id === visibleOpen[visibleOpen.length - 1]}
          task={allTasks.find((t) => t.id === id)}
          // FLUX-801: the clicked card's rect (pop-open origin) + bring-to-front on focus.
          originRect={anchorRects[id]}
          // FLUX-1200: pass the stable DockActions directly (not a per-id `() => action(id)` wrapper)
          // so ChatWindow's memo comparator (below) actually bails out for windows an unrelated dock
          // state change doesn't touch — a fresh closure here would defeat memo on every render.
          onRaise={raise}
          // FLUX-686 / FLUX-1209: session totals back the quiet token meter — orchestrator from
          // boardSession, Furnace-chat from furnaceSession, tickets from their own cliSession.
          session={
            id === BOARD_CONVERSATION_ID
              ? boardSession
              : id === FURNACE_CONVERSATION_ID
                ? furnaceSession
                : allTasks.find((t) => t.id === id)?.cliSession ?? null
          }
          anchorX={anchors[id]}
          working={statusOf.get(id) === 'running'}
          activity={activityOf(id)}
          draft={drafts[id] ?? ''}
          onDraftChange={setDraft}
          // FLUX-666: persist the composer's model/effort/permission chip selections across
          // minimize/reopen, the same per-id way the text draft is persisted.
          selections={selections[id]}
          onSelectionsChange={setSelections}
          // FLUX-734: ticket sideview toggle (ticket windows only — the orchestrator has no task).
          sideViewOpen={sideviewOpen.includes(id)}
          onToggleSideView={toggleSideView}
          // FLUX-887: "Open in panel" on the inline artifact card — idempotently reveal the sideview
          // (only toggles when closed) and force the Grooming Artifact section open so the viewer shows.
          onOpenArtifact={handleOpenArtifact}
          // FLUX-740: live, persisted sideview width + setter for the chat↔panel resize divider.
          sideviewWidth={sideviewWidth}
          setSideviewWidth={setSideviewWidth}
          // FLUX-744: seed a proportional (~45%) width from the chat column when the panel opens.
          seedSideviewWidth={seedSideviewWidth}
          // FLUX-920: persisted per-conversation window footprint — seeds size/position on (re)mount so
          // a resize/drag survives minimize/reopen + reload; committed back on the resize/drag gesture.
          windowGeometry={windowGeometry[id]}
          onGeometryChange={setWindowGeometry}
          // FLUX-1273: the full-screen plan-approval panel — a per-id boolean (not the raw shared
          // id) so ChatWindow's memo bails for every OTHER open window when one ticket's panel toggles.
          planApprovalPanelOpen={planApprovalOpen === id}
          // FLUX-1381: repeat-open signal — pinned to 0 unless THIS window's panel is the open one
          // (same memo-bail reasoning as the boolean above), and bumped by DockProvider on every
          // openPlanApproval call so a same-id reopen still un-minimizes the panel.
          planApprovalPanelNonce={planApprovalOpen === id ? planApprovalNonce : 0}
          onClosePlanApproval={closePlanApproval}
          onMinimize={toggle}
          // FLUX-720: the window's close (X) is hidden while a prompt is pending, mirroring the
          // tab gate — the chat can't be retired until you resolve it. Minimize stays available.
          canClose={id !== BOARD_CONVERSATION_ID && !pendingPromptConversationIds.has(id)}
          onClose={closeCard}
        />
      ))}
      </AnimatePresence>

      {/* Flat, Windows-taskbar-style strip: the orchestrator pinned "home", then one tab per
          chat. Each tab carries a fuller label (id + title) that shrinks as tabs multiply
          (titleWidth / compactId). The inner row uses py/-my so the absolute `!`/`x` aren't
          clipped under overflow-x-auto. */}
      <div className="eh-border eh-surface-overlay fixed bottom-3 left-1/2 z-40 flex max-w-[94vw] -translate-x-1/2 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 shadow-xl">
        {/* FLUX-1281: the global-actions cluster — Board / New Scratch / Furnace / Attention Dock
            grouped on one quiet shared wash so the four ambient controls read as one unit, distinct
            from the per-chat tabs strip. All four share the icon-first, hover/focus-reveal-label
            pattern (dockReveal.ts). The tabs' SortableContext stays outside, untouched. */}
        <div className="flex flex-shrink-0 items-center gap-1 rounded-xl bg-black/[0.03] p-1 dark:bg-white/[0.03]">
        {/* Orchestrator — pinned "home". Not retirable. FLUX-1209: Smelter now launches on its own
            FURNACE_CONVERSATION_ID, so this tab's label/identity is always the plain 'Orchestrator'
            (no more in-persona relabel — that was the override bug this ticket fixes). */}
        <ChatTab
          id={BOARD_CONVERSATION_ID}
          label="Orchestrator"
          orchestrator
          open={open.includes(BOARD_CONVERSATION_ID)}
          state={cardState(boardSession?.status, acked.includes(BOARD_CONVERSATION_ID))}
          // FLUX-923: same open=inline / minimized=dock handoff as the ticket tabs below.
          pendingPrompt={pendingPromptConversationIds.has(BOARD_CONVERSATION_ID) && !open.includes(BOARD_CONVERSATION_ID)}
          activity={boardSession?.currentActivity ?? null}
          unread={unreadOf(BOARD_CONVERSATION_ID)}
          onOpen={(el) => toggle(BOARD_CONVERSATION_ID, el)}
          onContextMenu={(e) => setMenu({ id: BOARD_CONVERSATION_ID, x: e.clientX, y: e.clientY })}
        />

        {/* FLUX-1225: "New Scratch" — spawn a freeform Scratch Chat straight from the dock, no
            ticket picker. Pinned right of the Orchestrator; mints a kind:'scratch' entity and opens
            its tab. FLUX-1281: icon-first (NotebookPen — its own identity, no longer borrowing the
            Board's spark), label reveals on hover/focus. */}
        <button
          type="button"
          onClick={() => void handleNewScratch()}
          disabled={creatingScratch}
          aria-label="New scratch chat"
          title="New scratch chat"
          className="eh-border group flex h-9 flex-shrink-0 items-center rounded-lg border bg-[var(--eh-input-bg)] text-xs font-medium text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-white/5"
        >
          <span className={DOCK_ICON_SLOT}>
            {creatingScratch ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <NotebookPen className="h-3.5 w-3.5" />}
          </span>
          <span className={DOCK_REVEAL_LABEL}>New Scratch</span>
        </button>

        {/* FLUX-1035 / FLUX-1209 / FLUX-1212: the Furnace icon — a small square button pinned right of
            the Orchestrator tab, plus a hover flyout offering "Open Furnace" (today's drawer) and
            "Open/Focus Furnace chat" (Smelter's own dedicated conversation window). Furnace orange when
            the drawer is open. FLUX-1053: when closed but a batch is burning it keeps an ambient orange
            treatment + a pulsing badge (bottom-right), so unattended work stays glanceable. FLUX-1212: a
            distinct blue message badge (top-left — opposite corner, never collides with the burn-pulse)
            lights when Smelter has an unread reply; the icon also takes a solid furnace-accent tint
            (mirroring the Board tab's "open" treatment) whenever the Furnace chat window itself is
            already open/docked, and the flyout's "Open Furnace" row surfaces a live batch count
            ("· N burning") instead of a bare label. */}
        {onToggleFurnace && (
          <div
            ref={furnaceFlyoutRef}
            className="relative flex-shrink-0"
            onMouseEnter={() => setFurnaceFlyoutOpen(true)}
            onMouseLeave={() => setFurnaceFlyoutOpen(false)}
          >
            <button
              type="button"
              onClick={onToggleFurnace}
              aria-label={furnaceBurning ? 'The Furnace — batches burning' : 'The Furnace'}
              aria-pressed={!!furnaceOpen}
              title={furnaceBurning ? 'The Furnace — batches burning' : 'The Furnace'}
              className={`group relative flex h-9 flex-shrink-0 items-center rounded-lg border text-xs font-medium transition-colors ${
                furnaceOpen
                  ? 'border-transparent text-white'
                  : furnaceChatOpen
                    ? 'border-[var(--eh-furnace-accent)]/60 bg-[var(--eh-furnace-accent)]/10 text-[var(--eh-furnace-accent)]'
                    : furnaceBurning
                      ? 'border-[var(--eh-furnace-orange)]/60 bg-[var(--eh-furnace-orange)]/10 text-[var(--eh-furnace-orange)]'
                      : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-muted)] hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5'
              }`}
              style={furnaceOpen ? { background: 'var(--eh-furnace-orange)' } : undefined}
            >
              <span className={DOCK_ICON_SLOT}>
                <Flame className={`h-4 w-4 ${!furnaceOpen && furnaceBurning ? 'animate-pulse' : ''}`} />
              </span>
              <span className={DOCK_REVEAL_LABEL}>Furnace</span>
              {/* Corner badges are direct children of the button (never an inner slot) so they
                  anchor to its true box and track the edge as the label reveals — FLUX-1281 rev-5. */}
              {!furnaceOpen && furnaceBurning && (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-[var(--eh-furnace-orange)] ring-2 ring-[var(--eh-base)]"
                />
              )}
              {furnaceChatUnread && (
                <span
                  aria-hidden="true"
                  className="absolute -left-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-[var(--eh-base)]"
                />
              )}
            </button>
            {/* Touch/keyboard fallback (FLUX-1212) for the hover flyout, restyled (FLUX-1281) from a
                separate kebab column into a corner-badge caret riding the button's bottom-right edge.
                A sibling (not a child) of the button — nested buttons are invalid HTML — absolutely
                positioned on the shared relative wrapper, which grows with the button on reveal. */}
            <button
              type="button"
              onClick={() => setFurnaceFlyoutOpen((v) => !v)}
              aria-label="Furnace options"
              aria-expanded={furnaceFlyoutOpen}
              aria-haspopup="menu"
              title="Furnace options"
              // FLUX-1337: visual glyph stays 14x14 (rev-3 mockup), but that's below the WCAG 2.5.8
              // 24x24 touch-target minimum — and it's the touch/no-hover fallback (FLUX-1212), so hit
              // area matters most here. `before:` pseudo-element pads the hit area without resizing
              // the visible circle.
              className="eh-border eh-surface before:content-[''] absolute -bottom-1 -right-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[var(--eh-text-muted)] shadow-sm transition-colors before:absolute before:-inset-2 hover:text-[var(--eh-text-primary)]"
            >
              <ChevronDown className="h-2.5 w-2.5" />
            </button>

            {furnaceFlyoutOpen && (
              <>
                {/* Hover bridge (FLUX-1212): fill the mb-2 gap between the icon and the flyout so moving
                    the pointer up into the menu never crosses empty space — that empty band is outside
                    the container's subtree, so crossing it fired onMouseLeave and snapped the menu shut
                    before a row could be clicked. Can't live inside the overflow-hidden menu below. */}
                <span aria-hidden="true" className="absolute bottom-full left-0 h-2 w-56" />
                <div
                  role="menu"
                  className="eh-border eh-surface absolute bottom-full left-0 mb-2 w-56 overflow-hidden rounded-xl border p-1 shadow-2xl"
                >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onToggleFurnace(); setFurnaceFlyoutOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--eh-text-primary)] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <Flame className="h-3.5 w-3.5 flex-shrink-0" style={{ color: FURNACE_ACCENT }} />
                  <span className="flex-1">Open Furnace</span>
                  {furnaceBurning && (
                    <span className="text-[10px] font-medium" style={{ color: 'var(--eh-furnace-orange)' }}>
                      {furnaceBurningCount ? `· ${furnaceBurningCount} burning` : 'burning'}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => { openChat(FURNACE_CONVERSATION_ID, e.currentTarget); setFurnaceFlyoutOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-[var(--eh-text-primary)] hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <Bot className="h-3.5 w-3.5 flex-shrink-0" style={{ color: FURNACE_ACCENT }} />
                  <span className="flex-1">{furnaceChatOpen ? 'Focus Furnace chat' : 'Open Furnace chat'}</span>
                  {furnaceChatWorking ? (
                    <ThinkingDots />
                  ) : furnaceChatUnread ? (
                    <span aria-hidden="true" className="h-2 w-2 flex-shrink-0 rounded-full bg-primary" />
                  ) : null}
                </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* FLUX-898: the unified attention surface — pinned immediately right of the Orchestrator.
            Replaces the old Pending tab + floating fallback: a 3-tier dynamic-label button
            (Needs You ▸ Updates ▸ Activity) that peeks new prompts and raises a 3-tab inbox. */}
        <AttentionDock />
        </div>

        {activeTickets.length > 0 && (
          <div className="h-7 w-px bg-[var(--eh-border)]" aria-hidden="true" />
        )}

        {/* FLUX-727: drag-to-reorder strip. `autoScroll={false}` so dnd-kit's drag auto-scroll
            doesn't fight the wheel-scroll listener on this overflow-x container. The orchestrator
            (above) stays outside the SortableContext — pinned home, never draggable.
            FLUX-1476: `min-w-0` lets this wrapper shrink inside the outer flex bar (matching the
            old scroll div's own shrink-to-zero via overflow-x-auto) so the edge fades below stay
            anchored to the true clipped boundary instead of the strip's unclipped content width. */}
        <div className="relative flex min-w-0 flex-1 items-center">
          <div
            ref={stripRef}
            className="eh-scrollbar-none flex items-center gap-1.5 overflow-x-auto px-1.5 py-2 -mx-1.5 -my-2"
          >
            <DndContext sensors={sensors} collisionDetection={closestCenter} autoScroll={false} onDragEnd={onDragEnd}>
              <SortableContext items={orderedIds} strategy={horizontalListSortingStrategy}>
                {orderedTickets.map((t) => {
                  // A require-input swimlane gets the SAME persistent tab badge as a parked prompt — it
                  // stays until answered. FLUX-923: but gate the tab GLOW on the window being minimized/
                  // closed — while the chat is OPEN the prompt is shown inline there, so the tab must stay
                  // quiet (no double-demand); minimizing re-asserts the glow so the prompt is never lost.
                  // The badge still re-appears the moment the window is minimized.
                  const pendingPrompt =
                    (pendingPromptConversationIds.has(t.id) || requireInputConversationIds.has(t.id)) && !open.includes(t.id);
                  // FLUX-720 hard-close gate keys off PROMPTS ONLY — require-input tabs keep the badge but
                  // stay closeable (they're dismissible by design), matching the context-menu close below.
                  const hardClose = pendingPromptConversationIds.has(t.id);
                  return (
                    <SortableChatTab
                      key={t.id}
                      id={t.id}
                      title={t.title}
                      orchestrator={false}
                      open={open.includes(t.id)}
                      state={cardState(t.cliSession?.status, acked.includes(t.id), t.status === 'Require Input' || t.swimlane === 'require-input')}
                      pendingPrompt={pendingPrompt}
                      statusTint={getStatusTint(config, t.status)}
                      status={t.status}
                      sessionPhase={t.cliSession?.phase}
                      activity={t.cliSession?.currentActivity ?? null}
                      unread={unreadOf(t.id)}
                      titleWidth={titleWidth}
                      compactId={compactId}
                      onOpen={(el) => toggle(t.id, el)}
                      // FLUX-720: hard-gate close while a prompt is pending — the tab can't be retired
                      // until the user resolves it (minimize still works; resolve controls stay usable).
                      onClose={hardClose ? undefined : () => closeCard(t.id)}
                      onContextMenu={(e) => setMenu({ id: t.id, x: e.clientX, y: e.clientY })}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          </div>
          {/* FLUX-1476: edge fades replace the (now-hidden) horizontal scrollbar as the overflow
              signal — only visible on the side(s) that actually clip content, and `pointer-events-none`
              so they never steal wheel-scroll or drag-reorder input from the strip beneath. */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--eh-surface-overlay)] to-transparent transition-opacity duration-150 ${scrollEdges.left ? 'opacity-100' : 'opacity-0'}`}
          />
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--eh-surface-overlay)] to-transparent transition-opacity duration-150 ${scrollEdges.right ? 'opacity-100' : 'opacity-0'}`}
          />
        </div>

        {/* History — always available (so it's discoverable even before anything is closed).
            FLUX-1281: moved off the main row onto a small file-tab riding the dock bar's top-right
            corner (absolute against the fixed bar container), freeing the row for actual chats.
            Same `showHistory` wiring — only the anchor moved. */}
        <div className="absolute -top-3.5 right-3">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            aria-label="Recent chats"
            aria-expanded={showHistory}
            title="Recent chats"
            // FLUX-1337: visible tab stays 20x32 (rev-3 mockup), but its short dimension is under the
            // WCAG 2.5.8 24x24 touch-target minimum. `before:` pseudo-element pads the hit area only.
            className="eh-border eh-surface-overlay before:content-[''] relative flex h-5 w-8 items-center justify-center rounded-t-lg border border-b-0 pb-0.5 text-[var(--eh-text-muted)] transition-colors before:absolute before:-inset-2 hover:text-[var(--eh-text-primary)]"
          >
            <History className="h-3 w-3" />
          </button>
          {/* FLUX-1281: rows carry the full task's identity — a status dot + left accent from the
              board palette (getStatusTint) for tickets, a violet NotebookPen treatment for
              kind:'scratch' entries (which already reach here: `dismissed` records any closed tab
              and `cancelledIds` has no kind filter — verified, no inclusion change needed). */}
          {showHistory && (
            <div className="eh-border eh-surface absolute bottom-full right-0 mb-1 max-h-72 w-72 overflow-y-auto rounded-xl border p-1 shadow-2xl">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
                Recent chats
              </div>
              {historyIds.length === 0 ? (
                <div className="px-2 py-2 text-xs text-gray-400">No recent chats</div>
              ) : (
                historyIds.map((id) => {
                  const task = allTasks.find((t) => t.id === id);
                  const scratch = task?.kind === 'scratch';
                  const tint = task && !scratch ? getStatusTint(config, task.status) : null;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={(e) => handleReopen(id, e.currentTarget)}
                      title={titleOf(id)}
                      className="flex w-full items-center gap-2 rounded-lg border-l-2 px-2 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-white/10"
                      style={{
                        borderLeftColor: scratch
                          ? 'rgb(139 92 246)'
                          : tint
                            ? `rgba(${tint.rgb}, 0.8)`
                            : 'transparent',
                      }}
                    >
                      {scratch ? (
                        <NotebookPen className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" />
                      ) : (
                        <History className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" />
                      )}
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {tint && (
                            <span
                              aria-hidden="true"
                              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                              style={{ backgroundColor: `rgb(${tint.rgb})` }}
                            />
                          )}
                          <span className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                            {titleOf(id)}
                          </span>
                        </span>
                        {scratch ? (
                          <span className="text-[10px] font-medium uppercase tracking-wide text-violet-500/80">
                            Scratch
                          </span>
                        ) : (
                          id !== BOARD_CONVERSATION_ID &&
                          id !== FURNACE_CONVERSATION_ID && (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
                              {task?.status ? `${id} · ${task.status}` : id}
                            </span>
                          )
                        )}
                      </span>
                    </button>
                  );
                })
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
          // FLUX-1221: reset (wipe transcript) is valid for either virtual conversation — the engine's
          // DELETE /:id/transcript already accepts both (isVirtualConversationId). No tab exposes the
          // Furnace-chat's context menu today (it's flyout/window-only, FLUX-1212), but this stays
          // correct for whenever one does instead of silently staying board-only.
          canReset={menu.id === BOARD_CONVERSATION_ID || menu.id === FURNACE_CONVERSATION_ID}
          onToggle={() => {
            toggle(menu.id);
            setMenu(null);
          }}
          onStop={() => {
            void stopSession(menu.id);
            setMenu(null);
          }}
          onReset={() => {
            void (async () => {
              if (await confirm({ title: `Reset the ${titleOf(menu.id)} conversation? This clears its chat history.`, tone: 'danger', confirmLabel: 'Reset' })) {
                void resetSession(menu.id);
              }
              setMenu(null);
            })();
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
});

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
  status,
  sessionPhase,
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
  /** Orchestrator label ("Orchestrator") — icon-only at rest, revealed on hover/focus (FLUX-1281). */
  label?: string;
  /** Ticket title — shown after the id when there's room. */
  title?: string;
  orchestrator: boolean;
  open: boolean;
  state: CardState;
  /** FLUX-1281: the ticket's board status — sources the leading PHASE glyph (ticket tabs only). */
  status?: string;
  /** FLUX-1281: the live session's launch phase — overrides `status` for the glyph while working. */
  sessionPhase?: string;
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
  const working = state === 'working';
  // FLUX-1281: the leading glyph is the lifecycle-phase icon (see STATUS_PHASE_ICON) — sourced
  // from the active session's identity while one runs, else the board status. Tint stays the
  // run-state channel (STATE_DOT); motion is gated to a live session only.
  const PhaseIcon = phaseIconFor(status, working ? sessionPhase : undefined);
  const fullLabel = orchestrator ? 'Orchestrator' : title ? `${id} — ${title}` : id;

  // Horizontal "chrome tab" — short, flat, label-bearing (vs the old square card). FLUX-1281:
  // the orchestrator drops the flex gap — its label collapses to zero width at rest (icon-first,
  // hover/focus-reveal) and a gap beside a zero-width item would leave the spark off-center.
  const base =
    `group relative flex h-9 flex-shrink-0 items-center ${orchestrator ? '' : 'gap-1.5 '}rounded-lg border pl-2 pr-2.5 text-left shadow-sm transition-all duration-150 `;
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
      onMouseDown={(e) => {
        // FLUX-757: middle-click attempts to close the tab — a no-op when onClose is absent
        // (the pinned orchestrator tab and prompt-gated chats), so the existing close-gating is
        // reused unchanged. preventDefault suppresses the browser autoscroll cursor; the
        // button===1 guard leaves left-click open, drag-to-reorder, and right-click untouched.
        if (e.button === 1) { e.preventDefault(); onClose?.(); }
      }}
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
          the gradient); a ticket gets its lifecycle-PHASE icon (FLUX-1281) — shape from the board
          status / active session, tint from the run-state (STATE_DOT). While a session is live the
          icon spins in place, except the review Eye whose pupil scans side-to-side instead (a
          spinning eye reads as broken). The label/title already carry the state for screen readers. */}
      {orchestrator ? (
        <Sparkles className="h-4 w-4 flex-shrink-0 text-amber-200 drop-shadow-[0_0_4px_rgba(253,230,138,0.55)]" />
      ) : (
        <PhaseIcon
          className={`h-3 w-3 flex-shrink-0 ${STATE_DOT[state].replace(/bg-/g, 'text-')}${
            working ? (PhaseIcon === Eye ? ' eh-eye-scan' : ' animate-spin') : ''
          }`}
          aria-hidden="true"
        />
      )}

      {/* Label: id (full, or just the number when crowded) + the real title. We no longer
          swap the label out for the live activity text while working — that buried the useful
          info. Instead a tiny thinking bubble (below) shows progress is ticking, and the
          current activity stays available on hover (tooltip). FLUX-1281: the orchestrator joins
          the dock bar's icon-first pattern — its label collapses at rest and reveals on
          hover/focus-visible (the aria-label/tooltip always carry 'Orchestrator'). */}
      <span className="flex min-w-0 items-baseline gap-1.5">
        {orchestrator ? (
          <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs font-semibold leading-none tracking-tight opacity-0 transition-all duration-200 group-hover:max-w-[130px] group-hover:pl-1.5 group-hover:opacity-100 group-focus-visible:max-w-[130px] group-focus-visible:pl-1.5 group-focus-visible:opacity-100">
            {label}
          </span>
        ) : (
          <span className="flex-shrink-0 text-xs font-semibold leading-none tracking-tight">
            {compactId ? short : id}
          </span>
        )}
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
          } ${orchestrator ? (open ? 'bg-white/90' : 'bg-white/70') : open ? 'bg-primary' : 'bg-[var(--eh-state-working)]'}`}
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

      {/* FLUX-1281: outcome corner badge — the finished/error SHAPE moved here from the old
          leading state glyph (that slot now carries the phase icon). Reuses the FLUX-720 corner +
          precedence mechanism: the pending-prompt badge above outranks it, and it suppresses the
          unread dot below — one badge owns the corner at a time. Check-in-circle vs triangle keeps
          the FLUX-819 colorblind-safe green/red split; both clear on ack (opening the chat). */}
      {!pendingPrompt && (state === 'finished' || state === 'error') && (
        <span
          aria-hidden="true"
          className={`absolute -left-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full text-white shadow ring-2 ring-[var(--eh-surface)] ${
            state === 'finished' ? 'bg-[var(--eh-state-success)]' : 'bg-[var(--eh-state-danger)]'
          }`}
        >
          {state === 'finished' ? <Check className="h-2.5 w-2.5" /> : <TriangleAlert className="h-2.5 w-2.5" />}
        </span>
      )}

      {/* Unread dot — agent said something you haven't opened since; purely "new since you last
          looked". Suppressed when the pending-prompt or outcome badge already owns this corner. */}
      {unread && !pendingPrompt && state !== 'finished' && state !== 'error' && (
        <span
          aria-hidden="true"
          className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-[var(--eh-surface)]"
        />
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
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [dismiss]);

  // FLUX-1022: routed through the shared stack — this menu is opened over an open dock window,
  // which now has its own Escape handling; sharing the stack keeps one ESC press from dismissing
  // just this menu instead of also collapsing the window underneath it.
  useEscapeKey(dismiss);

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

// FLUX-1281: BarSelect (the inline pill `<select>`) retired — its one consumer, the Assignee pill,
// moved into the metadata bar's "More" disclosure as a plain labeled select.

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
 *  (unlike a native `<select>`, where `<option>`s are text-only). Reuses BarPopover's
 *  open/close contract — outside-click + Escape close it, and `onPointerDown` is stopped so opening it
 *  never starts a window drag — and adds listbox keyboard nav (↑/↓/Home/End move, Enter/click select).
 *
 *  The metadata bar has `overflow-x-auto`, which (per CSS) forces the cross axis to clip too — so the
 *  menu MUST escape it. We position it with measured `position: fixed` coordinates from the trigger
 *  rect (same approach as CardMenu) instead of `absolute`. FLUX-1509: `position: fixed` alone isn't
 *  enough here — the dock window is a `motion.div` with an active `x`/`y`/`scale` transform (and
 *  `overflow-hidden`), and a CSS transform on an ancestor makes IT the containing block for a `fixed`
 *  descendant, so the menu was rendering offset relative to the window (wrong location) and clipped by
 *  its `overflow-hidden` (cut off) instead of overlaying the viewport. Portaling to `document.body`
 *  escapes both. */
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
      const t = e.target as Node;
      // FLUX-1509: the menu is portaled to <body>, so it's no longer a DOM descendant of `ref` —
      // check both the trigger wrapper and the portaled list before treating the click as "outside".
      if (ref.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Re-position on scroll/resize would be ideal, but the menu closes on any outside interaction,
    // so a fixed snapshot taken at open time is sufficient.
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // FLUX-1022: routed through the shared stack — this dropdown lives inside a dock window's
  // metadata bar, and that window now has its own Escape handling; sharing the stack keeps one
  // ESC press from closing just the dropdown instead of also collapsing the host window.
  useEscapeKey(() => setOpen(false), { enabled: open });

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
      {open && coords && createPortal(
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
        </div>,
        document.body,
      )}
    </div>
  );
}

/** FLUX-740: a bar control that opens a small floating panel for fields that don't fit a one-line
 *  pill (tags / implementation link / effort level). Closes on outside-click or Escape. Opens
 *  downward (the bar sits at the top of the chat column).
 *  FLUX-744: positioned with measured `position: fixed` (not `absolute`) so it escapes the metadata
 *  bar's `overflow-x-auto` clip and overlays the chat window instead of getting trapped under the bar.
 *  FLUX-1509: `fixed` alone isn't enough — the dock window is a `motion.div` with an active
 *  `x`/`y`/`scale` transform (and `overflow-hidden`), and a CSS transform on an ancestor makes IT the
 *  containing block for a `fixed` descendant. That trapped the panel inside the window: offset from
 *  its intended position (wrong location) and clipped by the window's `overflow-hidden` whenever the
 *  content ran taller than expected (cut off). Portaling to `document.body` escapes both, and the
 *  panel now caps its own height to the viewport with an internal scrollbar as a backstop. */
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
  const panelRef = useRef<HTMLDivElement>(null);

  const toggleOpen = () => {
    if (open) { setOpen(false); return; }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setCoords({ left: r.left, right: r.right, top: r.bottom + 4 });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      // FLUX-1509: the panel is portaled to <body>, so it's no longer a DOM descendant of `ref` —
      // check both the trigger wrapper and the portaled panel before treating the click as "outside".
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // FLUX-1022: routed through the shared stack — this popover lives inside a dock window's
  // metadata bar, and that window now has its own Escape handling; sharing the stack keeps one
  // ESC press from closing just the popover instead of also collapsing the host window.
  useEscapeKey(() => setOpen(false), { enabled: open });

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
      {open && coords && createPortal(
        <div
          ref={panelRef}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ left: panelLeft, top: panelTop, maxHeight: 'calc(100vh - 16px)' }}
          className="eh-border eh-surface fixed z-[60] w-64 overflow-y-auto rounded-lg border p-2.5 shadow-2xl"
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * FLUX-620 / FLUX-740: the editable ticket metadata bar under the chat window's title bar — the
 * "metadata cockpit". Holds ALL ticket fields; FLUX-1281 splits them by scan frequency: status /
 * priority stay inline pills next to the read-only branch badge (the at-a-glance trio), while
 * assignee / effort / tags / implementation link / effort level (+ the worktree readout) fold into
 * one "More" disclosure — same editable fields, one click away, nothing removed. Edits flow through
 * the shared `useTicketSideView` controller (same `updateTask` write path as the sideview), and the
 * unified dirty/save affordance lives here so it stays reachable even when the sideview panel is
 * collapsed or closed. Ticket windows only.
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
          reachable at the right edge even when the chat column is narrow and the pills overflow.
          FLUX-1281: when the ticket has a branch, ChatDiffPanel renders directly below — drop this
          bar's own border-b so the two strips merge into one continuous "ticket info" band closed
          by the diff panel's border; branchless windows keep the border as their own closer. */}
      <div className={`eh-border-subtle flex items-center gap-1.5 ${task.branch ? '' : 'border-b '}px-3 py-1.5 text-[11px]`}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <span className="flex-shrink-0 font-mono text-[var(--eh-text-muted)]">{task.id}</span>

        {/* Inline metadata pills — the at-a-glance pair. FLUX-744: status/priority use BarDropdown
            so they keep their board identity (priority icon, status color dot) — native <option>s
            can't render visuals. */}
        <BarDropdown
          title="Status"
          value={c.status}
          onChange={(v) => void c.saveField('status', v)}
          options={c.allStatuses.map((s) => ({ value: s, label: s, leading: <StatusDot config={config} status={s} /> }))}
          triggerLeading={<StatusDot config={config} status={c.status} />}
          className={getStatusColorClass(config, c.status)}
        />
        <BarDropdown
          title="Priority"
          value={c.priority}
          onChange={(v) => void c.saveField('priority', v)}
          options={c.availablePriorities.map((p) => ({ value: p.name, label: p.name, leading: getPriorityIcon(p.name, config, 'h-3 w-3') }))}
          triggerLeading={getPriorityIcon(c.priority, config, 'h-3 w-3')}
          className="eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-secondary)]"
        />

        {/* Read-only branch display. FLUX-1281: the inline ↑ahead/↓behind counters left the pill
            face — the pill's own tooltip now carries them, so the info survives the cleanup. */}
        {branchName && (
          <span
            className="flex min-w-0 flex-shrink-0 items-center gap-1 text-[var(--eh-text-secondary)]"
            title={ahead > 0 || behind > 0 ? `${branchName} — ${ahead} ahead, ${behind} behind master` : branchName}
          >
            <GitBranch className="h-3 w-3 flex-shrink-0" />
            <span className="max-w-[120px] truncate font-mono">{branchName}</span>
          </span>
        )}

        {/* FLUX-1281: the rarely-scanned fields fold into one disclosure, one click away.
            FLUX-979: every field here saves INSTANTLY on change via `c.saveField` — it never joins
            the pinned Save/Discard dirty flow (that's now title/body/hierarchy-edits only), so
            picking one of these never leaves the ticket in an unclear "unsaved" state. Worktree
            (read-only) rides along from the old inline strip. */}
        <BarPopover label="More" icon={Ellipsis} title="More fields — assignee, effort, tags, link, effort level" align="right">
          <div className="flex flex-col gap-2.5">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Assignee</label>
              <select
                value={c.assignee}
                onChange={(e) => void c.saveField('assignee', e.target.value)}
                className="eh-border w-full cursor-pointer rounded-md border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-primary"
              >
                <option value="unassigned">Unassigned</option>
                {c.allUsers.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Effort</label>
              <select
                value={c.effort}
                onChange={(e) => void c.saveField('effort', e.target.value)}
                className="eh-border w-full cursor-pointer rounded-md border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-primary"
              >
                {EFFORT_OPTIONS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Tags</label>
              {config && (
                <TagSelector tags={c.tags} onChange={(next) => void c.saveField('tags', next)} availableTags={c.allTags} configTags={config.tags} />
              )}
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Implementation Link</label>
              <input
                value={c.implementationLink}
                onChange={(e) => c.setImplementationLink(e.target.value)}
                onBlur={() => void c.saveField('implementationLink', c.implementationLink)}
                placeholder="https://github.com/..."
                className="eh-border w-full rounded-md border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Effort Level</label>
              <select
                value={c.effortLevel}
                onChange={(e) => void c.saveField('effortLevel', e.target.value)}
                className="eh-border w-full cursor-pointer rounded-md border bg-[var(--eh-input-bg)] px-2 py-1 text-[12px] outline-none focus:border-primary"
              >
                {EFFORT_LEVEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            {worktree && (
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">Worktree</label>
                <span className="flex items-center gap-1 text-[11px] text-[var(--eh-text-secondary)]" title={worktree}>
                  <FolderGit2 className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{worktree}</span>
                </span>
              </div>
            )}
          </div>
        </BarPopover>
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
  // FLUX-979: native "Leave site?" guard for a tab-close/refresh/navigation with an unsaved
  // title/body/hierarchy edit — metadata fields never contribute to `isDirty` any more (they save
  // instantly via `saveField`), so this only fires for genuine free-text edits.
  useUnsavedChangesGuard(c.isDirty);
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

// Canned prompt fired by the "Board Health" quick action (FLUX-966). The live signals fragment
// (computed engine-side just before send — see BoardHealthAction below) is prepended to this ask.
const BOARD_HEALTH_ASK =
  'Reason over the signals above. If the board needs tidying, call propose_board_rebase with a ' +
  "batch of items (one per flagged ticket or group) referencing those same ticket ids/facts — " +
  "don't invent claims beyond what's listed and don't mutate the board directly. If nothing above " +
  'warrants action, just say the board looks healthy.';

/** Fallback ask when the engine failed to compute signals (network/engine hiccup) — still asks
 *  the orchestrator to look, but makes clear no live numbers were injected this turn. */
const BOARD_HEALTH_FALLBACK_ASK =
  'Board Health signal computation failed (engine error) — no live staleness numbers this turn. ' +
  'Take a quick unguided look for stale Grooming/Require Input tickets, orphaned subtasks, ' +
  'duplicate titles, and Ready tickets with a dead/missing PR, and call propose_board_rebase if ' +
  'anything genuinely needs tidying. Say so if nothing stands out.';

/**
 * Board-chat-only quick action (FLUX-966): computes fresh staleness signals in the engine (stale
 * Grooming/Require Input tickets, orphaned subtasks, duplicate titles, dead/missing PRs on Ready
 * tickets) and bakes them into a canned prompt so the orchestrator reasons over concrete facts
 * before calling propose_board_rebase — instead of eyeballing the whole board and guessing.
 * Distinct from the FLUX-637 `TriageAction` above (which ranks the Todo column); this one feeds
 * the board-rebase ritual. Disabled while computing OR while a turn is in flight (double-fire guard,
 * same `busy` contract as TriageAction).
 */
function BoardHealthAction({ busy, onFire }: { busy: boolean; onFire: (prompt: string) => void }) {
  const [computing, setComputing] = useState(false);

  const onClick = async () => {
    setComputing(true);
    try {
      const fragment = await fetchTriageSignals();
      onFire(fragment ? `${fragment}\n\n${BOARD_HEALTH_ASK}` : BOARD_HEALTH_FALLBACK_ASK);
    } finally {
      setComputing(false);
    }
  };

  const busyOrComputing = busy || computing;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busyOrComputing}
        title="Compute real staleness signals (stale tickets, orphaned subtasks, duplicate titles, dead PRs) and propose a board-rebase"
        className="eh-border inline-flex items-center gap-1 rounded-md border bg-[var(--eh-input-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--eh-text-primary)] transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/5"
      >
        {busyOrComputing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />}
        Board Health
      </button>
    </div>
  );
}

// FLUX-1200: memoized so an unrelated DockState change (typing a draft in another chat, dragging
// the sideview divider, reordering tabs) doesn't re-render every OTHER open window — ChatDock itself
// reads the wide DockStateContext via `useDock()` and re-renders in full on any such change, but each
// ChatWindow instance now bails out unless its OWN props changed. This only works because the
// callback props below are the raw, referentially-stable DockActions (see the call site in ChatDock),
// not a fresh per-id closure — a new closure every render would defeat this memo entirely.
/** FLUX-1283: the chat window's draggable header bar — icon + title slot + the row of task/window
 *  action buttons. Extracted so the title slot (plain text for the orchestrator/Furnace-chat windows,
 *  an editable input bound to the shared ticket controller for task windows) can differ between
 *  `ChatWindow`'s task-bound and taskless render branches without duplicating the button JSX in both. */
function ChatWindowHeader({
  id,
  orchestrator,
  isFurnaceChat,
  task,
  titleSlot,
  startDrag,
  onToggleSideView,
  sideViewOpen,
  onMinimize,
  canClose,
  onClose,
  openTaskFullView,
  onResetConversation,
}: {
  id: string;
  orchestrator: boolean;
  isFurnaceChat: boolean;
  task?: Task;
  titleSlot: ReactNode;
  startDrag: (e: React.PointerEvent) => void;
  onToggleSideView?: (id: string) => void;
  sideViewOpen: boolean;
  onMinimize: (id: string) => void;
  canClose: boolean;
  onClose?: (id: string) => void;
  openTaskFullView: (task: Task) => void;
  onResetConversation: () => void;
}) {
  return (
    <div
      onPointerDown={startDrag}
      className="eh-border-subtle flex cursor-move select-none items-center justify-between border-b px-3.5 py-2.5 pr-9"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-semibold text-[var(--eh-text-primary)]">
        {orchestrator ? (
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
        ) : isFurnaceChat ? (
          <Flame className="h-3.5 w-3.5 flex-shrink-0" style={{ color: FURNACE_ACCENT }} />
        ) : (
          <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-[var(--eh-text-muted)]" />
        )}
        {titleSlot}
      </div>
      {/* FLUX-1281: the button row reads as two clusters split by a hairline — a VIEW group (reset /
          full-view / sideview: things about seeing the ticket) and a WINDOW group (minimize / close:
          things about this floating window). Same buttons, same order, same click targets. */}
      <div className="flex flex-shrink-0 items-center gap-0.5">
        {/* FLUX-1234: the Smelter's drafting/operator authority toggle lives here — in the Smelter
            chat header, the surface where that authority is exercised — instead of the Furnace
            drawer. Persists workspace-wide to config.furnaceSettings.smelterMode. Furnace chat only.
            Leading, outside both groups; its onPointerDown stopPropagation keeps the drag-to-move
            header from swallowing its clicks. */}
        {isFurnaceChat && (
          <div className="mr-1.5" onPointerDown={(e) => e.stopPropagation()}>
            <SmelterModeToggle />
          </div>
        )}
        <span className="flex items-center gap-0.5">
          {/* Orchestrator can't be closed (it's pinned) — instead it can be reset to a clean
              slate: stop the live turn and wipe the transcript. FLUX-1221: the Furnace-chat gets the
              same affordance here — it's the one reachable reset surface, since (by design, FLUX-1212)
              it has no strip tab and therefore no tab context-menu to reset from. */}
          {(orchestrator || isFurnaceChat) && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onResetConversation}
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
              onClick={() => { openTaskFullView(task); onMinimize(id); }}
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
              onClick={() => onToggleSideView(id)}
              title={sideViewOpen ? 'Hide ticket panel' : 'Show ticket panel'}
              aria-pressed={sideViewOpen}
              className={`rounded-md p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
                sideViewOpen ? 'text-primary' : 'text-[var(--eh-text-muted)] hover:text-[var(--eh-text-primary)]'
              }`}
            >
              {sideViewOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRight className="h-3.5 w-3.5" />}
            </button>
          )}
        </span>
        <span aria-hidden="true" className="mx-1 h-4 w-px flex-shrink-0 bg-[var(--eh-border)]" />
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onMinimize(id)}
            title="Minimize"
            className="rounded-md p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          {canClose && onClose && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onClose(id)}
              title="Close (move to recent chats)"
              className="rounded-md p-1 text-[var(--eh-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500 dark:hover:bg-red-500/15"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/** FLUX-1418/FLUX-1506: cheap placeholder shown in place of the heavy transcript/sideview content
 *  while `ChatWindow` defers mounting it past the open spring (or before the shrink-close exit).
 *  Ghost message rows (alternating alignment, like the transcript it's standing in for) replace the
 *  old centered spinner. */
function ChatWindowLoadingShell() {
  const widths = ['w-2/3', 'w-1/2', 'w-3/5', 'w-2/5'];
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden p-4" aria-busy="true" aria-label="Loading conversation">
      {widths.map((w, i) => (
        <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
          <Skeleton variant="bar" className={`h-9 ${w} max-w-[75%] !rounded-2xl`} />
        </div>
      ))}
    </div>
  );
}

const ChatWindow = memo(function ChatWindow({
  id,
  orchestrator,
  isTopmost,
  task,
  session,
  anchorX,
  originRect,
  onRaise,
  working,
  activity,
  draft,
  onDraftChange,
  selections,
  onSelectionsChange,
  sideViewOpen = false,
  onToggleSideView,
  onOpenArtifact,
  sideviewWidth = DEFAULT_SIDEVIEW_WIDTH,
  setSideviewWidth,
  seedSideviewWidth,
  windowGeometry,
  onGeometryChange,
  planApprovalPanelOpen = false,
  planApprovalPanelNonce = 0,
  onClosePlanApproval,
  onMinimize,
  canClose = true,
  onClose,
}: {
  id: string;
  orchestrator: boolean;
  /** FLUX-1022: whether this is the frontmost window in the dock's paint order — gates the
   *  ESC-to-collapse hook so only the top-most/focused window responds to a press. */
  isTopmost: boolean;
  /** The ticket this window is bound to (absent for the orchestrator → no action bar). */
  task?: Task;
  /** FLUX-686: the CLI session backing this conversation, for the quiet token/cost meter. */
  session?: CliSessionSummary | null;
  anchorX?: number;
  /** FLUX-801: the clicked card's on-screen rect, captured at open time — the pop-open animation
   *  grows the window out of it (and shrinks back to it on close). Absent → a plain scale/fade. */
  originRect?: AnchorRect;
  /** FLUX-801: bring this window to the front of the dock paint order (called on mousedown). */
  onRaise?: (id: string) => void;
  working: boolean;
  activity: string | null;
  /** FLUX-623: persisted unsent composer text for this conversation (survives minimize). */
  draft: string;
  onDraftChange: (id: string, text: string) => void;
  /** FLUX-666: persisted composer chip selections (model/effort/permission) for this
   *  conversation (survives minimize, alongside the text draft). */
  selections?: ComposerSelections;
  onSelectionsChange: (id: string, selections: ComposerSelections) => void;
  /** FLUX-734: whether the ticket sideview panel is expanded beside the chat (ticket windows only). */
  sideViewOpen?: boolean;
  /** FLUX-734: toggle the ticket sideview panel. Absent for the orchestrator (no bound task). */
  onToggleSideView?: (id: string) => void;
  /** FLUX-887: idempotently open the sideview + its Grooming Artifact section (the inline artifact
   *  card's "Open in panel" action). Absent for the orchestrator (no bound task). */
  onOpenArtifact?: (id: string) => void;
  /** FLUX-740: live, persisted width of the sideview panel (set by the chat↔panel divider). */
  sideviewWidth?: number;
  /** FLUX-740: commit a new sideview width (clamped + persisted in DockProvider). */
  setSideviewWidth?: (width: number) => void;
  /** FLUX-744: seed a proportional (~45%) sideview width from the chat column at open time, bounded
   *  by `maxWidth` so the grown window fits the viewport (no-op once the user has set a width). */
  seedSideviewWidth?: (chatWidth: number, maxWidth?: number) => void;
  /** FLUX-920: this conversation's persisted window footprint (size + dragged position), or undefined
   *  if it has never been resized/moved. Seeds `size`/`pos` on mount only (clamped to the viewport). */
  windowGeometry?: WindowGeometry;
  /** FLUX-920: commit a window-footprint change (merge-patched + persisted in DockProvider). Called on
   *  the resize-grip commit (`{w,h}`) and the title-bar drag commit (`{left,bottom}`). */
  onGeometryChange?: (id: string, geom: Partial<WindowGeometry>) => void;
  /** FLUX-1273: whether the full-screen plan-approval panel is open for THIS window's ticket. */
  planApprovalPanelOpen?: boolean;
  /** FLUX-1381: bumps on every `openPlanApproval` call for THIS window's ticket (0 while it isn't
   *  the open one). A repeat open of the already-open id leaves `planApprovalPanelOpen` unchanged,
   *  so this is what re-fires the minimize-reset effect and restores a minimized panel. */
  planApprovalPanelNonce?: number;
  /** FLUX-1273: close the plan-approval panel (stable DockActions reference — see the FLUX-1200 memo note above). */
  onClosePlanApproval?: () => void;
  onMinimize: (id: string) => void;
  /** FLUX-1200: whether the close (X) affordance is enabled — replaces the old pattern of the
   *  parent passing `onClose={undefined}` to disable it, which required a fresh closure per-id. */
  canClose?: boolean;
  /** Retire the card into History and close the window. Absent for the pinned orchestrator. */
  onClose?: (id: string) => void;
}) {
  // FLUX-1209: the Furnace-chat window — reuses the plain (non-orchestrator, taskless) window
  // chrome below, with a few Smelter-specific fallbacks (title, empty-state hint) computed off
  // `id` directly rather than threading a new prop through every caller.
  const isFurnaceChat = id === FURNACE_CONVERSATION_ID;
  // FLUX-1580: `__board__`/`__furnace__` are the SAME id across every workspace, so an already-open
  // window needs an explicit signal that the active board switched under it — see useChatSession's
  // `workspaceKey` param. Per-ticket windows pass `undefined` (unaffected, byte-for-byte unchanged).
  const isVirtualConversationWindow = id === BOARD_CONVERSATION_ID || isFurnaceChat;
  const activeBoardId = useAppSelector((s) => s.activeBoardId);
  // FLUX-1022: ESC collapses this floating chat window back to its dock card (session preserved,
  // never destroyed) — but only while it's the frontmost window, so a press doesn't reach into
  // background windows.
  useEscapeKey(() => onMinimize(id), { enabled: isTopmost });
  const confirm = useConfirm();
  const currentUser = useAppSelector((s) => s.currentUser);

  const config = useAppSelector((s) => s.config);
  // FLUX-801: pop-open / shrink-close animation. Gated on the shared `instant` flag (animations
  // disabled OR prefers-reduced-motion), matching the TaskCard/TaskModal precedent. When instant,
  // the window renders statically (no initial/animate/exit) — zero behavior change from before.
  // FLUX-1507: sourced from the centralized token hook — this used to call its own
  // `useReducedMotion()` alongside a local `speedMap`; both now live in `useMotionTokens`.
  const tokens = useMotionTokens();
  const animateWindow = !tokens.instant;
  // FLUX-1418: defer mounting the heavy content (ChatView transcript, TicketSideView,
  // ChatDiffPanel) until the open spring settles, so the synchronous mount cost doesn't land on
  // the animation's first frames. FLUX-1523 changed the OTHER half of this optimization: it used
  // to swap back to the cheap shell the instant a minimize started exiting; now it swaps back only
  // once that close *commits* (runs to completion uninterrupted) — see `contentMounted` below —
  // because tearing the heavy subtree down at close-start would force an expensive remount that
  // competes with the spring if the close gets interrupted by a re-open. `hasEverMounted` starts
  // true when animations are off (nothing to defer past). `useIsPresent` (not `usePresence`) is
  // read-only — it never registers as a removal blocker, so it can't strand this window mounted
  // after an exit finishes.
  const isPresent = useIsPresent();
  const [settled, setSettled] = useState(() => !animateWindow);
  // FLUX-1523: FLUX-1418 used to be one boolean (`settled`) driving BOTH the heavy-content mount
  // gate and the FLUX-1420 SSE-buffer gate — fine for a single uninterrupted open→close, but a
  // rapid re-open mid-close thrashed both: the mount gate tore down `ChatDiffPanel`/`ChatView`
  // just to remount them a frame later (perf regression), and the buffer gate could flip on/off
  // fast enough to risk a dropped commit. Split into two latches:
  //  - `hasEverMounted` — one-way; flips true the first time content settles in and never reverts.
  //    Combined with `closeCommitted` below, this keeps heavy content mounted THROUGH an
  //    interrupted close (re-open before the exit finishes) since there is nothing to remount.
  //  - `closeCommitted` — flips true only when a close's exit animation runs to completion
  //    (uninterrupted), and resets on the next reopen so the following close can re-commit.
  // `settled` itself is unchanged — it still oscillates with the spring and still drives the
  // FLUX-1420 SSE-buffer gate (`!settled` at the `useChatSession` call below) and the immediate-
  // hydration Cmd/Ctrl+F escape hatch, independent of the mount gate.
  const [hasEverMounted, setHasEverMounted] = useState(() => !animateWindow);
  const [closeCommitted, setCloseCommitted] = useState(false);
  // Heavy content (ChatDiffPanel / ChatView / TicketSideView) stays mounted once it has ever
  // arrived, through any interrupted close, and only tears down once a close actually commits.
  const contentMounted = hasEverMounted && !closeCommitted;
  // `useLayoutEffect` (not `useEffect`): the heavy-subtree teardown this drives must land in the
  // SAME commit that removes this window from `open`, one tick ahead of framer-motion's own
  // (rAF-driven) exit start — a passive effect would let at least one exit frame paint with the
  // heavy content still mounted before swapping to the cheap shell.
  useLayoutEffect(() => {
    if (isPresent) {
      // A genuine reopen (not merely an interrupted close retargeting back to `animate`) — clear
      // the prior cycle's commit latch so the next close can commit again.
      setCloseCommitted(false);
    } else {
      setSettled(false);
    }
  }, [isPresent]);
  useEffect(() => {
    if (settled || !animateWindow) return;
    // Belt-and-suspenders: `onAnimationComplete` below normally flips this; this guards against a
    // dropped/interrupted animation event stranding the window on the empty shell forever. Also
    // latches `hasEverMounted` — the mount gate (`contentMounted` above) now keys off that latch,
    // not `settled`, so without this the fallback would declare the window settled while leaving
    // it stuck on `ChatWindowLoadingShell`. Harmless if this fires mid-close: `contentMounted`
    // during a close keys off `closeCommitted`, not `hasEverMounted`, which is one-way regardless.
    const timer = setTimeout(() => {
      setSettled(true);
      setHasEverMounted(true);
    }, tokens.springSettleMs);
    return () => clearTimeout(timer);
  }, [settled, animateWindow, tokens.springSettleMs]);
  const handleAnimationComplete = useCallback(() => {
    if (isPresent) {
      setSettled(true);
      setHasEverMounted(true);
    } else {
      // This fires on THIS element's exit animation reaching completion — which only happens when
      // the close ran uninterrupted (an interrupted close retargets the same node back toward
      // `animate` and this callback fires with `isPresent` true instead, above). Prefer this over
      // a timer: a re-open that preempts the exit simply never reaches this branch.
      setCloseCommitted(true);
    }
  }, [isPresent]);

  // FLUX-748: pass `working` (live running session) so the hook's message queue auto-dispatches
  // on the turn-completion edge. FLUX-1420: also pass the animating flag (the open/minimize spring
  // is in flight while `!settled`) so the hook can buffer SSE-driven commits until it settles.
  const chat = useChatSession(id, true, working, !settled, isVirtualConversationWindow ? activeBoardId : undefined);
  const allTasks = useAppSelector((s) => s.tasks) as Task[];

  // FLUX-1339/1362: chat-scoped plan-review panel state. The panel opens as an own full-screen
  // surface (a maximizable FloatingPanel, default-maximized — FLUX-1362 deliberately reversed the
  // FLUX-1339 chat-body clamp because a small box is illegible for a plan), minimizes to a strip
  // near the composer, and its unsent-note draft guards the window close. `planMinimized` is local
  // (transient UI); the guard reads the module-level draft store so it works whether or not the
  // panel is mounted. Re-expand whenever the panel is (re)opened/closed from the dock/sideview —
  // FLUX-1381: also keyed on the nonce, which is what changes when "open plan" is clicked for a
  // ticket whose panel is ALREADY open but minimized (the boolean stays true in that case, so it
  // alone left the panel stuck hidden).
  const [planMinimized, setPlanMinimized] = useState(false);
  useEffect(() => { setPlanMinimized(false); }, [planApprovalPanelOpen, planApprovalPanelNonce]);
  const [closeGuard, setCloseGuard] = useState(false);
  const unsentPlanCount = planReviewDraftCount(id);
  // FLUX-923: composer-as-answer. A parked single-question ask_user_question for THIS chat (its own id,
  // or — via the resilience net — an unrouted prompt claimed by the single live chat) can be answered
  // straight from the composer in addition to the picker's chips. Shared hook (see useComposerAnswer).
  const { answerPrompt, onAnswerQuestion } = useComposerAnswer(id);
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
  // FLUX-805: a "suggest a supervisor run" proposal from the chat agent's latest turn takes precedence
  // over Require-Input quick replies, rendering as a one-click confirm chip (see chatRunProposal). Works
  // for a bound ticket chat or the board orchestrator chat alike — it's keyed off the transcript, not the task.
  const runProposal = useMemo(() => parseRunProposal(chat.messages), [chat.messages]);
  const quickReplies = useMemo(
    () =>
      runProposal
        ? [{ label: runProposal.label, value: runProposal.confirm, tone: 'primary' as const }]
        : task
          ? parseQuickReplies(task, requireInputStatus)
          : [],
    [runProposal, task, requireInputStatus],
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
  // FLUX-920: seed from the persisted footprint when present (a prior resize), else the larger default.
  // Either way the seed is clamped to the live viewport (the same bound the resize grip enforces) so a
  // geometry saved on a bigger monitor can never reopen larger than — or off — the current screen.
  const [size, setSize] = useState(() => {
    const maxW = typeof window !== 'undefined' ? window.innerWidth - 16 : CHAT_WINDOW_WIDTH;
    const maxH = typeof window !== 'undefined' ? window.innerHeight - 100 : CHAT_WINDOW_HEIGHT;
    const w = windowGeometry?.w ?? CHAT_WINDOW_WIDTH;
    const h = windowGeometry?.h ?? CHAT_WINDOW_HEIGHT;
    return {
      w: Math.max(MIN_WINDOW_WIDTH, Math.min(w, maxW)),
      h: Math.max(MIN_WINDOW_HEIGHT, Math.min(h, maxH)),
    };
  });
  // Dragged position as a `{left, bottom}` pair (FLUX-603) — bottom-pinned like the spawn
  // default, so the existing top-right resize math is unchanged. `null` until first drag,
  // when it falls back to the anchored spawn position below.
  // FLUX-920: seed from the persisted position when present (a prior drag); the render-derived
  // `left`/`bottom` below clamp it into the live viewport, so a stale off-screen value self-corrects.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(() =>
    windowGeometry && windowGeometry.left != null && windowGeometry.bottom != null
      ? { left: windowGeometry.left, bottom: windowGeometry.bottom }
      : null,
  );

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

  // Transform that visually places the (full-size) window at the clicked card: shrink to ~card width
  // and translate so the scaled window centers on the card. Pure transforms (x/y/scale) layered over
  // the fixed left/bottom positioning, so they never fight Rnd-style left/top math or the drag/resize
  // handlers (which run only after the animation settles back to the identity transform).
  const originTransform = useMemo(() => {
    if (!originRect) return null;
    const restingTop = viewport.h - bottom - size.h;
    const dx = originRect.left + originRect.width / 2 - (left + outerW / 2);
    const dy = originRect.top + originRect.height / 2 - (restingTop + size.h / 2);
    const scale = Math.max(0.1, Math.min(1, originRect.width / outerW));
    return { x: dx, y: dy, scale, opacity: 0 };
    // `left`/`bottom`/`outerW`/`size.h`/viewport are intentional deps so a re-clamp keeps the origin
    // honest; `initial` is only read on mount so this only matters for the exit snapshot.
  }, [originRect, left, bottom, outerW, size.h, viewport.h]);
  // Fallback when there's no source rect (e.g. reopened without an element): a gentle scale/fade.
  const restState = { scale: 0.94, opacity: 0, y: 16 };
  const motionProps = animateWindow
    ? {
        initial: originTransform ?? restState,
        animate: { x: 0, y: 0, scale: 1, opacity: 1, transition: tokens.spring },
        exit: { ...(originTransform ?? restState), transition: tokens.fade },
      }
    : {};

  // FLUX-821: Cmd/Ctrl+F must never silently no-op while content is deferred — force immediate
  // hydration so ChatView's own find-shortcut handler (mounted only once `contentMounted`, FLUX-1523)
  // takes over.
  useEffect(() => {
    if (contentMounted || !isTopmost) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setHasEverMounted(true);
        setSettled(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contentMounted, isTopmost]);

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
    // FLUX-920: track the last committed position so we can persist it on pointer-up (and only when
    // the title bar actually moved, so a plain click that raises the window doesn't write a position).
    let lastLeft = baseLeft;
    let lastBottom = baseBottom;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const maxLeft = (typeof window !== 'undefined' ? window.innerWidth : 1280) - outerW - 8;
      const maxBottom = (typeof window !== 'undefined' ? window.innerHeight : 800) - size.h - 8;
      const nLeft = Math.max(8, Math.min(baseLeft + (ev.clientX - startX), maxLeft));
      const nBottom = Math.max(8, Math.min(baseBottom - (ev.clientY - startY), maxBottom));
      lastLeft = nLeft;
      lastBottom = nBottom;
      moved = true;
      setPos({ left: nLeft, bottom: nBottom });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // FLUX-920: persist the dragged position so it survives minimize/reopen + reload.
      if (moved) onGeometryChange?.(id, { left: lastLeft, bottom: lastBottom });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // FLUX-1461: generalized resize — drag any of the 4 corners or 4 edges. The window is
  // bottom-left pinned (`left`/`bottom`), so whichever edge(s) the handle does NOT touch stay
  // anchored: dragging the right/top edges only grows w/h (as the original top-right grip did);
  // dragging the left/bottom edges also has to move `left`/`bottom` to keep the OPPOSITE corner
  // anchored. To avoid the anchored corner drifting under clamping, we clamp the moving `left`/
  // `bottom` value first (against the fixed opposite edge + the min/max bounds) and *derive* w/h
  // from that clamped position, rather than clamping w/h and left/bottom independently.
  function startResize(e: React.PointerEvent, handle: 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r') {
    e.preventDefault();
    e.stopPropagation();
    const doTop = handle === 'tl' || handle === 'tr' || handle === 't';
    const doBottom = handle === 'bl' || handle === 'br' || handle === 'b';
    const doLeft = handle === 'tl' || handle === 'bl' || handle === 'l';
    const doRight = handle === 'tr' || handle === 'br' || handle === 'r';
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;
    const startLeft = left;
    const startBottom = bottom;
    const rightEdge = startLeft + startW; // anchor when dragging the left edge
    const topFromBottom = startBottom + startH; // anchor (top edge) when dragging the bottom edge
    const maxW = (typeof window !== 'undefined' ? window.innerWidth : 1280) - 16 - (showSideView ? sideviewWidth : 0);
    const maxH = (typeof window !== 'undefined' ? window.innerHeight : 800) - 100;
    // FLUX-920: track the last committed geometry so we can persist it on pointer-up (and only
    // when the handle actually moved, so a no-op click doesn't write).
    let lastW = startW;
    let lastH = startH;
    let lastLeft = startLeft;
    let lastBottom = startBottom;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let w = startW;
      let h = startH;
      let nLeft = startLeft;
      let nBottom = startBottom;
      if (doRight) {
        w = Math.max(MIN_WINDOW_WIDTH, Math.min(startW + dx, maxW));
      } else if (doLeft) {
        const minLeft = Math.max(8, rightEdge - maxW);
        const maxLeft = rightEdge - MIN_WINDOW_WIDTH;
        nLeft = Math.max(minLeft, Math.min(startLeft + dx, maxLeft));
        w = rightEdge - nLeft;
      }
      if (doTop) {
        h = Math.max(MIN_WINDOW_HEIGHT, Math.min(startH - dy, maxH));
      } else if (doBottom) {
        const minBottom = Math.max(8, topFromBottom - maxH);
        const maxBottom = topFromBottom - MIN_WINDOW_HEIGHT;
        nBottom = Math.max(minBottom, Math.min(startBottom - dy, maxBottom));
        h = topFromBottom - nBottom;
      }
      lastW = w;
      lastH = h;
      lastLeft = nLeft;
      lastBottom = nBottom;
      moved = true;
      setSize({ w, h });
      if (doLeft || doBottom) setPos({ left: nLeft, bottom: nBottom });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // FLUX-920: persist the resized footprint (and any position shift) so it survives
      // minimize/reopen + reload.
      if (moved) {
        const patch: Partial<WindowGeometry> = { w: lastW, h: lastH };
        if (doLeft || doBottom) {
          patch.left = lastLeft;
          patch.bottom = lastBottom;
        }
        onGeometryChange?.(id, patch);
      }
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

  // FLUX-803: live subagent run group for this ticket window (no task → orchestrator board chat,
  // which has no per-ticket cliSessions, so it stays null and both surfaces are absent).
  const runGroup = useMemo(() => (task ? selectChatRunGroup(task) : null), [task]);
  const runActive = !!runGroup && runGroup.sessions.some(isActiveSession);
  const openRun = () => { if (task) openTaskFullView(task); };
  const stopOne = (sessionId: string) => { void stopTaskCliSession(id, { sessionId }); };
  const stopAll = () => { if (runGroup) void stopTaskCliSession(id, { groupId: runGroup.groupId }); };

  // FLUX-839: cold-open choice for the BOARD orchestrator only. When there's a prior transcript
  // (messages already loaded) but no live/resumable session — e.g. the engine restarted and the
  // board session is gone — the next plain Send silently cold-starts and auto-re-primes from the
  // saved board transcript (FLUX-838). We surface that fork explicitly: Resume (the default — plain
  // Send already resumes) vs Start fresh (wipe the transcript so the next send is a clean context).
  // Gated on `messages.length > 0` so it never flashes before the transcript loads, and hidden the
  // moment a session is live/resumable. `coldDismissed` lets "Resume" tuck the strip away.
  const [coldDismissed, setColdDismissed] = useState(false);
  const cold =
    orchestrator && !working && !session?.resumable && chat.messages.length > 0 && !coldDismissed;
  // Re-arm the cold-open choice when the session goes warm again. Without this, a no-draft "Resume"
  // dismiss latches `coldDismissed` for the ChatWindow lifetime, so a *second* cold (e.g. another
  // engine restart in the same session) would never re-offer the strip (FLUX-860).
  useEffect(() => {
    if (working || session?.resumable) setColdDismissed(false);
  }, [working, session?.resumable]);
  const coldResumeChoice = cold ? (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-2.5 py-2 text-[12px]">
      <span className="text-[var(--eh-text-secondary)]">
        Previous conversation found — resume it, or start a clean context?
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            // Plain Send already resumes (FLUX-838 re-prime). If the user has typed a draft, send it
            // now; otherwise just tuck the strip away and let them type — either way it's a resume.
            const text = (draft ?? '').trim();
            if (text) {
              void chat.send(draft);
              onDraftChange(id, '');
            }
            setColdDismissed(true);
          }}
          title="Continue the previous conversation (your next message is fed the prior context)"
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15"
        >
          <Play className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          Resume conversation
        </button>
        <button
          type="button"
          onClick={() => {
            // Destructive: clears the durable board transcript so the next send is a genuinely clean
            // context (no re-prime). Confirm — same one-way action as the header "Reset conversation".
            void (async () => {
              if (await confirm({ title: 'Start a fresh context? This clears the board conversation history.', tone: 'danger', confirmLabel: 'Reset' })) {
                void chat.reset();
              }
            })();
          }}
          title="Discard the previous conversation and start a clean context"
          className="inline-flex items-center gap-1 rounded-md border border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--eh-text-secondary)] transition-colors hover:bg-black/5 dark:hover:bg-white/5"
        >
          <RotateCcw className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
          Start fresh
        </button>
      </div>
      <span className="text-[10px] text-[var(--eh-text-muted)]">Sending a message resumes the previous conversation.</span>
    </div>
  ) : undefined;

  // FLUX-1585: a plan-gate run owns this ticket (active or parked — see `isPlanGateInFlight`'s doc)
  // — any incoming user text belongs to the grooming revise, never to whatever `phase:'review'`
  // session `chat`/`routeToChat` would otherwise resume (the FLUX-1560 incident: a resumed reviewer
  // session absorbed the user's annotations and self-approved its own edit). `false` for the
  // orchestrator/Furnace windows (`task` is undefined there — this gate is per-ticket only).
  const planGateOwnsInput = !!task && isPlanGateInFlight(task);
  const dispatchAsRevise = useCallback((text: string) => {
    if (!task) return;
    revisePlan(task.id, currentUser, text).catch((err) => {
      console.error(`Failed to route chat input to a plan revise for ${task.id}:`, err);
    });
  }, [task, currentUser]);

  // The chat surface itself is identical for orchestrator + ticket windows; only the surrounding
  // chrome (metadata bar, diff panel, sideview) differs, so it's built once and reused in both
  // branches of the body below.
  // FLUX-1339: route text into THIS chat — enqueue behind a live turn (FIFO), else send straight
  // away. Shared by the sideview, the plan panel, and the close-guard's "Send now".
  const routeToChat = (text: string) => {
    if (planGateOwnsInput) { dispatchAsRevise(text); return; }
    if (working || chat.busy) chat.enqueue(text);
    else void chat.send(text);
  };

  // FLUX-1585: the composer's own Send/Enqueue wrap the same gate — a plain typed chat message is
  // "mid-gate user input" exactly as much as a routed annotation is (AC #3). `handleSend` keeps
  // `chat.send`'s Promise return so the composer's busy/error handling is unaffected either way.
  const handleSend = useCallback((text: string, opts?: ChatSendOptions) => {
    if (planGateOwnsInput) { dispatchAsRevise(text); return Promise.resolve(); }
    return chat.send(text, opts);
  }, [planGateOwnsInput, dispatchAsRevise, chat]);
  const handleEnqueue = useCallback((text: string, opts?: ChatSendOptions) => {
    if (planGateOwnsInput) { dispatchAsRevise(text); return; }
    chat.enqueue(text, opts);
  }, [planGateOwnsInput, dispatchAsRevise, chat]);

  // FLUX-1339: flush the ticket's unsent plan-review draft into this chat (the guard's "Send now"),
  // then clear it so it can't re-prompt.
  const flushPlanNotesToChat = () => {
    const { annotations, notes } = loadPlanReviewDraft(id);
    const text = formatRegroomNotes(annotations, notes);
    if (text) routeToChat(text);
    clearPlanReviewDraft(id);
  };

  // FLUX-1339: guard the window close — closing a chat with unsent plan notes prompts (send now /
  // keep for later / discard) instead of stranding the draft out of view. No draft → close directly.
  const guardedClose = () => {
    if (!onClose) return;
    if (planReviewDraftCount(id) > 0) { setCloseGuard(true); return; }
    onClose(id);
  };

  // FLUX-1339: the minimized plan-review strip — pinned above the composer while the floating panel
  // is collapsed. Shows the unsent-note count + live agent status (revising / waiting / idle), all
  // derived from state this window already holds. Clicking it restores the panel at its last size.
  const planStripStatus: 'revising' | 'waiting' | 'idle' = working
    ? 'revising'
    : (isRequireInput || (task ? isPlanApprovalPending(task, config) : false))
      ? 'waiting'
      : 'idle';
  // FLUX-1362: revision metadata for the in-stream "new revision" markers (woven into the transcript
  // by publish time). Memoized so ChatView's markdown-heavy rows memo isn't busted every render.
  const artifactMarkers = useMemo(
    () => (task?.artifacts?.revisions ?? []).map((r) => ({ rev: r.rev, title: r.title, createdAt: r.createdAt })),
    [task?.artifacts?.revisions],
  );

  const planReviewStripEl = planApprovalPanelOpen && planMinimized && task ? (
    <button
      type="button"
      onClick={() => setPlanMinimized(false)}
      title="Restore the plan-review panel"
      className="flex w-full items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[12px] text-[var(--eh-text-secondary)] transition-colors hover:bg-primary/10"
    >
      <ListChecks className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
      <span className="font-semibold text-[var(--eh-text-primary)]">Plan review</span>
      <span className="flex items-center gap-1 text-[11px] text-[var(--eh-text-muted)]">
        {planStripStatus === 'revising' && <><Loader2 className="h-3 w-3 animate-spin" /> revising…</>}
        {planStripStatus === 'waiting' && <><CircleHelp className="h-3 w-3 text-amber-500" /> waiting for your input</>}
        {planStripStatus === 'idle' && <>idle</>}
      </span>
      {unsentPlanCount > 0 && (
        <span className="ml-auto flex items-center gap-1 rounded-full bg-[var(--eh-state-attention)]/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--eh-state-attention)]" />
          {unsentPlanCount} unsent
        </span>
      )}
      <Maximize2 className={`h-3.5 w-3.5 flex-shrink-0 text-[var(--eh-text-muted)] ${unsentPlanCount > 0 ? '' : 'ml-auto'}`} />
    </button>
  ) : undefined;

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
      authErrorCard={
        session?.status === 'failed' && session?.terminalReason === 'auth-expired'
          ? <AuthErrorCard diagnosis={session.authDiagnosis} recovering={chat.recovering} />
          : undefined
      }
      working={working}
      activity={activity}
      emptyHint={
        orchestrator
          ? 'Talk to the board. I can see and dispatch work to tickets.'
          : isFurnaceChat
            ? 'Talk to the Furnace Operator — plan a burn or troubleshoot a parked batch.'
            : `Chat about ${id}.`
      }
      contextCard={contextCard}
      quickReplies={quickReplies}
      linkifyTickets
      draft={draft}
      onDraftChange={(t) => onDraftChange(id, t)}
      selections={selections}
      onSelectionsChange={(s) => onSelectionsChange(id, s)}
      onSend={handleSend}
      // FLUX-685: edit-and-resend/retry only apply to a real ticket's own transcript — the virtual
      // board/Furnace conversations (`task` undefined here) have no per-turn truncate endpoint.
      onEditTurn={task ? chat.editAndResend : undefined}
      onRetryTurn={task ? chat.retryLast : undefined}
      queued={chat.queued}
      onEnqueue={handleEnqueue}
      onDequeue={chat.dequeue}
      onStop={chat.stop}
      onUploadImage={chat.uploadImage}
      awaitingInputBanner={isRequireInput && task ? <ChatRequireInputBanner task={task} /> : undefined}
      coldResumeChoice={coldResumeChoice}
      questionPicker={<ChatPendingInteractions conversationId={id} />}
      answerPrompt={answerPrompt}
      onAnswerQuestion={onAnswerQuestion}
      diffBranch={task?.branch}
      tickets={allTasks}
      meter={<SessionMeter session={session} config={config} />}
      presenceRail={runActive ? (
        <ChatPresenceRail group={runGroup!} taskId={id} onOpenRun={openRun} onStopSession={stopOne} />
      ) : undefined}
      orchestrationBlock={runGroup ? (
        <ChatOrchestrationBlock group={runGroup} taskId={id} onOpenRun={openRun} onStopSession={stopOne} onStopAll={stopAll} />
      ) : undefined}
      artifactMarkers={artifactMarkers}
      onOpenArtifact={() => onOpenArtifact?.(id)}
      planReadyPresent={task ? isPlanApprovalPending(task, config) : false}
      planReviewStrip={planReviewStripEl}
      actions={
        orchestrator ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <TriageAction busy={chat.busy || working} onTriage={() => void chat.send(TRIAGE_PROMPT)} />
            <BoardHealthAction busy={chat.busy || working} onFire={(prompt) => void chat.send(prompt)} />
          </div>
        ) : task ? (
          <TicketActions task={task} variant="compact" />
        ) : undefined
      }
    />
  );

  const handleResetConversation = async () => {
    // FLUX-1221: this button also backs the Furnace-chat's reset (see ChatWindowHeader) — label the
    // confirm off which window it actually is instead of hardcoding "orchestrator".
    const label = orchestrator ? 'orchestrator' : isFurnaceChat ? (session?.label ?? 'Furnace chat') : 'this';
    if (await confirm({ title: `Reset the ${label} conversation? This clears its chat history.`, tone: 'danger', confirmLabel: 'Reset' })) {
      void chat.reset();
    }
  };

  return (
    <motion.div
      ref={windowRef}
      // FLUX-801: bring this window above its siblings when the user interacts with it.
      onMouseDown={() => onRaise?.(id)}
      {...motionProps}
      // FLUX-1418/1523: on an open completing, flips `settled`/`hasEverMounted`, revealing the
      // deferred heavy content; on an uninterrupted close completing, flips `closeCommitted`,
      // tearing it back down (see the effects above `startDrag`).
      onAnimationComplete={handleAnimationComplete}
      className="eh-surface eh-border fixed z-50 flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
      style={{
        bottom,
        left,
        width: outerW,
        height: size.h,
        // FLUX-1418: promote the layer up front instead of leaving Blink to decide mid-spring
        // (FLUX-1266 precedent) — only while an animation could actually run on this window.
        ...(animateWindow ? { willChange: 'transform' } : {}),
      }}
    >
      {/* FLUX-1461: resize handles — 4 corners (subtle brackets) + 4 edges (thin strips), each
          keeping the opposite corner anchored. All are direct children of this `fixed` outer
          frame so they ride the outer edge (chat + sideview when open), matching the original
          top-right grip's behavior. */}
      <div
        onPointerDown={(e) => startResize(e, 'tl')}
        title="Drag to resize"
        className="group/resize absolute left-0 top-0 z-10 flex h-5 w-5 cursor-nwse-resize items-start justify-start p-1"
      >
        <span className="h-2.5 w-2.5 rounded-tl border-l-2 border-t-2 border-[var(--eh-text-muted)] opacity-40 transition-opacity group-hover/resize:opacity-90" />
      </div>
      <div
        onPointerDown={(e) => startResize(e, 'tr')}
        title="Drag to resize"
        className="group/resize absolute right-0 top-0 z-10 flex h-5 w-5 cursor-nesw-resize items-start justify-end p-1"
      >
        <span className="h-2.5 w-2.5 rounded-tr border-r-2 border-t-2 border-[var(--eh-text-muted)] opacity-40 transition-opacity group-hover/resize:opacity-90" />
      </div>
      <div
        onPointerDown={(e) => startResize(e, 'bl')}
        title="Drag to resize"
        className="group/resize absolute bottom-0 left-0 z-10 flex h-5 w-5 cursor-nesw-resize items-end justify-start p-1"
      >
        <span className="h-2.5 w-2.5 rounded-bl border-b-2 border-l-2 border-[var(--eh-text-muted)] opacity-40 transition-opacity group-hover/resize:opacity-90" />
      </div>
      <div
        onPointerDown={(e) => startResize(e, 'br')}
        title="Drag to resize"
        className="group/resize absolute bottom-0 right-0 z-10 flex h-5 w-5 cursor-nwse-resize items-end justify-end p-1"
      >
        <span className="h-2.5 w-2.5 rounded-br border-b-2 border-r-2 border-[var(--eh-text-muted)] opacity-40 transition-opacity group-hover/resize:opacity-90" />
      </div>
      <div
        onPointerDown={(e) => startResize(e, 't')}
        title="Drag to resize"
        className="absolute left-5 right-5 top-0 z-10 h-1.5 cursor-ns-resize"
      />
      <div
        onPointerDown={(e) => startResize(e, 'b')}
        title="Drag to resize"
        className="absolute bottom-0 left-5 right-5 z-10 h-1.5 cursor-ns-resize"
      />
      <div
        onPointerDown={(e) => startResize(e, 'l')}
        title="Drag to resize"
        className="absolute bottom-5 left-0 top-5 z-10 w-1.5 cursor-ew-resize"
      />
      <div
        onPointerDown={(e) => startResize(e, 'r')}
        title="Drag to resize"
        className="absolute bottom-5 right-0 top-5 z-10 w-1.5 cursor-ew-resize"
      />

      {/* FLUX-734/740/1283: chat column on the left; the ticket sideview docks on the right when open. For
          ticket windows the shared controller is lifted (TicketControllerScope) so the editable header
          title, metadata bar, and sideview all drive one form state + one save flow. */}
      {task ? (
        <TicketControllerScope task={task}>
          {(c) => (
            <>
              <ChatWindowHeader
                id={id}
                orchestrator={orchestrator}
                isFurnaceChat={isFurnaceChat}
                task={task}
                startDrag={startDrag}
                onToggleSideView={onToggleSideView}
                sideViewOpen={sideViewOpen}
                onMinimize={onMinimize}
                canClose={canClose}
                // FLUX-1339: guard the close when this ticket has unsent plan-review notes.
                onClose={onClose ? () => guardedClose() : undefined}
                openTaskFullView={openTaskFullView}
                onResetConversation={handleResetConversation}
                titleSlot={
                  <input
                    type="text"
                    value={c.title}
                    onChange={(e) => c.setTitle(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    placeholder="Task title..."
                    className="w-full min-w-0 truncate border-none bg-transparent p-0 text-[13px] font-semibold text-[var(--eh-text-primary)] outline-none focus:ring-0"
                  />
                }
              />
              {/* `relative` positioning context for the sideview's `absolute inset-0` fill. */}
              <div className="relative flex min-h-0 flex-1 overflow-hidden">
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <ChatMetadataBar c={c} />
                  {contentMounted && <ChatDiffPanel task={task} />}
                  <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
                    {contentMounted ? chatViewEl : <ChatWindowLoadingShell />}
                  </div>
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
                      {/* FLUX-874: route an artifact-region annotation into THIS chat — enqueue if a
                          turn is live (FIFO), otherwise send straight away (starts/resumes a session). */}
                      {contentMounted ? (
                        <TicketSideView
                          c={c}
                          onSendToChat={(text) => {
                            if (working || chat.busy) chat.enqueue(text);
                            else void chat.send(text);
                          }}
                        />
                      ) : (
                        <ChatWindowLoadingShell />
                      )}
                    </div>
                  </>
                )}
                {/* FLUX-1362 (ex-FLUX-1273/1339): the plan-approval panel opens as its OWN full-screen
                    surface — a maximizable FloatingPanel, default-maximized — with a restore control
                    that drops to a smaller resizable floating form (choice persists per storageKey).
                    Mounted inside this SAME controller scope so its staged header edits share one form
                    state with ChatMetadataBar/TicketSideView, and its "Ask in chat" / annotation
                    posting reuses the same live-send routing. Kept MOUNTED while minimized (`hidden`)
                    so the artifact iframe + composed draft survive collapse; the minimized affordance
                    is the strip above the composer (`planReviewStripEl`). */}
                {planApprovalPanelOpen && (
                  <FloatingPanel
                    storageKey={`eh-plan-panel-${id}`}
                    title={`Plan review · ${id}`}
                    hidden={planMinimized}
                    bodyClassName="flex min-h-0 flex-1 overflow-hidden"
                    defaultWidth={560}
                    defaultHeight={480}
                    maximizable
                    defaultMaximized
                    portal
                    onMinimize={() => setPlanMinimized(true)}
                    onClose={() => onClosePlanApproval?.()}
                  >
                    <PlanApprovalPanel
                      c={c}
                      onClose={() => onClosePlanApproval?.()}
                      onSendToChat={routeToChat}
                    />
                  </FloatingPanel>
                )}
              </div>
              {/* FLUX-1339: close-guard — closing this chat with unsent plan notes offers to send them
                  now, keep them for later (draft survives), or discard, instead of stranding the draft. */}
              {closeGuard && (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
                  <div className="eh-surface eh-border w-full max-w-sm rounded-xl border p-4 shadow-2xl">
                    <div className="mb-1 text-[14px] font-semibold text-[var(--eh-text-primary)]">Unsent plan notes</div>
                    <p className="mb-3 text-[12px] text-[var(--eh-text-secondary)]">
                      You have {unsentPlanCount} unsent plan-review note{unsentPlanCount === 1 ? '' : 's'} for {id}. What would you like to do before closing?
                    </p>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => { clearPlanReviewDraft(id); setCloseGuard(false); onClose?.(id); }}
                        className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        onClick={() => { setCloseGuard(false); onClose?.(id); }}
                        className="eh-border rounded-md border px-3 py-1.5 text-[12px] font-semibold text-[var(--eh-text-secondary)] transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                      >
                        Keep for later
                      </button>
                      <button
                        type="button"
                        onClick={() => { flushPlanNotesToChat(); setCloseGuard(false); onClose?.(id); }}
                        className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover"
                      >
                        Send now
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </TicketControllerScope>
      ) : (
        <>
          <ChatWindowHeader
            id={id}
            orchestrator={orchestrator}
            isFurnaceChat={isFurnaceChat}
            task={task}
            startDrag={startDrag}
            onToggleSideView={onToggleSideView}
            sideViewOpen={sideViewOpen}
            onMinimize={onMinimize}
            canClose={canClose}
            onClose={onClose}
            openTaskFullView={openTaskFullView}
            onResetConversation={handleResetConversation}
            titleSlot={
              <span className="truncate">
                {/* FLUX-1209: the Furnace-chat window title is the persona's resolved label (e.g.
                    "Furnace Operator (Smelter)"), same identity contract the board used to special-case
                    for an in-persona session — now scoped to its own conversation. */}
                {orchestrator ? 'Orchestrator' : isFurnaceChat ? session?.label ?? 'Furnace chat' : id}
              </span>
            }
          />
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
                {contentMounted ? chatViewEl : <ChatWindowLoadingShell />}
              </div>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
});

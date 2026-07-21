import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Send, Loader2, Square, Wrench, ChevronDown, ChevronRight, Check, Clock, ArrowDown, Cpu, Gauge, Shield, Paperclip, X, RefreshCw, Play, CheckCircle2, XCircle, Ban, PauseCircle, HelpCircle, LayoutTemplate, ExternalLink, Pencil } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import { ehBrowserUrl, fetchDiffFile, openWorkspaceEditor, type TranscriptMessage, type ChatAttachment } from '../../api';
import type { QueuedMessage, ChatSendOptions } from '../../hooks/useChatSession';
import { DELEGATION_TOOLS } from '../../orchestration';
import { TaskMarkdown } from '../TaskMarkdown';
import { CopyButton } from '../CopyButton';
import { DiffLines } from '../DiffLines';
import { searchTasks, getTaskActivityTimestamp } from '../../taskSearch';
import { useTranscriptFind } from './useTranscriptFind';
import { FindBar } from './FindBar';
import type { Task } from '../../types';
import { useDockActions } from '../DockProvider';
import type { ComposerSelections } from '../DockProvider';
import { formatRelative } from '../../lib/relativeTime';
import { DISPATCH_STAGE_LABEL, DISPATCH_PHASE_LABEL, DISPATCH_PHASE_ICON } from '../../lib/dispatch';
import { useEscapeKey } from '../../hooks/useEscapeKey';

/** FLUX-643: a one-tap reply chip rendered above the composer. Selecting it sends
 *  `value` as the chat reply. `tone: 'danger'` paints it red (e.g. a "Skip" option);
 *  FLUX-805: `tone: 'primary'` paints it as an accented launch CTA with a ▶ glyph (the
 *  "suggest a supervisor run" confirm chip). */
export interface QuickReply {
  label: string;
  value: string;
  tone?: 'danger' | 'primary';
}

/** One choice in a ChipSelect. `tone: 'danger'` paints the hint + active chip red. */
interface ChipOption {
  value: string;
  label: string;
  hint?: string;
  tone?: 'danger';
}

const MODEL_OPTS: ChipOption[] = [
  { value: '', label: 'Default' },
  { value: 'haiku', label: 'Haiku', hint: 'fast' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus', hint: 'max' },
];

const EFFORT_OPTS: ChipOption[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
];

const PERM_OPTS: ChipOption[] = [
  { value: '', label: 'Default' },
  { value: 'gated', label: 'Gated', hint: 'ask' },
  { value: 'skip', label: 'Skip', hint: 'danger', tone: 'danger' },
];

/** FLUX-814: how many trailing messages a chat renders on open, and how many more each
 *  "Show earlier" click reveals. Long threads (the orchestrator board reaches 800+ messages)
 *  used to mount EVERY message on open — each assistant turn a react-markdown parse — which
 *  froze the open for 3–4s. Rendering only the tail makes the open feel instant; older turns
 *  load on demand (and opening find reveals all, so search still scans the whole transcript). */
const INITIAL_VISIBLE_MESSAGES = 80;
const LOAD_MORE_MESSAGES = 200;
/** FLUX-821: find still needs the whole transcript mounted (it walks the live DOM), but expanding
 *  to it in one synchronous commit re-introduces the FLUX-814 freeze. So on find-open we grow the
 *  window a chunk PER FRAME instead of all at once — the same total work, spread across frames so
 *  the main thread keeps yielding (find bar paints, typing stays responsive) rather than blocking
 *  3–4s. The find recompute is debounced past the last chunk (see useTranscriptFind), so it walks
 *  the DOM once, fully populated. */
const FIND_EXPAND_CHUNK = 120;

/** FLUX-1362: the metadata a "new revision published" in-stream marker needs. */
export interface ArtifactMarker {
  rev: number;
  title?: string;
  /** ISO publish timestamp — used to weave the marker into the transcript at its point in time. */
  createdAt: string;
}

export interface ChatViewProps {
  messages: TranscriptMessage[];
  busy: boolean;
  error: string | null;
  /** Agent is actively working (drives the header spinner + stop button). */
  working?: boolean;
  /** Short activity label shown next to the spinner ("Reading…", "Editing…"). */
  activity?: string | null;
  /** Placeholder shown when there are no messages yet. */
  emptyHint?: string;
  /** Header label. */
  title?: string;
  /** Tailwind max-height for the scrollable message area (default `max-h-72`).
   *  The floating dock window passes a taller value so it feels less cramped. */
  scrollMaxClass?: string;
  /** Fill the parent's height (flex column, message area flex-grows) instead of
   *  using `scrollMaxClass`. Used by the resizable floating dock window. */
  fill?: boolean;
  onSend: (text: string, opts?: { model?: string; effort?: string; permissionMode?: string; attachments?: ChatAttachment[] }) => void | Promise<void>;
  /** FLUX-685: edit-and-resend a past user turn. When provided, a pencil affordance appears on
   *  every native (non-`sourceStream`) user turn; submitting the edit calls this with the turn's
   *  `seq`, the edited text, and the composer's current model/effort/permission chips. Omit to
   *  disable the affordance entirely (e.g. the virtual board/Furnace chats, which have no
   *  per-turn transcript to truncate). */
  onEditTurn?: (seq: number, text: string, opts: ChatSendOptions) => void | Promise<void>;
  /** FLUX-685: retry the last assistant turn — drops it and resends the preceding user turn's own
   *  text unchanged. When provided, a Retry affordance appears on the last assistant turn only.
   *  Receives the composer's current model/effort chips (so switching a chip then hitting Retry
   *  re-runs the SAME prompt under the new model/effort) — permission mode is intentionally not
   *  threaded through since Retry has no composer submission of its own to read it from. Omit to
   *  disable the affordance. */
  onRetryTurn?: (opts?: { model?: string; effort?: string }) => void | Promise<void>;
  /** Stop/interrupt the running turn. Shown while `working`. */
  onStop?: () => void | Promise<void>;
  /** FLUX-674: upload a pasted/dropped/picked image, returning its ref. When provided, the
   *  composer enables image attachments (paste, drag-drop, file picker); omit to keep the
   *  composer text-only. FLUX-676: the board orchestrator chat now supplies this too — its
   *  images land in the `assets/__board__/` sidecar rather than a per-ticket one. */
  onUploadImage?: (file: File) => Promise<ChatAttachment>;
  /** Phase-aware action bar (FLUX-610) — rendered pinned above the composer. Optional so
   *  ChatView stays transport-free; callers build & pass `<TicketActions variant="compact" />`.
   *  FLUX-622: suppressed while the chat is `working`/`busy` — only shown when idle/pending,
   *  so the user can't fire an action mid-turn. */
  actions?: ReactNode;
  /** FLUX-642: "where this left off" card shown (in place of `emptyHint`) when the chat has
   *  no messages. Caller builds it (last agent comment for a ticket, board snapshot for the
   *  orchestrator) so ChatView stays transport-free. */
  contextCard?: ReactNode;
  /** FLUX-643: one-tap reply chips rendered above the composer (e.g. proposed Require-Input
   *  defaults). Selecting one sends its `value` via `onSend`. Hidden while working/busy. */
  quickReplies?: QuickReply[];
  /** FLUX-641: linkify `FLUX-\d+` ids in assistant turns into inline launch chips. */
  linkifyTickets?: boolean;
  /** FLUX-662: inline ask_user_question picker for this conversation, rendered between the
   *  transcript and the composer. Caller builds it (`<ChatQuestionPicker conversationId>`) so
   *  ChatView stays transport-free. */
  questionPicker?: ReactNode;
  /** FLUX-923: a parked `ask_user_question` awaiting an answer in THIS chat. When set, the composer
   *  enters "answer mode" — Enter/Send settles the question via `onAnswerQuestion` (free-text answer)
   *  EVEN THOUGH the session is still `working` (the turn is parked on the question, so a normal send
   *  would only queue), and the textarea is labeled with the question. Caller passes it only for a
   *  single-question prompt; the picker's option chips handle multi-question. Cleared on resolve. */
  answerPrompt?: { id: string; label: string } | null;
  /** FLUX-923: settle the parked `answerPrompt` with the composer's free-text. Required when
   *  `answerPrompt` is set; the composer is otherwise a normal chat composer. */
  onAnswerQuestion?: (text: string) => void | Promise<void>;
  /** FLUX-752: a compact, display-only "Awaiting your input" banner shown just above the
   *  questionPicker/working strip when the bound ticket sits in Require Input (status or
   *  swimlane). Caller builds it (`<ChatRequireInputBanner task>`) and decides when to pass it
   *  so ChatView stays transport-free; omit for the orchestrator board chat (no bound ticket). */
  awaitingInputBanner?: ReactNode;
  /** FLUX-623: controlled composer draft. When `onDraftChange` is provided the composer's
   *  text is driven by `draft` (so the dock can persist it across minimize/reopen); omit both
   *  to keep the composer's internal uncontrolled state (the task-modal `ChatPane` path). */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** FLUX-666: controlled composer chip selections (model/effort/permission). When
   *  `onSelectionsChange` is provided the chips are driven by `selections` (so the dock can persist
   *  them across minimize/reopen alongside the text draft); omit both to keep the composer's internal
   *  uncontrolled selection state (the task-modal `ChatPane` path, which never unmounts). */
  selections?: ComposerSelections;
  onSelectionsChange?: (selections: ComposerSelections) => void;
  /** FLUX-661: branch/ref whose file diffs back the inline per-edit diffs. When set, a tool
   *  row carrying a `path` (edit-ish tools) becomes an expandable inline diff of that file
   *  (current cumulative diff vs base, via `fetchDiffFile(diffBranch, path)`). Omit (e.g. the
   *  branch-less orchestrator chat) to keep all tool rows label-only. */
  diffBranch?: string | null;
  /** FLUX-694: board ticket list backing the composer's `#`/`FLUX-` autocomplete. Optional so
   *  ChatView stays transport-free; callers pass the task list they already hold. Omit to disable
   *  ticket autocomplete (no popover ever opens). */
  tickets?: Task[];
  /** FLUX-686: a quiet, right-aligned readout shown above the composer — e.g. the session's
   *  cumulative token/cost meter. Optional so ChatView stays transport-free; callers build it
   *  (`<SessionMeter session={…} config={…} />`) from data they already hold. */
  meter?: ReactNode;
  /** FLUX-691: in-progress assistant text for the current turn, streamed token-by-token. Rendered
   *  as a cheap plain-text node OUTSIDE the memoized transcript (so a delta never re-parses the
   *  whole markdown list); it disappears the instant the committed message lands in `messages`. */
  liveText?: string;
  /** FLUX-750: a genuine cold open is in flight (transcript never loaded / evicted from the cache,
   *  nothing to show yet). Renders a spinner in place of the empty hint so a cold mount isn't a
   *  blank pane. Suppressed the moment there are messages (a cache hit hydrates with `loading`
   *  false, so the cached transcript renders immediately and this never shows). */
  loading?: boolean;
  /** FLUX-727: open the transcript at the TOP of the final message (not the bottom), rendered
   *  fully expanded (no "Show more" on it). Set by the dock chat window; omitted by the task-modal
   *  `ChatPane`, which keeps its bottom-anchored, clamp-all behavior. Only affects the first render
   *  after (re)mount — once the user scrolls or a turn streams, normal stick-to-tail resumes. */
  openToLastMessage?: boolean;
  /** FLUX-748: messages parked while the agent was mid-turn, awaiting FIFO auto-dispatch. Rendered
   *  as greyed "Queued · …" rows above the composer. Omit (with `onEnqueue`) to disable queueing —
   *  the composer then falls back to the old gated behavior (send blocked while working). */
  queued?: QueuedMessage[];
  /** FLUX-748: queue a message instead of sending it (called by the composer when `working`/`busy`). */
  onEnqueue?: (text: string, opts?: ChatSendOptions) => void;
  /** FLUX-748: remove a still-queued message by id (the ✕ on a queued row). */
  onDequeue?: (id: string) => void;
  /** FLUX-803: ambient "who's live now" presence rail, pinned above the transcript. Rendered only
   *  while a run is live (the caller passes it only then); absent for single-session chats. Caller
   *  builds it (`<ChatPresenceRail group=… />`) so ChatView stays transport-free. */
  presenceRail?: ReactNode;
  /** FLUX-803: the prominent inline orchestration block (durable run record). When provided, ChatView
   *  suppresses the raw `delegate_parallel`/`start_session` tool row and renders this card in its place
   *  (the spawn point); if no such row is in the transcript yet it renders just below the stream. Caller
   *  builds it (`<ChatOrchestrationBlock group=… />`) and passes it only when a run group exists. */
  orchestrationBlock?: ReactNode;
  /** FLUX-839: a "resume vs start fresh" choice strip shown just above the composer when the board
   *  orchestrator has a prior transcript but no live/resumable session (a cold open after a restart).
   *  Caller builds it (`ChatWindow` computes the cold state and wires Resume/Start-fresh) so ChatView
   *  stays transport-free; omit it (the normal case) and only the composer's Send shows. */
  coldResumeChoice?: ReactNode;
  /** FLUX-1362 (ex-FLUX-887): grooming-artifact revisions surfaced as in-stream "new revision"
   *  markers — woven into the transcript at each publish moment (by `createdAt` vs message `ts`) so
   *  they live in their place in time and scroll away, instead of a card glued to the tail forever.
   *  Caller passes the revision metadata + an open handler so ChatView stays transport-free. */
  artifactMarkers?: ArtifactMarker[];
  /** FLUX-1362: open the artifact in the sideview/plan panel (from a revision marker). */
  onOpenArtifact?: () => void;
  /** FLUX-1362: whether a plan-ready affordance (pending plan-approval card) is currently showing —
   *  used to dedupe: a "new revision" marker that would be the LAST stream item is suppressed when a
   *  plan-ready card is also present (we don't need both). */
  planReadyPresent?: boolean;
  /** FLUX-1339: the minimized plan-review strip — a pinned status bar shown just above the composer
   *  when the chat's plan-review floating panel is minimized (unsent-note count + live agent status).
   *  Caller builds it (`ChatWindow`) so ChatView stays transport-free; omit it (the normal case) and
   *  nothing renders. */
  planReviewStrip?: ReactNode;
  /** FLUX-1601: an actionable auth-failure card (`<AuthErrorCard/>`) shown in place of the plain
   *  `error` string when the bound session's `terminalReason` is 'auth-expired'. Caller builds it so
   *  ChatView stays transport-free; omit to fall back to the plain error text. */
  authErrorCard?: ReactNode;
}

/**
 * FLUX-602: the dumb, reusable chat surface — pure props, no transport. Pair with
 * useChatSession for data. Container chrome (panel / dock / popup) is the caller's.
 * Assistant turns render as flowing markdown (clickable ticket/links via TaskMarkdown);
 * user turns sit in a right-aligned accent bubble; tool calls are quiet "watch it
 * work" rows. Everything is keyed off the `--eh-*` theme tokens so the surface stays
 * on-brand across all five themes (no hardcoded blue / one-off greys).
 *
 * Radius scale (documented, consistent): bubbles + composer = rounded-2xl, send button
 * + chips = rounded-lg/md. The caller's window owns the outer 2xl.
 */
/** FLUX-1439: splits the live-turn accrued text into a `committed` prefix (everything through the
 *  last completed paragraph boundary — always safe to hand to `TaskMarkdown` as-is: an odd count of
 *  ``` fences just means the trailing code block runs to the end of input, which is standard
 *  CommonMark behavior, not a special case we need to close ourselves) and a `tail`, the
 *  currently-growing paragraph. The tail is returned only when it reads as plain inline prose —
 *  no block-starting marker (heading/list/quote/table/fence) and no unterminated inline construct
 *  (code span / emphasis / link) — so the per-word fade wrapper below can never visually sever a
 *  markdown construct from its closing delimiter. When unsafe, the whole text folds into
 *  `committed` and streams through the ordinary single-parse path instead.
 */
function splitLiveTail(text: string): { committed: string; tail: string } {
  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) return { committed: text, tail: '' };

  const lastBreak = text.lastIndexOf('\n\n');
  const paraStart = lastBreak === -1 ? 0 : lastBreak + 2;
  const tail = text.slice(paraStart);
  if (/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|\|)/.test(tail) || /[`*_[\]]/.test(tail)) {
    return { committed: text, tail: '' };
  }
  return { committed: text.slice(0, paraStart), tail };
}

export function ChatView({
  messages,
  busy,
  error,
  working,
  activity,
  emptyHint,
  title = 'Chat',
  scrollMaxClass = 'max-h-72',
  fill = false,
  onSend,
  onEditTurn,
  onRetryTurn,
  onStop,
  onUploadImage,
  actions,
  contextCard,
  quickReplies,
  linkifyTickets = false,
  questionPicker,
  answerPrompt,
  onAnswerQuestion,
  awaitingInputBanner,
  draft,
  onDraftChange,
  selections: selectionsProp,
  onSelectionsChange: onSelectionsChangeProp,
  diffBranch,
  tickets,
  meter,
  liveText,
  loading = false,
  openToLastMessage = false,
  queued,
  onEnqueue,
  onDequeue,
  presenceRail,
  orchestrationBlock,
  coldResumeChoice,
  artifactMarkers,
  onOpenArtifact,
  planReadyPresent = false,
  planReviewStrip,
  authErrorCard,
}: ChatViewProps) {
  // FLUX-1362: keep the open handler in a ref so the (markdown-heavy) rows memo doesn't need it as a
  // dep — a marker's click always performs the same "open the artifact" action regardless of identity.
  const onOpenArtifactRef = useRef(onOpenArtifact);
  onOpenArtifactRef.current = onOpenArtifact;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // FLUX-1439: gates the live-turn word-paced reveal + per-word/cursor CSS animation. The blanket
  // reduced-motion stylesheet override (index.css) already neutralizes the CSS animation durations;
  // this additionally disables the artificial word-by-word reveal DELAY itself (content still
  // streams progressively, just committed per-arrival instead of trickled).
  const prefersReducedMotion = useReducedMotion();
  // FLUX-727: one-shot guard so the "open at the top of the final message" scroll runs only on the
  // first render with messages after (re)mount. ChatView re-mounts on each dock open (keyed in
  // `open.map`), so this naturally resets per open.
  const didInitialScrollRef = useRef(false);
  // FLUX-829: while true, the initial pin keeps re-asserting itself each frame (the re-pin loop
  // below) because earlier turns are still collapsing post-paint (ToolGroup folding — FLUX-1439
  // removed the other collapse source, Clampable capping) and shrinking the content above the
  // target. Cleared once heights hold steady or the user takes over the scroll, so it never fights
  // a deliberate scroll.
  const repinActiveRef = useRef(false);
  // FLUX-644: jump-to-bottom pill state — shown while the user has scrolled up; `newCount`
  // tallies messages that arrived since they detached from the bottom.
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(messages.length);

  // FLUX-685: edit-and-resend state — the user turn currently being edited (its `seq` + original
  // text), or null when the composer is in its normal send mode. Lives here (not inside Composer)
  // because both the Edit button (a message row) and the Composer need it; cleared by the
  // Composer itself on submit or Cancel.
  const [editingTurn, setEditingTurn] = useState<{ seq: number; text: string } | null>(null);

  // FLUX-1566: the uncontrolled (task-modal ChatPane) path never passes `onSelectionsChange`, so
  // Composer's model/effort chips lived only in Composer's own internal state — invisible to the
  // Retry button here, which always resent under the session default. Mirror the chips into a local
  // state here so Retry (and the gating below) can read them too; the controlled (dock) path is
  // untouched since it keeps flowing the parent's `selections`/`onSelectionsChange` straight through.
  const selectionsControlled = onSelectionsChangeProp !== undefined;
  const [internalSelections, setInternalSelections] = useState<ComposerSelections | undefined>(selectionsProp);
  const selections = selectionsControlled ? selectionsProp : internalSelections;
  const onSelectionsChange = selectionsControlled ? onSelectionsChangeProp : setInternalSelections;

  // FLUX-814: render only the last `visibleCount` messages on open (the tail), so a long thread
  // doesn't mount 800+ markdown rows synchronously and freeze the open. "Show earlier" reveals
  // older turns in chunks; `restoreFromBottomRef` keeps the viewport anchored when those rows are
  // prepended above the current scroll position.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const restoreFromBottomRef = useRef<number | null>(null);

  // FLUX-686: in-transcript find, scoped to this surface's scroll container. Opened with
  // Cmd/Ctrl+F or `/` (see the root onKeyDown below); the bar handles next/prev + Esc itself.
  // FLUX-821: `visibleCount` is passed as the reveal signal so the (DOM-walking) match recompute
  // re-fires as the progressive expansion grows the window — and, being debounced, only settles
  // once the last chunk has mounted, walking the fully-populated transcript exactly once.
  const find = useTranscriptFind(scrollRef, messages, visibleCount);

  // FLUX-695: unread-divider state. `lastSeenRef` is the count of messages the user has seen;
  // `dividerIndex` is the boundary (first unseen index) where the "new messages" rule renders.
  // `documentActiveRef` tracks whether this surface is actually attended (tab visible + window
  // focused) — arrivals while unattended are what earn the divider. The chat is "viewed" (divider
  // cleared) only when the user is attending AND scrolled to the live tail.
  const lastSeenRef = useRef(messages.length);
  const documentActiveRef = useRef(
    typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus()),
  );
  const [dividerIndex, setDividerIndex] = useState<number | null>(null);

  // Mark everything seen and drop the divider — the user is looking at the live tail.
  function markSeen() {
    lastSeenRef.current = messages.length;
    setDividerIndex(null);
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    // setState bails out when the value is unchanged, so this is cheap per scroll tick.
    setShowJump(!atBottom);
    if (atBottom) {
      setNewCount(0);
      if (documentActiveRef.current) markSeen(); // scrolled back to the tail while attending → caught up.
    }
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJump(false);
    setNewCount(0);
    markSeen(); // an explicit jump-to-latest is a deliberate "I'm caught up".
  }

  // FLUX-814: reveal an older chunk of the transcript. Record the distance-from-bottom first so the
  // layout effect below can restore it — prepending rows above would otherwise jump the viewport.
  function showEarlier() {
    const el = scrollRef.current;
    if (el) restoreFromBottomRef.current = el.scrollHeight - el.scrollTop;
    setVisibleCount((c) => Math.min(messages.length, c + LOAD_MORE_MESSAGES));
  }

  // FLUX-814: after "Show earlier" prepends rows, keep the previously-visible content in place by
  // pinning the same distance from the bottom. Runs only on a `visibleCount` change (not on new
  // turns — those keep the existing stick-to-bottom behavior). Child layout effects (ToolGroup
  // measuring) run before this parent effect, so heights are settled when we restore.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && restoreFromBottomRef.current != null) {
      el.scrollTop = el.scrollHeight - restoreFromBottomRef.current;
      restoreFromBottomRef.current = null;
    }
  }, [visibleCount]);

  // FLUX-821: progressively reveal the rest of the transcript while find is open, one chunk per
  // frame, so find can walk the whole DOM without the all-at-once mount re-freezing the heavy board.
  // The effect re-runs as `visibleCount` climbs (each chunk), scheduling the next frame until the
  // window covers everything. Each step anchors the viewport from the bottom (same mechanism as
  // `showEarlier`) so prepended older rows don't shove the user's position around. The find
  // recompute is debounced and keyed on `visibleCount`, so it fires once after the last chunk lands.
  useEffect(() => {
    if (!find.open || visibleCount >= messages.length) return;
    const el = scrollRef.current;
    if (el) restoreFromBottomRef.current = el.scrollHeight - el.scrollTop;
    const id = requestAnimationFrame(() => {
      setVisibleCount((c) => Math.min(messages.length, c + FIND_EXPAND_CHUNK));
    });
    return () => cancelAnimationFrame(id);
  }, [find.open, visibleCount, messages.length]);

  // FLUX-727/829: put the final assistant message at the top of the viewport. Returns false when
  // `[data-last-msg]` isn't in the DOM yet (e.g. a trailing user message mid-send has no settled
  // reply) so callers can keep their one-shot armed instead of landing the user at the bottom.
  function pinToLast(el: HTMLDivElement): boolean {
    const last = el.querySelector('[data-last-msg]') as HTMLElement | null;
    if (!last) return false;
    el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    atBottomRef.current = false;
    return true;
  }

  // FLUX-829: the initial pin measures against first-paint heights, but earlier turns shrink in a
  // LATER commit — `ToolGroup` folds after mount (FLUX-1439 removed the other collapse source,
  // Clampable capping) — so the content above the target collapses and the browser clamps our
  // now-too-large scrollTop back toward 0, dumping the user at the top of the loaded window. Re-pin
  // every frame until scrollHeight holds steady for a few frames (collapse commits have flushed), or
  // a 1s safety cap, whichever comes first. `cancelRepin` (genuine user input below) stops it early.
  function startRepinLoop() {
    repinActiveRef.current = true;
    let lastH = scrollRef.current?.scrollHeight ?? 0;
    let stableFrames = 0;
    const startedAt = Date.now();
    const tick = () => {
      const el = scrollRef.current;
      if (!repinActiveRef.current || !el) {
        repinActiveRef.current = false;
        return;
      }
      // Measure content height BEFORE pinning. A scrollTop write changes the scroll offset, not
      // scrollHeight, so this reads the same value the post-pin read would — but taking it before
      // the write keeps the scrollHeight read off the tail of a scrollTop write, avoiding a
      // write→read layout flush within the frame.
      const h = el.scrollHeight;
      if (h === lastH) stableFrames += 1;
      else {
        stableFrames = 0;
        lastH = h;
      }
      pinToLast(el);
      if (stableFrames >= 3 || Date.now() - startedAt > 1000) {
        repinActiveRef.current = false;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // FLUX-829: a deliberate user scroll (wheel / touch / arrow keys / scrollbar drag) takes over —
  // stop re-pinning so we never yank them back. Keyed on real input events, NOT the scroll event,
  // which our own `pinToLast` writes would otherwise trip.
  function cancelRepin() {
    repinActiveRef.current = false;
  }

  // FLUX-695: track tab visibility + window focus. When the surface becomes attended while the
  // user is already at the bottom, the new messages are in view → mark them seen (clear divider).
  useEffect(() => {
    const sync = () => {
      const active = document.visibilityState === 'visible' && document.hasFocus();
      documentActiveRef.current = active;
      if (active && atBottomRef.current) markSeen();
    };
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
    };
    // markSeen closes over `messages.length`; re-bind so a late focus marks the right count.
  }, [messages.length]);

  // Stick to bottom only when the user is already near the bottom — don't yank them down
  // while they've scrolled up to read. When detached, surface the new arrivals on the pill.
  // FLUX-695: an arrival while the surface is unattended (tab hidden/blurred OR scrolled away)
  // drops the unread divider at the boundary; an attended arrival just advances `lastSeen`.
  useEffect(() => {
    // FLUX-727: on first open (dock window), land at the TOP of the final message — instead of
    // snapping to the very bottom. One-shot per mount. Skipped while a turn is streaming (`working`)
    // so a live chat keeps stick-to-tail. Setting `atBottomRef=false` (inside pinToLast) also stops
    // `handleScroll` from snapping back / auto-marking-seen, leaving the unread divider intact.
    // FLUX-829: the pin set here measures first-paint heights, but earlier turns then collapse in a
    // LATER commit (ToolGroup folding — FLUX-1439 removed the other collapse source, Clampable
    // capping) and the browser clamps our scrollTop back toward 0 — landing the user at the top of
    // the loaded window. So we don't fire once and trust it: `startRepinLoop` re-asserts the pin
    // every frame until heights settle (or the user scrolls).
    if (openToLastMessage && !didInitialScrollRef.current && messages.length > 0 && !working) {
      // FLUX-824: only burn the one-shot once the scroll ACTUALLY runs. If this first pass fires
      // while a turn streams (`working`) or before `[data-last-msg]` is in the DOM (pinToLast returns
      // false), leaving the guard unset keeps the one-shot armed for the next render instead of
      // silently landing the user at the bottom — the intermittent "sometimes it doesn't scroll".
      const el = scrollRef.current;
      if (el && pinToLast(el)) {
        didInitialScrollRef.current = true;
        startRepinLoop();
        prevLenRef.current = messages.length;
        return;
      }
    }
    const grew = messages.length - prevLenRef.current;
    if (grew < 0) {
      // Transcript shrank/reset — rebaseline so a stale boundary can't point past the end.
      lastSeenRef.current = messages.length;
      setDividerIndex(null);
      // FLUX-814: a reset/conversation-switch collapses the window back to the tail.
      setVisibleCount(INITIAL_VISIBLE_MESSAGES);
    } else if (grew > 0) {
      // FLUX-814: grow the window with *incremental* arrivals so the hidden/visible boundary stays
      // fixed — a streaming turn never drops an already-rendered row off the top. A turn commit adds
      // only a handful of messages; gating on `< INITIAL_VISIBLE_MESSAGES` excludes the one-shot bulk
      // hydration on cold open (the whole history lands at once — that's exactly what must NOT expand
      // the window, or the freeze returns). Incremental arrivals are cheap (one parse each).
      if (grew < INITIAL_VISIBLE_MESSAGES) setVisibleCount((c) => c + grew);
      const attended = documentActiveRef.current && atBottomRef.current;
      if (attended) {
        lastSeenRef.current = messages.length;
        setDividerIndex(null);
      } else {
        setDividerIndex((cur) => (cur === null ? lastSeenRef.current : cur));
      }
    }
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    } else if (grew > 0) {
      setNewCount((c) => c + grew);
      setShowJump(true);
    }
    prevLenRef.current = messages.length;
    // `openToLastMessage`/`working` feed the one-shot initial scroll above; `didInitialScrollRef`
    // guards re-runs so adding them can't double-fire the land-on-final-message behavior.
  }, [messages, openToLastMessage, working]);

  // FLUX-1439: decouples arrival (`liveText`, which may arrive in bursts) from what's actually
  // painted. `displayedLiveText` is what the live `TaskMarkdown` parses; it trails `liveText` and
  // catches up word-by-word (interval shrinking as the backlog grows) so the reveal reads as real
  // typing instead of raw markdown snapping in, while never falling permanently behind a fast
  // stream. `liveTextPropRef` mirrors the prop so the pump's recursive timer always reads the
  // freshest arrived text without restarting on every delta or closing over a stale value.
  const liveTextPropRef = useRef(liveText);
  useEffect(() => { liveTextPropRef.current = liveText; }, [liveText]);
  const [displayedLiveText, setDisplayedLiveText] = useState('');
  const revealedLenRef = useRef(0);
  const streamingLive = !!liveText;
  useEffect(() => {
    if (!streamingLive) {
      // Stream cleared — either the turn committed (FLUX-691 hands off to the memoized `rows`
      // render) or a fresh turn/conversation reset. Either way, drop all reveal state so the next
      // stream starts clean.
      revealedLenRef.current = 0;
      setDisplayedLiveText('');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf: number | null = null;

    if (prefersReducedMotion) {
      // Progressive but unanimated: catch the display up to the real text every frame — still
      // throttled to ~1 re-parse/frame (not 1 per SSE delta) so a flood of tokens can't reintroduce
      // the FLUX-691 freeze class — with no artificial word-by-word delay.
      const tick = () => {
        if (cancelled) return;
        const text = liveTextPropRef.current ?? '';
        if (text.length !== revealedLenRef.current) {
          revealedLenRef.current = text.length;
          setDisplayedLiveText(text);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } else {
      // Word-paced typewriter: reveal one whitespace-delimited word (+ its trailing whitespace)
      // at a time. The per-word delay shrinks as the backlog (unrevealed words already arrived)
      // grows, so the reveal speeds up exactly when the response floods in — it never decouples
      // from the real stream rate, just smooths it. This doubles as the FLUX-691 rAF-class
      // throttle: each tick is at minimum MIN_MS apart, well under a frame's worth of re-parses.
      const MIN_MS = 12;
      const MAX_MS = 70;
      const BACKLOG_FOR_MIN_WORDS = 40;
      const tick = () => {
        if (cancelled) return;
        const text = liveTextPropRef.current ?? '';
        const pending = text.slice(revealedLenRef.current);
        if (!pending) {
          timer = setTimeout(tick, MIN_MS);
          return;
        }
        const m = /^\S+\s*/.exec(pending);
        const chunk = m ? m[0] : pending;
        revealedLenRef.current += chunk.length;
        setDisplayedLiveText(text.slice(0, revealedLenRef.current));

        const backlogWords = (text.slice(revealedLenRef.current).match(/\S+/g) ?? []).length;
        const delay = Math.max(
          MIN_MS,
          MAX_MS - (MAX_MS - MIN_MS) * Math.min(1, backlogWords / BACKLOG_FOR_MIN_WORDS),
        );
        timer = setTimeout(tick, delay);
      };
      timer = setTimeout(tick, MIN_MS);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [streamingLive, prefersReducedMotion]);

  // FLUX-691/1439: keep the streaming live node pinned to the tail while the user is already there,
  // so word-by-word output stays in view. Keyed on `displayedLiveText` (what's actually painted),
  // not the raw `liveText` prop, so the pin fires after the pump's content lands instead of racing
  // it. `useLayoutEffect` (not `useEffect`) runs synchronously before the browser paints the new
  // height, so the corrective scroll lands in the same frame as the content that caused it — the
  // up/down bounce reported against this surface was the paint-then-correct gap a plain `useEffect`
  // leaves open. A single deterministic instant write (no `behavior: 'smooth'`, which would stack/
  // interrupt itself across ticks) — smooth scrolling stays reserved for the explicit "jump to
  // latest" click (`scrollToBottom` above).
  useLayoutEffect(() => {
    if (displayedLiveText && atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [displayedLiveText]);

  // FLUX-1439: the committed prefix renders through the real `TaskMarkdown` parse (progressive
  // markdown, no raw-syntax flash); the tail — the currently-growing paragraph, when safe to
  // word-split (see `splitLiveTail`) — is tokenized once per reveal tick so each newest word can
  // mount as its own fresh `<span>` and play its fade-in once (React reuses the DOM node for
  // already-mounted words, so their animation never replays).
  const { liveCommitted, liveTail, liveTailTokens } = useMemo(() => {
    if (!displayedLiveText) return { liveCommitted: '', liveTail: '', liveTailTokens: [] as string[] };
    if (prefersReducedMotion) return { liveCommitted: displayedLiveText, liveTail: '', liveTailTokens: [] as string[] };
    const { committed, tail } = splitLiveTail(displayedLiveText);
    return { liveCommitted: committed, liveTail: tail, liveTailTokens: tail ? tail.split(/(\s+)/).filter(Boolean) : [] };
  }, [displayedLiveText, prefersReducedMotion]);

  // FLUX-639: elapsed timer for the current turn. Starts when `working` flips on, ticks each
  // second, resets when it flips off.
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!working) {
      startRef.current = null;
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const iv = setInterval(() => setElapsed(Date.now() - (startRef.current ?? Date.now())), 1000);
    return () => clearInterval(iv);
  }, [working]);

  // FLUX-640: in-memory activity trail for the current turn. The engine reports a coarse
  // activity verb (Reading/Editing/Running command/…); we accumulate the distinct transitions
  // into a trail, reset it at the start of each turn, and keep it after the turn ends so it can
  // fold into a one-line summary above the composer.
  const [trail, setTrail] = useState<string[]>([]);
  const wasWorkingRef = useRef(false);
  useEffect(() => {
    if (working && !wasWorkingRef.current) {
      setTrail(activity ? [activity] : []);
    } else if (working && activity) {
      setTrail((prev) => (prev[prev.length - 1] === activity ? prev : [...prev, activity]));
    }
    wasWorkingRef.current = !!working;
  }, [working, activity]);

  // Render the (markdown-heavy) transcript only when it actually changes. The composer
  // owns its own input state in a sibling component, so typing never re-renders this list;
  // memoizing on `messages` also skips a rebuild when only the header activity ticks during
  // streaming. (FLUX-607 perf: long chats froze on every keystroke because the input state
  // re-reconciled the whole transcript subtree.)
  // FLUX-680: render the transcript as segments rather than one row per message. A run of
  // consecutive *plain* tool rows (no inline diff) folds into a single collapsed ToolGroup so a
  // turn that fires many Read/Bash/grep calls doesn't bury the agent's prose in a wall of rows.
  // Assistant/user turns — and edit-diff tool rows (which are individually meaningful and already
  // expandable) — break a run and render inline as before.
  // FLUX-803: when an inline orchestration block is supplied, ChatView suppresses the raw
  // delegation tool row and renders the block at that spawn point. The boolean (not the node) is a
  // memo dep so live block updates never bust the markdown-heavy transcript memo.
  const hasBlock = !!orchestrationBlock;
  // FLUX-814: window the rendered transcript to the last `visibleCount` messages. Find walks the
  // live DOM, so search must see the whole transcript — but FLUX-821: rather than flipping the
  // whole window open in one synchronous commit on find-open (which re-froze the heavy board for
  // 3–4s), the progressive-expansion effect below grows `visibleCount` a chunk per frame while find
  // is open. Once the window covers all messages, `startIndex` is 0 and nothing is hidden. The
  // window is never collapsed back when find closes — re-mounting/jumping the viewport would be
  // pure waste (and the find-close scroll jump, FLUX-821 item 2, came from exactly that toggle).
  const fullyExpanded = visibleCount >= messages.length;
  const startIndex = fullyExpanded ? 0 : Math.max(0, messages.length - visibleCount);
  const { rows, spawnInsertAt } = useMemo(() => {
    // FLUX-803: a tool row that spawned the subagent group (tagged by the projector). Excluded from
    // the plain-tool fold so it never disappears inside a ToolGroup before we can anchor the block.
    const isDelegationTool = (m: TranscriptMessage) => m.role === 'tool' && DELEGATION_TOOLS.has(m.tool ?? '');
    const isPlainTool = (m: TranscriptMessage) =>
      m.role === 'tool' && !(m.path && diffBranch) && !(hasBlock && isDelegationTool(m));

    // FLUX-727: index of the final assistant turn (highest non-tool index, unless that turn is a
    // trailing `user` message — i.e. mid-send — in which case there's no settled final reply).
    // When `openToLastMessage` it renders unclamped and is tagged `data-last-msg` so the initial
    // scroll can land on its top.
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'tool') {
        if (messages[i].role !== 'user') lastAssistantIdx = i;
        break;
      }
    }

    const renderMessage = (m: TranscriptMessage, i: number) => {
      if (m.role === 'tool') {
        // FLUX-661: an edit-ish tool row carrying a file path becomes an expandable inline
        // diff (when the chat knows the branch). Other tool rows stay the quiet label.
        if (m.path && diffBranch) {
          return <InlineEditDiff key={i} branch={diffBranch} path={m.path} tool={m.tool} added={m.added} removed={m.removed} />;
        }
        return <ToolRow key={i} text={m.text} openRef={diffBranch} />;
      }
      if (m.role === 'user') {
          // FLUX-674: a user turn may carry pasted images — render them inline above the text.
          const atts = m.attachments ?? [];
          // FLUX-685: edit-and-resend needs an addressable, NATIVE turn (a foreign turn gathered
          // from another stream via extract carries `sourceStream` — its `seq` addresses that
          // OTHER stream's transcript, not this one, so truncating here would be wrong).
          const canEdit = !!onEditTurn && m.seq !== undefined && !m.sourceStream && !working && !busy;
          return (
            <div key={i} className="group flex items-end justify-end gap-2">
              {/* FLUX-684: quiet hover-revealed timestamp, left of the right-aligned bubble. */}
              <MessageTime ts={m.ts} />
              {/* FLUX-685: hover-revealed edit affordance — same treatment as CopyButton below. */}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setEditingTurn({ seq: m.seq!, text: m.text })}
                  title="Edit and resend — drops this message and everything after it"
                  className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--eh-text-muted)] opacity-0 transition-opacity hover:text-[var(--eh-text-secondary)] focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              <div className="flex max-w-[80%] flex-col gap-1.5 rounded-2xl rounded-br-md border border-primary/15 bg-primary/10 px-3.5 py-2 text-[13px] text-[var(--eh-text-primary)]">
                {atts.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {atts.map((a, j) => (
                      <a key={j} href={ehBrowserUrl(a.url)} target="_blank" rel="noreferrer" title={a.fileName}>
                        <img
                          src={ehBrowserUrl(a.url)}
                          alt={a.fileName}
                          className="max-h-40 max-w-[200px] rounded-lg border border-primary/20 object-contain"
                        />
                      </a>
                    ))}
                  </div>
                )}
                {m.text && <span className="whitespace-pre-wrap break-words">{m.text}</span>}
              </div>
            </div>
          );
        }
      // FLUX-745 / FLUX-794: a system/automated note. Not a bubble — a subtle chip, visually
      // distinct from user/assistant turns. `action` = the pressed phase-launch button (▶), the
      // default `context-update` = the warm-resume situational update (⟳).
      if (m.role === 'note') {
        if (m.kind === 'action') {
          return <ActionChip key={i} text={m.text} ts={m.ts} />;
        }
        if (m.kind === 'permission') {
          return <PermissionChip key={i} text={m.text} ts={m.ts} />;
        }
        if (m.kind === 'dispatch') {
          return (
            <DispatchChip
              key={i}
              text={m.text}
              ts={m.ts}
              sourceTask={m.sourceTask}
              title={m.sourceTask ? tickets?.find((t) => t.id === m.sourceTask)?.title : undefined}
              phase={m.phase}
              lifecycle={m.lifecycle}
              startedAt={m.startedAt}
              linkifyTickets={linkifyTickets}
            />
          );
        }
        return <ContextUpdateChip key={i} text={m.text} ts={m.ts} />;
      }
      // Assistant — no bubble: flowing markdown so code blocks / lists / links breathe.
      // FLUX-727: the final assistant message is tagged so the initial-scroll effect can position
      // its top at the viewport top.
      // FLUX-1439: committed replies render in full, unclamped — the FLUX-693 "Show more/less"
      // height cap was removed (explicit user tradeoff: a very long reply can make the transcript
      // tall; no replacement safeguard is in scope).
      const isLastAssistant = i === lastAssistantIdx;
      // FLUX-685: Retry only makes sense on the LAST assistant turn, only while idle, and only
      // when it's a native turn (see the edit-affordance comment above for why `sourceStream`
      // disqualifies it).
      const canRetry = isLastAssistant && !!onRetryTurn && !m.sourceStream && !working && !busy;
      return (
        <div
          key={i}
          data-last-msg={openToLastMessage && isLastAssistant ? '' : undefined}
          className="group max-w-full text-[13px] leading-relaxed text-[var(--eh-text-primary)]"
        >
          <TaskMarkdown body={m.text} compact linkifyTickets={linkifyTickets} />
          {/* FLUX-684/683: quiet hover-revealed footer — timestamp + a copy-message affordance. */}
          <div className="mt-0.5 flex items-center gap-2">
            <MessageTime ts={m.ts} />
            <CopyButton
              getText={() => m.text}
              title="Copy message"
              className="flex h-4 w-4 items-center justify-center rounded text-[var(--eh-text-muted)] opacity-0 transition-opacity hover:text-[var(--eh-text-secondary)] focus-visible:opacity-100 group-hover:opacity-100"
            />
            {canRetry && (
              <button
                type="button"
                onClick={() => void onRetryTurn!({ model: selections?.model || undefined, effort: selections?.effort || undefined })}
                title="Retry — resend the preceding turn and drop this reply"
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--eh-text-muted)] opacity-0 transition-opacity hover:text-[var(--eh-text-secondary)] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      );
    };

    // Walk the messages, batching maximal runs of plain tool rows into one ToolGroup. The
    // trailing group stays open while the agent is working so a live turn keeps showing motion.
    const out: ReactNode[] = [];
    // FLUX-803: output index where the inline orchestration block should be spliced — the position
    // the first delegation tool row would have occupied. Stays null when there's no block / no such
    // row yet (the consumer then renders the block just below the stream).
    let spawnInsertAt: number | null = null;
    let dividerDone = false;
    // FLUX-1362: weave "new revision" markers into the stream at their publish moment. Sorted
    // ascending; `flushMarkers(ts)` emits every not-yet-emitted marker published strictly before the
    // next message's timestamp, so each marker sits after the messages that preceded it in time.
    const markers = (artifactMarkers ?? []).slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    let mIdx = 0;
    const flushMarkers = (tsBound: string | null) => {
      while (mIdx < markers.length && (tsBound === null || markers[mIdx]!.createdAt < tsBound)) {
        const m = markers[mIdx]!;
        out.push(<ChatRevisionMarker key={`art-rev-${m.rev}`} marker={m} onOpen={() => onOpenArtifactRef.current?.()} />);
        mIdx++;
      }
    };
    // FLUX-814: start at the window head (the tail of the transcript) — absolute indices `i` are
    // kept for keys, the unread-divider boundary, and `lastAssistantIdx`, so all anchors stay correct.
    for (let i = startIndex; i < messages.length; i++) {
      // FLUX-1362: emit any revision markers published before this message, so they land in time order.
      flushMarkers(messages[i]!.ts);
      // FLUX-695: drop the "new messages" rule before the first unseen segment. We push it at the
      // first segment whose start index reaches the boundary (a tool run straddling the boundary
      // renders the rule just before the run — close enough, and never mid-fold).
      if (dividerIndex !== null && !dividerDone && i >= dividerIndex) {
        out.push(<UnreadDivider key="unread-divider" />);
        dividerDone = true;
      }
      // FLUX-803: suppress the spawn-point tool row — the prominent inline block stands in for it.
      // Record where the first one sits so the consumer can splice the block at that point.
      if (hasBlock && isDelegationTool(messages[i])) {
        if (spawnInsertAt === null) spawnInsertAt = out.length;
        continue;
      }
      if (isPlainTool(messages[i])) {
        const start = i;
        const texts: string[] = [];
        while (i < messages.length && isPlainTool(messages[i])) texts.push(messages[i++].text);
        i--; // the for-loop's i++ will re-advance past the last consumed row
        // A lone tool call isn't worth a fold — render it as a plain row. Two or more collapse.
        if (texts.length === 1) {
          out.push(<ToolRow key={`g${start}`} text={texts[0]} openRef={diffBranch} />);
        } else {
          const isTrailing = i === messages.length - 1;
          out.push(<ToolGroup key={`g${start}`} texts={texts} defaultOpen={isTrailing && !!working} openRef={diffBranch} />);
        }
        continue;
      }
      out.push(renderMessage(messages[i], i));
    }
    // FLUX-1362: markers newer than the last message would append at the tail. Dedupe — when a
    // plan-ready card is also showing we don't need both, so drop the trailing marker(s) then.
    if (!planReadyPresent) flushMarkers(null);
    return { rows: out, spawnInsertAt };
    // FLUX-685: `busy`, `onEditTurn`/`onRetryTurn`, and the model/effort chip values feed the
    // Edit/Retry affordances' gating + click handlers computed inside `renderMessage` above — added
    // to the deps so a chip change or a working/busy flip is never rendered off a stale closure.
  }, [messages, linkifyTickets, diffBranch, working, busy, dividerIndex, openToLastMessage, hasBlock, startIndex, artifactMarkers, planReadyPresent, onEditTurn, onRetryTurn, selections?.model, selections?.effort]);

  // The floating window owns its own title bar, so suppress the in-surface title there. The
  // "working" signal now lives in the WorkingStrip above the composer (FLUX-639), so the
  // header is title-only.
  const showHeader = !fill && !!title;
  const showActions = !!actions && !working && !busy; // FLUX-622: only act when idle/pending.

  return (
    <div
      className={`flex flex-col gap-3 ${fill ? 'h-full min-h-0' : ''}`}
      // FLUX-686: open the in-transcript find. Cmd/Ctrl+F overrides the browser's native find for
      // this surface; `/` opens it too, but only when focus isn't in a text field (so typing a
      // slash in the composer is unaffected). Keydown bubbles here from the focused descendant.
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          find.setOpen(true);
        } else if (e.key === '/' && !find.open) {
          const t = e.target as HTMLElement;
          if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && !t.isContentEditable) {
            e.preventDefault();
            find.setOpen(true);
          }
        }
      }}
    >
      {/* FLUX-803: ambient presence rail — pinned above everything so "who's live now" sits where
          the eye lands first. Present only while a run is live (the caller gates it). */}
      {presenceRail}

      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">{title}</p>
        </div>
      )}

      {/* Scroll region — wrapped in a relative box so the jump-to-bottom pill (FLUX-644) and the
          find bar (FLUX-686) can float over its edges. */}
      <div className={`relative flex flex-col ${fill ? 'min-h-0 flex-1' : ''}`}>
        {/* FLUX-686: in-transcript find overlay (top-right). Mounts only while open. */}
        {find.open && <FindBar find={find} />}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          // FLUX-829: a genuine user scroll gesture stops the initial re-pin loop so we never fight
          // it. Keyed on input events (not onScroll, which our own pinToLast writes also trigger).
          onWheel={cancelRepin}
          onTouchMove={cancelRepin}
          onPointerDown={cancelRepin}
          onKeyDown={cancelRepin}
          // tabIndex makes the transcript focusable so the `/` shortcut works after clicking it
          // (not only while the composer holds focus); outline-none keeps the focus ring quiet.
          tabIndex={0}
          className={`flex flex-col gap-3 overflow-y-auto pr-1 outline-none ${fill ? 'min-h-0 flex-1' : scrollMaxClass}`}
        >
          {messages.length === 0 && (
            loading ? (
              // FLUX-750: genuine cold open — transcript is being fetched with nothing cached to
              // show. A quiet spinner instead of a blank pane (a cache hit skips this entirely).
              <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-[var(--eh-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Loading conversation…</span>
              </div>
            ) : (
              <>
                {/* FLUX-642: caller-built context (last comment / board snapshot). May render
                    null (e.g. a brand-new ticket), in which case only the hint shows. */}
                {contextCard}
                <p className="py-4 text-center text-[12px] text-[var(--eh-text-muted)]">{emptyHint || 'Send a message to start.'}</p>
              </>
            )
          )}
          {/* FLUX-814: "load earlier" affordance — only the last N messages render on open so a long
              thread doesn't freeze; this reveals older turns in chunks (scroll position preserved).
              FLUX-821: hidden while find is open — find auto-expands the window itself, so the manual
              affordance would only flicker as the window fills in. */}
          {startIndex > 0 && !find.open && (
            <button
              type="button"
              onClick={showEarlier}
              className="mx-auto mb-1 flex items-center gap-1.5 rounded-full border border-[var(--eh-border)] bg-[var(--eh-surface)] px-3 py-1 text-[11px] font-semibold text-[var(--eh-text-secondary)] transition-colors hover:text-[var(--eh-text-primary)]"
            >
              Show earlier messages ({startIndex})
            </button>
          )}
          {/* FLUX-803: splice the inline orchestration block in at the spawn point (where the
              suppressed delegation tool row sat). When no spawn row is in the transcript yet, the
              block renders just below the stream as a fallback so a freshly-spawned run still shows. */}
          {orchestrationBlock && spawnInsertAt !== null ? (
            <>
              {rows.slice(0, spawnInsertAt)}
              {orchestrationBlock}
              {rows.slice(spawnInsertAt)}
            </>
          ) : (
            <>
              {rows}
              {orchestrationBlock}
            </>
          )}
          {/* FLUX-691/1439: the live streaming node — the current turn's assistant text, rendered
              as PROGRESSIVE MARKDOWN (word-paced, see the reveal pump above), not raw plain text.
              It sits OUTSIDE the memoized `rows` (so a delta only re-renders this node, never the
              markdown-heavy transcript) and its re-parse is throttled by the word pump (≤1 parse
              per revealed word, timer-paced — never per raw SSE delta), preserving the FLUX-691
              perf isolation. It clears the instant the committed message lands in the transcript,
              at which point the memoized list renders the final, markdown-rendered message in its
              place — no duplicate, no flicker. The trailing cursor is literal-inline (part of the
              same `<p>` as the last word, never a sibling block) so its removal at stream-end
              causes no line jump. */}
          {displayedLiveText && (
            <div className="group max-w-full text-[13px] leading-relaxed text-[var(--eh-text-primary)]">
              {liveCommitted && <TaskMarkdown body={liveCommitted} compact linkifyTickets={linkifyTickets} />}
              {liveTail && (
                <p className="mb-0 whitespace-pre-wrap break-words">
                  {liveTailTokens.map((tok, i) =>
                    /^\s+$/.test(tok) ? tok : <span key={i} className="eh-word-fade">{tok}</span>,
                  )}
                  <span className="eh-live-cursor" aria-hidden="true" />
                </p>
              )}
            </div>
          )}
        </div>

        {/* FLUX-644: jump back to the live tail after scrolling up. */}
        {showJump && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-[var(--eh-border)] bg-[var(--eh-surface)] px-3 py-1 text-[11px] font-semibold text-[var(--eh-text-secondary)] shadow-lg transition-colors hover:text-[var(--eh-text-primary)]"
          >
            <ArrowDown className="h-3 w-3" />
            {newCount > 0 ? `${newCount} new message${newCount === 1 ? '' : 's'}` : 'Jump to latest'}
          </button>
        )}
      </div>

      {authErrorCard ? (
        <div className="px-0.5">{authErrorCard}</div>
      ) : (
        error && <p className="px-0.5 text-[11px] text-red-500">{error}</p>
      )}

      {/* FLUX-686: quiet caller-built meter (e.g. the session token/cost readout), right-aligned
          just above the composer area so it's glanceable without competing with the transcript. */}
      {meter && <div className="flex justify-end px-0.5">{meter}</div>}

      {/* FLUX-752: display-only "Awaiting your input" banner for a board Require-Input ticket —
          sits just above the question picker / working strip where the user's eyes already are.
          Complementary to the FLUX-643 quick-reply chips below; the reply itself goes through the
          composer/chips, not here. */}
      {awaitingInputBanner && <div className="px-0.5">{awaitingInputBanner}</div>}

      {/* FLUX-662: inline ask_user_question picker — sits right above the working strip so a
          parked question is impossible to miss, attached to the chat that asked it.
          FLUX-1413: wrapped in a shrinkable flex child (min-h-0 + overflow-hidden) so a tall
          picker is bounded by the pane's remaining height instead of overflowing it — the
          transcript above may shrink toward 0 while a question is pending, which is fine. */}
      {questionPicker && <div className="flex min-h-0 shrink flex-col overflow-hidden">{questionPicker}</div>}

      {/* FLUX-639/640: consolidated working strip + activity timeline, pinned above the
          composer so liveness sits where the user's eyes already are. */}
      <WorkingStrip working={!!working} busy={busy} activity={activity ?? null} elapsedMs={elapsed} trail={trail} onStop={onStop} />

      {/* FLUX-643: one-tap reply chips (e.g. Require-Input defaults). FLUX-805: the same surface
          hosts the "suggest a supervisor run" confirm chip (tone 'primary') — clicking it sends the
          confirmation that prompts the agent to launch the proposed fleet. Hidden while working/busy
          so a run can't be confirmed mid-turn. */}
      {quickReplies && quickReplies.length > 0 && !working && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 px-0.5">
          {quickReplies.map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => void onSend(q.value)}
              title={q.value}
              className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                q.tone === 'danger'
                  ? 'border-red-500/30 text-red-500 hover:bg-red-500/10'
                  : q.tone === 'primary'
                    ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                    : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-primary)] hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
              {q.tone === 'primary' && <Play className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
              <span className="truncate">{q.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Phase-aware action bar — pinned between the transcript and the composer so the
          ticket's next moves are always one click away (engine = free, agent = tokenized).
          Hidden mid-turn (FLUX-622) so the user can't act while the chat is working/busy. */}
      {showActions && <div className="px-0.5">{actions}</div>}

      {/* FLUX-748: queued-message rows — messages the user submitted mid-turn, parked to
          auto-dispatch FIFO when the turn finishes. Greyed/dashed to read as "pending", each
          with a ✕ to cancel it before it sends. Sits right above the composer. */}
      {queued && queued.length > 0 && (
        <div className="flex flex-col gap-1 px-0.5">
          {queued.map((q) => (
            <div
              key={q.id}
              className="group flex items-center gap-2 rounded-lg border border-dashed border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-2.5 py-1.5 text-[12px]"
            >
              <Clock className="h-3.5 w-3.5 flex-shrink-0 text-[var(--eh-text-muted)]" />
              <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">
                Queued
              </span>
              <span className="truncate text-[var(--eh-text-secondary)]">
                {q.text || (q.opts.attachments?.length ? `${q.opts.attachments.length} image(s)` : '')}
              </span>
              {onDequeue && (
                <button
                  type="button"
                  onClick={() => onDequeue(q.id)}
                  title="Remove from queue"
                  className="ml-auto flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/5"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* FLUX-839: cold-open "resume vs start fresh" choice — shown just above the composer when the
          board orchestrator has a prior transcript but no live session. Caller-built so ChatView stays
          transport-free; absent in the normal warm flow. */}
      {coldResumeChoice && <div className="px-0.5">{coldResumeChoice}</div>}

      {/* FLUX-1339: the minimized plan-review strip — pinned just above the composer (next to the
          working strip) so the collapsed panel's unsent-note count + live agent status stay in view
          while the chat itself is unobstructed. */}
      {planReviewStrip && <div className="px-0.5">{planReviewStrip}</div>}

      {/* Composer lives in its own component so its per-keystroke input state never
          re-renders the transcript above it. */}
      <Composer busy={busy} working={!!working} onSend={onSend} onEnqueue={onEnqueue} onUploadImage={onUploadImage} draft={draft} onDraftChange={onDraftChange} selections={selections} onSelectionsChange={onSelectionsChange} tickets={tickets} answerPrompt={answerPrompt} onAnswerQuestion={onAnswerQuestion} editingTurn={editingTurn} onEditSubmit={onEditTurn} onCancelEdit={() => setEditingTurn(null)} />
    </div>
  );
}

/**
 * FLUX-695: the "new messages" rule rendered in the transcript at the boundary between what the
 * user had already seen and what arrived while the chat was unattended (tab hidden/blurred or
 * scrolled away). A thin accent line with a centered label; clears once the user views the tail.
 */
function UnreadDivider() {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary" aria-label="New messages">
      <span className="h-px flex-1 bg-primary/30" aria-hidden="true" />
      New
      <span className="h-px flex-1 bg-primary/30" aria-hidden="true" />
    </div>
  );
}

/**
 * FLUX-682: a repo-relative file path rendered as a link that opens the file in VS Code via
 * `openWorkspaceEditor(path, ref)` (the same `code -g` bridge the uncommitted-changes panel uses).
 * `openRef` is the diff/worktree branch so worktree checkouts open the right tree. Rendered as a
 * focusable `role="link"` span (not a `<button>`) so it can safely nest inside the InlineEditDiff
 * row's expand button without invalid button-in-button markup. Degrades gracefully: if the open
 * call returns false (e.g. `code` not on PATH, or standalone browser) it no-ops and dims the link
 * with an explanatory title rather than throwing.
 */
function FileLink({
  path,
  openRef,
  className,
  children,
}: {
  path: string;
  openRef?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const open = (e: { stopPropagation: () => void; preventDefault?: () => void }) => {
    e.stopPropagation();
    e.preventDefault?.();
    openWorkspaceEditor(path, openRef ?? undefined)
      .then((ok) => setFailed(!ok))
      .catch(() => setFailed(true));
  };
  return (
    <span
      role="link"
      tabIndex={0}
      title={failed ? `Couldn't open ${path} — is the \`code\` CLI on PATH?` : `Open ${path} in VS Code`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      }}
      className={`cursor-pointer underline-offset-2 hover:underline ${failed ? 'opacity-50' : ''} ${className ?? ''}`}
    >
      {children ?? path}
    </span>
  );
}

// FLUX-682: conservative repo-relative path matcher for plain tool rows. Requires at least one
// `dir/` segment and a file extension, and only matches at a boundary (start / whitespace / `·` /
// `:`) — so bare words, flags, and mid-URL fragments (preceded by `/`) don't get linkified. We
// prefer not-a-link over a wrong-link. First match wins.
const REPO_PATH_RE = /(^|[\s·:])((?:[\w.@~-]+\/)+[\w.@~-]+\.[a-zA-Z][\w]{0,9})(?=$|[\s:·,)\]])/;
function splitToolText(text: string): { before: string; path: string | null; after: string } {
  const m = REPO_PATH_RE.exec(text);
  if (!m) return { before: text, path: null, after: '' };
  const start = m.index + m[1].length;
  const path = m[2];
  return { before: text.slice(0, start), path, after: text.slice(start + path.length) };
}

/** FLUX-1473: split a repo-relative path into its directory prefix and basename so `ToolRow` can
 *  keep the basename fully visible while eliding the directory. The directory span is
 *  left-truncated (a `direction: rtl` + `text-align: left` reverse-ellipsis, the same trick
 *  VS Code's own tab labels use) so it drops the *far* end (the repo root) and keeps the segment
 *  nearest the file — the useful context — rather than a plain end-ellipsis eating the basename. */
function PathTail({ path }: { path: string }) {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return <span className="flex-shrink-0">{path}</span>;
  const dir = path.slice(0, idx + 1);
  const base = path.slice(idx + 1);
  return (
    <>
      <span className="min-w-0 flex-shrink truncate opacity-70" style={{ direction: 'rtl', textAlign: 'left' }}>
        {dir}
      </span>
      <span className="flex-shrink-0">{base}</span>
    </>
  );
}

/** Quiet, uniform tool row — muted wrench + monospace, truncated so long file paths never blow
 *  out the width. Shared by the inline single-tool case and the expanded ToolGroup. FLUX-682: a
 *  repo-relative path in the row text is linkified to open in VS Code. FLUX-1473: the label text
 *  arrives already repo-relative (the engine strips the worktree root); the row itself only
 *  elides the *directory* portion when it overflows (via `PathTail`) so the basename — the part a
 *  reader actually scans for — is never the part that gets clipped. */
function ToolRow({ text, openRef }: { text: string; openRef?: string | null }) {
  const parts = useMemo(() => splitToolText(text), [text]);
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[11px] text-[var(--eh-text-muted)]">
      <Wrench className="h-3 w-3 flex-shrink-0" />
      {parts.path ? (
        <span className="flex min-w-0 items-center font-mono">
          <span className="flex-shrink-0 whitespace-pre">{parts.before}</span>
          <FileLink path={parts.path} openRef={openRef} className="flex min-w-0 items-center">
            <PathTail path={parts.path} />
          </FileLink>
          {parts.after && <span className="flex-shrink-0 truncate">{parts.after}</span>}
        </span>
      ) : (
        <span className="truncate font-mono">{text}</span>
      )}
    </div>
  );
}

/**
 * FLUX-745: a subtle, collapsible "⟳ context update" chip for a `note` transcript row (the
 * warm-resume situational update injected by FLUX-655). It is deliberately NOT a chat bubble —
 * a quiet, full-width meta row (muted refresh glyph + label + hover-revealed timestamp) that
 * reads as a system/automated note. Default-collapsed so the (often multi-paragraph) situational
 * update never buries the actual conversation; expanding renders the text as markdown.
 */
/**
 * FLUX-1362: an in-stream "new revision published" marker — a quiet one-line chip woven into the
 * transcript at the revision's publish moment (so it scrolls away like any other event), replacing
 * the tail-pinned inline artifact card (retired in FLUX-1362). Clicking opens the artifact panel.
 */
function ChatRevisionMarker({ marker, onOpen }: { marker: ArtifactMarker; onOpen?: () => void }) {
  const interactive = !!onOpen;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      {...(interactive ? { type: 'button' as const, onClick: onOpen } : {})}
      title={interactive ? 'Open this artifact in the panel' : undefined}
      className={`group/rev flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/[0.03] px-2.5 py-1 text-left text-[11px] text-[var(--eh-text-secondary)] transition-colors ${interactive ? 'hover:border-primary/40 hover:bg-primary/[0.07]' : ''}`}
    >
      <LayoutTemplate className="h-3.5 w-3.5 flex-shrink-0 text-primary/80" aria-hidden="true" />
      <span className="font-semibold text-[var(--eh-text-primary)]">New revision {marker.rev} published</span>
      {marker.title && <span className="min-w-0 truncate text-[var(--eh-text-muted)]">· {marker.title}</span>}
      {interactive && (
        <span className="ml-auto flex flex-shrink-0 items-center gap-1 text-[10px] font-semibold text-primary/70 transition-colors group-hover/rev:text-primary">
          <ExternalLink className="h-3 w-3" aria-hidden="true" /> Open in panel
        </span>
      )}
    </Tag>
  );
}

function ContextUpdateChip({ text, ts }: { text: string; ts?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide context update' : 'Show context update'}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-dashed border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-2 py-1 text-left text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <RefreshCw className="h-3 w-3 flex-shrink-0" />
        <span className="flex-shrink-0 font-medium uppercase tracking-wide">Context update</span>
        <MessageTime ts={ts} className="ml-auto" />
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-[var(--eh-border)] bg-black/[0.02] px-3 py-2 text-[12px] leading-relaxed text-[var(--eh-text-secondary)] dark:bg-white/[0.02]">
          <TaskMarkdown body={text} compact />
        </div>
      )}
    </div>
  );
}

/**
 * FLUX-794: the pressed phase-launch action (Groom / Implement / Review / Finalize), recorded as a
 * durable `action` note so the popped-in chat shows WHICH button started the session. A quiet,
 * non-bubble row with a ▶ (play) glyph — distinct from the ⟳ context-update chip — sitting in
 * chronological order before the agent's first response. Display-only; not collapsible (the text is
 * a single short line, optionally with the launch focus appended).
 */
function ActionChip({ text, ts }: { text: string; ts?: string }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-dashed border-primary/25 bg-primary/[0.04] px-2 py-1 text-[11px] text-[var(--eh-text-muted)]">
      <Play className="h-3 w-3 flex-shrink-0 text-primary/70" />
      <span className="min-w-0 truncate font-medium text-[var(--eh-text-secondary)]">{text}</span>
      <MessageTime ts={ts} className="ml-auto flex-shrink-0" />
    </div>
  );
}

/**
 * FLUX-833: a gated-tool approval round-trip (`permission_prompt`) recorded as a durable
 * `permission` note so a cold resume shows the approval was requested and how it settled. A quiet,
 * non-bubble row with a 🛡 (shield) glyph — distinct from the ▶ action and ⟳ context-update chips.
 * The text already carries its own state emoji (🔒 requested / ✅ granted / ⛔ denied); display-only.
 */
function PermissionChip({ text, ts }: { text: string; ts?: string }) {
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-dashed border-amber-400/30 bg-amber-400/[0.05] px-2 py-1 text-[11px] text-[var(--eh-text-muted)]">
      <Shield className="h-3 w-3 flex-shrink-0 text-amber-500/70" />
      <span className="min-w-0 truncate font-medium text-[var(--eh-text-secondary)]">{text}</span>
      <MessageTime ts={ts} className="ml-auto flex-shrink-0" />
    </div>
  );
}

// FLUX-867: DISPATCH_STAGE_LABEL (lifecycle → friendly) and DISPATCH_PHASE_LABEL (phase → short)
// moved to ../../lib/dispatch so the board chip here and the Activity screen share one source of
// truth and the friendly labels can't drift. Imported at the top of this file.

/**
 * FLUX-869: per-lifecycle accent for a dispatched-session chip — a leading status dot/glyph, a 2px
 * left rail, and the colored lifecycle word, on an otherwise-neutral body so the accent does the
 * talking. One accent per state, holding in light + dark (WCAG AA): working = primary (live, the dot
 * pulses), completed = emerald, failed = rose, waiting-input = amber (loudest, +tinted body — it's
 * the row that needs a human), cancelled = muted zinc, started = lighter primary. Terminal states
 * carry a static glyph (no motion).
 */
const LIFECYCLE_STYLE: Record<
  NonNullable<TranscriptMessage['lifecycle']>,
  { rail: string; dot: string; text: string; bg?: string; Icon?: LucideIcon }
> = {
  started: { rail: 'border-l-primary/50', dot: 'bg-primary/60', text: 'text-primary/80' },
  working: { rail: 'border-l-primary', dot: 'bg-primary', text: 'text-primary' },
  completed: {
    rail: 'border-l-[var(--eh-state-success)]',
    dot: 'bg-[var(--eh-state-success)]',
    text: 'text-emerald-600 dark:text-emerald-400',
    Icon: CheckCircle2,
  },
  failed: {
    rail: 'border-l-rose-500',
    dot: 'bg-rose-500',
    text: 'text-rose-600 dark:text-rose-400',
    Icon: XCircle,
  },
  'waiting-input': {
    rail: 'border-l-[var(--eh-state-attention)]',
    dot: 'bg-[var(--eh-state-attention)]',
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-[var(--eh-state-attention)]/[0.07]',
    Icon: PauseCircle,
  },
  cancelled: {
    rail: 'border-l-zinc-400 dark:border-l-zinc-500',
    dot: 'bg-zinc-400 dark:bg-zinc-500',
    text: 'text-zinc-500 dark:text-zinc-400',
    Icon: Ban,
  },
};

/** FLUX-869: neutral fallback accent for a dispatch row with no/unknown lifecycle. */
const LIFECYCLE_STYLE_DEFAULT: { rail: string; dot: string; text: string; bg?: string; Icon?: LucideIcon } = {
  rail: 'border-l-[var(--eh-border)]',
  dot: 'bg-[var(--eh-text-muted)]',
  text: 'text-[var(--eh-text-muted)]',
};

// FLUX-869: DISPATCH_PHASE_ICON (phase → lucide glyph for the dispatched-session chip) moved to
// ../../lib/dispatch (FLUX-1281) so the ChatDock's ticket-tab phase iconography shares the shapes.

/** FLUX-869: compact run-duration label, e.g. `45s`, `4m`, `6m12s`, `1h3m`. Coarsens above an hour
 *  (drops seconds) so a long-running row stays short. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}m${s}s` : `${m}m`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

/** FLUX-869: elapsed-ms since `startedAt`, re-rendering each second while `live` (interval cleared on
 *  unmount). Returns null when `startedAt` is absent/unparseable so the caller omits the duration
 *  token gracefully. Terminal rows pass `live=false` and read once (no interval). */
function useElapsed(startedAt: string | undefined, live: boolean): number | null {
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !Number.isFinite(start)) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live, start]);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, now - start);
}

/** FLUX-862: collapse a working chip's narration to one line for its collapsed-header preview —
 *  mirrors ToolGroup's "· last: <action>" summary so a collapsed WORKING row isn't indistinguishable
 *  from every other one. Whitespace-collapsed and capped; CSS truncation handles the rest. */
function previewLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * FLUX-849: a dispatched (unattended, work-phase) session's live activity teed to the board
 * orchestrator thread, rendered as a quiet non-bubble `dispatch` note so a user watching the board
 * sees `started / working / needs-input / completed / failed` without opening the ticket. A 📡
 * (radio) glyph + the source ticket id + the lifecycle stage. The in-flight `working` narration can
 * be multi-paragraph, so that variant is collapsible (default-collapsed, like the context-update
 * chip); the short lifecycle markers render inline.
 */
function DispatchChip({
  text,
  ts,
  sourceTask,
  title,
  phase,
  lifecycle,
  startedAt,
  linkifyTickets,
}: {
  text: string;
  ts?: string;
  sourceTask?: string;
  /** FLUX-865: source ticket title, resolved from the `tickets` prop at the call site. Omitted when
   *  the ticket isn't loaded — the chip falls back to the bare id. */
  title?: string;
  phase?: 'grooming' | 'implementation' | 'review' | 'finalize' | 'fast-path' | 'batch-grooming';
  lifecycle?: 'started' | 'working' | 'completed' | 'failed' | 'cancelled' | 'waiting-input';
  /** FLUX-869: dispatched session start (ISO) — powers the run-duration token. Absent on older rows. */
  startedAt?: string;
  linkifyTickets?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const { openTicket } = useDockActions();
  const isWorking = lifecycle === 'working';
  // FLUX-862: one-line preview of the in-flight narration, shown only on a collapsed working
  // header (open state hides it — the full text is right there instead).
  const preview = isWorking && !open ? previewLine(text) : undefined;
  const stageLabel = (lifecycle && DISPATCH_STAGE_LABEL[lifecycle]) ?? lifecycle ?? 'activity';
  // FLUX-869: lifecycle accent (status dot/glyph + left rail + colored word). Neutral fallback when
  // lifecycle is absent/unknown so a malformed row still renders.
  const style = (lifecycle && LIFECYCLE_STYLE[lifecycle]) ?? LIFECYCLE_STYLE_DEFAULT;
  // FLUX-865/869: phase known → a single tooltip'd icon (replaces the uppercase pill). Absent phase
  // renders nothing, never "undefined".
  const phaseLabel = phase ? (DISPATCH_PHASE_LABEL[phase] ?? phase) : undefined;
  const PhaseIcon = phase ? DISPATCH_PHASE_ICON[phase] : undefined;
  const StatusIcon = style.Icon;

  // FLUX-869: run duration. Working → live-ticking `running Xm` (gated null when no startedAt);
  // terminal → final `ran Xm` computed as (eventTs − startedAt). Omitted gracefully when absent.
  const elapsedLive = useElapsed(startedAt, isWorking);
  let durationLabel: string | undefined;
  if (isWorking) {
    durationLabel = elapsedLive != null ? `running ${formatDuration(elapsedLive)}` : undefined;
  } else if (startedAt && ts) {
    const finalMs = new Date(ts).getTime() - new Date(startedAt).getTime();
    if (Number.isFinite(finalMs) && finalMs >= 0) durationLabel = `ran ${formatDuration(finalMs)}`;
  }

  // FLUX-869: leading status glyph — working = pulsing dot (ping ring gated behind reduced-motion),
  // terminal = its static lucide glyph, started/unknown = a plain dot. "Live row breathes, finished
  // row sits still."
  const statusGlyph = isWorking ? (
    <span className="relative flex h-2 w-2 flex-shrink-0 items-center justify-center" aria-label="working">
      {!reduceMotion && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${style.dot}`} />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
    </span>
  ) : StatusIcon ? (
    <StatusIcon className={`h-3 w-3 flex-shrink-0 ${style.text}`} aria-label={stageLabel} />
  ) : (
    <span className={`h-2 w-2 flex-shrink-0 rounded-full ${style.dot}`} aria-label={stageLabel} />
  );

  // FLUX-862: the ticket id is the chip's most natural click target — open it the same way an
  // inline `FLUX-123` chat reference does. A <span role="link"> (not a real <button>) because the
  // working variant nests this header inside its own collapse-toggle <button>; stopPropagation
  // keeps the id click from also firing that toggle (mirrors FileLink above).
  const openSourceTicket = (e: { stopPropagation: () => void; preventDefault?: () => void }) => {
    e.stopPropagation();
    e.preventDefault?.();
    if (sourceTask) openTicket(sourceTask);
  };

  // FLUX-869 hierarchy ladder: title is the brightest lead, id secondary mono, phase a tooltip'd
  // icon, the lifecycle word carries the color (the one surviving uppercase token).
  const header = (
    <>
      {statusGlyph}
      {sourceTask && (
        linkifyTickets ? (
          <span
            role="link"
            tabIndex={0}
            title={`Open ${sourceTask}`}
            onClick={openSourceTicket}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openSourceTicket(e); }}
            className="flex-shrink-0 cursor-pointer font-mono text-[var(--eh-text-muted)] underline-offset-2 hover:text-primary hover:underline"
          >
            {sourceTask}
          </span>
        ) : (
          <span className="flex-shrink-0 font-mono text-[var(--eh-text-muted)]">{sourceTask}</span>
        )
      )}
      {(title || preview) && (
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--eh-text-primary)]" title={title}>
          {title}
          {preview && (
            <span className="font-mono font-normal text-[var(--eh-text-muted)]">
              {title ? ' · ' : ''}
              {preview}
            </span>
          )}
        </span>
      )}
      {PhaseIcon && (
        <span title={phaseLabel} className="flex-shrink-0">
          <PhaseIcon className="h-3 w-3 text-[var(--eh-text-muted)]" aria-label={phaseLabel} />
        </span>
      )}
      <span className={`flex-shrink-0 text-[10px] font-medium uppercase tracking-wide ${style.text}`}>
        {stageLabel}
      </span>
    </>
  );

  // FLUX-869: right-aligned meta cluster — final/live duration then the absolute/relative "when".
  const meta = (
    <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
      {durationLabel && (
        <span className="whitespace-nowrap tabular-nums text-[10px] text-[var(--eh-text-muted)]">{durationLabel}</span>
      )}
      <MessageTime ts={ts} className="!opacity-100 !text-[var(--eh-text-secondary)]" />
    </span>
  );

  // Lifecycle markers (started / completed / failed / stopped / needs input) are one short line.
  if (!isWorking) {
    return (
      <div
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md border border-[var(--eh-border)] border-l-2 ${style.rail} ${style.bg ?? ''} px-2 py-1 text-[11px] text-[var(--eh-text-muted)]`}
      >
        {header}
        {meta}
      </div>
    );
  }

  // In-flight narration — collapsible so a long message never buries the orchestrator dialogue.
  return (
    <div className="group min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide dispatched-session narration' : 'Show dispatched-session narration'}
        className={`flex w-full min-w-0 items-center gap-1.5 rounded-md border border-[var(--eh-border)] border-l-2 ${style.rail} ${style.bg ?? ''} px-2 py-1 text-left text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]`}
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        {header}
        {meta}
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-[var(--eh-border)] bg-black/[0.02] px-3 py-2 text-[12px] leading-relaxed text-[var(--eh-text-secondary)] dark:bg-white/[0.02]">
          <TaskMarkdown body={text} compact linkifyTickets={linkifyTickets} />
        </div>
      )}
    </div>
  );
}

/** FLUX-1473: while a tool group is the live trailing run, cap the expanded list to the last few
 *  rows plus a "+N earlier · <counts>" summary line — a long tool-heavy turn otherwise dumps 20+
 *  rows of scrollback into the transcript instead of reading as motion. The summary is itself a
 *  button that reveals everything; a manually forced-full group (or one that settles once the
 *  turn ends) shows the full list uncapped, same as before FLUX-1473. */
const LIVE_TOOL_GROUP_CAP = 4;

/**
 * FLUX-680: a collapsed cluster of consecutive tool calls. Default-collapsed, the header reads
 * "⚙ N tool calls · last: <action>" so you still get a "what did it just do" glance without
 * expanding; clicking reveals the individual quiet ToolRows. The trailing group is opened by the
 * caller while the agent is working so a live turn keeps showing motion.
 */
function ToolGroup({ texts, defaultOpen, openRef }: { texts: string[]; defaultOpen: boolean; openRef?: string | null }) {
  const [open, setOpen] = useState(defaultOpen);
  const [forceFull, setForceFull] = useState(false);
  // FLUX-687: the group's key (`g${start}`) is stable, so React never remounts it to pick up a
  // changed defaultOpen. Drive open from the prop so a group collapses once it stops being the
  // live trailing run, while still letting the user manually toggle within a render cycle.
  // FLUX-1473: a manual "show all" resets here too, so the next live-trailing group starts capped.
  useEffect(() => {
    setOpen(defaultOpen);
    setForceFull(false);
  }, [defaultOpen]);
  const last = texts[texts.length - 1];
  const capped = open && defaultOpen && !forceFull && texts.length > LIVE_TOOL_GROUP_CAP;
  const visibleStart = capped ? texts.length - LIVE_TOOL_GROUP_CAP : 0;
  const visible = capped ? texts.slice(visibleStart) : texts;
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide tool calls' : 'Show tool calls'}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="flex-shrink-0 font-medium">{texts.length} tool calls</span>
        {!open && (
          <>
            <span className="flex-shrink-0 opacity-50">·</span>
            <span className="truncate font-mono opacity-80">{last}</span>
          </>
        )}
      </button>
      {open && (
        <div className="ml-3.5 flex flex-col gap-1 border-l border-[var(--eh-border)] pl-2">
          {capped && (
            <button
              type="button"
              onClick={() => setForceFull(true)}
              title="Show all tool calls"
              className="flex min-w-0 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
            >
              <span className="flex-shrink-0 font-medium">+{visibleStart} earlier</span>
              <span className="flex-shrink-0 opacity-50">·</span>
              <span className="truncate opacity-80">{summarizeTrail(texts.slice(0, visibleStart).map((t) => t.split(' · ')[0]))}</span>
            </button>
          )}
          {visible.map((t, i) => (
            <ToolRow key={visibleStart + i} text={t} openRef={openRef} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * FLUX-661/688: an edit-tool row rendered as an expandable inline diff. The collapsed row reads
 * like a real change line — verb (`edited`/`wrote`) + file basename + colored per-edit `+N −M`
 * counts (FLUX-688: what *this* tool call changed, derived server-side from the tool input) —
 * but is clickable; expanding lazily fetches the file's current cumulative diff vs base
 * (`fetchDiffFile(branch, path)`, the same endpoint the ChatDiffPanel uses) and renders the
 * syntax-highlighted hunk. Note the deliberate mismatch: the row counts describe this single
 * edit, while the expanded diff is the file's *current* cumulative diff vs base — consistent
 * with the always-current diff panel (sibling ticket). A true per-edit hunk is the follow-up.
 */
function InlineEditDiff({
  branch,
  path,
  tool,
  added,
  removed,
}: {
  branch: string;
  path: string;
  tool?: string;
  added?: number;
  removed?: number;
}) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!open || diff !== null || loading || error) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    fetchDiffFile(branch, path)
      .then((text) => { if (reqIdRef.current === reqId) setDiff(text ?? '(no diff available)'); })
      .catch((e) => { if (reqIdRef.current === reqId) setError(e?.message || 'Failed to load file diff'); })
      .finally(() => { if (reqIdRef.current === reqId) setLoading(false); });
  }, [open, diff, loading, error, branch, path]);

  // Repo-relative POSIX path → basename for the row; full path lives in the button title.
  const base = path.split('/').pop() || path;
  const verb = tool === 'Write' ? 'wrote' : 'edited';
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={path}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-[var(--eh-text-secondary)]"
      >
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="flex-shrink-0">{verb}</span>
        {/* FLUX-682: basename opens the file in VS Code; stopPropagation keeps the row's diff toggle
            from also firing. Uses `branch` as the ref so worktree checkouts open the right tree. */}
        <FileLink path={path} openRef={branch} className="truncate font-mono">{base}</FileLink>
        {added !== undefined && removed !== undefined && (
          <span className="flex-shrink-0 text-[10px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{' '}
            <span className="text-red-500 dark:text-red-400">−{removed}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="mb-1 ml-3.5 overflow-x-auto rounded border border-[var(--eh-border)] bg-black/[0.02] py-1 dark:bg-white/[0.02]">
          {loading && <p className="px-2 py-1 text-[11px] text-[var(--eh-text-muted)]">Loading…</p>}
          {error && (
            <p className="px-2 py-1 text-[11px] text-red-500">
              {error}{' '}
              <button type="button" onClick={() => setError(null)} className="underline hover:no-underline">
                Retry
              </button>
            </p>
          )}
          {!loading && !error && diff !== null && <DiffLines content={diff} />}
        </div>
      )}
    </div>
  );
}

/**
 * FLUX-684: the muted, hover-revealed timestamp on a chat turn. Renders nothing when `ts` is
 * absent/unparseable (optimistic/pending turns). The label is `opacity-0 group-hover:opacity-100`
 * so it stays out of the way until you hover the row; its width is always reserved, so revealing
 * it causes no layout shift. The absolute local time lives in the `title` tooltip.
 */
function MessageTime({ ts, className = '' }: { ts?: string; className?: string }) {
  const rel = ts ? formatRelative(ts) : '';
  if (!rel) return null;
  return (
    <span
      title={new Date(ts!).toLocaleString()}
      className={`select-none whitespace-nowrap text-[10px] text-[var(--eh-text-muted)] opacity-0 transition-opacity group-hover:opacity-100 ${className}`}
    >
      {rel}
    </span>
  );
}

/** mm:ss once past a minute, else `Ns` — compact enough for the inline strip. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Fold the turn's activity trail into one line: distinct verbs in order, counted when
 *  repeated (e.g. "Reading ×2 · Editing · Running command"). */
function summarizeTrail(trail: string[]): string {
  const order: string[] = [];
  const counts: Record<string, number> = {};
  for (const a of trail) {
    if (!(a in counts)) order.push(a);
    counts[a] = (counts[a] ?? 0) + 1;
  }
  return order.map((a) => (counts[a] > 1 ? `${a} ×${counts[a]}` : a)).join(' · ');
}

/**
 * FLUX-639/640: the single persistent "is it alive" surface, pinned above the composer.
 * While the turn runs it shows the live activity verb, an elapsed timer and a Stop button,
 * with an expandable timeline of what the agent did this turn. When the turn ends it folds
 * the trail into a one-line summary (still expandable) so finished turns don't clutter the
 * transcript. Renders nothing when idle with no trail.
 */
function WorkingStrip({
  working,
  busy,
  activity,
  elapsedMs,
  trail,
  onStop,
}: {
  working: boolean;
  busy: boolean;
  activity: string | null;
  elapsedMs: number;
  trail: string[];
  onStop?: () => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const live = working || busy;
  if (!live && trail.length === 0) return null;

  // Live: the agent is working (or a turn is being sent). Show activity + elapsed + Stop.
  if (live) {
    const label = working ? activity || 'Working' : 'Thinking…';
    const hasTrail = trail.length > 1;
    return (
      <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--eh-text-primary)]">{label}</span>
          {working && <span className="flex-shrink-0 font-mono text-[11px] text-[var(--eh-text-muted)]">{formatElapsed(elapsedMs)}</span>}
          {hasTrail && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? 'Hide steps' : 'Show steps'}
              aria-expanded={expanded}
              className="flex flex-shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {trail.length}
            </button>
          )}
          {working && onStop && (
            <button
              type="button"
              onClick={() => onStop()}
              className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/10"
            >
              <Square className="h-2.5 w-2.5 fill-current" /> Stop
            </button>
          )}
        </div>
        {hasTrail && expanded && <TrailList trail={trail} />}
      </div>
    );
  }

  // Folded: the turn finished — a quiet one-line summary, expandable to the full trail.
  return (
    <div className="rounded-xl border border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-3 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left"
      >
        {/* FLUX-649: a neutral, muted clock — the strip only knows the trail, not the turn's
            outcome, so it must not assert an emerald "✓ success" on a stopped/errored turn. */}
        <Clock className="h-3.5 w-3.5 flex-shrink-0 text-[var(--eh-text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--eh-text-muted)]">{summarizeTrail(trail)}</span>
        {trail.length > 1 &&
          (expanded ? (
            <ChevronDown className="h-3 w-3 flex-shrink-0 text-[var(--eh-text-muted)]" />
          ) : (
            <ChevronRight className="h-3 w-3 flex-shrink-0 text-[var(--eh-text-muted)]" />
          ))}
      </button>
      {expanded && trail.length > 1 && <TrailList trail={trail} />}
    </div>
  );
}

/** The expanded per-step list shared by the live and folded states. */
function TrailList({ trail }: { trail: string[] }) {
  return (
    <ol className="mt-2 space-y-1 border-t border-[var(--eh-border)] pt-2">
      {trail.map((step, i) => (
        <li key={i} className="flex items-center gap-2 text-[11px] text-[var(--eh-text-secondary)]">
          <span className="h-1 w-1 flex-shrink-0 rounded-full bg-[var(--eh-text-muted)]" aria-hidden="true" />
          <span className="truncate">{step}</span>
        </li>
      ))}
    </ol>
  );
}

/** FLUX-694: a detected ticket-reference trigger ending at the caret — the token's start
 *  offset in the input and the search query to fuzzy-match against the board. */
interface TicketTrigger {
  start: number;
  query: string;
}

/** Max autocomplete suggestions shown at once. */
const MENTION_LIMIT = 8;

/**
 * FLUX-694: detect a ticket-reference trigger ending at the caret. Two forms:
 *  - `#query`   — explicit picker; `query` is the text typed after `#`.
 *  - `FLUX-12`  — a typed project-id prefix (prefixes derived from the board's ticket ids).
 * The trigger must sit at the start of the input or after whitespace / an opening bracket, so it
 * never fires mid-word (`C#`, a URL fragment, an email). Returns the replaceable token's start
 * offset + the search query, or `null` when the caret isn't inside a trigger.
 *
 * `@file` autocomplete is intentionally NOT handled here: the engine exposes no repo file-list
 * endpoint/index to back it, so it's deferred per the FLUX-694 grooming gate. Add an `@` branch
 * here (and an `@`-form clause to the popover) once such an index exists.
 */
function detectTicketTrigger(before: string, prefixes: string[]): TicketTrigger | null {
  const hash = /(?:^|[\s([{<])#([\w-]*)$/.exec(before);
  if (hash) {
    const query = hash[1];
    return { start: before.length - query.length - 1, query };
  }
  if (prefixes.length > 0) {
    // Escape each prefix before interpolating — a ticket-id prefix carrying a regex metachar
    // (possible for board/group projects) would otherwise throw on every keystroke (FLUX-677 review).
    const escaped = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?:^|[\\s([{<])((?:${escaped.join('|')})-\\d*)$`, 'i');
    const m = re.exec(before);
    if (m) {
      const token = m[1];
      return { start: before.length - token.length, query: token };
    }
  }
  return null;
}

/**
 * Message composer — isolated from the transcript on purpose. Holds the input + the
 * model / effort / permission selections in local state, so typing only re-renders this
 * small subtree (not the markdown-heavy message list). Submits via the parent's `onSend`.
 *
 * FLUX-623: the text draft is *optionally* controlled. When `onDraftChange` is provided the
 * value comes from the `draft` prop (so the dock can persist it across minimize/reopen, which
 * unmounts this subtree); otherwise it falls back to internal `useState` (the task-modal
 * `ChatPane` path, which never unmounts).
 *
 * FLUX-666: the model/effort/permission chip selections are optionally controlled the SAME way.
 * When `onSelectionsChange` is provided they come from the `selections` prop (so the dock persists
 * them across minimize/reopen alongside the text draft); otherwise they fall back to internal
 * `useState` (the never-unmounting `ChatPane` path).
 */
function Composer({
  busy,
  working,
  onSend,
  onEnqueue,
  onUploadImage,
  draft,
  onDraftChange,
  selections,
  onSelectionsChange,
  tickets,
  answerPrompt,
  onAnswerQuestion,
  editingTurn,
  onEditSubmit,
  onCancelEdit,
}: {
  busy: boolean;
  /** FLUX-714: the agent's turn is genuinely in flight (live `running` session). FLUX-748: this no
   *  longer blocks submit — instead a mid-turn submit is QUEUED (via `onEnqueue`) and auto-sent when
   *  the turn finishes. `busy` alone resets when the POST returns (~1s), long before the turn ends. */
  working?: boolean;
  onSend: ChatViewProps['onSend'];
  /** FLUX-748: queue a message instead of sending when `working`/`busy`. When absent the composer
   *  keeps the old gated behavior (submit blocked mid-turn). */
  onEnqueue?: (text: string, opts?: ChatSendOptions) => void;
  onUploadImage?: (file: File) => Promise<ChatAttachment>;
  draft?: string;
  onDraftChange?: (text: string) => void;
  selections?: ComposerSelections;
  onSelectionsChange?: (selections: ComposerSelections) => void;
  tickets?: Task[];
  /** FLUX-923: when set, submit answers this parked question instead of sending/queuing a message. */
  answerPrompt?: { id: string; label: string } | null;
  onAnswerQuestion?: (text: string) => void | Promise<void>;
  /** FLUX-685: when set, the composer is editing this past user turn — seeds the draft with its
   *  text and submit routes to `onEditSubmit` instead of send/queue. */
  editingTurn?: { seq: number; text: string } | null;
  onEditSubmit?: (seq: number, text: string, opts: ChatSendOptions) => void | Promise<void>;
  /** FLUX-685: step out of edit mode — clears the parent's `editingTurn` (called on submit too). */
  onCancelEdit?: () => void;
}) {
  const [internalInput, setInternalInput] = useState('');
  // FLUX-666: internal chip-selection state — used only on the uncontrolled (ChatPane) path.
  const [internalModel, setInternalModel] = useState('');
  const [internalEffort, setInternalEffort] = useState('');
  const [internalPermission, setInternalPermission] = useState('');
  // FLUX-1236: has the user touched the Perms chip in this composer's life? The chip can't tell
  // "left at Default ('')" from "explicitly chose Default ('')", and DockProvider.setSelections
  // normalizes/prunes '' ↔ undefined so persisted selections can't carry the distinction either.
  // Gate the permission field on this flag: only a touched chip transmits a mode; an untouched
  // follow-up omits it so the engine leaves the session's mode alone (see submit + api.ts).
  const [permissionTouched, setPermissionTouched] = useState(false);
  // FLUX-674: pasted/dropped/picked images staged for the next turn, plus upload state.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // FLUX-923: answer-mode off-ramp + in-flight guard. `answerDismissed` lets the user step OUT of
  // answer mode (the ✕ on the pill) so an Enter/Send goes through the normal send/queue path instead
  // of irreversibly settling the parked question — the picker chips stay as the answer path. Reset
  // whenever a *different* question arrives so a fresh prompt always re-enters answer mode.
  const [answerDismissed, setAnswerDismissed] = useState(false);
  // Prevents a double-answer race (chip + Enter, or a double Enter) from POSTing the same prompt twice.
  const [answerSubmitting, setAnswerSubmitting] = useState(false);
  const answerPromptId = answerPrompt?.id ?? null;
  useEffect(() => {
    setAnswerDismissed(false);
    setAnswerSubmitting(false);
  }, [answerPromptId]);
  // Effective answer mode: a single-question prompt is parked for this chat AND the user hasn't opted out.
  const answering = !!answerPrompt && !answerDismissed;
  // FLUX-694: ticket autocomplete. `mention` is the active trigger at the caret (null when none);
  // `mentionIdx` is the highlighted suggestion. `taRef` lets us read/restore the caret for
  // mid-string insertion. The picker is keyboard-first (↑/↓/Enter/Tab/Esc).
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<TicketTrigger | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);

  // Controlled when the parent owns the draft; uncontrolled otherwise. A single value/setValue
  // pair keeps the textarea always-controlled (no controlled↔uncontrolled flip warning).
  const controlled = onDraftChange !== undefined;
  const input = controlled ? draft ?? '' : internalInput;
  const setValue = controlled ? onDraftChange! : setInternalInput;

  // FLUX-685: entering edit mode repopulates the composer with the target turn's text — keyed on
  // `seq` (not the whole `editingTurn` object) so this fires once per NEW edit target and doesn't
  // clobber further keystrokes on re-render.
  const editingSeq = editingTurn?.seq;
  useEffect(() => {
    if (editingSeq !== undefined) setValue(editingTurn!.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSeq]);

  // FLUX-666: chip selections are optionally controlled the same way as the text draft. When the
  // parent owns them (`onSelectionsChange` provided — the dock path), the values come from the
  // `selections` prop and each setter folds the one changed field into a fresh selections object
  // the parent persists; otherwise they're internal `useState` (the never-unmounting ChatPane path).
  const selectionsControlled = onSelectionsChange !== undefined;
  const model = selectionsControlled ? selections?.model ?? '' : internalModel;
  const effort = selectionsControlled ? selections?.effort ?? '' : internalEffort;
  const permission = selectionsControlled ? selections?.permission ?? '' : internalPermission;
  const setModel = selectionsControlled
    ? (v: string) => onSelectionsChange!({ model: v, effort, permission })
    : setInternalModel;
  const setEffort = selectionsControlled
    ? (v: string) => onSelectionsChange!({ model, effort: v, permission })
    : setInternalEffort;
  const setPermission = selectionsControlled
    ? (v: string) => onSelectionsChange!({ model, effort, permission: v })
    : setInternalPermission;
  // FLUX-1236: mark the chip touched on any user change so `submit` transmits the mode only then.
  const changePermission = (v: string) => {
    setPermissionTouched(true);
    setPermission(v);
  };

  const canAttach = !!onUploadImage;
  const isUploading = uploading > 0;

  // FLUX-694: distinct project-id prefixes present on the board (e.g. `FLUX`), so a typed
  // `FLUX-12` opens the picker without hardcoding the project key. Empty ⇒ only `#` triggers.
  const prefixes = useMemo(
    () => Array.from(new Set((tickets ?? []).map((t) => t.id.split('-')[0]).filter(Boolean))),
    [tickets],
  );

  // Suggestions for the active trigger: fuzzy-rank via the shared board search; an empty query
  // (just typed `#`) falls back to the most-recently-active tickets so the picker is never blank.
  const candidates = useMemo(() => {
    if (!mention || !tickets || tickets.length === 0) return [];
    if (mention.query) return searchTasks(tickets, mention.query, MENTION_LIMIT).map((r) => r.task);
    return [...tickets]
      .sort((a, b) => getTaskActivityTimestamp(b) - getTaskActivityTimestamp(a))
      .slice(0, MENTION_LIMIT);
  }, [mention, tickets]);

  // Re-evaluate the trigger whenever the value or caret moves. Resets the highlight to the top.
  function refreshMention(value: string, caret: number) {
    if (!tickets || tickets.length === 0) {
      if (mention) setMention(null);
      return;
    }
    setMention(detectTicketTrigger(value.slice(0, caret), prefixes));
    setMentionIdx(0);
  }

  // Splice the chosen ticket id (+ trailing space) over the trigger token, then restore focus and
  // place the caret right after the inserted ref — works mid-string, not just at end-of-input.
  function insertTicket(id: string) {
    if (!mention) return;
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const next = `${input.slice(0, mention.start)}${id} ${input.slice(caret)}`;
    setValue(next);
    setMention(null);
    const pos = mention.start + id.length + 1;
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  }

  const mentionOpen = !!mention && candidates.length > 0;

  // Upload a batch of image files in parallel, appending each successful ref to the chips.
  async function uploadFiles(files: File[]) {
    if (!onUploadImage || files.length === 0) return;
    setAttachError(null);
    setUploading((n) => n + files.length);
    await Promise.all(
      files.map(async (file) => {
        try {
          const att = await onUploadImage(file);
          setAttachments((prev) => [...prev, att]);
        } catch (err) {
          setAttachError(err instanceof Error ? err.message : 'Failed to attach image.');
        } finally {
          setUploading((n) => n - 1);
        }
      }),
    );
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const files = Array.from(e.clipboardData.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    void uploadFiles(files);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!canAttach) return;
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    setDragging(false);
    if (files.length === 0) return;
    e.preventDefault();
    void uploadFiles(files);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!canAttach || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  }

  function submit() {
    const text = input.trim();
    // FLUX-685: edit-and-resend — takes priority over everything below (a deliberate click on the
    // pencil affordance, which is itself disabled while working/busy, so this branch never races
    // the answer-mode/queue paths). Empty text is a no-op rather than a resend-with-nothing.
    if (editingTurn) {
      if (!text || working || busy) return;
      const opts: ChatSendOptions = {
        model,
        effort,
        permissionMode: permissionTouched ? permission : undefined,
        attachments,
      };
      void onEditSubmit?.(editingTurn.seq, text, opts);
      setValue('');
      setAttachments([]);
      setAttachError(null);
      onCancelEdit?.();
      return;
    }
    // FLUX-923: answer mode — a parked ask_user_question is awaiting an answer in this chat. Route the
    // free-text reply to settle it (the session is still `working` because the turn is parked on the
    // question, so the normal path would only QUEUE the text). Must run BEFORE the working/busy branch.
    // Stepping out via the pill's ✕ (`answerDismissed`) falls through to the normal send/queue path.
    if (answering && onAnswerQuestion) {
      if (!text || answerSubmitting) return;
      setAnswerSubmitting(true);
      // Clear the box only AFTER the engine accepts the answer — on failure the typed text is kept so
      // the user can retry (onAnswerQuestion rethrows; the prompt stays parked). See useComposerAnswer.
      void (async () => {
        try {
          await onAnswerQuestion(text);
          setValue('');
          setAttachments([]);
          setAttachError(null);
        } catch {
          setAttachError('Failed to send your answer — it was kept; please try again.');
        } finally {
          setAnswerSubmitting(false);
        }
      })();
      return;
    }
    if ((!text && attachments.length === 0) || isUploading) return;
    // FLUX-1236: only send the permission chip when the user actually touched it this session.
    // Otherwise every ordinary follow-up would transmit the chip's '' → 'default' sentinel and
    // wipe the session's mode on resume. `undefined` is dropped by the api layer ("unchanged").
    const opts: ChatSendOptions = {
      model,
      effort,
      permissionMode: permissionTouched ? permission : undefined,
      attachments,
    };
    // FLUX-748: mid-turn (working) or mid-POST (busy) → queue instead of erroring; it auto-dispatches
    // when the turn finishes. When no queue is wired, keep the old gate (block while working/busy).
    if (working || busy) {
      if (!onEnqueue) return;
      onEnqueue(text, opts);
    } else {
      void onSend(text, opts);
    }
    setValue('');
    // FLUX-666: reset the model/effort chips after a send, consistent with clearing the text draft
    // (they are per-turn overrides that otherwise fall back to the session defaults).
    // FLUX-1236: but the permission chip is a STICKY session mode, not a per-turn override —
    // preserve its value (and its touched flag) so the picker keeps showing the chosen mode and the
    // next send re-emits it (an idempotent no-op on the engine). Resetting it to Default would make
    // the following send transmit the 'default' sentinel and silently revert the mode the user set.
    // On the controlled (dock) path one write prunes to nothing when all three are empty; on the
    // uncontrolled path reset the internal states directly (calling the per-field controlled setters
    // in sequence would each see a stale closure of the other two).
    if (selectionsControlled) {
      onSelectionsChange!({ permission });
    } else {
      setInternalModel('');
      setInternalEffort('');
    }
    setAttachments([]);
    setAttachError(null);
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragging(false)}
      className={`relative rounded-2xl border bg-[var(--eh-input-bg)] transition-colors focus-within:border-primary ${
        dragging ? 'border-primary border-dashed' : 'border-[var(--eh-border)]'
      }`}
    >
      {/* FLUX-694: ticket autocomplete popover — floats above the composer (which sits at the
          bottom of the window), reusing the ChipSelect `eh-border eh-surface` popover treatment.
          Items use onMouseDown+preventDefault so clicking one doesn't blur the textarea before
          the selection lands. Keyboard nav lives on the textarea's onKeyDown. */}
      {mentionOpen && (
        <div
          role="listbox"
          aria-label="Ticket suggestions"
          className="eh-border eh-surface absolute bottom-full left-2 right-2 z-20 mb-1.5 max-h-60 overflow-y-auto rounded-lg border p-1 shadow-xl"
        >
          <div className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--eh-text-muted)]">
            Reference a ticket
          </div>
          {candidates.map((t, i) => {
            const selected = i === mentionIdx;
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={selected}
                ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setMentionIdx(i)}
                onClick={() => insertTicket(t.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                  selected ? 'bg-primary/10' : 'hover:bg-black/5 dark:hover:bg-white/5'
                }`}
              >
                <span className="flex-shrink-0 font-mono text-[11px] font-semibold text-primary">{t.id}</span>
                <span className="truncate text-[var(--eh-text-secondary)]">{t.title}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* FLUX-674: thumbnail chips for staged images, each removable before send. */}
      {(attachments.length > 0 || isUploading) && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          {attachments.map((a, i) => (
            <div key={i} className="group relative">
              <img
                src={ehBrowserUrl(a.url)}
                alt={a.fileName}
                title={a.fileName}
                className="h-14 w-14 rounded-lg border border-[var(--eh-border)] object-cover"
              />
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                title="Remove"
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700 text-white opacity-0 shadow transition-opacity group-hover:opacity-100 hover:bg-gray-900 dark:bg-white/30 dark:hover:bg-white/50"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          {isUploading && (
            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-[var(--eh-border)] text-[var(--eh-text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
        </div>
      )}
      {/* FLUX-685: editing-mode banner — a visible cue that Enter/Send will REPLACE the transcript
          from this turn onward (not append a normal message), with a ✕ off-ramp back to a plain
          send. Mirrors the FLUX-923 answer-mode pill below. */}
      {editingTurn && (
        <div className="mx-3 mt-2 flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-[11px] text-[var(--eh-text-primary)]">
          <Pencil className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold text-primary">Editing:</span> will replace this message and everything after it
          </span>
          <button
            type="button"
            onClick={() => { setValue(''); onCancelEdit?.(); }}
            title="Cancel editing"
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[var(--eh-text-muted)] transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {/* FLUX-923: answer-mode pill — a visible cue that Enter/Send will SETTLE the parked question
          (not send a chat message), with a ✕ off-ramp back to normal send so an accidental Enter or a
          stale draft can't silently burn the question. The picker chips remain the other answer path. */}
      {answering && answerPrompt && (
        <div className="mx-3 mt-2 flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-[11px] text-[var(--eh-text-primary)]">
          <HelpCircle className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold text-primary">Answering:</span> {answerPrompt.label}
          </span>
          <button
            type="button"
            onClick={() => setAnswerDismissed(true)}
            title="Send a normal message instead (the question stays open — answer it from the chips above)"
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[var(--eh-text-muted)] transition-colors hover:bg-black/10 hover:text-[var(--eh-text-primary)] dark:hover:bg-white/10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {attachError && <p className="px-3.5 pt-2 text-[11px] text-red-500">{attachError}</p>}
      <textarea
        ref={taRef}
        value={input}
        onChange={(e) => {
          setValue(e.target.value);
          refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => refreshMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onBlur={() => setMention(null)}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          // FLUX-694: while the autocomplete is open, the arrow/Enter/Tab/Esc keys drive it
          // instead of the textarea (Enter must not send, Esc must not blur).
          if (mentionOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setMentionIdx((i) => (i + 1) % candidates.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setMentionIdx((i) => (i - 1 + candidates.length) % candidates.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              insertTicket(candidates[mentionIdx].id);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={
          editingTurn
            ? 'Edit and resend…  (Enter to replace, Shift+Enter for newline)'
            : answering
              ? 'Type your answer…  (Enter to send your reply)'
              : canAttach
                ? 'Message…  (Enter to send, paste or drop an image)'
                : 'Message…  (Enter to send, Shift+Enter for newline)'
        }
        className="max-h-32 min-h-[40px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] text-[var(--eh-text-primary)] placeholder:text-[var(--eh-text-muted)] focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <ChipSelect icon={Cpu} name="Model" value={model} options={MODEL_OPTS} onChange={setModel} />
          <ChipSelect icon={Gauge} name="Effort" value={effort} options={EFFORT_OPTS} onChange={setEffort} />
          <ChipSelect icon={Shield} name="Perms" value={permission} options={PERM_OPTS} onChange={changePermission} />
          {canAttach && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attach image"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5"
              >
                <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = ''; // allow re-picking the same file
                  void uploadFiles(files);
                }}
              />
            </>
          )}
        </div>
        <button
          type="button"
          onClick={submit}
          // FLUX-748: stay clickable while working/busy so a follow-up can be QUEUED — only the
          // legacy no-queue path (`!onEnqueue`) keeps the old hard gate. Empty input / uploads
          // still disable it in either mode. FLUX-923: in answer mode the only gate is empty text —
          // answering a parked question is allowed regardless of `working` (the turn is parked on it).
          // FLUX-685: editing has NO queue equivalent — a rewind+resend only makes sense against an
          // idle turn, so it's gated on `working || busy` same as the legacy no-queue path.
          disabled={
            editingTurn
              ? !input.trim() || working || busy
              : answering
                ? !input.trim() || answerSubmitting
                : isUploading || (!input.trim() && attachments.length === 0) || ((busy || working) && !onEnqueue)
          }
          title={
            editingTurn
              ? working || busy
                ? 'Wait for the current turn to finish'
                : 'Resend — replaces this message and everything after it'
              : answering
                ? 'Send your answer to the agent'
                : (working || busy) && onEnqueue
                  ? 'Queue message — sends when the current turn finishes'
                  : working
                    ? 'Wait for the current turn to finish'
                    : 'Send'
          }
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {answering && answerSubmitting ? <Loader2 className="h-4 w-4 animate-spin" />
            : !answering && (busy || working) && !onEnqueue ? <Loader2 className="h-4 w-4 animate-spin" />
            : editingTurn ? <RefreshCw className="h-4 w-4" />
            : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

/**
 * Compact, fully-themed replacement for a native `<select>` in the composer footer.
 * Trigger = icon + current value + chevron; the popover opens upward (the composer sits
 * at the bottom of the window) on the `--eh-*` surface tokens so it matches the chat.
 * A non-default selection tints the chip with the accent (or red for a `danger` option)
 * so you can see at a glance which knobs are overridden.
 */
function ChipSelect({
  icon: Icon,
  name,
  value,
  options,
  onChange,
}: {
  icon: LucideIcon;
  name: string;
  value: string;
  options: ChipOption[];
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];
  const active = value !== '';
  const danger = current.tone === 'danger';
  // FLUX-1473: at Default, the trigger reads the dimension name ("Model") rather than the value
  // ("Default") — three chips all saying "Default" carried no information beyond their 11px icon.
  // The word "Default" now only shows up inside the open popover's option list.
  const triggerLabel = active ? current.label : name;

  // Close on outside pointer while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // FLUX-1022: routed through the shared stack — this chip select lives inside the composer of a
  // dock window (or TaskModal's chat pane), both of which now have their own Escape handling;
  // sharing the stack keeps one ESC press from closing just the dropdown instead of also
  // collapsing/closing the host.
  useEscapeKey(() => setOpen(false), { enabled: open });

  const triggerTone = !active
    ? 'text-[var(--eh-text-muted)] hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5'
    : danger
      ? 'bg-red-500/10 text-red-500'
      : 'bg-primary/10 text-primary';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={active ? `${name}: ${current.label}` : name}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${triggerTone}`}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="max-w-[72px] truncate">{triggerLabel}</span>
        <ChevronDown className={`h-3 w-3 flex-shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="menu"
          className="eh-border eh-surface absolute bottom-full left-0 z-10 mb-1.5 min-w-[150px] rounded-lg border p-1 shadow-xl"
        >
          <div className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--eh-text-muted)]">
            {name}
          </div>
          {options.map((o) => {
            const selected = o.value === value;
            const tint = selected ? (o.tone === 'danger' ? 'text-red-500' : 'text-primary') : 'text-[var(--eh-text-secondary)]';
            return (
              <button
                key={o.value || 'default'}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${tint}`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="font-medium">{o.label}</span>
                  {o.hint && (
                    <span className={`text-[10px] ${o.tone === 'danger' ? 'text-red-500' : 'text-[var(--eh-text-muted)]'}`}>
                      {o.hint}
                    </span>
                  )}
                </span>
                {selected && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

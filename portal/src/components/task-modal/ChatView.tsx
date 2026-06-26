import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Send, Loader2, Square, Wrench, ChevronDown, ChevronRight, Check, Clock, ArrowDown, Cpu, Gauge, Shield, Paperclip, X, RefreshCw, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fetchDiffFile, openWorkspaceEditor, type TranscriptMessage, type ChatAttachment } from '../../api';
import type { QueuedMessage, ChatSendOptions } from '../../hooks/useChatSession';
import { DELEGATION_TOOLS } from '../../orchestration';
import { TaskMarkdown } from '../TaskMarkdown';
import { CopyButton } from '../CopyButton';
import { DiffLines } from '../DiffLines';
import { searchTasks, getTaskActivityTimestamp } from '../../taskSearch';
import { useTranscriptFind } from './useTranscriptFind';
import { FindBar } from './FindBar';
import type { Task } from '../../types';
import type { ComposerSelections } from '../DockProvider';
import { formatRelative } from '../../lib/relativeTime';

/** FLUX-643: a one-tap reply chip rendered above the composer. Selecting it sends
 *  `value` as the chat reply. `tone: 'danger'` paints it red (e.g. a "Skip" option). */
export interface QuickReply {
  label: string;
  value: string;
  tone?: 'danger';
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
  onStop,
  onUploadImage,
  actions,
  contextCard,
  quickReplies,
  linkifyTickets = false,
  questionPicker,
  awaitingInputBanner,
  draft,
  onDraftChange,
  selections,
  onSelectionsChange,
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
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // FLUX-727: one-shot guard so the "open at the top of the final message" scroll runs only on the
  // first render with messages after (re)mount. ChatView re-mounts on each dock open (keyed in
  // `open.map`), so this naturally resets per open.
  const didInitialScrollRef = useRef(false);
  // FLUX-644: jump-to-bottom pill state — shown while the user has scrolled up; `newCount`
  // tallies messages that arrived since they detached from the bottom.
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(messages.length);

  // FLUX-686: in-transcript find, scoped to this surface's scroll container. Opened with
  // Cmd/Ctrl+F or `/` (see the root onKeyDown below); the bar handles next/prev + Esc itself.
  const find = useTranscriptFind(scrollRef, messages);

  // FLUX-814: render only the last `visibleCount` messages on open (the tail), so a long thread
  // doesn't mount 800+ markdown rows synchronously and freeze the open. "Show earlier" reveals
  // older turns in chunks; `restoreFromBottomRef` keeps the viewport anchored when those rows are
  // prepended above the current scroll position.
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const restoreFromBottomRef = useRef<number | null>(null);

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
  // turns — those keep the existing stick-to-bottom behavior). Child layout effects (Clampable
  // measuring) run before this parent effect, so heights are settled when we restore.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && restoreFromBottomRef.current != null) {
      el.scrollTop = el.scrollHeight - restoreFromBottomRef.current;
      restoreFromBottomRef.current = null;
    }
  }, [visibleCount]);

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
    // FLUX-727: on first open (dock window), land at the TOP of the final message — rendered
    // unclamped (see the rows memo) — instead of snapping to the very bottom. One-shot per mount;
    // this passive effect runs after all layout effects (Clampable measuring) have settled, so the
    // final message is already at its true height when we measure. Skipped while a turn is streaming
    // (`working`) so a live chat keeps stick-to-tail. Setting `atBottomRef=false` also stops
    // `handleScroll` from snapping back / auto-marking-seen, leaving the unread divider intact.
    if (openToLastMessage && !didInitialScrollRef.current && messages.length > 0 && !working) {
      // FLUX-824: only burn the one-shot once the scroll ACTUALLY runs. If this first pass fires
      // while a turn streams (`working`) or before `[data-last-msg]` is in the DOM (`last` null),
      // leaving the guard unset keeps the one-shot armed for the next render instead of silently
      // landing the user at the bottom — the intermittent "sometimes it doesn't scroll" failure.
      const el = scrollRef.current;
      const last = el?.querySelector('[data-last-msg]') as HTMLElement | null;
      if (el && last) {
        didInitialScrollRef.current = true;
        el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
        atBottomRef.current = false;
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

  // FLUX-691: keep the streaming live node pinned to the tail while the user is already there, so
  // token-by-token output stays in view. Deltas don't change `messages`, so the effect above never
  // fires for them; this one does — but only follows the tail when already at the bottom (never
  // yanks a user who scrolled up to read), and never touches the unread divider / jump pill.
  useEffect(() => {
    if (liveText && atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [liveText]);

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
  // FLUX-814: window the rendered transcript to the last `visibleCount` messages. Opening find
  // reveals everything (find walks the live DOM, so search must see the whole transcript); once
  // the window has grown to cover all messages, `startIndex` is 0 and nothing is hidden.
  const fullyExpanded = find.open || visibleCount >= messages.length;
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

    const renderMessage = (m: TranscriptMessage, i: number, live: boolean) => {
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
          return (
            <div key={i} className="group flex items-end justify-end gap-2">
              {/* FLUX-684: quiet hover-revealed timestamp, left of the right-aligned bubble. */}
              <MessageTime ts={m.ts} />
              <div className="flex max-w-[80%] flex-col gap-1.5 rounded-2xl rounded-br-md border border-primary/15 bg-primary/10 px-3.5 py-2 text-[13px] text-[var(--eh-text-primary)]">
                {atts.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {atts.map((a, j) => (
                      <a key={j} href={a.url} target="_blank" rel="noreferrer" title={a.fileName}>
                        <img
                          src={a.url}
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
        return <ContextUpdateChip key={i} text={m.text} ts={m.ts} />;
      }
      // Assistant — no bubble: flowing markdown so code blocks / lists / links breathe.
      // FLUX-693: a very long turn is clamped with a "Show more/less" toggle so one giant
      // message can't blow out the scroll. The live trailing row (`live`) is never clamped —
      // the user must see streaming output as it lands (coordinates with FLUX-691).
      // FLUX-727: the final assistant message is rendered fully (clamp off) when `openToLastMessage`,
      // and tagged so the initial-scroll effect can position its top at the viewport top. Earlier
      // long messages keep the clamp; the live trailing row stays unclamped as before.
      const isLastAssistant = i === lastAssistantIdx;
      return (
        <div
          key={i}
          data-last-msg={openToLastMessage && isLastAssistant ? '' : undefined}
          className="group max-w-full text-[13px] leading-relaxed text-[var(--eh-text-primary)]"
        >
          <Clampable clamp={!live && !(openToLastMessage && isLastAssistant)}>
            <TaskMarkdown body={m.text} compact linkifyTickets={linkifyTickets} />
          </Clampable>
          {/* FLUX-684/683: quiet hover-revealed footer — timestamp + a copy-message affordance. */}
          <div className="mt-0.5 flex items-center gap-2">
            <MessageTime ts={m.ts} />
            <CopyButton
              getText={() => m.text}
              title="Copy message"
              className="flex h-4 w-4 items-center justify-center rounded text-[var(--eh-text-muted)] opacity-0 transition-opacity hover:text-[var(--eh-text-secondary)] focus-visible:opacity-100 group-hover:opacity-100"
            />
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
    // FLUX-814: start at the window head (the tail of the transcript) — absolute indices `i` are
    // kept for keys, the unread-divider boundary, and `lastAssistantIdx`, so all anchors stay correct.
    for (let i = startIndex; i < messages.length; i++) {
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
      // FLUX-693: the live trailing assistant row (last message while working) is rendered
      // unclamped so streaming output stays fully visible.
      out.push(renderMessage(messages[i], i, i === messages.length - 1 && !!working));
    }
    return { rows: out, spawnInsertAt };
  }, [messages, linkifyTickets, diffBranch, working, dividerIndex, openToLastMessage, hasBlock, startIndex]);

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
              thread doesn't freeze; this reveals older turns in chunks (scroll position preserved). */}
          {startIndex > 0 && (
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
          {/* FLUX-691: the live streaming node — the current turn's assistant text rendered
              token-by-token. It sits OUTSIDE the memoized `rows` (so each delta only re-renders
              this node, never the markdown-heavy transcript) and is plain text, not markdown (no
              per-delta re-parse). It clears the instant the committed message lands in the
              transcript, at which point the memoized list renders the final, markdown-rendered
              message in its place — no duplicate, no flicker. Never clamped (FLUX-693). */}
          {liveText && (
            <div className="group max-w-full whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--eh-text-primary)]">
              {liveText}
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

      {error && <p className="px-0.5 text-[11px] text-red-500">{error}</p>}

      {/* FLUX-686: quiet caller-built meter (e.g. the session token/cost readout), right-aligned
          just above the composer area so it's glanceable without competing with the transcript. */}
      {meter && <div className="flex justify-end px-0.5">{meter}</div>}

      {/* FLUX-752: display-only "Awaiting your input" banner for a board Require-Input ticket —
          sits just above the question picker / working strip where the user's eyes already are.
          Complementary to the FLUX-643 quick-reply chips below; the reply itself goes through the
          composer/chips, not here. */}
      {awaitingInputBanner && <div className="px-0.5">{awaitingInputBanner}</div>}

      {/* FLUX-662: inline ask_user_question picker — sits right above the working strip so a
          parked question is impossible to miss, attached to the chat that asked it. */}
      {questionPicker}

      {/* FLUX-639/640: consolidated working strip + activity timeline, pinned above the
          composer so liveness sits where the user's eyes already are. */}
      <WorkingStrip working={!!working} busy={busy} activity={activity ?? null} elapsedMs={elapsed} trail={trail} onStop={onStop} />

      {/* FLUX-643: one-tap reply chips (e.g. Require-Input defaults). */}
      {quickReplies && quickReplies.length > 0 && !working && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 px-0.5">
          {quickReplies.map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => void onSend(q.value)}
              title={q.value}
              className={`inline-flex max-w-full items-center rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                q.tone === 'danger'
                  ? 'border-red-500/30 text-red-500 hover:bg-red-500/10'
                  : 'eh-border bg-[var(--eh-input-bg)] text-[var(--eh-text-primary)] hover:bg-black/5 dark:hover:bg-white/5'
              }`}
            >
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

      {/* Composer lives in its own component so its per-keystroke input state never
          re-renders the transcript above it. */}
      <Composer busy={busy} working={!!working} onSend={onSend} onEnqueue={onEnqueue} onUploadImage={onUploadImage} draft={draft} onDraftChange={onDraftChange} selections={selections} onSelectionsChange={onSelectionsChange} tickets={tickets} />
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

/** FLUX-693: collapsed height past which a turn is clamped (px). Tall enough that most turns are
 *  never clamped; short enough that one giant message can't swallow the scroll. */
const CLAMP_MAX_PX = 360;
/** Bottom fade applied to the content itself (background-agnostic — masks the content rather than
 *  painting a gradient over it, so it works on any theme surface) when clamped. */
const CLAMP_FADE = 'linear-gradient(to bottom, #000 0, #000 calc(100% - 2.5rem), transparent 100%)';

/**
 * FLUX-693: clamps over-tall within-row content (assistant turns) to `maxPx` with a bottom
 * fade + a "Show more / Show less" toggle. Cheap: the cap is pure CSS (`max-height` + overflow
 * hidden + a mask fade); `scrollHeight` is read once per content change in a layout effect to
 * decide whether the toggle is even needed — no per-render measurement loop.
 *
 * Expand state is local (mirrors ToolGroup / InlineEditDiff). Because each row is keyed stably
 * in the transcript, that state survives re-renders during a session without having to thread it
 * through the `rows` useMemo. `clamp={false}` (the live trailing/streaming row) renders the
 * children verbatim — never clamped, never measured.
 */
function Clampable({ clamp = true, maxPx = CLAMP_MAX_PX, children }: { clamp?: boolean; maxPx?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [needsClamp, setNeedsClamp] = useState(false);

  // Measure once after layout, re-running only when the content (children) or cap changes — not
  // every render. scrollHeight reports the full content height even while the element is capped.
  useLayoutEffect(() => {
    if (!clamp) {
      setNeedsClamp(false); // setState bails when unchanged, so this is a no-op once cleared.
      return;
    }
    const el = ref.current;
    if (!el) return;
    setNeedsClamp(el.scrollHeight > maxPx + 8);
  }, [clamp, maxPx, children]);

  if (!clamp) return <>{children}</>;

  const collapsed = needsClamp && !expanded;
  return (
    <div>
      <div
        ref={ref}
        className={collapsed ? 'overflow-hidden' : ''}
        style={collapsed ? { maxHeight: maxPx, WebkitMaskImage: CLAMP_FADE, maskImage: CLAMP_FADE } : undefined}
      >
        {children}
      </div>
      {needsClamp && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-[var(--eh-text-muted)] transition-colors hover:bg-black/5 hover:text-[var(--eh-text-secondary)] dark:hover:bg-white/5"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** Quiet, uniform tool row — muted wrench + monospace, truncated so long file paths never blow
 *  out the width. Shared by the inline single-tool case and the expanded ToolGroup. FLUX-682: a
 *  repo-relative path in the row text is linkified to open in VS Code. */
function ToolRow({ text, openRef }: { text: string; openRef?: string | null }) {
  const parts = useMemo(() => splitToolText(text), [text]);
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-0.5 text-[11px] text-[var(--eh-text-muted)]">
      <Wrench className="h-3 w-3 flex-shrink-0" />
      <span className="truncate font-mono">
        {parts.path ? (
          <>
            {parts.before}
            <FileLink path={parts.path} openRef={openRef}>{parts.path}</FileLink>
            {parts.after}
          </>
        ) : (
          text
        )}
      </span>
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
 * FLUX-680: a collapsed cluster of consecutive tool calls. Default-collapsed, the header reads
 * "⚙ N tool calls · last: <action>" so you still get a "what did it just do" glance without
 * expanding; clicking reveals the individual quiet ToolRows. The trailing group is opened by the
 * caller while the agent is working so a live turn keeps showing motion.
 */
function ToolGroup({ texts, defaultOpen, openRef }: { texts: string[]; defaultOpen: boolean; openRef?: string | null }) {
  const [open, setOpen] = useState(defaultOpen);
  // FLUX-687: the group's key (`g${start}`) is stable, so React never remounts it to pick up a
  // changed defaultOpen. Drive open from the prop so a group collapses once it stops being the
  // live trailing run, while still letting the user manually toggle within a render cycle.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const last = texts[texts.length - 1];
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
          {texts.map((t, i) => (
            <ToolRow key={i} text={t} openRef={openRef} />
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
}) {
  const [internalInput, setInternalInput] = useState('');
  // FLUX-666: internal chip-selection state — used only on the uncontrolled (ChatPane) path.
  const [internalModel, setInternalModel] = useState('');
  const [internalEffort, setInternalEffort] = useState('');
  const [internalPermission, setInternalPermission] = useState('');
  // FLUX-674: pasted/dropped/picked images staged for the next turn, plus upload state.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
    if ((!text && attachments.length === 0) || isUploading) return;
    const opts: ChatSendOptions = { model, effort, permissionMode: permission, attachments };
    // FLUX-748: mid-turn (working) or mid-POST (busy) → queue instead of erroring; it auto-dispatches
    // when the turn finishes. When no queue is wired, keep the old gate (block while working/busy).
    if (working || busy) {
      if (!onEnqueue) return;
      onEnqueue(text, opts);
    } else {
      void onSend(text, opts);
    }
    setValue('');
    // FLUX-666: reset the chip selections after a send, consistent with clearing the text draft.
    // On the controlled (dock) path one write to all-empty prunes the persisted entry; on the
    // uncontrolled path reset the three internal states directly (calling the per-field controlled
    // setters in sequence would each see a stale closure of the other two).
    if (selectionsControlled) {
      onSelectionsChange!({});
    } else {
      setInternalModel('');
      setInternalEffort('');
      setInternalPermission('');
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
                src={a.url}
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
        placeholder={canAttach ? 'Message…  (Enter to send, paste or drop an image)' : 'Message…  (Enter to send, Shift+Enter for newline)'}
        className="max-h-32 min-h-[40px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] text-[var(--eh-text-primary)] placeholder:text-[var(--eh-text-muted)] focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <ChipSelect icon={Cpu} name="Model" value={model} options={MODEL_OPTS} onChange={setModel} />
          <ChipSelect icon={Gauge} name="Effort" value={effort} options={EFFORT_OPTS} onChange={setEffort} />
          <ChipSelect icon={Shield} name="Perms" value={permission} options={PERM_OPTS} onChange={setPermission} />
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
          // still disable it in either mode.
          disabled={isUploading || (!input.trim() && attachments.length === 0) || ((busy || working) && !onEnqueue)}
          title={
            (working || busy) && onEnqueue
              ? 'Queue message — sends when the current turn finishes'
              : working
                ? 'Wait for the current turn to finish'
                : 'Send'
          }
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {(busy || working) && !onEnqueue ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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

  // Close on outside pointer / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
        title={`${name}: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors ${triggerTone}`}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="max-w-[72px] truncate">{current.label}</span>
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

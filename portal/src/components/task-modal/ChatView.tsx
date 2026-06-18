import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Send, Loader2, Square, Wrench, ChevronDown, ChevronRight, Check, CheckCircle2, ArrowDown, Cpu, Gauge, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranscriptMessage } from '../../api';
import { TaskMarkdown } from '../TaskMarkdown';

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
  onSend: (text: string, opts?: { model?: string; effort?: string; permissionMode?: string }) => void | Promise<void>;
  /** Stop/interrupt the running turn. Shown while `working`. */
  onStop?: () => void | Promise<void>;
  /** Phase-aware action bar (FLUX-610) — rendered pinned above the composer. Optional so
   *  ChatView stays transport-free; callers build & pass `<TicketActionBar />`.
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
  /** FLUX-623: controlled composer draft. When `onDraftChange` is provided the composer's
   *  text is driven by `draft` (so the dock can persist it across minimize/reopen); omit both
   *  to keep the composer's internal uncontrolled state (the task-modal `ChatPane` path). */
  draft?: string;
  onDraftChange?: (text: string) => void;
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
  actions,
  contextCard,
  quickReplies,
  linkifyTickets = false,
  questionPicker,
  draft,
  onDraftChange,
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // FLUX-644: jump-to-bottom pill state — shown while the user has scrolled up; `newCount`
  // tallies messages that arrived since they detached from the bottom.
  const [showJump, setShowJump] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const prevLenRef = useRef(messages.length);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    // setState bails out when the value is unchanged, so this is cheap per scroll tick.
    setShowJump(!atBottom);
    if (atBottom) setNewCount(0);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    atBottomRef.current = true;
    setShowJump(false);
    setNewCount(0);
  }

  // Stick to bottom only when the user is already near the bottom — don't yank them down
  // while they've scrolled up to read. When detached, surface the new arrivals on the pill.
  useEffect(() => {
    const grew = messages.length - prevLenRef.current;
    if (atBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    } else if (grew > 0) {
      setNewCount((c) => c + grew);
      setShowJump(true);
    }
    prevLenRef.current = messages.length;
  }, [messages]);

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
  const rows = useMemo(
    () =>
      messages.map((m, i) => {
        if (m.role === 'tool') {
          // Quiet, uniform tool row — muted icon (no per-row colored marker) + monospace,
          // truncated so long file paths never blow out the width.
          return (
            <div key={i} className="flex min-w-0 items-center gap-1.5 px-0.5 text-[11px] text-[var(--eh-text-muted)]">
              <Wrench className="h-3 w-3 flex-shrink-0" />
              <span className="truncate font-mono">{m.text}</span>
            </div>
          );
        }
        if (m.role === 'user') {
          return (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/15 bg-primary/10 px-3.5 py-2 text-[13px] text-[var(--eh-text-primary)]">
                {m.text}
              </div>
            </div>
          );
        }
        // Assistant — no bubble: flowing markdown so code blocks / lists / links breathe.
        return (
          <div key={i} className="max-w-full text-[13px] leading-relaxed text-[var(--eh-text-primary)]">
            <TaskMarkdown body={m.text} compact linkifyTickets={linkifyTickets} />
          </div>
        );
      }),
    [messages, linkifyTickets],
  );

  // The floating window owns its own title bar, so suppress the in-surface title there. The
  // "working" signal now lives in the WorkingStrip above the composer (FLUX-639), so the
  // header is title-only.
  const showHeader = !fill && !!title;
  const showActions = !!actions && !working && !busy; // FLUX-622: only act when idle/pending.

  return (
    <div className={`flex flex-col gap-3 ${fill ? 'h-full min-h-0' : ''}`}>
      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">{title}</p>
        </div>
      )}

      {/* Scroll region — wrapped in a relative box so the jump-to-bottom pill (FLUX-644) can
          float over its bottom edge. */}
      <div className={`relative flex flex-col ${fill ? 'min-h-0 flex-1' : ''}`}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={`flex flex-col gap-3 overflow-y-auto pr-1 ${fill ? 'min-h-0 flex-1' : scrollMaxClass}`}
        >
          {messages.length === 0 && (
            <>
              {/* FLUX-642: caller-built context (last comment / board snapshot). May render
                  null (e.g. a brand-new ticket), in which case only the hint shows. */}
              {contextCard}
              <p className="py-4 text-center text-[12px] text-[var(--eh-text-muted)]">{emptyHint || 'Send a message to start.'}</p>
            </>
          )}
          {rows}
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

      {/* Composer lives in its own component so its per-keystroke input state never
          re-renders the transcript above it. */}
      <Composer busy={busy} onSend={onSend} draft={draft} onDraftChange={onDraftChange} />
    </div>
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
        className="flex w-full items-center gap-2 text-left"
      >
        <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
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

/**
 * Message composer — isolated from the transcript on purpose. Holds the input + the
 * model / effort / permission selections in local state, so typing only re-renders this
 * small subtree (not the markdown-heavy message list). Submits via the parent's `onSend`.
 *
 * FLUX-623: the text draft is *optionally* controlled. When `onDraftChange` is provided the
 * value comes from the `draft` prop (so the dock can persist it across minimize/reopen, which
 * unmounts this subtree); otherwise it falls back to internal `useState` (the task-modal
 * `ChatPane` path, which never unmounts). Model/effort/permission stay local either way —
 * persisting those is out of scope (see the ticket's Risks note).
 */
function Composer({
  busy,
  onSend,
  draft,
  onDraftChange,
}: {
  busy: boolean;
  onSend: ChatViewProps['onSend'];
  draft?: string;
  onDraftChange?: (text: string) => void;
}) {
  const [internalInput, setInternalInput] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permission, setPermission] = useState('');

  // Controlled when the parent owns the draft; uncontrolled otherwise. A single value/setValue
  // pair keeps the textarea always-controlled (no controlled↔uncontrolled flip warning).
  const controlled = onDraftChange !== undefined;
  const input = controlled ? draft ?? '' : internalInput;
  const setValue = controlled ? onDraftChange! : setInternalInput;

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setValue('');
    void onSend(text, { model, effort, permissionMode: permission });
  }

  return (
    <div className="rounded-2xl border border-[var(--eh-border)] bg-[var(--eh-input-bg)] transition-colors focus-within:border-primary">
      <textarea
        value={input}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder="Message…  (Enter to send, Shift+Enter for newline)"
        className="max-h-32 min-h-[40px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] text-[var(--eh-text-primary)] placeholder:text-[var(--eh-text-muted)] focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-0.5">
          <ChipSelect icon={Cpu} name="Model" value={model} options={MODEL_OPTS} onChange={setModel} />
          <ChipSelect icon={Gauge} name="Effort" value={effort} options={EFFORT_OPTS} onChange={setEffort} />
          <ChipSelect icon={Shield} name="Perms" value={permission} options={PERM_OPTS} onChange={setPermission} />
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !input.trim()}
          title="Send"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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

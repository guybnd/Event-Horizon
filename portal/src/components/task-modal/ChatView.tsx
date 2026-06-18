import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Send, Loader2, Square, Wrench, ChevronDown, Check, Cpu, Gauge, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranscriptMessage } from '../../api';
import { TaskMarkdown } from '../TaskMarkdown';

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
   *  ChatView stays transport-free; callers build & pass `<TicketActionBar />`. */
  actions?: ReactNode;
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
}: ChatViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  // Stick to bottom only when the user is already near the bottom — don't yank
  // them down while they've scrolled up to read.
  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

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
            <TaskMarkdown body={m.text} compact />
          </div>
        );
      }),
    [messages],
  );

  // The floating window owns its own title bar, so suppress the in-surface title there.
  const showHeader = (!fill && !!title) || !!working;

  return (
    <div className={`flex flex-col gap-3 ${fill ? 'h-full min-h-0' : ''}`}>
      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          {!fill && title ? (
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--eh-text-muted)]">{title}</p>
          ) : (
            <span />
          )}
          {working && (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--eh-text-muted)]">
                <Loader2 className="h-3 w-3 animate-spin text-primary" /> {activity || 'Working'}
              </span>
              {onStop && (
                <button
                  type="button"
                  onClick={() => onStop()}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/10"
                >
                  <Square className="h-2.5 w-2.5 fill-current" /> Stop
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex flex-col gap-3 overflow-y-auto pr-1 ${fill ? 'min-h-0 flex-1' : scrollMaxClass}`}
      >
        {messages.length === 0 && (
          <p className="py-6 text-center text-[12px] text-[var(--eh-text-muted)]">{emptyHint || 'Send a message to start.'}</p>
        )}
        {rows}
        {busy && !working && (
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--eh-text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin text-primary" /> thinking…
          </div>
        )}
      </div>

      {error && <p className="px-0.5 text-[11px] text-red-500">{error}</p>}

      {/* Phase-aware action bar — pinned between the transcript and the composer so the
          ticket's next moves are always one click away (engine = free, agent = tokenized). */}
      {actions && <div className="px-0.5">{actions}</div>}

      {/* Composer lives in its own component so its per-keystroke input state never
          re-renders the transcript above it. */}
      <Composer busy={busy} onSend={onSend} />
    </div>
  );
}

/**
 * Message composer — isolated from the transcript on purpose. Holds the input + the
 * model / effort / permission selections in local state, so typing only re-renders this
 * small subtree (not the markdown-heavy message list). Submits via the parent's `onSend`.
 */
function Composer({ busy, onSend }: { busy: boolean; onSend: ChatViewProps['onSend'] }) {
  const [input, setInput] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [permission, setPermission] = useState('');

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    void onSend(text, { model, effort, permissionMode: permission });
  }

  return (
    <div className="rounded-2xl border border-[var(--eh-border)] bg-[var(--eh-input-bg)] transition-colors focus-within:border-primary">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
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

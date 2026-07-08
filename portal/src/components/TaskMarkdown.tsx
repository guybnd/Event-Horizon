import { Children, Fragment, cloneElement, isValidElement, memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ImageIcon, MessageSquare, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { resolveTaskMarkdownHref } from '../taskMarkdownUtils';
import { useTaskById, useConfig } from '../store/useAppSelector';
import { useDockActions } from './DockProvider';
import { getStatusTint, getStatusColorClass } from '../statusStyles';
import { StatusBadge } from './StatusBadge';
import { normalizeStatus } from '../workflow';
import { TicketActions } from './ticket-actions/TicketActions';
import { CopyButton } from './CopyButton';
import { useEscapeKey } from '../hooks/useEscapeKey';

type TaskMarkdownImageMode = 'inline' | 'comment';

function MarkdownImageUnavailable({ alt, src }: { alt?: string; src?: string }) {
  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
      Image unavailable{alt ? `: ${alt}` : src ? `: ${src}` : '.'}
    </div>
  );
}

function MarkdownImage({
  src,
  alt,
  taskId,
  compact,
  imageMode,
}: {
  src?: string;
  alt?: string;
  taskId?: string;
  compact?: boolean;
  imageMode: TaskMarkdownImageMode;
}) {
  const [failed, setFailed] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const resolvedSrc = resolveTaskMarkdownHref(taskId, src);
  const imageLabel = alt?.trim() || src?.split('/').pop() || 'Attached image';

  if (!resolvedSrc || failed) {
    return <MarkdownImageUnavailable alt={alt} src={src} />;
  }

  if (imageMode === 'comment') {
    return (
      <>
        <span className="group relative inline-flex max-w-full align-middle">
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            className="inline-flex max-w-full items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-left text-xs font-semibold text-gray-700 transition-colors hover:border-primary hover:text-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-200 dark:hover:border-primary"
          >
            <ImageIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{imageLabel}</span>
            <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-gray-400">Open</span>
          </button>
          <span className="pointer-events-none absolute left-0 top-full z-20 hidden w-56 pt-2 group-hover:block group-focus-within:block">
            <span className="block rounded-2xl border border-gray-200 bg-white p-2 shadow-xl dark:border-white/10 dark:bg-[#1f2028]">
              <img
                src={resolvedSrc}
                alt={alt || ''}
                loading="lazy"
                onError={() => setFailed(true)}
                className="max-h-48 w-full rounded-xl bg-black/5 object-contain dark:bg-black/30"
              />
              <span className="mt-2 block truncate text-[10px] text-gray-500 dark:text-gray-400">{imageLabel}</span>
            </span>
          </span>
        </span>

        {isOpen && (
          <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/70 p-6" onClick={() => setIsOpen(false)}>
            <button
              type="button"
              aria-label="Close image preview"
              onClick={() => setIsOpen(false)}
              className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
            >
              <X className="h-5 w-5" />
            </button>
            <div
              className="max-h-full max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-[#11131a] p-4 shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <img src={resolvedSrc} alt={alt || ''} className="max-h-[80vh] w-full rounded-2xl object-contain" />
              <p className="mt-3 truncate text-sm text-white/80">{imageLabel}</p>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt || ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className={compact
        ? 'mb-3 max-h-64 w-full rounded-xl border border-gray-200 bg-white object-contain dark:border-white/10 dark:bg-black/20'
        : 'mb-4 max-h-[32rem] w-full rounded-2xl border border-gray-200 bg-white object-contain dark:border-white/10 dark:bg-black/20'}
    />
  );
}

/**
 * FLUX-641 / FLUX-653: inline ticket chip. Linkified `FLUX-\d+` references in assistant
 * output become a chip showing the ticket's live board-status dot and a clickable id.
 *
 * FLUX-715: the chip no longer carries a ▸ play button — silent fire-and-forget launching is
 * gone. To act on the ticket you click the id to open the *mini-card*, which now embeds the
 * full unified `<TicketActions variant="compact" />` (click = default launch, ▾ for templates,
 * status-applicable transitions/PR actions) — the same registry the board card uses.
 *
 * FLUX-653 enriches it so you can read and act on the referenced ticket in place:
 *  - **Hover** the id → a lightweight, non-interactive tooltip (title + status) after a
 *    ~150ms intent delay, so scanning a line of chips doesn't flicker.
 *  - **Click** the id → a *pinned* popover (dismissed on outside-click / Esc) carrying the
 *    title/status/priority/effort, the embedded `<TicketActions />`, and an "Open Ticket Chat"
 *    affordance that opens the ticket's chat-aligned view (FLUX-744).
 * Both surfaces portal to `document.body` so the narrow chat scroll container can't clip them.
 *
 * Renders as plain text when the id doesn't resolve to a real ticket (guards against
 * false positives like "UTF-8").
 */
const HOVER_INTENT_MS = 150;

function TicketChip({ id }: { id: string }) {
  const task = useTaskById(id);
  const config = useConfig();
  // FLUX-744: inline ticket references open the chat-aligned view (with the ticket panel), matching
  // the new default everywhere else — not the center modal.
  const { openTicket } = useDockActions();

  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const open = pinned || hovering;

  // Anchor the floating surface to the chip; track scroll/resize so it stays put.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = pinned ? 288 : 240;
      const estHeight = pinned ? 200 : 72;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      let top = r.bottom + 6;
      if (top + estHeight > window.innerHeight - 8) top = Math.max(8, r.top - estHeight - 6);
      setPos({ top, left });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, pinned]);

  // Pinned popover: dismiss on outside-click / Esc.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // FLUX-715: don't dismiss while the embedded TicketActions has opened a modal dialog
      // (the orchestration launcher / start prompt may portal outside the popover's DOM).
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      setPinned(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pinned]);

  // FLUX-1022: routed through the shared stack — this chip renders inline in chat messages and
  // task descriptions, both of which can sit inside a dock ChatWindow or TaskModal that now have
  // their own Escape handling; sharing the stack keeps one ESC press from unpinning just this
  // popover instead of also collapsing/closing the host.
  useEscapeKey(() => setPinned(false), { enabled: pinned });

  // Clear any pending hover-intent timer on unmount.
  useEffect(() => () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
  }, []);

  if (!task) return <>{id}</>;

  const tint = getStatusTint(config, task.status);
  const statusColor = getStatusColorClass(config, task.status);
  const running = task.cliSession?.status === 'running';

  const startHover = () => {
    if (pinned) return;
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovering(true), HOVER_INTENT_MS);
  };
  const endHover = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHovering(false);
  };

  return (
    <span
      ref={anchorRef}
      onMouseEnter={startHover}
      onMouseLeave={endHover}
      className="mx-0.5 inline-flex max-w-full select-none items-center gap-1 rounded-md border border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-1.5 py-0.5 align-baseline text-[0.85em] font-medium not-italic"
    >
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${running ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: `rgb(${tint.rgb})` }}
        title={task.status}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (hoverTimer.current !== null) {
            window.clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }
          setHovering(false);
          setPinned((p) => !p);
        }}
        aria-haspopup="dialog"
        aria-expanded={pinned}
        className="font-mono text-primary no-underline hover:underline"
      >
        {id}
      </button>

      {pos && pinned &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 999999 }}
            role="dialog"
            aria-label={`${id} details`}
            className="w-72 max-w-[90vw] rounded-xl border border-[var(--eh-border)] bg-[var(--eh-surface)] p-3 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-primary">{id}</span>
              <StatusBadge status={normalizeStatus(task.status)} colorClass={statusColor} className="text-[10px]" />
            </div>
            {task.title && (
              <div className="mt-1 text-sm font-semibold leading-snug text-[var(--eh-text-primary)]">{task.title}</div>
            )}
            {(task.priority || task.effort) && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[var(--eh-text-muted)]">
                {task.priority && <span>Priority: {task.priority}</span>}
                {task.effort && <span>Effort: {task.effort}</span>}
              </div>
            )}
            <div className="mt-2.5 border-t border-[var(--eh-border)] pt-2.5">
              <TicketActions task={task} variant="compact" />
            </div>
            <button
              type="button"
              onClick={() => {
                setPinned(false);
                openTicket(task.id);
              }}
              className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
            >
              <MessageSquare className="h-3 w-3" /> Open Ticket Chat
            </button>
          </div>,
          document.body,
        )}

      {pos && hovering && !pinned &&
        createPortal(
          <div
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 999998 }}
            className="pointer-events-none w-60 max-w-[80vw] rounded-lg border border-[var(--eh-border)] bg-[var(--eh-surface)] px-2.5 py-2 shadow-xl"
          >
            {task.title && (
              <div className="text-xs font-semibold leading-snug text-[var(--eh-text-primary)]">{task.title}</div>
            )}
            <div className="mt-1">
              <StatusBadge status={normalizeStatus(task.status)} colorClass={statusColor} className="text-[10px]" />
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

// `FLUX-123`-style ids. Requires an uppercase project key + number; non-resolving
// matches fall back to plain text in TicketChip, so over-matching is harmless.
const TICKET_ID_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
// Anchored variant: the whole string IS a single ticket id (markdown-link text / href).
const TICKET_ID_EXACT_RE = /^([A-Z][A-Z0-9]+-\d+)$/;

// Intrinsic inline wrappers we descend into when linkifying (`**FLUX-617**`, `*FLUX-617*`).
// Kept to an allowlist of plain string-typed tags so we stay shallow and predictable:
// code spans and links render as function components (not in this set), so they're skipped
// here — links are chipped by the `a` renderer instead, code is left verbatim.
const INLINE_WRAPPER_TAGS = new Set(['strong', 'em', 'del', 'b', 'i', 's', 'span', 'sup', 'sub']);

/** Split a plain string on ticket-id matches, swapping each for a <TicketChip>. */
function splitTicketIds(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(TICKET_ID_RE);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<TicketChip key={m.index} id={m[1]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Flatten a node's text content (only direct string/number children) and trim it. */
function nodeText(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('')
    .trim();
}

/** If a candidate (link text or href) is exactly a single ticket id, return it. */
function singleTicketId(...candidates: ReactNode[]): string | undefined {
  for (const c of candidates) {
    const text = typeof c === 'string' ? c.trim() : nodeText(c);
    const m = TICKET_ID_EXACT_RE.exec(text);
    if (m) return m[1];
  }
  return undefined;
}

/** Linkify string children of a prose node, descending one level into intrinsic inline
 *  wrappers (strong/em/…) so `**FLUX-617**` chips too. Stays shallow: code spans and links
 *  are function components and thus skipped here (links handled by the `a` renderer). */
function linkifyTicketIds(children: ReactNode): ReactNode {
  return Children.toArray(children).map((child, i) => {
    if (typeof child === 'string') {
      return <Fragment key={i}>{splitTicketIds(child)}</Fragment>;
    }
    if (isValidElement(child) && typeof child.type === 'string' && INLINE_WRAPPER_TAGS.has(child.type)) {
      const inner = (child.props as { children?: ReactNode }).children;
      if (inner != null) {
        return cloneElement(child, { key: child.key ?? i }, linkifyTicketIds(inner));
      }
    }
    return child;
  });
}

/** Inline `code` renderer. When linkification is on and a code span's content is exactly a
 *  single ticket id that resolves to a real ticket, render the enriched <TicketChip> instead
 *  of the verbatim code box — covers backticked ids like `` `FLUX-630` `` (the common case
 *  when the model formats ids as code). Resolution is checked at this component boundary
 *  (unconditional useTaskById), so no conditional hooks; non-resolving spans stay code. */
function MarkdownInlineCode({ children, linkify }: { children: ReactNode; linkify: boolean }) {
  const candidate = linkify ? singleTicketId(children) : undefined;
  const resolved = useTaskById(candidate);
  if (candidate && resolved) return <TicketChip id={candidate} />;
  return (
    <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-black/30 dark:text-gray-100">
      {children}
    </code>
  );
}

/** Markdown link renderer. When linkification is on and the link's visible text (or href)
 *  is a single ticket id that resolves to a real ticket, render the enriched <TicketChip>
 *  instead of a plain `<a>` — covers `[FLUX-586](…)`. Hooks live in TicketChip/useTaskById,
 *  so the chip-vs-link choice is made here at a component boundary (no conditional hooks).
 *  Non-ticket links and non-resolving ids keep the plain-link path. */
function MarkdownLink({
  children,
  href,
  taskId,
  linkify,
}: {
  children: ReactNode;
  href?: string;
  taskId?: string;
  linkify: boolean;
}) {
  const candidate = linkify ? singleTicketId(children, href) : undefined;
  const resolved = useTaskById(candidate);
  if (candidate && resolved) return <TicketChip id={candidate} />;
  const resolvedHref = resolveTaskMarkdownHref(taskId, href);
  return (
    <a className="text-primary underline underline-offset-2" href={resolvedHref} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Flatten the rendered text content of a node tree (strings + nested element children). Used
 *  to recover a fenced block's source from the `pre`/`code` render tree for the copy button. */
function extractText(node: ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

// FLUX-1298: matches a blockquote whose flattened text opens with the TL;DR label (from the
// grooming convention's `> **TL;DR** — …`), tolerant of the bold markup and an optional colon/dash.
const TLDR_RE = /^tl;?dr\b/i;

/** Whether a blockquote's rendered children open with the TL;DR label, so it can render as a
 *  prominent callout instead of an ordinary quote. */
function isTldrBlockquote(children: ReactNode): boolean {
  return TLDR_RE.test(extractText(children).trim());
}

/** FLUX-683: fenced code block with a hover-revealed copy button. The `pre` is wrapped in a
 *  positioned container so the button can pin to the top-right without scrolling away with the
 *  (horizontally-scrollable) code. The source is recovered from the rendered children and the
 *  single trailing newline react-markdown leaves on a fence is trimmed. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const source = extractText(children).replace(/\n$/, '');
  return (
    <div className="group/code relative mb-4">
      <pre className="w-full overflow-x-auto rounded-lg bg-black/90 break-normal">{children}</pre>
      <CopyButton
        getText={() => source}
        title="Copy code"
        className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-white/10 text-gray-300 opacity-0 transition-opacity hover:bg-white/20 hover:text-white focus-visible:opacity-100 group-hover/code:opacity-100"
      />
    </div>
  );
}

export const TaskMarkdown = memo(function TaskMarkdown({
  body,
  taskId,
  compact = false,
  emptyMessage = 'No description yet.',
  imageMode = 'inline',
  linkifyTickets = false,
}: {
  body: string;
  taskId?: string;
  compact?: boolean;
  emptyMessage?: string;
  imageMode?: TaskMarkdownImageMode;
  /** FLUX-641: render `FLUX-\d+` ids in prose as inline launch chips (assistant chat only). */
  linkifyTickets?: boolean;
}) {
  // Wrap prose children with ticket-chip linkification when enabled; identity otherwise.
  const lt = (children: ReactNode): ReactNode => (linkifyTickets ? linkifyTicketIds(children) : children);
  const headingClassNames = compact
    ? {
        h1: 'mb-3 text-2xl font-bold text-gray-900 dark:text-gray-100',
        h2: 'mb-2 mt-6 text-xl font-semibold text-gray-900 dark:text-gray-100',
        h3: 'mb-2 mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100',
      }
    : {
        h1: 'mb-4 text-3xl font-bold text-gray-900 dark:text-gray-100',
        h2: 'mb-3 mt-8 text-2xl font-semibold text-gray-900 dark:text-gray-100',
        h3: 'mb-2 mt-6 text-xl font-semibold text-gray-900 dark:text-gray-100',
      };
  const paragraphClassName = imageMode === 'comment'
    ? 'mb-2 whitespace-pre-wrap last:mb-0'
    : 'mb-4 whitespace-pre-wrap';
  const ParagraphTag = imageMode === 'comment' ? 'div' : 'p';

  return (
    <div className={`max-w-none min-w-0 break-words text-sm leading-7 text-gray-700 dark:text-gray-300 ${compact ? '' : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className={headingClassNames.h1}>{lt(children)}</h1>,
          h2: ({ children }) => <h2 className={headingClassNames.h2}>{lt(children)}</h2>,
          h3: ({ children }) => <h3 className={headingClassNames.h3}>{lt(children)}</h3>,
          p: ({ children }) => <ParagraphTag className={paragraphClassName}>{lt(children)}</ParagraphTag>,
          ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
          li: ({ children }) => <li>{lt(children)}</li>,
          a: ({ children, href }) => (
            <MarkdownLink href={href} taskId={taskId} linkify={linkifyTickets}>
              {children}
            </MarkdownLink>
          ),
          img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} taskId={taskId} compact={compact} imageMode={imageMode} />,
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-') || String(children).includes('\n');
            if (isBlock) {
              return <code className="block p-4 text-sm text-gray-100">{children}</code>;
            }
            return <MarkdownInlineCode linkify={linkifyTickets}>{children}</MarkdownInlineCode>;
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          blockquote: ({ children }) => {
            // FLUX-1298: a TL;DR blockquote renders as a prominent callout — bigger, non-italic,
            // soft accent box — so it stands out from ordinary quotes. Bold phrases inside keep
            // their inherited text color (no per-word recoloring); the box carries the emphasis.
            if (isTldrBlockquote(children)) {
              return (
                <blockquote className="mb-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-base not-italic text-gray-800 [&>p]:mb-0 dark:border-primary/30 dark:bg-primary/10 dark:text-gray-100">
                  {lt(children)}
                </blockquote>
              );
            }
            return (
              <blockquote className="mb-4 border-l-4 border-primary/40 pl-4 italic text-gray-600 dark:text-gray-400">
                {lt(children)}
              </blockquote>
            );
          },
          table: ({ children }) => <table className="mb-4 w-full border-collapse overflow-hidden rounded-lg">{children}</table>,
          thead: ({ children }) => <thead className="bg-gray-100 dark:bg-white/5">{children}</thead>,
          th: ({ children }) => <th className="border border-gray-200 px-3 py-2 text-left dark:border-white/10">{lt(children)}</th>,
          td: ({ children }) => <td className="border border-gray-200 px-3 py-2 dark:border-white/10">{lt(children)}</td>,
        }}
      >
        {body || emptyMessage}
      </ReactMarkdown>
    </div>
  );
});
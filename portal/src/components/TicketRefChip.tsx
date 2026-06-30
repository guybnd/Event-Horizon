import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, GitBranch, MessageSquare } from 'lucide-react';
import { useTaskById, useConfig } from '../store/useAppSelector';
import { useDockActions } from './DockProvider';
import { BOARD_CONVERSATION_ID } from '../api';
import { relativeTime } from '../workflow';
import { getStatusColorClass, getStatusTint } from '../statusStyles';
import { StatusBadge } from './StatusBadge';

/**
 * FLUX-922: the shared, interactive ticket-reference chip + hover-card.
 *
 * Consolidated from AttentionDock's ad-hoc `TicketRefChip` mini-panel so the notification cards and
 * the needs-you cards surface the same enriched ticket reference: a clickable id with a live status
 * dot that, on hover/focus, reveals a body-portaled card (id · title · status · assignee · branch ·
 * live activity) carrying the two open actions — **Open chat** (primary, the default target) and
 * **Open ticket** (secondary).
 *
 * NOTE: the chat inline-enricher `TicketChip` in `TaskMarkdown.tsx` is a *separate*, pinned-capable
 * copy and has NOT been folded into this component yet — only AttentionDock was unified here. Folding
 * the chat chip in is the remaining (and larger) consolidation win; until then the two will need to
 * be kept in visual parity by hand.
 *
 * Per the rev-4 refinement, the open actions live IN this card (the surfaces that use it drop their
 * redundant inline "Open ticket" buttons). The card portals to `document.body` so a narrow scroll
 * container (the notification list is `overflow-hidden` per card) can never clip it, and it stays
 * open while the pointer is over — or keyboard focus is inside — the trigger OR the card so its
 * buttons remain reachable. Opening via keyboard focus moves focus into the card; Esc closes it and
 * returns focus to the chip.
 */

const HOVER_INTENT_MS = 140;
const CLOSE_GRACE_MS = 140;

interface Props {
  ticketId: string | null;
  /** Appends ` · <relative time>` to the trigger (used by the AttentionDock needs-you cards). */
  time?: string;
  /** Visual: 'chip' = bordered pill with status dot (notifications); 'muted' = dotted-underline
   *  muted text (AttentionDock). Defaults to 'chip'. */
  variant?: 'chip' | 'muted';
  /** Push the chip to the end of a flex row (AttentionDock's right-aligned ref). */
  alignEnd?: boolean;
}

export function TicketRefChip({ ticketId, time, variant = 'chip', alignEnd = false }: Props) {
  const isBoard = ticketId === BOARD_CONVERSATION_ID;
  const task = useTaskById(ticketId && !isBoard ? ticketId : undefined);
  const config = useConfig();
  const { openChat, openTicket } = useDockActions();

  const anchorRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const intentTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // FLUX-922 a11y fix: when the card is opened by keyboard focus (not the mouse) we move focus into
  // it so its Open-ticket/Open-chat buttons are reachable despite the portal breaking DOM tab order.
  const openedViaKeyboard = useRef(false);
  // True between mousedown and mouseup on the trigger, so the focus that a click induces is treated
  // as a mouse open (no focus-steal) rather than a keyboard one.
  const pointerInteracting = useRef(false);
  const [hovering, setHovering] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Anchor the floating card to the chip; track scroll/resize so it stays put.
  useLayoutEffect(() => {
    if (!hovering) return;
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 256;
      const estHeight = 150;
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
  }, [hovering]);

  useEffect(() => () => {
    if (intentTimer.current !== null) window.clearTimeout(intentTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  // When the card opens via keyboard, move focus into it (first action) so a keyboard/AT user can
  // reach Open ticket / Open chat — the portal places the card at the end of <body>, so it would
  // otherwise never appear in sequential tab order after the chip. Mouse opens skip this.
  useEffect(() => {
    if (hovering && openedViaKeyboard.current && cardRef.current) {
      cardRef.current.querySelector<HTMLElement>('button')?.focus();
    }
  }, [hovering]);

  // Board reference (or unresolved id): a static label, no hover-card — matches prior parity.
  if (!ticketId) {
    return time && alignEnd
      ? <span className="ml-auto text-[11px] text-[var(--eh-text-muted)]">{relativeTime(time)}</span>
      : null;
  }
  if (isBoard || !task) {
    const label = isBoard ? 'Board' : ticketId;
    return (
      <span className={`${alignEnd ? 'ml-auto ' : ''}text-[11px] text-[var(--eh-text-muted)]`}>
        {label}{time ? ` · ${relativeTime(time)}` : ''}
      </span>
    );
  }

  const tint = getStatusTint(config, task.status);
  const statusColor = getStatusColorClass(config, task.status);
  const running = task.cliSession?.status === 'running';

  const open = (viaKeyboard = false) => {
    openedViaKeyboard.current = viaKeyboard;
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (hovering) return;
    if (intentTimer.current !== null) window.clearTimeout(intentTimer.current);
    // Keyboard focus reveals the card immediately (no hover-intent delay — the user committed by
    // tabbing to it); the mouse uses the intent delay to avoid flicker on pass-through.
    if (viaKeyboard) setHovering(true);
    else intentTimer.current = window.setTimeout(() => setHovering(true), HOVER_INTENT_MS);
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    if (intentTimer.current !== null) { window.clearTimeout(intentTimer.current); intentTimer.current = null; }
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHovering(false), CLOSE_GRACE_MS);
  };
  // Close only when focus leaves the whole trigger-or-card group (the card is portaled, so a focus
  // move into it reads as a blur on the trigger — guard on relatedTarget to keep it open).
  const handleGroupBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (anchorRef.current?.contains(next) || cardRef.current?.contains(next))) return;
    scheduleClose();
  };
  const closeAndRefocus = () => {
    setHovering(false);
    anchorRef.current?.querySelector<HTMLElement>('button')?.focus();
  };

  const go = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHovering(false);
    fn();
  };

  const trigger =
    variant === 'muted' ? (
      <button
        type="button"
        onClick={go(() => openChat(task.id))}
        className="cursor-pointer border-b border-dotted border-[var(--eh-border)] text-[11px] text-[var(--eh-text-muted)] transition-colors hover:text-primary"
      >
        {task.id}{time ? ` · ${relativeTime(time)}` : ''}
      </button>
    ) : (
      <button
        type="button"
        onClick={go(() => openChat(task.id))}
        className="inline-flex select-none items-center gap-1 rounded-md border border-[var(--eh-border)] bg-[var(--eh-input-bg)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary transition-colors hover:border-primary"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: `rgb(${tint.rgb})` }}
          aria-hidden
        />
        {task.id}
      </button>
    );

  return (
    <span
      ref={anchorRef}
      onMouseEnter={() => open(false)}
      onMouseLeave={scheduleClose}
      onMouseDown={() => { pointerInteracting.current = true; }}
      onMouseUp={() => { pointerInteracting.current = false; }}
      onFocus={() => open(!pointerInteracting.current)}
      onBlur={handleGroupBlur}
      onKeyDown={(e) => { if (e.key === 'Escape' && hovering) { e.stopPropagation(); closeAndRefocus(); } }}
      className={`${alignEnd ? 'ml-auto ' : ''}relative inline-flex shrink-0 items-center`}
    >
      {trigger}
      {hovering && pos &&
        createPortal(
          <div
            ref={cardRef}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onFocus={cancelClose}
            onBlur={handleGroupBlur}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAndRefocus(); } }}
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 999999 }}
            role="dialog"
            aria-label={`${task.id} details`}
            className="w-64 max-w-[90vw] rounded-xl border border-[var(--eh-border)] bg-[var(--eh-surface)] p-3 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-primary">{task.id}</span>
              <StatusBadge status={task.status} colorClass={statusColor} className="text-[10px]" />
            </div>
            {task.title && (
              <div className="mt-1 text-sm font-semibold leading-snug text-[var(--eh-text-primary)]">{task.title}</div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--eh-text-muted)]">
              {task.assignee && <span>{task.assignee}</span>}
              {task.branch && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="max-w-[10rem] truncate">{task.branch}</span>
                </span>
              )}
            </div>
            {running && task.cliSession?.currentActivity && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                {task.cliSession.currentActivity}
              </div>
            )}
            <div className="mt-2.5 flex items-center gap-2 border-t border-[var(--eh-border)] pt-2.5">
              <button
                type="button"
                onClick={go(() => openChat(task.id))}
                className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/25"
              >
                <MessageSquare className="h-3 w-3" /> Open chat
              </button>
              <button
                type="button"
                onClick={go(() => openTicket(task.id))}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--eh-text-muted)] transition-colors hover:text-primary"
              >
                <ExternalLink className="h-3 w-3" /> Open ticket
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}

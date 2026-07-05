import { memo, useRef, useEffect, useCallback, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Bell,
  CheckCircle2,
  CheckCheck,
  GitBranch,
  Info,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useMotionValue, useTransform, useReducedMotion } from 'framer-motion';
import type { Notification } from '../api';
import { markNotificationRead, markNotificationUnread, markAllNotificationsRead, dismissNotification, executeNotificationAction, stopTaskCliSession, BOARD_CONVERSATION_ID } from '../api';
import { useAppSelector, useAppActions, useTaskById } from '../store/useAppSelector';
import { useDockActions } from './DockProvider';
import { relativeTime, normalizeStatus } from '../workflow';
import { notificationCategory } from './notificationCategory';
import { useNotificationPrefs, isNotificationVisible } from '../hooks/useNotificationPrefs';
import { getStatusColorClass } from '../statusStyles';
import { StatusBadge } from './StatusBadge';
import { TicketRefChip } from './TicketRefChip';

/**
 * FLUX-922: per-type theme tokens. Each type drives an accent rgb triplet (comma form for
 * `rgb()`/`rgba()` template strings) that paints the glowing rail, the radial type-wash, the icon
 * chip and the unread dot via inline styles (inline wins over the unlayered `.eh-*` rules, the same
 * tactic `statusStyles.ts` uses). `review` (violet) is the FLUX-922 addition.
 */
const TYPE_THEME: Record<Notification['type'], { icon: LucideIcon; accent: string }> = {
  error: { icon: AlertTriangle, accent: '239, 68, 68' }, // red
  prompt: { icon: Bell, accent: '245, 158, 11' }, // amber
  completion: { icon: CheckCircle2, accent: '16, 185, 129' }, // emerald
  review: { icon: BadgeCheck, accent: '139, 92, 246' }, // violet
  info: { icon: Info, accent: '59, 130, 246' }, // blue
};

const LIVE_ACCENT = '16, 185, 129'; // emerald — a card whose ticket has a running session

const ACTION_SUCCESS_LABELS: Record<string, string> = {
  reinstall: 'Skills reinstalled successfully',
};

/** Rotating quips for the caught-up empty state. */
const QUIPS = [
  'All clear ✨',
  'Inbox zero — nicely done',
  'Nothing needs you right now',
  'The board is calm',
  'Caught up. Go ship something.',
];

const CONFETTI_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#ec4899'];

/** Swipe threshold (px) past which a release commits the action. */
const SWIPE_THRESHOLD = 64;

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** FLUX-922: relative time that reveals the pretty absolute timestamp in a body-portaled tip on
 *  hover (the list clips per-card, so the tip must escape to `document.body`). */
function TimeHover({ iso }: { iso: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 220)) });
  };
  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      className="cursor-default text-[10px] text-gray-500 dark:text-gray-400"
    >
      {relativeTime(iso)}
      {pos && createPortal(
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 999999 }}
          className="pointer-events-none rounded-md border border-[var(--eh-border)] bg-[var(--eh-surface)] px-2 py-1 text-[11px] text-[var(--eh-text-primary)] shadow-xl"
        >
          {formatAbsolute(iso)}
        </div>,
        document.body,
      )}
    </span>
  );
}

const NotificationCard = memo(function NotificationCard({
  notification,
  read,
  onDismiss,
  onMarkRead,
  onMarkUnread,
  onClose,
  onUpdate,
}: {
  notification: Notification;
  /** Effective read state (server read OR optimistically marked read by the panel). */
  read: boolean;
  onDismiss: (id: string) => void;
  onMarkRead: (id: string) => void;
  onMarkUnread: (id: string) => void;
  onClose: () => void;
  onUpdate: () => void;
}) {
  const { openTaskFullView, openTaskModal } = useAppActions();
  const { openTicket, openBoard } = useDockActions();
  const boardConfig = useAppSelector((s) => s.config);
  const reduce = useReducedMotion();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // FLUX-922 perf fix: subscribe to only this card's task via the Map-backed O(1) hook so a card
  // re-renders only when its own task ref changes — not on every mutation of the whole tasks array
  // (which fired several times a second on any live cliSession tick and defeated this card's memo).
  const task = useTaskById(
    notification.ticketId && notification.ticketId !== BOARD_CONVERSATION_ID
      ? notification.ticketId
      : undefined,
  );
  const isLive = task?.cliSession?.status === 'running';
  const theme = TYPE_THEME[notification.type] ?? TYPE_THEME.info;
  const Icon = theme.icon;
  const accent = isLive ? LIVE_ACCENT : theme.accent;
  // Verdict chip for review cards — portal-derived from the linked task's live reviewState. For the
  // (rare) case the task isn't in the store yet, fall back to a title heuristic that fails SAFE:
  // only an explicit phrase match yields a verdict; an unrecognized title renders no chip rather
  // than guessing 'approved' (a wrong-positive verdict is worse than none).
  const verdict: 'approved' | 'changes-requested' | null =
    notification.type === 'review'
      ? (task?.reviewState
        ?? (/changes\s+requested/i.test(notification.title)
          ? 'changes-requested'
          : /approved/i.test(notification.title)
            ? 'approved'
            : null))
      : null;
  const showBranch = !!task?.branch && (notification.type === 'completion' || notification.type === 'review' || isLive);

  // FLUX-778: swipe-to-action. Drag right reveals the read-toggle (left side) — "Mark read" on an
  // unread card, "Mark unread" on a read one (FLUX-800) — drag left reveals "Dismiss" (right side);
  // each fades + scales in as you drag and fires on release past the threshold. A drag flag
  // suppresses the click that would otherwise also open the ticket.
  const x = useMotionValue(0);
  const readReveal = useTransform(x, [12, SWIPE_THRESHOLD], [0, 1]);
  const readScale = useTransform(x, [SWIPE_THRESHOLD, SWIPE_THRESHOLD * 1.4], [1, 1.15]);
  const dismissReveal = useTransform(x, [-SWIPE_THRESHOLD, -12], [1, 0]);
  const dismissScale = useTransform(x, [-SWIPE_THRESHOLD * 1.4, -SWIPE_THRESHOLD], [1.15, 1]);
  const draggedRef = useRef(false);

  const handleOpen = useCallback(() => {
    if (draggedRef.current) return; // a swipe just ended — don't also open the ticket
    if (!notification.ticketId) return;
    // FLUX-810: the orchestrator-reply notification has no task entry (the board isn't a ticket),
    // so the `useTaskById` lookup above resolves to undefined. Special-case it to open the chat.
    if (notification.ticketId === BOARD_CONVERSATION_ID) {
      void markNotificationRead(notification.id).then(onUpdate);
      onClose();
      openBoard();
      return;
    }
    if (!task) return;
    void markNotificationRead(notification.id).then(onUpdate);
    onClose();
    // FLUX-690: open honoring boardCardOpenMode (default chat), like a board card.
    const mode = boardConfig?.boardCardOpenMode || 'chat';
    if (mode === 'full') openTaskFullView(task);
    else if (mode === 'popup') openTaskModal(task);
    else openTicket(task.id);
  }, [notification, task, onClose, onUpdate, openTaskFullView, openTaskModal, openTicket, openBoard, boardConfig]);

  const handleAction = useCallback(async (e: React.MouseEvent, actionId: string) => {
    e.stopPropagation();
    if (actionId === 'dismiss') {
      onDismiss(notification.id);
    } else if (actionId === 'view') {
      handleOpen();
    } else if (actionId === 'open-url') {
      const urlMatch = notification.message.match(/https?:\/\/\S+/);
      if (urlMatch) window.open(urlMatch[0], '_blank');
      onMarkRead(notification.id);
    } else {
      await executeNotificationAction(notification.id, actionId);
      const label = ACTION_SUCCESS_LABELS[actionId] || 'Done';
      setSuccessMessage(label);
      setTimeout(() => onUpdate(), 2000);
    }
  }, [notification, handleOpen, onDismiss, onMarkRead, onUpdate]);

  const handleStop = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task?.cliSession) return;
    setStopping(true);
    try {
      await stopTaskCliSession(task.id, { sessionId: task.cliSession.id });
    } catch {
      /* surfaced via refresh */
    } finally {
      setStopping(false);
      onUpdate();
    }
  }, [task, onUpdate]);

  if (successMessage) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, height: 0, scale: 0.9, transition: { duration: 0.2 } }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-2 overflow-hidden rounded-xl border-l-4 border-l-emerald-500 bg-emerald-50 p-3 dark:bg-emerald-500/10"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{successMessage}</p>
      </motion.div>
    );
  }

  // Meaningful inline actions (Answer / View PR / Retry / View review …). `view` is folded into the
  // row click + ticket chip, and `dismiss` has its own affordance — both filtered out (rev-5).
  const inlineActions = notification.actions.filter((a) => a.actionId !== 'dismiss' && a.actionId !== 'view');

  return (
    <motion.div
      layout
      initial={reduce ? false : { opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, height: 0, scale: 0.97, transition: { duration: 0.2 } }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className="relative overflow-hidden rounded-xl"
    >
      {/* Revealed swipe actions behind the card. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between rounded-xl bg-gray-100 px-4 dark:bg-white/5">
        <motion.span
          style={{ opacity: readReveal, scale: readScale }}
          className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-blue-600 dark:text-blue-400"
        >
          {read
            ? <><Undo2 className="h-4 w-4" /> Mark unread</>
            : <><CheckCheck className="h-4 w-4" /> Mark read</>}
        </motion.span>
        <motion.span
          style={{ opacity: dismissReveal, scale: dismissScale }}
          className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400"
        >
          Dismiss <Trash2 className="h-4 w-4" />
        </motion.span>
      </div>

      {/* Draggable card (solid background so the actions only show as it slides). */}
      <motion.div
        drag="x"
        style={{ x }}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.9}
        dragMomentum={false}
        dragSnapToOrigin
        onDragStart={() => { draggedRef.current = true; }}
        onDragEnd={(_, info) => {
          if (info.offset.x <= -SWIPE_THRESHOLD || info.velocity.x < -600) onDismiss(notification.id);
          else if (info.offset.x >= SWIPE_THRESHOLD || info.velocity.x > 600) {
            if (read) onMarkUnread(notification.id); else onMarkRead(notification.id);
          }
          setTimeout(() => { draggedRef.current = false; }, 40);
        }}
        whileDrag={{ cursor: 'grabbing' }}
        whileHover={reduce ? undefined : { y: -1 }}
        onClick={handleOpen}
        // FLUX-922 a11y fix: the whole-card open affordance was mouse-only. Make the row a real
        // button so keyboard users can open it; the target!==currentTarget guard lets Enter/Space on
        // an inner control (dismiss, Stop, actions, chip) act on that control instead of the row.
        role="button"
        tabIndex={0}
        aria-label={notification.title}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
            e.preventDefault();
            handleOpen();
          }
        }}
        className={`group relative flex cursor-pointer gap-3 overflow-hidden rounded-xl border p-3 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${read ? 'border-[var(--eh-border)] bg-white dark:bg-[#23242f]' : 'border-[var(--eh-border)] bg-white shadow-sm dark:bg-[#272938]'}`}
      >
        {/* Glowing accent rail. */}
        <div
          className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] ${isLive ? 'animate-pulse' : ''}`}
          style={{
            background: `rgb(${accent})`,
            boxShadow: !read || isLive ? `0 0 8px 0 rgba(${accent}, 0.7)` : 'none',
          }}
        />
        {/* Faint radial type-wash bleeding from the rail corner. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(120% 80% at 0% 0%, rgba(${accent}, ${read ? 0.05 : 0.1}) 0%, rgba(${accent}, 0) 60%)` }}
        />

        {/* Tinted icon chip. */}
        <div
          className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: `rgba(${accent}, 0.14)`, color: `rgb(${accent})` }}
        >
          <Icon className="h-4 w-4" />
        </div>

        <div className="relative min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className={`break-words text-xs font-semibold ${read ? 'text-gray-600 dark:text-gray-300' : 'text-gray-900 dark:text-gray-100'}`}>
              {notification.title}
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(notification.id); }}
              title="Dismiss"
              aria-label="Dismiss notification"
              className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-gray-500 dark:text-gray-400">{notification.message}</p>

          {/* Signal row: ticket ref · status · branch · verdict · time. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {notification.ticketId && <TicketRefChip ticketId={notification.ticketId} />}
            {task && (
              <StatusBadge status={normalizeStatus(task.status)} colorClass={getStatusColorClass(boardConfig, task.status)} className="text-[10px]" />
            )}
            {verdict && (
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${verdict === 'approved' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'}`}>
                {verdict === 'approved' ? 'Approved' : 'Changes requested'}
              </span>
            )}
            {showBranch && task?.branch && (
              <span className="inline-flex items-center gap-1 rounded-md bg-black/5 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-white/5 dark:text-gray-400">
                <GitBranch className="h-2.5 w-2.5 shrink-0" />
                <span className="max-w-[8rem] truncate">{task.branch}</span>
              </span>
            )}
            <TimeHover iso={notification.createdAt} />
          </div>

          {/* Live running-session treatment: activity ticker + indeterminate shimmer + Stop. */}
          {isLive && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
                </span>
                {task?.cliSession?.currentActivity && (
                  <span className="min-w-0 truncate text-[10px] text-gray-500 dark:text-gray-400">{task.cliSession.currentActivity}</span>
                )}
                <button
                  onClick={handleStop}
                  disabled={stopping}
                  className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 transition-colors hover:bg-rose-200 disabled:opacity-50 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25"
                >
                  <Square className="h-2.5 w-2.5" /> Stop
                </button>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-emerald-500/15">
                <div className={`h-full w-1/3 rounded-full bg-emerald-500/70 ${reduce ? '' : 'eh-notif-indeterminate'}`} />
              </div>
            </div>
          )}

          {/* Reveal footer — revealed on hover; focus-within keeps it for keyboard. FLUX-922 a11y
              fix: carries a focusable per-card read-toggle (Mark read / Mark unread), which was
              previously reachable only via the swipe gesture, plus any meaningful inline actions. */}
          <div className="mt-2 flex flex-wrap items-center gap-3 opacity-100 md:max-h-0 md:overflow-hidden md:opacity-0 md:transition-all md:group-hover:max-h-20 md:group-hover:opacity-100 md:group-focus-within:max-h-20 md:group-focus-within:opacity-100">
            <button
              onClick={(e) => { e.stopPropagation(); if (read) onMarkUnread(notification.id); else onMarkRead(notification.id); }}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 transition-colors hover:text-primary dark:text-gray-400"
            >
              {read
                ? <><Undo2 className="h-3 w-3" /> Mark unread</>
                : <><CheckCheck className="h-3 w-3" /> Mark read</>}
            </button>
            {inlineActions.map((action) => (
              <button
                key={action.actionId}
                onClick={(e) => handleAction(e, action.actionId)}
                className="text-[11px] font-semibold text-primary transition-colors hover:text-primary-hover"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>

        {!read && (
          <div
            className="absolute right-9 top-3 h-2 w-2 rounded-full"
            style={{ background: `rgb(${accent})`, boxShadow: `0 0 6px 0 rgba(${accent}, 0.8)` }}
          />
        )}
      </motion.div>
    </motion.div>
  );
});

/** A one-shot confetti burst fired when the list transitions to empty. Gated by reduced-motion. */
function ConfettiBurst() {
  const dots = Array.from({ length: 18 });
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden">
      {dots.map((_, i) => {
        const angle = (i / dots.length) * Math.PI * 2;
        const dist = 64 + (i % 5) * 16;
        return (
          <motion.span
            key={i}
            initial={{ opacity: 1, x: 0, y: 0, scale: 0.5 }}
            animate={{ opacity: 0, x: Math.cos(angle) * dist, y: Math.sin(angle) * dist, scale: 1 }}
            transition={{ duration: 0.9 + (i % 4) * 0.1, ease: 'easeOut' }}
            className="absolute h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: CONFETTI_COLORS[i % CONFETTI_COLORS.length] }}
          />
        );
      })}
    </div>
  );
}

/** The caught-up empty state: a haloed orb + a rotating quip, with confetti on the just-emptied
 *  transition. Motion (halo pulse, quip rotation, confetti) is gated behind reduced-motion. */
function EmptyState({ celebrate, actionTab }: { celebrate: boolean; actionTab: boolean }) {
  const reduce = useReducedMotion();
  const [quip, setQuip] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const t = window.setInterval(() => setQuip((q) => (q + 1) % QUIPS.length), 4200);
    return () => window.clearInterval(t);
  }, [reduce]);
  return (
    <div className="relative flex flex-col items-center justify-center py-12 text-center">
      {celebrate && !reduce && <ConfettiBurst />}
      <div className="relative mb-3">
        <div className={`absolute inset-0 rounded-full bg-primary/30 blur-xl ${reduce ? '' : 'eh-notif-orb'}`} />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary/80 to-primary text-white shadow-lg">
          <Sparkles className="h-6 w-6" />
        </div>
      </div>
      {actionTab ? (
        <p className="text-xs font-semibold text-[var(--eh-text-primary)]">Nothing needs you right now</p>
      ) : (
        <AnimatePresence mode="wait">
          <motion.p
            key={quip}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.3 }}
            className="text-xs font-semibold text-[var(--eh-text-primary)]"
          >
            {QUIPS[quip]}
          </motion.p>
        </AnimatePresence>
      )}
    </div>
  );
}

interface Props {
  notifications: Notification[];
  onClose: () => void;
  onUpdate: () => void;
  /** FLUX-898: render inline inside the unified attention surface's Updates tab — drop the floating
   *  card chrome (fixed position, title bar, outside-click-to-close) and fill the host instead. */
  embedded?: boolean;
}

/** Time buckets for the section headers, newest first. */
const BUCKETS = [
  { key: 'now', label: 'Now' },
  { key: 'today', label: 'Earlier today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'older', label: 'Earlier' },
] as const;
type BucketKey = (typeof BUCKETS)[number]['key'];

function bucketOf(iso: string): BucketKey {
  const then = new Date(iso);
  const now = new Date();
  const diffMin = (now.getTime() - then.getTime()) / 60000;
  if (diffMin < 60) return 'now';
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) return 'today';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (then.toDateString() === yest.toDateString()) return 'yesterday';
  return 'older';
}

export const NotificationPanel = memo(function NotificationPanel({ notifications, onClose, onUpdate, embedded = false }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  // FLUX-778: optimistic local state so dismiss/mark-read are instant — the card animates out (or
  // restyles) immediately and the API call + refresh run in the background, instead of waiting on a
  // round-trip. The sets self-reconcile on the next refresh (dismissed items leave the server list).
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  // FLUX-800: optimistic *unread* overrides — swiping right on a read card marks it unread. Kept as
  // its own set so it can override a server `read: true` (which readIds alone cannot undo).
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    // FLUX-898: embedded inside the attention surface the host owns open/close, so the panel must not
    // self-close on outside clicks (every click on the surface chrome would be "outside").
    if (embedded) return;
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Element;
      // FLUX-777: ignore clicks on the bell toggle so it can close the panel itself — otherwise the
      // outside-mousedown closes it and the toggle's onClick immediately re-opens it (stuck open).
      if (target?.closest?.('[data-notif-toggle]')) return;
      if (panelRef.current && !panelRef.current.contains(target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClickOutside); };
  }, [onClose, embedded]);

  // FLUX-822: reconcile-and-evict. The optimistic sets bridge the API round-trip, but left alone
  // they grow for the panel's lifetime and a stale override can win over true server state (e.g. an
  // id kept in `readIds` after the server marked it read through another surface). On every refresh
  // (a new `notifications` array), drop ids the server now agrees with or that have left the list, so
  // the sets only ever hold genuinely in-flight overrides.
  useEffect(() => {
    setReadIds((prev) => {
      if (prev.size === 0) return prev;
      // Keep only ids still present AND not yet read on the server (the override is still pending).
      const next = new Set<string>();
      for (const n of notifications) if (prev.has(n.id) && !n.read) next.add(n.id);
      return next.size === prev.size ? prev : next;
    });
    setDismissedIds((prev) => {
      if (prev.size === 0) return prev;
      // Once a dismissed notification leaves the server list the override is satisfied — evict it.
      const live = new Set(notifications.map((n) => n.id));
      const next = new Set<string>();
      for (const id of prev) if (live.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    // FLUX-922 perf fix: prune unreadIds too (was previously omitted → slow unbounded growth in the
    // long-lived embedded panel). Keep only ids still present AND still read on the server, i.e. the
    // unread override is still pending; drop ones the server now agrees are unread or that have left.
    setUnreadIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const n of notifications) if (prev.has(n.id) && n.read) next.add(n.id);
      return next.size === prev.size ? prev : next;
    });
  }, [notifications]);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((prev) => { const next = new Set(prev); next.add(id); return next; });
    // FLUX-831: on failure the server keeps the notification in the live list, so roll back the
    // optimistic dismissedIds override (the reconcile effect would otherwise retain it for the
    // panel's lifetime — `live.has(id)` keeps it) and refetch to reconcile truth.
    void dismissNotification(id).then(onUpdate).catch(() => {
      setDismissedIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
      onUpdate();
    });
  }, [onUpdate]);

  const markRead = useCallback((id: string) => {
    setReadIds((prev) => { const next = new Set(prev); next.add(id); return next; });
    setUnreadIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    // FLUX-823: on failure the server keeps the notification unread, so roll back the optimistic
    // readIds override (the reconcile effect would otherwise retain it for the panel's lifetime —
    // `prev.has(n.id) && !n.read` keeps it) and refetch to reconcile truth.
    void markNotificationRead(id).then(onUpdate).catch(() => {
      setReadIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
      onUpdate();
    });
  }, [onUpdate]);

  const markUnread = useCallback((id: string) => {
    setUnreadIds((prev) => { const next = new Set(prev); next.add(id); return next; });
    setReadIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    // FLUX-823: same swallow as markRead — roll back the optimistic unreadIds override on failure
    // and refetch so a failed mark-unread doesn't leave a permanent stale override.
    void markNotificationUnread(id).then(onUpdate).catch(() => {
      setUnreadIds((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
      onUpdate();
    });
  }, [onUpdate]);

  const { prefs } = useNotificationPrefs();
  const visible = notifications.filter((n) => !dismissedIds.has(n.id) && isNotificationVisible(n, prefs));
  const isRead = (n: Notification) => (n.read || readIds.has(n.id)) && !unreadIds.has(n.id);
  const byCategory = {
    action: visible.filter((n) => notificationCategory(n.type) === 'action'),
    update: visible.filter((n) => notificationCategory(n.type) === 'update'),
  } as const;
  const [tab, setTab] = useState<'all' | 'action' | 'update'>(() => (byCategory.action.length ? 'action' : 'all'));
  const shown =
    tab === 'action' ? byCategory.action
    : tab === 'update' ? byCategory.update
    : visible; // 'all'
  // FLUX-922: group the shown list into time buckets, newest-first within each.
  const sorted = [...shown].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const grouped = BUCKETS.map((b) => ({ ...b, items: sorted.filter((n) => bucketOf(n.createdAt) === b.key) })).filter((g) => g.items.length > 0);

  // FLUX-922: celebrate the moment the visible list empties (confetti in the empty state). Tracks the
  // prior count so a tab switch into an already-empty bucket doesn't fire it.
  const prevCount = useRef(visible.length);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (prevCount.current > 0 && visible.length === 0) {
      setCelebrate(true);
      const t = window.setTimeout(() => setCelebrate(false), 1300);
      prevCount.current = visible.length;
      return () => window.clearTimeout(t);
    }
    prevCount.current = visible.length;
  }, [visible.length]);

  const TABS = [
    { key: 'all' as const, label: 'All', count: visible.length },
    { key: 'action' as const, label: 'Action', count: byCategory.action.length },
    { key: 'update' as const, label: 'Updates', count: byCategory.update.length },
  ];

  const handleMarkAllRead = useCallback(() => {
    // FLUX-823: track exactly the ids this call adds so a failed bulk mark-all-read rolls back its
    // own optimistic overrides (not ones already pending from individual markReads) and refetches.
    const added: string[] = [];
    setReadIds((prev) => {
      const next = new Set(prev);
      visible.forEach((n) => { if (!next.has(n.id)) { next.add(n.id); added.push(n.id); } });
      return next;
    });
    void markAllNotificationsRead().then(onUpdate).catch(() => {
      setReadIds((prev) => { const next = new Set(prev); added.forEach((id) => next.delete(id)); return next; });
      onUpdate();
    });
  }, [onUpdate, visible]);

  const showMarkAll = visible.some((n) => !isRead(n));
  const markAllBtn = showMarkAll ? (
    <button
      onClick={handleMarkAllRead}
      className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 transition-colors hover:text-primary"
    >
      <CheckCheck className="h-3 w-3" />
      Mark all read
    </button>
  ) : null;

  // FLUX-777: tab bar — filter by pertinence instead of scrolling stacked sections. FLUX-898: when
  // embedded the bar also carries Mark-all-read (no title header to host it).
  const tabBar = (
    <div className="flex items-center gap-1 border-b border-gray-100 px-2 py-1.5 dark:border-white/5">
      {TABS.map((t) => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${active ? 'bg-primary/15 text-primary' : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5'}`}
          >
            {t.label}
            <span className={`rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums ${active ? 'bg-primary/20 text-primary' : 'bg-gray-200/80 text-gray-500 dark:bg-white/10 dark:text-gray-400'}`}>
              {t.count}
            </span>
          </button>
        );
      })}
      {embedded && markAllBtn && <div className="ml-auto pr-1">{markAllBtn}</div>}
    </div>
  );

  const list = (
    <div
      aria-live="polite"
      className={`overflow-y-auto p-2 ${embedded ? 'min-h-0 flex-1' : 'max-h-[420px]'}`}
    >
      {shown.length === 0 ? (
        <EmptyState celebrate={celebrate} actionTab={tab === 'action'} />
      ) : (
        // FLUX-922 fix: AnimatePresence's direct children must be the cards for the per-card
        // exit-collapse to fire, so nest one inside each bucket's items container. The outer
        // AnimatePresence around the bucket wrappers lets a bucket that empties fade out instead of
        // popping.
        <AnimatePresence mode="popLayout" initial={false}>
          {grouped.map((g) => (
            <motion.div key={g.key} layout exit={{ opacity: 0, transition: { duration: 0.15 } }} className="mb-1">
              <div className="px-1 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {g.label}
              </div>
              <div className="space-y-1.5">
                <AnimatePresence initial={false}>
                  {g.items.map((n) => (
                    <NotificationCard
                      key={n.id}
                      notification={n}
                      read={isRead(n)}
                      onDismiss={dismiss}
                      onMarkRead={markRead}
                      onMarkUnread={markUnread}
                      onClose={onClose}
                      onUpdate={onUpdate}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      )}
    </div>
  );

  if (embedded) {
    return (
      <div ref={panelRef} className="flex h-full min-h-0 flex-col">
        {tabBar}
        {list}
      </div>
    );
  }

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="absolute right-0 top-full z-50 mt-2 max-h-[480px] w-[360px] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#1a1b26]"
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-white/5">
        <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Notifications</h3>
        <div className="flex items-center gap-2">
          {markAllBtn}
          <button onClick={onClose} className="rounded p-1 text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {tabBar}
      {list}
    </motion.div>
  );
});

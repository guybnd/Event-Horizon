import { memo, useRef, useEffect, useCallback, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Info, X, CheckCheck, ExternalLink, Trash2, Undo2 } from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useTransform } from 'framer-motion';
import type { Notification } from '../api';
import { markNotificationRead, markNotificationUnread, markAllNotificationsRead, dismissNotification, executeNotificationAction, BOARD_CONVERSATION_ID } from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { useDockActions } from './DockProvider';
import { relativeTime } from '../workflow';
import { notificationCategory } from './notificationCategory';
import { useNotificationPrefs, isNotificationVisible } from '../hooks/useNotificationPrefs';

interface Props {
  notifications: Notification[];
  onClose: () => void;
  onUpdate: () => void;
}

const TYPE_CONFIG = {
  error: { icon: AlertTriangle, borderColor: 'border-l-red-500', iconColor: 'text-red-500' },
  prompt: { icon: Bell, borderColor: 'border-l-amber-500', iconColor: 'text-amber-500' },
  completion: { icon: CheckCircle2, borderColor: 'border-l-emerald-500', iconColor: 'text-emerald-500' },
  info: { icon: Info, borderColor: 'border-l-blue-500', iconColor: 'text-blue-500' },
};

const ACTION_SUCCESS_LABELS: Record<string, string> = {
  reinstall: 'Skills reinstalled successfully',
};

/** Swipe threshold (px) past which a release commits the action. */
const SWIPE_THRESHOLD = 64;

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
  const tasks = useAppSelector((s) => s.tasks);
  const boardConfig = useAppSelector((s) => s.config);
  const config = TYPE_CONFIG[notification.type];
  const Icon = config.icon;
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
    // FLUX-810: the orchestrator-reply notification has no `tasks` entry (the board isn't a ticket),
    // so the `tasks.find` path below would no-op. Special-case it to open the orchestrator chat.
    if (notification.ticketId === BOARD_CONVERSATION_ID) {
      void markNotificationRead(notification.id).then(onUpdate);
      onClose();
      openBoard();
      return;
    }
    const task = tasks.find((t) => t.id === notification.ticketId);
    if (!task) return;
    void markNotificationRead(notification.id).then(onUpdate);
    onClose();
    // FLUX-690: open honoring boardCardOpenMode (default chat), like a board card.
    const mode = boardConfig?.boardCardOpenMode || 'chat';
    if (mode === 'full') openTaskFullView(task);
    else if (mode === 'popup') openTaskModal(task);
    else openTicket(task.id);
  }, [notification, tasks, onClose, onUpdate, openTaskFullView, openTaskModal, openTicket, openBoard, boardConfig]);

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

  if (successMessage) {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9, x: -20 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-2 rounded-lg border-l-4 border-l-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 p-3"
      >
        <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
        <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">{successMessage}</p>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className="relative overflow-hidden rounded-lg"
    >
      {/* Revealed swipe actions behind the card. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between rounded-lg bg-gray-100 px-4 dark:bg-white/5">
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
        onClick={handleOpen}
        className={`relative flex cursor-pointer gap-3 rounded-lg border-l-4 p-3 ${config.borderColor} ${read ? 'bg-white dark:bg-[#23242f]' : 'bg-white shadow-sm dark:bg-[#272938]'}`}
      >
        <div className={`shrink-0 mt-0.5 ${config.iconColor}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className={`text-xs font-semibold break-words ${read ? 'text-gray-600 dark:text-gray-300' : 'text-gray-900 dark:text-gray-100'}`}>
              {notification.title}
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(notification.id); }}
              title="Dismiss"
              aria-label="Dismiss notification"
              className="shrink-0 -mr-1 -mt-1 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/10 dark:hover:text-gray-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 break-words whitespace-pre-wrap">{notification.message}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[10px] text-gray-400">{relativeTime(notification.createdAt)}</span>
            {notification.actions
              .filter((a) => a.actionId !== 'dismiss' && a.actionId !== 'view')
              .map((action) => (
                <button
                  key={action.actionId}
                  onClick={(e) => handleAction(e, action.actionId)}
                  className="text-[10px] font-semibold text-primary transition-colors hover:text-primary-hover"
                >
                  {action.label}
                </button>
              ))}
            {notification.ticketId && (
              <span className="flex items-center gap-0.5 text-[10px] text-gray-400">
                <ExternalLink className="h-2.5 w-2.5" />
                {notification.ticketId}
              </span>
            )}
          </div>
        </div>
        {!read && <div className="absolute right-9 top-3 h-2 w-2 rounded-full bg-primary" />}
      </motion.div>
    </motion.div>
  );
});

export const NotificationPanel = memo(function NotificationPanel({ notifications, onClose, onUpdate }: Props) {
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
  }, [onClose]);

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
    : [...byCategory.action, ...byCategory.update]; // 'all' — action-first
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

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="absolute right-0 top-full mt-2 z-50 w-[360px] max-h-[480px] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#1a1b26]"
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-white/5">
        <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Notifications</h3>
        <div className="flex items-center gap-2">
          {visible.some((n) => !isRead(n)) && (
            <button
              onClick={handleMarkAllRead}
              className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 hover:text-primary transition-colors"
            >
              <CheckCheck className="h-3 w-3" />
              Mark all read
            </button>
          )}
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* FLUX-777: tab bar — filter by pertinence instead of scrolling stacked sections. */}
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
      </div>

      <div className="overflow-y-auto max-h-[420px] p-2 space-y-1.5">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-gray-400">
            <Bell className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-xs font-medium">{tab === 'action' ? 'Nothing needs you right now' : 'No notifications'}</p>
          </div>
        ) : (
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.map((n) => (
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
        )}
      </div>
    </motion.div>
  );
});

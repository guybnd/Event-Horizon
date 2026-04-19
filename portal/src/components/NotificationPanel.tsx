import { memo, useRef, useEffect, useCallback, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Info, X, CheckCheck, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Notification } from '../api';
import { markNotificationRead, markAllNotificationsRead, dismissNotification, executeNotificationAction } from '../api';
import { useApp } from '../AppContext';
import { relativeTime } from '../workflow';

interface Props {
  notifications: Notification[];
  onClose: () => void;
  onUpdate: () => void;
}

const TYPE_CONFIG = {
  error: {
    icon: AlertTriangle,
    borderColor: 'border-l-red-500',
    iconColor: 'text-red-500',
    bgColor: 'bg-red-50 dark:bg-red-500/5',
  },
  prompt: {
    icon: Bell,
    borderColor: 'border-l-amber-500',
    iconColor: 'text-amber-500',
    bgColor: 'bg-amber-50 dark:bg-amber-500/5',
  },
  completion: {
    icon: CheckCircle2,
    borderColor: 'border-l-emerald-500',
    iconColor: 'text-emerald-500',
    bgColor: 'bg-emerald-50 dark:bg-emerald-500/5',
  },
  info: {
    icon: Info,
    borderColor: 'border-l-blue-500',
    iconColor: 'text-blue-500',
    bgColor: 'bg-blue-50 dark:bg-blue-500/5',
  },
};

const ACTION_SUCCESS_LABELS: Record<string, string> = {
  reinstall: 'Skills reinstalled successfully',
};

const NotificationCard = memo(function NotificationCard({
  notification,
  onClose,
  onUpdate,
}: {
  notification: Notification;
  onClose: () => void;
  onUpdate: () => void;
}) {
  const { openTaskFullView, tasks } = useApp();
  const config = TYPE_CONFIG[notification.type];
  const Icon = config.icon;
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleClick = useCallback(() => {
    if (notification.ticketId) {
      const task = tasks.find(t => t.id === notification.ticketId);
      if (task) {
        markNotificationRead(notification.id).then(onUpdate);
        onClose();
        openTaskFullView(task);
      }
    }
  }, [notification, tasks, onClose, onUpdate, openTaskFullView]);

  const handleAction = useCallback(async (e: React.MouseEvent, actionId: string) => {
    e.stopPropagation();
    if (actionId === 'dismiss') {
      await dismissNotification(notification.id);
      onUpdate();
    } else if (actionId === 'view') {
      handleClick();
    } else if (actionId === 'open-url') {
      const urlMatch = notification.message.match(/https?:\/\/\S+/);
      if (urlMatch) window.open(urlMatch[0], '_blank');
      await markNotificationRead(notification.id);
      onUpdate();
    } else {
      await executeNotificationAction(notification.id, actionId);
      const label = ACTION_SUCCESS_LABELS[actionId] || 'Done';
      setSuccessMessage(label);
      setTimeout(() => onUpdate(), 2000);
    }
  }, [notification, handleClick, onUpdate]);

  const handleDismiss = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await dismissNotification(notification.id);
    onUpdate();
  }, [notification, onUpdate]);

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
      exit={{ opacity: 0, x: -30, scale: 0.92, filter: 'blur(4px)' }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      onClick={handleClick}
      className={`relative flex gap-3 rounded-lg border-l-4 p-3 transition-colors cursor-pointer hover:shadow-sm ${config.borderColor} ${notification.read ? 'bg-white dark:bg-white/2' : config.bgColor}`}
    >
      <div className={`shrink-0 mt-0.5 ${config.iconColor}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-xs font-semibold truncate ${notification.read ? 'text-gray-600 dark:text-gray-300' : 'text-gray-900 dark:text-gray-100'}`}>
            {notification.title}
          </p>
          <button
            onClick={handleDismiss}
            className="shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{notification.message}</p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[10px] text-gray-400">{relativeTime(notification.createdAt)}</span>
          {notification.actions
            .filter(a => a.actionId !== 'dismiss' && a.actionId !== 'view')
            .map(action => (
              <button
                key={action.actionId}
                onClick={(e) => handleAction(e, action.actionId)}
                className="text-[10px] font-semibold text-primary hover:text-primary-hover transition-colors"
              >
                {action.label}
              </button>
            ))}
          {notification.ticketId && (
            <span className="text-[10px] text-gray-400 flex items-center gap-0.5">
              <ExternalLink className="h-2.5 w-2.5" />
              {notification.ticketId}
            </span>
          )}
        </div>
      </div>
      {!notification.read && (
        <div className="absolute top-3 right-8 h-2 w-2 rounded-full bg-primary" />
      )}
    </motion.div>
  );
});

export const NotificationPanel = memo(function NotificationPanel({ notifications, onClose, onUpdate }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClickOutside); };
  }, [onClose]);

  const handleMarkAllRead = useCallback(async () => {
    await markAllNotificationsRead();
    onUpdate();
  }, [onUpdate]);

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
          {notifications.some(n => !n.read) && (
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

      <div className="overflow-y-auto max-h-[420px] p-2 space-y-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {notifications.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center py-10 text-gray-400"
            >
              <Bell className="h-8 w-8 mb-2 opacity-40" />
              <p className="text-xs font-medium">No notifications</p>
            </motion.div>
          ) : (
            notifications.map(n => (
              <NotificationCard
                key={n.id}
                notification={n}
                onClose={onClose}
                onUpdate={onUpdate}
              />
            ))
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
});

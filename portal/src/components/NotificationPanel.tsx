import { memo, useRef, useEffect, useCallback } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Info, X, CheckCheck, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
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
    } else if (actionId === 'view') {
      handleClick();
      return;
    } else if (actionId === 'open-url') {
      const urlMatch = notification.message.match(/https?:\/\/\S+/);
      if (urlMatch) window.open(urlMatch[0], '_blank');
      await markNotificationRead(notification.id);
    } else {
      await executeNotificationAction(notification.id, actionId);
    }
    onUpdate();
  }, [notification, handleClick, onUpdate]);

  const handleDismiss = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    await dismissNotification(notification.id);
    onUpdate();
  }, [notification, onUpdate]);

  return (
    <div
      onClick={handleClick}
      className={`relative flex gap-3 rounded-lg border-l-4 p-3 transition-all cursor-pointer hover:shadow-sm ${config.borderColor} ${notification.read ? 'bg-white dark:bg-white/2' : config.bgColor}`}
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
    </div>
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
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-gray-400">
            <Bell className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-xs font-medium">No notifications</p>
          </div>
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
      </div>
    </motion.div>
  );
});

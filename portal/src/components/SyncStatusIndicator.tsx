import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, CloudOff, RefreshCw, AlertCircle, WifiOff, Lock, Copy, X } from 'lucide-react';
import { ConflictResolutionModal } from './ConflictResolutionModal';
import * as api from '../api';
import type { ConflictInfo } from '../api';

export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'synced'; lastSyncTime: string }
  | { state: 'conflict'; conflicts: ConflictInfo[] }
  | { state: 'error'; error: string; errorType: 'network' | 'auth' | 'conflict' | 'unknown' };

export function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus>({ state: 'idle' });
  const [isOffline, setIsOffline] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [showErrorToast, setShowErrorToast] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    async function connect() {
      try {
        // First fetch to check if sync is configured (orphan mode)
        const res = await fetch('/api/sync-status');
        if (!res.ok) {
          // No sync configured (in-repo mode)
          setIsOffline(true);
          return;
        }

        const initialStatus = await res.json();
        setStatus(initialStatus);
        setIsOffline(false);

        // Connect to SSE stream for real-time updates
        es = new EventSource('/api/sync-status/stream');

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            setStatus(data);
            setIsOffline(false);
          } catch (err) {
            console.error('[sync-status] Failed to parse SSE message:', err);
          }
        };

        es.onerror = () => {
          // Connection lost, attempt reconnect after 5s
          setIsOffline(true);
          if (es) {
            es.close();
            es = null;
          }

          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, 5000);
          }
        };
      } catch (err) {
        setIsOffline(true);

        // Retry connection after 5s
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 5000);
        }
      }
    }

    connect();

    // Update time every 30 seconds to refresh time-ago displays
    intervalRef.current = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);

    return () => {
      if (es) {
        es.close();
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
    };
  }, []);

  // Don't show anything if no remote is configured (in-repo mode)
  if (isOffline && status.state === 'idle') {
    return null;
  }

  const getIcon = () => {
    if (isOffline) return <CloudOff className="h-3.5 w-3.5" />;

    switch (status.state) {
      case 'syncing':
        return <RefreshCw className="h-3.5 w-3.5 animate-spin" />;
      case 'synced':
        return <Cloud className="h-3.5 w-3.5" />;
      case 'conflict':
        return <AlertCircle className="h-3.5 w-3.5" />;
      case 'error':
        switch (status.errorType) {
          case 'network':
            return <WifiOff className="h-3.5 w-3.5" />;
          case 'auth':
            return <Lock className="h-3.5 w-3.5" />;
          default:
            return <AlertCircle className="h-3.5 w-3.5" />;
        }
      default:
        return <Cloud className="h-3.5 w-3.5" />;
    }
  };

  const formatTimeAgo = (timestamp: string): string => {
    const lastSync = new Date(timestamp);
    const diffMs = currentTime - lastSync.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);

    if (diffHours > 0) {
      return `${diffHours}h ago`;
    } else if (diffMins > 0) {
      return `${diffMins}m ago`;
    } else {
      return 'now';
    }
  };

  const getLabel = () => {
    if (isOffline) return 'Offline';

    switch (status.state) {
      case 'syncing':
        return 'Syncing...';
      case 'synced':
        return `Synced ${formatTimeAgo(status.lastSyncTime)}`;
      case 'conflict':
        return status.conflicts.length === 1 ? '1 Conflict' : `${status.conflicts.length} Conflicts`;
      case 'error':
        switch (status.errorType) {
          case 'network':
            return 'Network Error';
          case 'auth':
            return 'Auth Failed';
          default:
            return 'Sync Error';
        }
      default:
        return 'Idle';
    }
  };

  const getTooltip = () => {
    if (isOffline) return 'No remote configured (working offline)';

    switch (status.state) {
      case 'syncing':
        return 'Syncing changes to remote...';
      case 'synced':
        return `Last synced ${formatTimeAgo(status.lastSyncTime)}`;
      case 'conflict':
        return `Merge conflict: ${status.conflicts.length} ticket${status.conflicts.length === 1 ? '' : 's'} need manual resolution`;
      case 'error':
        return `Sync failed: ${status.error}`;
      default:
        return 'Sync status unknown';
    }
  };

  const getColorClasses = () => {
    if (isOffline) {
      return 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300';
    }

    switch (status.state) {
      case 'syncing':
        return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300';
      case 'synced':
        return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300';
      case 'conflict':
        return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
      case 'error':
        return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300';
      default:
        return 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400';
    }
  };

  const isInteractive = true;

  const getAriaLabel = () => {
    if (isOffline) return 'Sync status: Offline. No remote configured.';

    switch (status.state) {
      case 'syncing':
        return 'Sync status: Syncing changes to remote';
      case 'synced':
        return `Sync status: Synced ${formatTimeAgo(status.lastSyncTime)}`;
      case 'conflict':
        return `Sync status: ${status.conflicts.length} conflict${status.conflicts.length === 1 ? '' : 's'} detected. ${status.conflicts.map(c => c.ticketId).join(', ')} need${status.conflicts.length === 1 ? 's' : ''} manual resolution. Click to resolve.`;
      case 'error':
        return `Sync status: ${status.errorType} error - ${status.error}. Click for details.`;
      default:
        return 'Sync status: Idle';
    }
  };

  const handleClick = () => {
    if (status.state === 'conflict') {
      setShowConflictModal(true);
    } else if (status.state === 'error') {
      setShowErrorToast(true);
    } else if (status.state !== 'syncing') {
      void api.triggerSync();
    }
  };

  const copyErrorToClipboard = () => {
    if (status.state === 'error') {
      const errorDetails = `Sync Error (${status.errorType}):\n${status.error}`;
      navigator.clipboard.writeText(errorDetails).catch(err => {
        console.error('Failed to copy error to clipboard:', err);
      });
    }
  };

  const handleResolve = async (resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>) => {
    // Call api.resolveConflicts directly instead of duplicating
    await api.resolveConflicts(resolutions);
    setShowConflictModal(false);
  };

  return (
    <>
      <button
        type="button"
        className={`group flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 transition-all duration-200 overflow-hidden ${getColorClasses()} ${status.state !== 'syncing' ? 'cursor-pointer hover:scale-105 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/50' : 'cursor-default'}`}
        title={status.state === 'syncing' ? getTooltip() : `${getTooltip()} — click to sync now`}
        aria-label={getAriaLabel()}
        onClick={handleClick}
        disabled={status.state === 'syncing'}
        tabIndex={0}
        onKeyDown={(e) => {
          if (status.state !== 'syncing' && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        <div className="relative shrink-0">
          {getIcon()}
          {status.state === 'synced' && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
        </div>
        <span className="text-sm font-semibold leading-none">{getLabel()}</span>
      </button>

      {status.state === 'conflict' && showConflictModal && createPortal(
        <ConflictResolutionModal
          conflicts={status.conflicts}
          onResolve={handleResolve}
          onClose={() => setShowConflictModal(false)}
        />,
        document.body
      )}

      {status.state === 'error' && showErrorToast && createPortal(
        <div
          className="fixed z-[9999] bg-black/50 backdrop-blur-sm"
          style={{
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
            overflow: 'auto'
          }}
          onClick={() => setShowErrorToast(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 border border-red-200 dark:border-red-800 rounded-lg shadow-xl p-6 space-y-4 w-full"
            style={{ maxWidth: '32rem', margin: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1">
                <AlertCircle className="h-6 w-6 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                    Sync Error ({status.errorType})
                  </h3>
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 break-words">
                    {status.error}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowErrorToast(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0 transition-colors"
                aria-label="Close error notification"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={copyErrorToClipboard}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors"
              >
                <Copy className="h-4 w-4" />
                Copy to clipboard
              </button>
              <button
                onClick={() => setShowErrorToast(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors ml-auto"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

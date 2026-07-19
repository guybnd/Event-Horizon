import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Cloud, CloudOff, RefreshCw, AlertCircle, AlertTriangle, WifiOff, Lock, Copy, Check, X, ArrowUpCircle } from 'lucide-react';
import { ConflictResolutionModal } from './ConflictResolutionModal';
import * as api from '../api';
import { ehFetch, ehEventSourceUrl } from '../api';
import type { ConflictInfo, ResolutionStrategy, SyncRemediation } from '../api';

export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'synced'; lastSyncTime: string }
  | { state: 'conflict'; conflicts: ConflictInfo[] }
  // FLUX-1232: local and remote flux-data have both moved since their common ancestor.
  | { state: 'diverged'; ahead: number; behind: number }
  // FLUX-895: `remediation` (auth case) carries the exact fix commands so this
  // indicator can render an actionable "sign-in needed" panel.
  | { state: 'error'; error: string; errorType: 'network' | 'auth' | 'conflict' | 'unknown'; remediation?: SyncRemediation }
  // FLUX-1426: this store's `sync-protocol` marker is ahead of what this engine build
  // supports — sync is read-only until the engine is upgraded.
  | { state: 'protocol-mismatch'; required: number; supported: number };

// Fallback fix steps if the engine didn't attach a remediation payload (older engine).
const FALLBACK_AUTH_REMEDIATION: SyncRemediation = {
  reason:
    "git push/fetch can't authenticate to GitHub. Being logged into gh alone isn't enough until git is pointed at it.",
  commands: ['gh auth login', 'gh auth setup-git'],
};

// How long a transient error must persist before we surface it as a hard
// "Sync Error". Sync often errors then self-heals on the next cycle; holding the
// error for this window stops the indicator from flapping red on every blip.
const ERROR_CONFIRM_DELAY_MS = 12000;

// FLUX-995: liveness watchdog, mirroring AppContext.tsx's /api/events fix (FLUX-910). The
// engine now sends a named `ping` every ~15s (SYNC_STATUS_KEEPALIVE_MS in sync-status.ts);
// if we see no traffic for well over that, the stream is a stalled half-open socket (NAT
// idle-reaper, laptop sleep) that EventSource will NOT auto-reconnect from on its own — it
// never observed a close, so `onerror` never fires and readyState stays OPEN forever.
const SYNC_STATUS_STALE_MS = 40_000; // ~2.6x the 15s server heartbeat, same ratio as AppContext.tsx

export function SyncStatusIndicator() {
  const [status, setStatus] = useState<SyncStatus>({ state: 'idle' });
  const [isOffline, setIsOffline] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [showErrorToast, setShowErrorToast] = useState(false);
  // FLUX-1426: the protocol-mismatch details panel (read-only fence — no fix from the portal).
  const [showProtocolMismatchPanel, setShowProtocolMismatchPanel] = useState(false);
  // FLUX-1232: the diverged-state panel and its confirm-gated reset-to-remote action.
  const [showDivergedPanel, setShowDivergedPanel] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetInFlight, setResetInFlight] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // FLUX-895: which remediation command was just copied (for transient ✓ feedback).
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());
  // True only once an error has persisted past ERROR_CONFIRM_DELAY_MS. While an
  // error is fresh (and might self-heal), this stays false and we show a calm
  // "Retrying…" state instead of the alarming red error.
  const [errorConfirmed, setErrorConfirmed] = useState(false);
  const intervalRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    // FLUX-995: liveness clock for the stale-stream watchdog below.
    let lastEventAt = Date.now();

    async function connect() {
      try {
        // First fetch to check if sync is configured (orphan mode)
        const res = await ehFetch('/sync-status');
        if (!res.ok) {
          // No sync configured (in-repo mode)
          setIsOffline(true);
          return;
        }

        const initialStatus = await res.json();
        setStatus(initialStatus);
        setIsOffline(false);

        // Connect to SSE stream for real-time updates
        es = new EventSource(ehEventSourceUrl('/sync-status/stream'));

        es.onopen = () => { lastEventAt = Date.now(); };

        // FLUX-995: named `ping` heartbeat from the engine — bumps liveness without
        // touching sync status (a bare comment line wouldn't fire any handler at all).
        es.addEventListener('ping', () => { lastEventAt = Date.now(); });

        es.onmessage = (event) => {
          lastEventAt = Date.now();
          try {
            const data = JSON.parse(event.data);
            setStatus(data);
            setIsOffline(false);
            // Sync recovered (any non-error status) — drop the confirmed-error
            // latch so the next hiccup starts fresh in the calm "Retrying…" state.
            if (data?.state !== 'error') setErrorConfirmed(false);
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
      } catch {
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

    // FLUX-995: a stalled half-open socket never fires `onerror` (EventSource never
    // observed a close, so readyState stays OPEN forever) — mirrors the watchdog already
    // shipped for /api/events in AppContext.tsx. A CONNECTING socket is left alone so we
    // don't fight EventSource's own in-flight reconnect.
    const watchdog = window.setInterval(() => {
      if (disposed) return;
      const rs = es?.readyState;
      if (Date.now() - lastEventAt > SYNC_STATUS_STALE_MS && rs !== EventSource.CONNECTING) {
        lastEventAt = Date.now();
        try { es?.close(); } catch { /* ignore */ }
        es = null;
        void connect();
      }
    }, 10_000);

    return () => {
      disposed = true;
      if (es) {
        es.close();
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      clearInterval(watchdog);
    };
  }, []);

  // Debounce error → confirmed-error. When sync enters the error state, wait
  // ERROR_CONFIRM_DELAY_MS before treating it as a real error; if a non-error
  // status arrives first, the blip never surfaces. Clearing on dependency change
  // cancels the pending timer the moment sync recovers.
  useEffect(() => {
    // Only arm the confirm timer while in the error state. Recovery resets the
    // latch in the SSE handler, so here we just manage the pending timer.
    if (status.state === 'error') {
      if (errorTimerRef.current === null && !errorConfirmed) {
        errorTimerRef.current = window.setTimeout(() => {
          errorTimerRef.current = null;
          setErrorConfirmed(true);
        }, ERROR_CONFIRM_DELAY_MS);
      }
    } else if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    return () => {
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
    };
  }, [status.state, errorConfirmed]);

  // A fresh error that hasn't persisted long enough to confirm — render it as a
  // calm "Retrying…" state rather than a hard error.
  const isSoftRetry = status.state === 'error' && !errorConfirmed;

  // Don't show anything if no remote is configured (in-repo mode)
  if (isOffline && status.state === 'idle') {
    return null;
  }

  const getIcon = () => {
    if (isOffline) return <CloudOff className="h-3.5 w-3.5" />;
    if (isSoftRetry) return <RefreshCw className="h-3.5 w-3.5 animate-spin" />;

    switch (status.state) {
      case 'syncing':
        return <RefreshCw className="h-3.5 w-3.5 animate-spin" />;
      case 'synced':
        return <Cloud className="h-3.5 w-3.5" />;
      case 'conflict':
        return <AlertCircle className="h-3.5 w-3.5" />;
      case 'diverged':
        return <AlertTriangle className="h-3.5 w-3.5" />;
      case 'error':
        switch (status.errorType) {
          case 'network':
            return <WifiOff className="h-3.5 w-3.5" />;
          case 'auth':
            return <Lock className="h-3.5 w-3.5" />;
          default:
            return <AlertCircle className="h-3.5 w-3.5" />;
        }
      case 'protocol-mismatch':
        return <ArrowUpCircle className="h-3.5 w-3.5" />;
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
    if (isSoftRetry) return 'Retrying…';

    switch (status.state) {
      case 'syncing':
        return 'Syncing...';
      case 'synced':
        return `Synced ${formatTimeAgo(status.lastSyncTime)}`;
      case 'conflict':
        return status.conflicts.length === 1 ? '1 Conflict' : `${status.conflicts.length} Conflicts`;
      case 'diverged':
        return 'Diverged';
      case 'error':
        switch (status.errorType) {
          case 'network':
            return 'Network Error';
          case 'auth':
            return 'Sign-in needed';
          default:
            return 'Sync Error';
        }
      case 'protocol-mismatch':
        return 'Upgrade needed';
      default:
        return 'Idle';
    }
  };

  const getTooltip = () => {
    if (isOffline) return 'No remote configured (working offline)';
    if (isSoftRetry) return 'Sync hiccup — retrying automatically. Click for details.';

    switch (status.state) {
      case 'syncing':
        return 'Syncing changes to remote...';
      case 'synced':
        return `Last synced ${formatTimeAgo(status.lastSyncTime)}`;
      case 'conflict':
        return `Merge conflict: ${status.conflicts.length} ticket${status.conflicts.length === 1 ? '' : 's'} need manual resolution`;
      case 'diverged':
        return `Local board diverged from remote (${status.ahead} ahead, ${status.behind} behind). Click for options.`;
      case 'error':
        return status.errorType === 'auth'
          ? 'GitHub sign-in needed — sync is paused. Click for the fix.'
          : `Sync failed: ${status.error}`;
      case 'protocol-mismatch':
        return `This store requires a newer engine (sync protocol ${status.required}, this engine supports ${status.supported}). Sync is read-only until the engine is upgraded. Click for details.`;
      default:
        return 'Sync status unknown';
    }
  };

  const getColorClasses = () => {
    if (isOffline) {
      return 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300';
    }
    if (isSoftRetry) {
      // Calm, non-alarming while we wait to see if it self-heals.
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
    }

    switch (status.state) {
      case 'syncing':
        return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300';
      case 'synced':
        return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300';
      case 'conflict':
        return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
      case 'diverged':
        return 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-300';
      case 'error':
        return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300';
      case 'protocol-mismatch':
        return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300';
      default:
        return 'border-gray-200 bg-white/60 text-gray-500 dark:border-white/10 dark:bg-white/5 dark:text-gray-400';
    }
  };

  const getAriaLabel = () => {
    if (isOffline) return 'Sync status: Offline. No remote configured.';
    if (isSoftRetry) return 'Sync status: transient hiccup, retrying automatically. Click for details.';

    switch (status.state) {
      case 'syncing':
        return 'Sync status: Syncing changes to remote';
      case 'synced':
        return `Sync status: Synced ${formatTimeAgo(status.lastSyncTime)}`;
      case 'conflict':
        return `Sync status: ${status.conflicts.length} conflict${status.conflicts.length === 1 ? '' : 's'} detected. ${status.conflicts.map(c => c.ticketId).join(', ')} need${status.conflicts.length === 1 ? 's' : ''} manual resolution. Click to resolve.`;
      case 'diverged':
        return `Sync status: local board diverged from remote, ${status.ahead} ahead and ${status.behind} behind. Click for options.`;
      case 'error':
        return status.errorType === 'auth'
          ? 'Sync status: GitHub sign-in needed — sync is paused. Click for the fix steps.'
          : `Sync status: ${status.errorType} error - ${status.error}. Click for details.`;
      case 'protocol-mismatch':
        return `Sync status: this store requires sync protocol ${status.required}, this engine supports ${status.supported}. Sync is read-only until the engine is upgraded. Click for details.`;
      default:
        return 'Sync status: Idle';
    }
  };

  const handleClick = () => {
    if (status.state === 'conflict') {
      setShowConflictModal(true);
    } else if (status.state === 'diverged') {
      setResetError(null);
      setConfirmingReset(false);
      setShowDivergedPanel(true);
    } else if (status.state === 'error') {
      setShowErrorToast(true);
    } else if (status.state === 'protocol-mismatch') {
      setShowProtocolMismatchPanel(true);
    } else if (status.state !== 'syncing') {
      void api.triggerSync();
    }
  };

  // FLUX-1232: the confirm-gated "Reset board to remote" action — destructive, so it only ever
  // runs after the user has seen the consequence spelled out and clicked a second, explicit
  // confirm button (never a one-click accident).
  const handleResetToRemote = async () => {
    setResetInFlight(true);
    setResetError(null);
    try {
      await api.resetToRemote();
      setShowDivergedPanel(false);
      setConfirmingReset(false);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetInFlight(false);
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

  // FLUX-895: copy one remediation command with transient ✓ feedback.
  const copyCommand = (cmd: string) => {
    navigator.clipboard.writeText(cmd)
      .then(() => {
        setCopiedCmd(cmd);
        window.setTimeout(() => setCopiedCmd((c) => (c === cmd ? null : c)), 1500);
      })
      .catch((err) => console.error('Failed to copy command:', err));
  };

  // FLUX-895: kick an immediate sync (re-detects gh auth) from the re-auth panel.
  const retrySync = () => {
    void api.triggerSync();
    setShowErrorToast(false);
  };

  // FLUX-895: actionable re-auth panel — distinct from the generic error toast.
  // Shows the engine's remediation (why + exact copy-paste commands) plus Retry.
  const renderAuthPanel = () => {
    if (status.state !== 'error') return null;
    const remediation = status.remediation ?? FALLBACK_AUTH_REMEDIATION;
    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto"
        onClick={() => setShowErrorToast(false)}
      >
        <div
          className="bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-500/40 rounded-lg shadow-xl p-6 space-y-4 w-full"
          style={{ maxWidth: '32rem', margin: 'auto' }}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="GitHub sign-in needed"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <Lock className="h-6 w-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">GitHub sign-in needed</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">Sync is paused until you re-authenticate.</p>
              </div>
            </div>
            <button
              onClick={() => setShowErrorToast(false)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0 transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <p className="text-sm text-gray-700 dark:text-gray-300 break-words">{remediation.reason}</p>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Run these, then retry:</p>
            {remediation.commands.map((cmd) => (
              <div
                key={cmd}
                className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-100 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/60"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-sm text-gray-800 dark:text-gray-200">{cmd}</code>
                <button
                  onClick={() => copyCommand(cmd)}
                  className="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
                  aria-label={`Copy command: ${cmd}`}
                >
                  {copiedCmd === cmd
                    ? (<><Check className="h-3.5 w-3.5 text-emerald-500" />Copied</>)
                    : (<><Copy className="h-3.5 w-3.5" />Copy</>)}
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={retrySync}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90"
            >
              <RefreshCw className="h-4 w-4" />
              Retry sync
            </button>
            <button
              onClick={() => setShowErrorToast(false)}
              className="ml-auto flex items-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  };

  const handleResolve = async (resolutions: Array<{ ticketId: string; strategy: ResolutionStrategy; newContent?: string }>) => {
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

      {status.state === 'diverged' && showDivergedPanel && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto"
          onClick={() => !resetInFlight && setShowDivergedPanel(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 border border-orange-300 dark:border-orange-500/40 rounded-lg shadow-xl p-6 space-y-4 w-full"
            style={{ maxWidth: '32rem', margin: 'auto' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Local board diverged from remote"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <AlertTriangle className="h-6 w-6 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Board diverged from remote</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    Local is {status.ahead} commit{status.ahead === 1 ? '' : 's'} ahead and {status.behind} commit{status.behind === 1 ? '' : 's'} behind origin/flux-data.
                  </p>
                </div>
              </div>
              {!resetInFlight && (
                <button
                  onClick={() => setShowDivergedPanel(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0 transition-colors"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>

            <p className="text-sm text-gray-700 dark:text-gray-300">
              Sync will keep trying to merge automatically. If it's wedged (e.g. after switching dev
              machines), you can force the local board to match the remote instead — a backup of the
              current local state is tagged first, so this is recoverable.
            </p>

            {resetError && (
              <p className="text-sm text-red-600 dark:text-red-400 break-words">{resetError}</p>
            )}

            {!confirmingReset ? (
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={() => void api.triggerSync()}
                  className="flex items-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                >
                  <RefreshCw className="h-4 w-4" />
                  Try syncing again
                </button>
                <button
                  onClick={() => setConfirmingReset(true)}
                  className="ml-auto rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-700"
                >
                  Reset board to remote…
                </button>
              </div>
            ) : (
              <div className="space-y-3 rounded-md border border-orange-300 bg-orange-50 p-3 dark:border-orange-500/30 dark:bg-orange-500/10">
                <p className="text-sm font-medium text-orange-800 dark:text-orange-200">
                  This discards {status.ahead} un-pushed local board commit{status.ahead === 1 ? '' : 's'} and
                  replaces the board with the remote's version. A backup ref is kept, but this cannot be
                  undone from the portal.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void handleResetToRemote()}
                    disabled={resetInFlight}
                    className="flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                  >
                    {resetInFlight ? (<><RefreshCw className="h-4 w-4 animate-spin" />Resetting…</>) : 'Yes, discard local & reset to remote'}
                  </button>
                  <button
                    onClick={() => setConfirmingReset(false)}
                    disabled={resetInFlight}
                    className="rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {status.state === 'error' && status.errorType === 'auth' && showErrorToast && createPortal(
        renderAuthPanel(),
        document.body
      )}

      {status.state === 'protocol-mismatch' && showProtocolMismatchPanel && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto"
          onClick={() => setShowProtocolMismatchPanel(false)}
        >
          <div
            className="bg-white dark:bg-gray-800 border border-red-300 dark:border-red-500/40 rounded-lg shadow-xl p-6 space-y-4 w-full"
            style={{ maxWidth: '32rem', margin: 'auto' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Engine upgrade needed"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <ArrowUpCircle className="h-6 w-6 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Engine upgrade needed</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
                    This board requires sync protocol {status.required}; this engine only supports {status.supported}.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowProtocolMismatchPanel(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 shrink-0 transition-colors"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm text-gray-700 dark:text-gray-300">
              Sync is paused read-only — this engine will not commit, merge, or push into the board's
              shared store until it is upgraded to a version that supports protocol {status.required}.
              The board stays usable locally in the meantime. This clears automatically once the engine
              is upgraded.
            </p>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setShowProtocolMismatchPanel(false)}
                className="ml-auto flex items-center gap-2 rounded-md bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {status.state === 'error' && status.errorType !== 'auth' && showErrorToast && createPortal(
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

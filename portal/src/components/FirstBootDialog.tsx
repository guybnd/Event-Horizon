import { useState, useEffect } from 'react';
import { HardDrive, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { fetchBootStatus, confirmBoot, type BootStatus } from '../api';

interface FirstBootDialogProps {
  onComplete: () => void;
}

export function FirstBootDialog({ onComplete }: FirstBootDialogProps) {
  const [status, setStatus] = useState<BootStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchBootStatus()
      .then((s) => {
        setStatus(s);
        if (!s.firstBoot) {
          onComplete();
        }
      })
      .catch(() => {
        onComplete();
      })
      .finally(() => setLoading(false));
  }, [onComplete]);

  const handleConfirm = async (migrate: boolean) => {
    setConfirming(true);
    setError(null);
    try {
      await confirmBoot(migrate);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize settings.');
    } finally {
      setConfirming(false);
    }
  };

  if (loading || !status || !status.firstBoot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-bg-dark p-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-bg-dark p-8">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center rounded-2xl bg-primary/10 p-4">
            <HardDrive className="h-8 w-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            Setting up Event Horizon
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-sm">
            Your settings will be stored at:
          </p>
          <code className="rounded-lg bg-gray-100 dark:bg-white/10 px-3 py-2 text-xs font-mono text-gray-700 dark:text-gray-300 break-all">
            {status.dataDir}
          </code>
        </div>

        {status.legacyFound && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                  Existing data found
                </p>
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Settings from <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/30">~/.event-horizon</code> will be migrated to the new location. The old directory won't be deleted.
                </p>
              </div>
            </div>
          </div>
        )}

        {status.legacyFound && !error && (
          <div className="mb-3 flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-500/20 p-3">
            <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
            <span className="text-xs text-green-700 dark:text-green-400">Your workspaces and preferences will be preserved.</span>
          </div>
        )}

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={() => handleConfirm(status.legacyFound)}
          disabled={confirming}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-6 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {confirming ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {status.legacyFound ? 'Migrating…' : 'Initializing…'}
            </>
          ) : (
            status.legacyFound ? 'Migrate & Continue' : 'Continue'
          )}
        </button>

        {status.legacyFound && (
          <button
            onClick={() => handleConfirm(false)}
            disabled={confirming}
            className="mt-3 flex h-9 w-full items-center justify-center rounded-2xl border border-gray-200 bg-white px-6 text-xs font-medium text-gray-600 transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-400 dark:hover:bg-white/10"
          >
            Start fresh (don't migrate)
          </button>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Play } from 'lucide-react';
import type { Task } from '../../types';
import { createBranch, fetchHealth } from '../../api';

interface StartTaskPromptProps {
  task: Task;
  onConfirm: (branch: string | null) => void;
  onCancel: () => void;
}

function suggestedBranchName(task: Task): string {
  const slug = (task.title || task.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `flux/${task.id}-${slug}`;
}

export function StartTaskPrompt({ task, onConfirm, onCancel }: StartTaskPromptProps) {
  const isXs = task.effort === 'XS';
  const [useBranch, setUseBranch] = useState(!isXs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    fetchHealth().then((h) => setGhAvailable(h.ghAuthAvailable)).catch(() => setGhAvailable(null));
  }, []);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      if (useBranch) {
        const { branch } = await createBranch(task.id);
        onConfirm(branch);
      } else {
        onConfirm(null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to create branch');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Start working on {task.id}</p>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400 truncate">{task.title}</p>

        <div className="space-y-2">
          <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${useBranch ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-white/10'}`}>
            <input type="radio" className="mt-0.5 accent-primary" checked={useBranch} onChange={() => setUseBranch(true)} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" />
                Create a new branch
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{suggestedBranchName(task)}</p>
            </div>
          </label>

          <label className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${!useBranch ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-white/10'}`}>
            <input type="radio" className="accent-primary" checked={!useBranch} onChange={() => setUseBranch(false)} />
            <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Continue on current branch</span>
          </label>
        </div>

        {isXs && (
          <p className="mt-2 text-[10px] text-gray-400">XS ticket — branch skipped by default.</p>
        )}

        {useBranch && ghAvailable === false && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-semibold">gh not configured.</span> Branch will be created, but{' '}
              <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">finish</code> will commit locally
              instead of opening a PR. Run <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">gh auth login</code> to enable PR creation.
            </span>
          </div>
        )}

        {error && (
          <p className="mt-3 text-xs text-red-500">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleStart()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}

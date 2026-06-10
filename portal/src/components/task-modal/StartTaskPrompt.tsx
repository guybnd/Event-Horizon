import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import type { Task } from '../../types';
import { createBranch, fetchHealth } from '../../api';
import { BranchSection } from './BranchSection';

interface StartTaskPromptProps {
  task: Task;
  onConfirm: (branch: string | null) => void;
  onCancel: () => void;
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

        <BranchSection
          taskId={task.id}
          taskTitle={task.title || task.id}
          effort={task.effort}
          useBranch={useBranch}
          setUseBranch={setUseBranch}
          ghAvailable={ghAvailable}
        />

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

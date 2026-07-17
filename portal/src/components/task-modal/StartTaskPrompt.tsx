import { useEffect, useState } from 'react';
import { Play, FolderGit2, Check } from 'lucide-react';
import type { Task } from '../../types';
import {
  fetchHealth, fetchConfig, openWorktreeWindow,
  fetchWorktrees, joinWorktree, type WorktreeInfo,
} from '../../api';
import { BranchSection, type StartMode } from './BranchSection';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { StartSelection } from '../../agentActions';

interface StartTaskPromptProps {
  task: Task;
  onConfirm: (selection: StartSelection) => void;
  onCancel: () => void;
}

export function StartTaskPrompt({ task, onConfirm, onCancel }: StartTaskPromptProps) {
  // FLUX-1022: this prompt is only ever mounted while shown, so the hook is unconditionally
  // registered for its lifetime — ESC cancels, same as clicking the backdrop or "Cancel"/"Done".
  useEscapeKey(onCancel);

  const isXs = task.effort === 'XS';
  const [mode, setMode] = useState<StartMode>(isXs ? 'current' : 'branch');
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [joinBranch, setJoinBranch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [windowMsg, setWindowMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth().then((h) => setGhAvailable(h.ghAuthAvailable)).catch(() => setGhAvailable(null));
    // Default to a dedicated worktree when the workspace setting opts in (FLUX-521).
    fetchConfig().then((c) => { if (c.worktreeByDefault && !isXs) setMode('worktree'); }).catch(() => {});
    fetchWorktrees().then(setWorktrees).catch(() => {});
  }, [isXs]);

  // Pick up this ticket — either in the portal (Start) or a new window (New window).
  // Start closes immediately (FLUX-1464): branch/worktree creation is slow (several seconds for a
  // worktree), so it happens after the picker is gone, not in front of it — the parent shows its
  // own busy/error state while resolving the selection and launching. New window stays open and
  // resolves the branch itself since it has its own confirmation state to show.
  const handleStart = () => {
    if (mode === 'join' && !joinBranch) {
      setError('Pick a worktree to join.');
      return;
    }
    onConfirm({ mode, joinBranch: mode === 'join' ? joinBranch : null });
  };

  const handleOpenWindow = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'join') {
        if (!joinBranch) throw new Error('Pick a worktree to join.');
        await joinWorktree(task.id, joinBranch);
      }
      const r = await openWorktreeWindow(task.id);
      try { await navigator.clipboard.writeText(r.seedPrompt); } catch { /* clipboard may be blocked */ }
      setWindowMsg(
        r.opened
          ? `Opened ${task.id} in a new window. The prompt is on your clipboard — paste it there to start the agent.`
          : `Worktree ready at ${r.worktree}, but the 'code' CLI wasn't found — open that folder manually. The prompt is on your clipboard.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open worktree window');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">Start working on {task.id}</p>
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400 truncate">{task.title}</p>

        {windowMsg ? (
          // Terminal confirmation state — New window succeeded; nothing left to press.
          <>
            <div className="flex items-start gap-2 rounded-md bg-emerald-50 p-3 text-[11px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              <Check className="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{windowMsg}</span>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={onCancel}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <BranchSection
              taskId={task.id}
              taskTitle={task.title || task.id}
              effort={task.effort}
              ghAvailable={ghAvailable}
              mode={mode}
              setMode={setMode}
              worktrees={worktrees}
              joinBranch={joinBranch}
              setJoinBranch={setJoinBranch}
            />

            {error && <p className="mt-3 text-xs text-red-500">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={onCancel}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Cancel
              </button>
              {mode !== 'current' && (
                <button
                  onClick={() => void handleOpenWindow()}
                  disabled={busy}
                  title="Create/join the worktree and open it in a new VS Code window"
                  className="flex items-center gap-1.5 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                >
                  <FolderGit2 className="h-3 w-3" />
                  New window
                </button>
              )}
              <button
                onClick={handleStart}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover disabled:opacity-50"
              >
                <Play className="h-3 w-3" />
                Start
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

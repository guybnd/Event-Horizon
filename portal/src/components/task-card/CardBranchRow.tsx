import { Undo2, GitBranch, FolderGit2, Copy, Check, X, Loader2 } from 'lucide-react';
import type { Task } from '../../types';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardBranchRow({ task, c }: { task: Task; c: TaskCardController }) {
  const {
    hasWorktree,
    detachMsg,
    worktreeChangedFiles,
    setChangesFocus,
    setView,
    branchCopied,
    setBranchCopied,
    detachState,
    setDetachState,
    handleCardDetach,
  } = c;

  return (
    <div
      className={`mb-2 flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 py-1 text-[10px] font-mono ${hasWorktree ? 'border-primary/30 bg-primary/5 text-primary' : 'border-gray-100 bg-gray-50 text-gray-500 dark:border-white/5 dark:bg-black/20 dark:text-gray-400'}`}
      title={hasWorktree ? 'Running in a dedicated worktree' : undefined}
    >
      {detachMsg ? (
        <span className="min-w-0 flex-1 truncate text-primary/80">{detachMsg}</span>
      ) : (
        <>
          {hasWorktree
            ? <FolderGit2 className="h-2.5 w-2.5 shrink-0" />
            : <GitBranch className="h-2.5 w-2.5 shrink-0 text-gray-400" />}
          <span className="min-w-0 flex-1 truncate">{task.branch}</span>
          {hasWorktree && worktreeChangedFiles > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setChangesFocus(task.branch!);
                setView('changes');
              }}
              title={`${worktreeChangedFiles} file${worktreeChangedFiles === 1 ? '' : 's'} changed vs master — view diffs`}
              className="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[9px] font-semibold tabular-nums transition-colors hover:bg-primary/25"
            >
              {worktreeChangedFiles}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              void navigator.clipboard.writeText(task.branch!).then(() => {
                setBranchCopied(true);
                setTimeout(() => setBranchCopied(false), 1500);
              });
            }}
            title="Copy branch name"
            className="shrink-0 rounded p-0.5 transition-colors hover:text-gray-700 dark:hover:text-gray-200"
          >
            {branchCopied ? <Check className="h-2.5 w-2.5 text-emerald-500" /> : <Copy className="h-2.5 w-2.5 opacity-50" />}
          </button>
          {hasWorktree && detachState === 'busy' && (
            <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
          )}
          {hasWorktree && detachState === 'idle' && (
            <button
              onClick={(e) => { e.stopPropagation(); setDetachState('confirm'); }}
              title="Close worktree — return any uncommitted work to the main tree (keeps the branch)"
              className="shrink-0 rounded p-0.5 transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <Undo2 className="h-2.5 w-2.5 opacity-60" />
            </button>
          )}
          {hasWorktree && detachState === 'confirm' && (
            <span className="flex shrink-0 items-center gap-0.5">
              <span className="text-[9px] opacity-70">Close?</span>
              <button
                onClick={(e) => { e.stopPropagation(); void handleCardDetach(); }}
                title="Confirm: close worktree, return work to main"
                className="rounded p-0.5 text-emerald-500 transition-colors hover:bg-emerald-500/10"
              >
                <Check className="h-2.5 w-2.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDetachState('idle'); }}
                title="Cancel"
                className="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-500/10"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}

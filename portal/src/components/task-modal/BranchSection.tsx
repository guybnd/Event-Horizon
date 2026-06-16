import type { ReactNode } from 'react';
import { AlertTriangle, GitBranch, FolderGit2, FolderInput } from 'lucide-react';
import type { WorktreeInfo } from '../../api';

export type StartMode = 'worktree' | 'branch' | 'current' | 'join';

interface BranchSectionProps {
  taskId: string;
  taskTitle: string;
  effort?: string;
  ghAvailable: boolean | null;
  mode: StartMode;
  setMode: (m: StartMode) => void;
  worktrees: WorktreeInfo[];
  joinBranch: string | null;
  setJoinBranch: (b: string | null) => void;
}

function suggestedBranchName(id: string, title: string): string {
  const slug = (title || id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `flux/${id}-${slug}`;
}

function OptionCard({ active, onSelect, children }: { active: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${active ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-white/10'}`}>
      <input type="radio" className="mt-0.5 accent-primary" checked={active} onChange={onSelect} />
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

export function BranchSection({
  taskId, taskTitle, effort, ghAvailable,
  mode, setMode, worktrees, joinBranch, setJoinBranch,
}: BranchSectionProps) {
  const isXs = effort === 'XS';
  const usesNewBranch = mode === 'worktree' || mode === 'branch';
  const branchName = suggestedBranchName(taskId, taskTitle);

  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
        How to start
      </label>
      <div className="space-y-2">
        <OptionCard active={mode === 'worktree'} onSelect={() => setMode('worktree')}>
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary" /> New branch + dedicated worktree
          </div>
          <p className="mt-0.5 text-[10px] text-gray-400">Isolated checkout — master stays put, concurrent tasks never collide.</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{branchName}</p>
        </OptionCard>

        <OptionCard active={mode === 'branch'} onSelect={() => setMode('branch')}>
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" /> New branch
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{branchName}</p>
        </OptionCard>

        <OptionCard active={mode === 'current'} onSelect={() => setMode('current')}>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Continue on current branch</span>
        </OptionCard>

        {worktrees.length > 0 && (
          <>
            <OptionCard
              active={mode === 'join'}
              onSelect={() => { setMode('join'); if (!joinBranch) setJoinBranch(worktrees[0].branch); }}
            >
              <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
                <FolderInput className="h-3.5 w-3.5 shrink-0 text-primary" /> Join an existing worktree
              </div>
              <p className="mt-0.5 text-[10px] text-gray-400">Work this ticket on another ticket's branch, in its worktree.</p>
            </OptionCard>
            {mode === 'join' && (
              <select
                className="w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[11px] outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                value={joinBranch ?? ''}
                onChange={(e) => setJoinBranch(e.target.value)}
              >
                {worktrees.map((w) => (
                  <option key={w.branch} value={w.branch}>
                    {w.branch}{w.ticketId ? ` · ${w.ticketId}` : ''}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>

      {isXs && mode !== 'current' && (
        <p className="mt-2 text-[10px] text-gray-400">XS ticket — a branch is optional.</p>
      )}

      {usesNewBranch && ghAvailable === false && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">gh not configured.</span> The branch will be created, but{' '}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-500/20">finish</code> commits locally instead of opening a PR.
          </span>
        </div>
      )}
    </div>
  );
}

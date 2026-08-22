import type { ReactNode } from 'react';
import { AlertTriangle, GitBranch, FolderGit2, FolderInput, Copy, Check, RefreshCw } from 'lucide-react';
import type { WorktreeInfo, GhRecheckResult } from '../../api';
import { useCopied } from '../../hooks/useCopied';

export type StartMode = 'worktree' | 'branch' | 'current' | 'join';

interface BranchSectionProps {
  taskId: string;
  taskTitle: string;
  effort?: string;
  gh: GhRecheckResult | null;
  ghChecking: boolean;
  ghSettled: boolean;
  ghError: string | null;
  onRecheckGh: () => void;
  mode: StartMode;
  setMode: (m: StartMode) => void;
  worktrees: WorktreeInfo[];
  joinBranch: string | null;
  setJoinBranch: (b: string | null) => void;
}

/** Single best-guess install command per platform — mirrors OnboardingWizard.tsx's
 * GH_INSTALL_COMMANDS, kept separate since this panel has no room for the full chip set. */
function ghInstallCommand(platform: string, linuxPackageManager: GhRecheckResult['linuxPackageManager']): string | null {
  if (platform === 'darwin') return 'brew install gh';
  if (platform === 'win32') return 'winget install GitHub.cli';
  switch (linuxPackageManager) {
    case 'pacman': return 'sudo pacman -S github-cli';
    case 'apt': return 'sudo apt install gh';
    case 'dnf': return 'sudo dnf install gh';
    case 'zypper': return 'sudo zypper install gh';
    default: return null;
  }
}

function formatCheckedAgo(lastCheckedAt: number | null): string | null {
  if (lastCheckedAt === null) return null;
  const minutes = Math.floor((Date.now() - lastCheckedAt) / 60_000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Checked ${hours}h ago`;
}

function GhWarning({ gh, ghChecking, ghSettled, ghError, onRecheckGh }: {
  gh: GhRecheckResult | null;
  ghChecking: boolean;
  ghSettled: boolean;
  ghError: string | null;
  onRecheckGh: () => void;
}) {
  const { copied, copy } = useCopied();

  if (gh?.ok) return null;
  // Nothing probed yet, or a probe is in flight — don't render "unknown" before the first
  // probe for the current session has settled (resolved or rejected).
  if (gh === null && !ghSettled) return null;

  const unknown = gh === null;
  const remedyCommand = unknown
    ? null
    : gh.reason === 'not-authenticated'
      ? 'gh auth login'
      : ghInstallCommand(gh.platform, gh.linuxPackageManager);
  const message = unknown
    ? (ghError ? `Couldn't check gh status (${ghError}).` : "Couldn't determine gh status.")
    : gh.reason === 'not-authenticated'
      ? 'gh is not signed in.'
      : 'GitHub CLI not found on PATH.';
  const checkedAgo = unknown ? null : formatCheckedAgo(gh.lastCheckedAt);

  const colors = unknown
    ? 'border-gray-300/60 bg-gray-50 text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-400'
    : 'border-amber-300/40 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
  const codeColors = unknown ? 'bg-gray-200/60 dark:bg-white/10' : 'bg-amber-100 dark:bg-amber-500/20';

  return (
    <div className={`mt-3 rounded-md border p-2 text-[11px] ${colors}`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          <span className="font-semibold">{message}</span> The branch will be created, but{' '}
          <code className={`rounded px-1 ${codeColors}`}>finish</code> {unknown ? 'may commit' : 'commits'} locally instead of opening a PR.
        </span>
      </div>

      {remedyCommand && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-5">
          <code className="flex-1 truncate rounded bg-black/5 px-1.5 py-0.5 font-mono dark:bg-white/10">{remedyCommand}</code>
          <button
            type="button"
            onClick={() => void copy(remedyCommand)}
            title="Copy command"
            className="flex shrink-0 items-center rounded px-1.5 py-0.5 hover:bg-black/5 dark:hover:bg-white/10"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-between gap-2 pl-5">
        <span className="text-gray-400">{checkedAgo}</span>
        <button
          type="button"
          onClick={onRecheckGh}
          disabled={ghChecking}
          className="flex shrink-0 items-center gap-1 font-medium hover:underline disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${ghChecking ? 'animate-spin' : ''}`} />
          Re-check
        </button>
      </div>
    </div>
  );
}

function suggestedBranchName(id: string, title: string): string {
  const slug = (title || id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `flux/${id}-${slug}`;
}

function OptionCard({ active, onSelect, name, children }: { active: boolean; onSelect: () => void; name: string; children: ReactNode }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${active ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-white/10'}`}>
      <input type="radio" name={name} className="mt-0.5 accent-primary" checked={active} onChange={onSelect} />
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

export function BranchSection({
  taskId, taskTitle, effort, gh, ghChecking, ghSettled, ghError, onRecheckGh,
  mode, setMode, worktrees, joinBranch, setJoinBranch,
}: BranchSectionProps) {
  const isXs = effort === 'XS';
  const usesNewBranch = mode === 'worktree' || mode === 'branch';
  const branchName = suggestedBranchName(taskId, taskTitle);
  const radioGroupName = `branch-choice-${taskId}`;

  return (
    <div>
      <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
        How to start
      </legend>
      <div className="space-y-2">
        <OptionCard name={radioGroupName} active={mode === 'worktree'} onSelect={() => setMode('worktree')}>
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
            <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-primary" /> New branch + dedicated worktree
          </div>
          <p className="mt-0.5 text-[10px] text-gray-400">Isolated checkout — master stays put, concurrent tasks never collide.</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{branchName}</p>
        </OptionCard>

        <OptionCard name={radioGroupName} active={mode === 'branch'} onSelect={() => setMode('branch')}>
          <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" /> New branch
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{branchName}</p>
        </OptionCard>

        <OptionCard name={radioGroupName} active={mode === 'current'} onSelect={() => setMode('current')}>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-100">Continue on current branch</span>
        </OptionCard>

        {worktrees.length > 0 && (
          <>
            <OptionCard
              name={radioGroupName}
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
                  // Key on the worktree path (always present + unique) rather than the
                  // branch, which can be empty on a detached worktree and collide.
                  <option key={w.path} value={w.branch}>
                    {w.branch}{w.ticketId ? ` · ${w.ticketId}` : ''}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      </fieldset>

      {isXs && mode !== 'current' && (
        <p className="mt-2 text-[10px] text-gray-400">XS ticket — a branch is optional.</p>
      )}

      {usesNewBranch && (
        <GhWarning gh={gh} ghChecking={ghChecking} ghSettled={ghSettled} ghError={ghError} onRecheckGh={onRecheckGh} />
      )}
    </div>
  );
}

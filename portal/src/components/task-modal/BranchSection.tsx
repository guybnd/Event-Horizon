import { AlertTriangle, GitBranch } from 'lucide-react';

interface BranchSectionProps {
  taskId: string;
  taskTitle: string;
  effort?: string;
  useBranch: boolean;
  setUseBranch: (v: boolean) => void;
  ghAvailable: boolean | null;
}

function suggestedBranchName(id: string, title: string): string {
  const slug = (title || id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `flux/${id}-${slug}`;
}

export function BranchSection({ taskId, taskTitle, effort, useBranch, setUseBranch, ghAvailable }: BranchSectionProps) {
  const isXs = effort === 'XS';

  return (
    <div>
      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-gray-400">
        Branch
      </label>
      <div className="space-y-2">
        <label className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${useBranch ? 'border-primary bg-primary/5' : 'border-gray-200 dark:border-white/10'}`}>
          <input type="radio" className="mt-0.5 accent-primary" checked={useBranch} onChange={() => setUseBranch(true)} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary" />
              Create a new branch
            </div>
            <p className="mt-0.5 truncate font-mono text-[10px] text-gray-400">{suggestedBranchName(taskId, taskTitle)}</p>
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
    </div>
  );
}

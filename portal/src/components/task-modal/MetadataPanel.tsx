import { useState, useEffect } from 'react';
import { GitBranch, FolderGit2, Copy, Check, FolderX, Loader2 } from 'lucide-react';
import type { TagDef, Task } from '../../types';
import { TagSelector } from '../TagSelector';
import { fetchBranchStatus, detachWorktree, type BranchStatus } from '../../api';
import { DiffSummaryPanel } from './DiffSummaryPanel';
import { useAppActions } from '../../store/useAppSelector';
import { useConfirm } from '../../hooks/useConfirm';

const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];

interface MetadataPanelProps {
  status: string;
  setStatus: (v: string) => void;
  assignee: string;
  setAssignee: (v: string) => void;
  priority: string;
  setPriority: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  effortLevel: string;
  setEffortLevel: (v: string) => void;
  implementationLink: string;
  setImplementationLink: (v: string) => void;
  tags: string[];
  setTags: (tags: string[]) => void;
  allStatuses: string[];
  allUsers: string[];
  allTags: string[];
  configTags: TagDef[];
  availablePriorities: { name: string; icon?: string; color: string }[];
  task?: Partial<Task>;
  onDiffFileClick?: (file: string) => void;
  /** "popup" renders a compact horizontal bar; default renders the full sidebar panel */
  variant?: 'popup';
  isWideMode?: boolean;
}

export function MetadataPanel({
  status, setStatus,
  assignee, setAssignee,
  priority, setPriority,
  effort, setEffort,
  effortLevel, setEffortLevel,
  implementationLink, setImplementationLink,
  tags, setTags,
  allStatuses, allUsers, allTags, configTags, availablePriorities,
  task,
  onDiffFileClick,
  variant,
  isWideMode,
}: MetadataPanelProps) {
  const { triggerRefresh, refreshWorktrees } = useAppActions();
  const confirm = useConfirm();
  const [branchStatus, setBranchStatus] = useState<BranchStatus | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!task?.id || !task.branch) { setBranchStatus(null); return; }
    fetchBranchStatus(task.id).then(setBranchStatus).catch(() => {});
  }, [task?.id, task?.branch]);

  const copyBranch = (name: string) => {
    void navigator.clipboard.writeText(name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // FLUX-521: manual-finish escape hatch — remove the worktree, keep the branch.
  const [detaching, setDetaching] = useState(false);
  const [detachMsg, setDetachMsg] = useState<string | null>(null);
  const handleDetach = async () => {
    if (!task?.id) return;
    if (!(await confirm({
      title: 'Detach the dedicated worktree?',
      body: 'The branch is kept; any uncommitted work is surfaced onto master (or kept as a stash).',
      confirmLabel: 'Detach',
    }))) return;
    setDetaching(true);
    setDetachMsg(null);
    try {
      const result = await detachWorktree(task.id);
      setDetachMsg(result.message);
      fetchBranchStatus(task.id).then(setBranchStatus).catch(() => {});
      // Refresh the board too, so the card's worktree badge clears without a
      // manual page reload (the detach no longer lingers in the UI).
      refreshWorktrees();
      triggerRefresh();
    } catch (err) {
      setDetachMsg(err instanceof Error ? err.message : 'Failed to detach worktree');
    } finally {
      setDetaching(false);
    }
  };

  if (variant === 'popup') {
    return (
      <div className={isWideMode ? 'flex items-end gap-4' : 'flex flex-wrap items-end gap-3'}>
        <div className={isWideMode ? 'w-32' : 'w-36'}>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Status</label>
          <select
            className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {allStatuses.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </div>

        <div className={isWideMode ? 'w-32' : 'w-40'}>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Assignee</label>
          <select
            className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="unassigned">Unassigned</option>
            {allUsers.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </div>

        <div className={isWideMode ? 'w-40' : 'w-40'}>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Priority</label>
          <select
            className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            {availablePriorities.map((item) => (
              <option key={item.name} value={item.name}>{item.name}</option>
            ))}
          </select>
        </div>

        <div className={isWideMode ? 'w-28' : 'w-28'}>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Effort</label>
          <select
            className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          >
            {EFFORT_OPTIONS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </div>

        <div className={isWideMode ? 'w-64' : 'min-w-[240px] flex-1'}>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
          <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={configTags} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-white/5 dark:bg-black/10">
      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Status</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {allStatuses.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Assignee</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="unassigned">Unassigned</option>
          {allUsers.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Priority</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          {availablePriorities.map((item) => (
            <option key={item.name} value={item.name}>{item.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Effort</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
        >
          {EFFORT_OPTIONS.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Effort Override</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={effortLevel}
          onChange={(e) => setEffortLevel(e.target.value)}
        >
          <option value="">Uses global default</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Implementation Link</label>
        <input
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={implementationLink}
          onChange={(e) => setImplementationLink(e.target.value)}
          placeholder="https://github.com/..."
        />
      </div>

      {task?.branch && (
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Branch</label>
          <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-mono ${branchStatus?.exists === false ? 'border-gray-100 bg-gray-50 text-gray-400 dark:border-white/5 dark:bg-black/10 dark:text-gray-500 line-through' : branchStatus?.worktree ? 'border-primary/30 bg-primary/5 text-primary' : 'border-gray-200 bg-white dark:border-white/10 dark:bg-[#252630]'}`}>
            {branchStatus?.worktree
              ? <FolderGit2 className="h-3 w-3 shrink-0" />
              : <GitBranch className="h-3 w-3 shrink-0 text-gray-400" />}
            <span className="flex-1 truncate text-gray-700 dark:text-gray-200">{task.branch}</span>
            {branchStatus?.exists && (branchStatus.aheadCount > 0 || branchStatus.behindCount > 0) && (
              <span className="shrink-0 text-[10px] text-gray-400">
                {branchStatus.aheadCount > 0 && <span className="text-emerald-500">↑{branchStatus.aheadCount}</span>}
                {branchStatus.behindCount > 0 && <span className="ml-0.5 text-amber-500">↓{branchStatus.behindCount}</span>}
              </span>
            )}
            <button onClick={() => copyBranch(task.branch!)} title="Copy branch name" className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>
          {branchStatus?.worktree && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-[10px] text-gray-400" title={branchStatus.worktree}>dedicated worktree active</span>
              <button
                onClick={() => void handleDetach()}
                disabled={detaching}
                title="Remove the worktree, keep the branch (uncommitted work is preserved)"
                className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200"
              >
                {detaching ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderX className="h-3 w-3" />}
                Detach
              </button>
            </div>
          )}
          {detachMsg && <p className="mt-1 text-[10px] text-gray-400">{detachMsg}</p>}
        </div>
      )}

      {task && onDiffFileClick && (
        <DiffSummaryPanel task={task} onFileClick={onDiffFileClick} />
      )}

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
        <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={configTags} />
      </div>
    </div>
  );
}

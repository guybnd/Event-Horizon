import { useState, useEffect } from 'react';
import { GitBranch, Copy, Check } from 'lucide-react';
import type { TagDef, Task } from '../../types';
import { TagSelector } from '../TagSelector';
import { fetchBranchStatus, type BranchStatus } from '../../api';
import { DiffSummaryPanel } from './DiffSummaryPanel';

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
          <div className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-mono ${branchStatus?.exists === false ? 'border-gray-100 bg-gray-50 text-gray-400 dark:border-white/5 dark:bg-black/10 dark:text-gray-500 line-through' : 'border-gray-200 bg-white dark:border-white/10 dark:bg-[#252630]'}`}>
            <GitBranch className="h-3 w-3 shrink-0 text-gray-400" />
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

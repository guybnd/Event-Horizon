import type { TagDef } from '../../types';
import { TagSelector } from '../TagSelector';

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
  variant,
  isWideMode,
}: MetadataPanelProps) {
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

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
        <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={configTags} />
      </div>
    </div>
  );
}

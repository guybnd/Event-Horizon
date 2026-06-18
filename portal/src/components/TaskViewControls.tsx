import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowUpDown, ChevronDown, ChevronUp, Equal, FolderGit2, GitCompare, Inbox, Search, SlidersHorizontal, Tag, User, X } from 'lucide-react';
import { useApp } from '../AppContext';
import type { Config } from '../types';
import type { WorktreeInfo } from '../api';
import { BoardStatusCluster } from './BoardStatusCluster';
import { UncommittedChangesStoplight } from './UncommittedChangesStoplight';

function getTagColor(name: string, config: Config | null) {
  const tagObj = config?.tags?.find((t) => t.name === name);
  return tagObj?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
}

function getPriorityIcon(name: string, config: Config | null) {
  const p = config?.priorities?.find((p) => p.name === name);
  const color = p?.color || 'text-gray-400';
  switch (p?.icon) {
    case 'AlertCircle': return <AlertCircle className={`h-3.5 w-3.5 ${color}`} />;
    case 'ChevronUp': return <ChevronUp className={`h-3.5 w-3.5 ${color}`} />;
    case 'ChevronDown': return <ChevronDown className={`h-3.5 w-3.5 ${color}`} />;
    case 'Equal':
    case 'Equals': return <Equal className={`h-3.5 w-3.5 ${color}`} />;
    default: return null;
  }
}

function FilterDropdown({
  label,
  displayValue,
  children,
}: {
  label: string;
  displayValue: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex w-full items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
      <span className="w-[72px] flex-none text-xs font-medium uppercase tracking-[0.16em] text-gray-400">{label}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 flex-1 items-center justify-between gap-1.5 text-sm text-gray-600 outline-none dark:text-gray-200"
      >
        <span className="whitespace-nowrap">{displayValue}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-none text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-full rounded-xl border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]">
          {children}
        </div>
      )}
    </div>
  );
}

function DropdownItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
        selected
          ? 'bg-primary/10 font-semibold text-primary dark:bg-primary/20'
          : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  );
}


/**
 * Worktree filter chip (FLUX-516) — a dropdown to isolate the board to a single
 * active worktree's branch, "any" worktree, or off. Replaces the old binary toggle.
 */
function WorktreeFilterChip({
  worktrees,
  value,
  onChange,
}: {
  worktrees: WorktreeInfo[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { setView, setChangesFocus } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const active = value !== '';
  const selected = value && value !== 'any' ? worktrees.find((w) => w.branch === value) : null;
  const label =
    value === '' ? `Worktrees (${worktrees.length})`
    : value === 'any' ? 'Any worktree'
    : selected ? (selected.ticketId ?? selected.branch)
    : value; // a branch whose worktree is gone — still show what's filtered

  return (
    <div ref={ref} className="relative flex-none">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Isolate the board to a specific worktree"
        className={`inline-flex min-w-[110px] items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-all ${
          active
            ? 'border-primary bg-primary text-white shadow-sm shadow-primary/30'
            : 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10 dark:border-primary/30 dark:bg-primary/10 dark:hover:bg-primary/20'
        }`}
      >
        <FolderGit2 className="h-4 w-4 flex-none" />
        <span className="max-w-[140px] truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-none transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-xl border border-gray-200 bg-white p-1 shadow-2xl dark:border-white/10 dark:bg-[#1e1f2a]">
          <DropdownItem selected={value === 'any'} onClick={() => { onChange('any'); setOpen(false); }}>
            <FolderGit2 className="h-3.5 w-3.5 flex-none text-primary" />
            <span className="flex-1">Any worktree</span>
            <span className="text-[10px] text-gray-400">{worktrees.length}</span>
          </DropdownItem>

          <div className="my-1 border-t border-gray-100 dark:border-white/5" />

          {worktrees.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] italic text-gray-400">No active worktrees</div>
          ) : (
            worktrees.map((w) => (
              <DropdownItem key={w.path} selected={value === w.branch} onClick={() => { onChange(w.branch); setOpen(false); }}>
                <span className="flex-1 truncate">{w.ticketId ?? w.branch}</span>
                {typeof w.changedFiles === 'number' && w.changedFiles > 0 && (
                  <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">{w.changedFiles}</span>
                )}
              </DropdownItem>
            ))
          )}

          {active && (
            <>
              <div className="my-1 border-t border-gray-100 dark:border-white/5" />
              <DropdownItem selected={false} onClick={() => { onChange(''); setOpen(false); }}>
                <X className="h-3.5 w-3.5 flex-none text-gray-400" />
                <span className="flex-1">Clear worktree filter</span>
              </DropdownItem>
            </>
          )}
          <div className="my-1 border-t border-gray-100 dark:border-white/5" />
          <DropdownItem
            selected={false}
            onClick={() => {
              setChangesFocus(selected ? selected.branch : null);
              setView('changes');
              setOpen(false);
            }}
          >
            <GitCompare className="h-3.5 w-3.5 flex-none text-gray-400" />
            <span className="flex-1">View {selected ? 'these' : 'all'} changes →</span>
          </DropdownItem>
        </div>
      )}
    </div>
  );
}

interface TaskViewControlsProps {
  title: string;
  searchPlaceholder: string;
  visibleCount: number;
  totalCount: number;
  itemLabel: string;
}

export function TaskViewControls({
  title,
  searchPlaceholder,
  visibleCount,
  totalCount,
  itemLabel,
}: TaskViewControlsProps) {
  const {
    searchQuery,
    setSearchQuery,
    sortOption,
    setSortOption,
    filterAssignee,
    setFilterAssignee,
    filterPriority,
    setFilterPriority,
    filterTag,
    setFilterTag,
    filterUnreadOnly,
    setFilterUnreadOnly,
    filterWorktree,
    setFilterWorktree,
    worktrees,
    totalUnreadCount,
    clearTaskFilters,
    config,
  } = useApp();
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const filtersRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAdvancedFilters) return;
    const handler = (e: MouseEvent) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) {
        setShowAdvancedFilters(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [showAdvancedFilters]);

  const activeFilterCount = [
    searchQuery.trim().length > 0,
    sortOption !== 'default',
    filterAssignee !== 'all',
    filterPriority !== 'all',
    filterTag !== 'all',
    filterUnreadOnly,
    filterWorktree !== '',
  ].filter(Boolean).length;
  const activeAdvancedFilterCount = [
    sortOption !== 'default',
    filterAssignee !== 'all',
    filterPriority !== 'all',
    filterTag !== 'all',
  ].filter(Boolean).length;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white/80 p-3 shadow-sm dark:border-white/10 dark:bg-[#181922]/80">
      <div className="relative flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-none">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-300">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div className="hidden sm:block">
            <div className="text-sm font-semibold text-gray-900 dark:text-white whitespace-nowrap">{title}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {visibleCount} of {totalCount} {itemLabel}
            </div>
          </div>
        </div>

        <button
          onClick={() => setFilterUnreadOnly(!filterUnreadOnly)}
          className={`inline-flex min-w-[90px] flex-none items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-all ${
            filterUnreadOnly
              ? 'border-amber-400 bg-amber-400 text-white shadow-sm shadow-amber-400/30 dark:border-amber-400 dark:bg-amber-400 dark:text-white'
              : 'border-amber-300/60 bg-amber-50/60 text-amber-600 hover:border-amber-400 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400 dark:hover:bg-amber-500/20'
          }`}
        >
          <Inbox className="h-4 w-4" />
          {totalUnreadCount > 0 ? `Unread (${totalUnreadCount})` : 'Unread'}
        </button>

        {/* Worktrees chip — a dropdown to isolate the board to a specific active
            worktree (or "any"), FLUX-516. Shown when any worktree is active or the
            filter is set (so it can be cleared). */}
        {(worktrees.length > 0 || filterWorktree !== '') && (
          <WorktreeFilterChip
            worktrees={worktrees}
            value={filterWorktree}
            onChange={setFilterWorktree}
          />
        )}

        {/* Uncommitted-changes stoplight + dropdown (FLUX-535/544) — grouped with
            the worktree control since both reflect the board's git working state. */}
        <UncommittedChangesStoplight />

        <div ref={filtersRef} className="relative flex-none">
          <button
            onClick={() => setShowAdvancedFilters((current) => !current)}
            className={`inline-flex min-w-[90px] items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
              showAdvancedFilters
                ? 'border-gray-300 bg-gray-100 text-gray-700 dark:border-white/20 dark:bg-white/10 dark:text-gray-200'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10'
            }`}
          >
            <span>{activeAdvancedFilterCount > 0 ? `Filters (${activeAdvancedFilterCount})` : 'Filters'}</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
          </button>

          {showAdvancedFilters && (
            <div className="absolute left-0 top-full z-50 mt-1.5 flex w-72 flex-col gap-2 rounded-2xl border border-gray-200 bg-white/95 p-3 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1e1f2a]/95">
              {/* Sort */}
              <FilterDropdown
                label="Sort"
                displayValue={
                  <span className="flex items-center gap-1.5">
                    <ArrowUpDown className="h-3.5 w-3.5 flex-none text-gray-400" />
                    {sortOption === 'default' ? 'Default' : sortOption === 'priority' ? 'Priority' : sortOption === 'updated' ? 'Recently updated' : 'Assignee'}
                  </span>
                }
              >
                {([
                  { value: 'default', label: 'Default' },
                  { value: 'priority', label: 'Priority' },
                  { value: 'updated', label: 'Recently updated' },
                  { value: 'assignee', label: 'Assignee' },
                ] as const).map((opt) => (
                  <DropdownItem key={opt.value} selected={sortOption === opt.value} onClick={() => setSortOption(opt.value)}>
                    <ArrowUpDown className="h-3.5 w-3.5 flex-none text-gray-400" />
                    {opt.label}
                  </DropdownItem>
                ))}
              </FilterDropdown>

              {/* Assignee */}
              <FilterDropdown
                label="Assignee"
                displayValue={
                  <span className="flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 flex-none text-gray-400" />
                    {filterAssignee === 'all' ? 'All assignees' : filterAssignee === 'unassigned' ? 'Unassigned' : filterAssignee}
                  </span>
                }
              >
                <DropdownItem selected={filterAssignee === 'all'} onClick={() => setFilterAssignee('all')}>
                  <User className="h-3.5 w-3.5 flex-none text-gray-400" />
                  All assignees
                </DropdownItem>
                {config?.users.map((user) => (
                  <DropdownItem key={user.name} selected={filterAssignee === user.name} onClick={() => setFilterAssignee(user.name)}>
                    <User className="h-3.5 w-3.5 flex-none text-gray-400" />
                    {user.name}
                  </DropdownItem>
                ))}
                <DropdownItem selected={filterAssignee === 'unassigned'} onClick={() => setFilterAssignee('unassigned')}>
                  <User className="h-3.5 w-3.5 flex-none text-gray-400" />
                  Unassigned
                </DropdownItem>
              </FilterDropdown>

              {/* Priority */}
              <FilterDropdown
                label="Priority"
                displayValue={
                  filterPriority === 'all' ? (
                    <span className="flex items-center gap-1.5 text-gray-400">All priorities</span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      {getPriorityIcon(filterPriority, config)}
                      {filterPriority}
                    </span>
                  )
                }
              >
                <DropdownItem selected={filterPriority === 'all'} onClick={() => setFilterPriority('all')}>
                  <span className="text-gray-400">All priorities</span>
                </DropdownItem>
                {config?.priorities.map((priority) => (
                  <DropdownItem key={priority.name} selected={filterPriority === priority.name} onClick={() => setFilterPriority(priority.name)}>
                    {getPriorityIcon(priority.name, config)}
                    {priority.name}
                  </DropdownItem>
                ))}
              </FilterDropdown>

              {/* Tag */}
              <FilterDropdown
                label="Tag"
                displayValue={
                  filterTag === 'all' ? (
                    <span className="flex items-center gap-1.5">
                      <Tag className="h-3.5 w-3.5 flex-none text-gray-400" />
                      All tags
                    </span>
                  ) : (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getTagColor(filterTag, config)}`}>
                      {filterTag}
                    </span>
                  )
                }
              >
                <DropdownItem selected={filterTag === 'all'} onClick={() => setFilterTag('all')}>
                  <Tag className="h-3.5 w-3.5 flex-none text-gray-400" />
                  All tags
                </DropdownItem>
                {config?.tags.map((tag) => (
                  <DropdownItem key={tag.name} selected={filterTag === tag.name} onClick={() => setFilterTag(tag.name)}>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${getTagColor(tag.name, config)}`}>
                      {tag.name}
                    </span>
                  </DropdownItem>
                ))}
              </FilterDropdown>
            </div>
          )}
        </div>

        <button
          onClick={clearTaskFilters}
          disabled={activeFilterCount === 0}
          className="flex-none min-w-[90px] rounded-xl border border-gray-200 bg-white px-3 py-2 text-center text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-default disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
        >
          Clear
        </button>

        <label className="flex min-w-44 flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
          <Search className="h-4 w-4 flex-none text-gray-400" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="min-w-0 w-full bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-200"
          />
        </label>

        {/* Right: board-context live status — agents, tokens.
            Anchored right so the agent popover opens leftward into the viewport. */}
        <div className="hidden h-9 w-px flex-none bg-gray-200 dark:bg-white/10 lg:block" />
        <BoardStatusCluster />
      </div>
    </section>
  );
}
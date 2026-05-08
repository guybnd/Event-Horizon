import { useState } from 'react';
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../AppContext';

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
    clearTaskFilters,
    config,
  } = useApp();
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  const activeFilterCount = [
    searchQuery.trim().length > 0,
    sortOption !== 'default',
    filterAssignee !== 'all',
    filterPriority !== 'all',
    filterTag !== 'all',
  ].filter(Boolean).length;
  const activeAdvancedFilterCount = [
    sortOption !== 'default',
    filterAssignee !== 'all',
    filterPriority !== 'all',
    filterTag !== 'all',
  ].filter(Boolean).length;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white/80 p-3 shadow-sm dark:border-white/10 dark:bg-[#181922]/80">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
        <div className="flex items-center gap-3 xl:min-w-[240px] xl:flex-none">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-300">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900 dark:text-white">{title}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {visibleCount} of {totalCount} {itemLabel}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-center">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            <Search className="h-4 w-4 flex-none text-gray-400" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400 dark:text-gray-200"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowAdvancedFilters((current) => !current)}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
            >
              <span>{activeAdvancedFilterCount > 0 ? `Filters (${activeAdvancedFilterCount})` : 'Filters'}</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
            </button>

            <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600 dark:border-white/10 dark:bg-white/5 dark:text-gray-300">
              {activeFilterCount > 0 ? `${activeFilterCount} active` : 'Clean view'}
            </div>

            <button
              onClick={clearTaskFilters}
              disabled={activeFilterCount === 0}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-100 disabled:cursor-default disabled:opacity-60 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {showAdvancedFilters && (
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <label className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            <span className="flex-none text-xs font-medium uppercase tracking-[0.16em] text-gray-400">Sort</span>
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as any)}
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-600 outline-none dark:bg-[#1a1b23] dark:text-gray-200"
            >
              <option value="default">Default</option>
              <option value="priority">Priority</option>
              <option value="updated">Recently updated</option>
              <option value="assignee">Assignee</option>
            </select>
          </label>

          <label className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            <span className="flex-none text-xs font-medium uppercase tracking-[0.16em] text-gray-400">Assignee</span>
            <select
              value={filterAssignee}
              onChange={(event) => setFilterAssignee(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-600 outline-none dark:bg-[#1a1b23] dark:text-gray-200"
            >
              <option value="all">All assignees</option>
              {config?.users.map((user) => (
                <option key={user.name} value={user.name}>{user.name}</option>
              ))}
              <option value="unassigned">Unassigned</option>
            </select>
          </label>

          <label className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            <span className="flex-none text-xs font-medium uppercase tracking-[0.16em] text-gray-400">Priority</span>
            <select
              value={filterPriority}
              onChange={(event) => setFilterPriority(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-600 outline-none dark:bg-[#1a1b23] dark:text-gray-200"
            >
              <option value="all">All priorities</option>
              {config?.priorities.map((priority) => (
                <option key={priority.name} value={priority.name}>{priority.name}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            <span className="flex-none text-xs font-medium uppercase tracking-[0.16em] text-gray-400">Tag</span>
            <select
              value={filterTag}
              onChange={(event) => setFilterTag(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-600 outline-none dark:bg-[#1a1b23] dark:text-gray-200"
            >
              <option value="all">All tags</option>
              {config?.tags.map((tag) => (
                <option key={tag.name} value={tag.name}>{tag.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </section>
  );
}
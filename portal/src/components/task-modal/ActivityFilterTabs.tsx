import type { TaskModalController } from '../../hooks/useTaskModalController';

type ActivityFilter = 'all' | 'decisions' | 'sessions';

type ActivityFilterTabsProps = Pick<TaskModalController,
  | 'activityFilter'
  | 'setActivityFilter'
  | 'unreadCommentCount'
  | 'modalTask'
  | 'ctxMarkAllCommentsRead'
>;

export function ActivityFilterTabs({
  activityFilter,
  setActivityFilter,
  unreadCommentCount,
  modalTask,
  ctxMarkAllCommentsRead,
}: ActivityFilterTabsProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {(['all', 'decisions', 'sessions'] as ActivityFilter[]).map((filter) => (
        <button
          key={filter}
          type="button"
          onClick={() => setActivityFilter(filter)}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
            activityFilter === filter
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/15'
          }`}
        >
          {filter === 'all' ? 'All' : filter === 'decisions' ? 'Decisions' : 'Sessions'}
        </button>
      ))}
      {unreadCommentCount > 0 && (
        <button
          type="button"
          onClick={() => modalTask?.id && ctxMarkAllCommentsRead(modalTask.id, (modalTask.history || []).filter(e => e.type === 'comment' && e.id).map(e => e.id!))}
          className="ml-auto rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25"
        >
          Mark all read ({unreadCommentCount})
        </button>
      )}
    </div>
  );
}

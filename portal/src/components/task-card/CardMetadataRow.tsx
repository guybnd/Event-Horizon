import { useMemo } from 'react';
import { Layers } from 'lucide-react';
import type { Task } from '../../types';
import { StatusBadge } from '../StatusBadge';
import { reviewChip } from '../ReviewChip';
import { getStatusColorClass } from '../../statusStyles';
import type { TaskCardController } from '../../hooks/useTaskCardController';


function useTimeInColumn(task: Task): string | null {
  return useMemo(() => {
    const history = task.history ?? [];
    // Walk backwards to find the most recent entry that moved us into the current status
    let enteredAt: string | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (e.type === 'status_change' && (e as { to?: string }).to === task.status) {
        enteredAt = e.date;
        break;
      }
    }
    if (!enteredAt) return null;
    const ms = Date.now() - new Date(enteredAt).getTime();
    if (ms < 60_000) return null; // less than 1 min — not worth showing
    const mins = Math.floor(ms / 60_000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days >= 1) return `${days}d`;
    if (hours >= 1) return `${hours}h`;
    return `${mins}m`;
  }, [task.history, task.status]);
}

export function CardMetadataRow({ task, isOverlay, c }: { task: Task; isOverlay?: boolean; c: TaskCardController }) {
  const timeInColumn = useTimeInColumn(task);
  const {
    isEditingTitle,
    titleInputRef,
    titleValue,
    setTitleValue,
    handleTitleSave,
    setIsEditingTitle,
    setPriorityMenuOpen,
    setEffortMenuOpen,
    setAssigneeMenuOpen,
    setTagMenuOpen,
    visibleTitle,
    config,
    hideStatusBadge,
    isEpic,
    parentTask,
    openBoardTask,
    effortMenuRef,
    effortMenuOpen,
    effortLabel,
    EFFORT_OPTIONS,
    handleEffortChange,
    priorityMenuRef,
    priorityMenuOpen,
    getPriorityIcon,
    priorityName,
    handlePriorityChange,
  } = c;

  return (
    <div className="mb-2 flex flex-col items-start gap-1">
      {isEditingTitle && !isOverlay ? (
        <input
          ref={titleInputRef}
          value={titleValue}
          onChange={(event) => setTitleValue(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onBlur={() => void handleTitleSave()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void handleTitleSave();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setTitleValue(task.title || '');
              setIsEditingTitle(false);
            }
          }}
          className="mb-0.5 w-full rounded border border-primary/30 bg-white px-2 py-1 text-sm font-semibold leading-snug text-gray-900 outline-none dark:border-primary/40 dark:bg-[#1f2028] dark:text-gray-100"
        />
      ) : (
        <button
          onClick={(event) => {
            event.stopPropagation();
            if (!isOverlay) {
              setIsEditingTitle(true);
              setPriorityMenuOpen(false);
              setEffortMenuOpen(false);
              setAssigneeMenuOpen(false);
              setTagMenuOpen(false);
            }
          }}
          className="mb-0.5 text-left font-semibold text-gray-900 transition-colors group-hover:text-primary dark:text-gray-100 text-[13.5px] leading-snug tracking-[-0.01em] pr-8"
        >
          {visibleTitle}
        </button>
      )}
      <div className="relative flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold tracking-wider text-gray-400 dark:text-gray-500">
          {task.id}
        </span>
        {timeInColumn && !isOverlay && (
          <span
            title={`In "${task.status}" for ${timeInColumn}`}
            className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-gray-400 dark:bg-white/5 dark:text-gray-500"
          >
            {timeInColumn}
          </span>
        )}
        {/* Status badge is redundant under a column header on the board
            (the column conveys status + hue). Kept off-board: drag
            overlay, releases screen, swimlane reuse. */}
        {!hideStatusBadge && (
          <StatusBadge
            status={task.status}
            colorClass={getStatusColorClass(config, task.status)}
            className="text-[9px] font-bold uppercase tracking-[0.12em]"
          />
        )}
        {/* Internal review verdict (FLUX-816). PR cards render their own review badge in
            PrDeckSection (from reviewDecision ?? reviewState), so this is non-PR only to avoid
            double-badging. null reviewState → no badge (never a false "approved"). */}
        {task.kind !== 'pr' && reviewChip(task.reviewState)}
        {isEpic && task.kind !== 'pr' && (
          <span className="flex items-center gap-0.5 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[9px] font-bold text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
            <Layers className="w-2.5 h-2.5" />
            Epic
          </span>
        )}
        {parentTask && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openBoardTask(parentTask);
            }}
            className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/15"
          >
            -&gt; {parentTask.id}
          </button>
        )}
        {/* Effort + priority share the same wrapping metadata row as ID/status
            so every card has one consistent metadata rhythm. */}
        {!isOverlay && (
          <div ref={effortMenuRef} className="relative">
            <button
              onClick={(event) => {
                event.stopPropagation();
                setEffortMenuOpen((open) => !open);
                setPriorityMenuOpen(false);
              }}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${effortLabel ? 'bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/20' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-black/20 dark:text-gray-400 dark:hover:bg-black/30'}`}
            >
              <span>{effortLabel || 'Effort'}</span>
            </button>
            {effortMenuOpen && (
              <div
                className="absolute left-0 top-full z-[90] mt-1 min-w-24 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                onClick={(event) => event.stopPropagation()}
              >
                {EFFORT_OPTIONS.map((option) => (
                  <button
                    key={option}
                    onClick={() => handleEffortChange(option)}
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={priorityMenuRef} className="relative">
        {!isOverlay && config?.priorities?.length ? (
          <>
            <button
              onClick={(event) => {
                event.stopPropagation();
                setPriorityMenuOpen(open => !open);
                setEffortMenuOpen(false);
              }}
              className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 transition-colors hover:bg-gray-200 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-black/30"
            >
              {getPriorityIcon(priorityName)}
              <span>{priorityName}</span>
            </button>
            {priorityMenuOpen && (
              <div
                className="absolute left-0 top-full z-[90] mt-1 min-w-32 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                onClick={(event) => event.stopPropagation()}
              >
                {config.priorities.map(priority => (
                  <button
                    key={priority.name}
                    onClick={() => handlePriorityChange(priority.name)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                  >
                    {getPriorityIcon(priority.name)}
                    <span>{priority.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          getPriorityIcon(priorityName)
        )}
        </div>
      </div>
    </div>
  );
}

import { X } from 'lucide-react';
import { StatusBadge } from '../StatusBadge';
import { getStatusColorClass } from '../../statusStyles';
import { TicketPicker } from '../TicketPicker';
import type { Config, Task } from '../../types';
import type { TaskModalController } from '../../hooks/useTaskModalController';

type SubtasksPanelProps = Pick<TaskModalController,
  | 'modalTask'
  | 'parentId'
  | 'setParentId'
  | 'subtasks'
  | 'setSubtasks'
  | 'allTasks'
  | 'openTaskModal'
  | 'linkedSubtasks'
  | 'danglingSubtaskIds'
  | 'inlineSubtaskMap'
> & {
  config: Config;
  parentTask: Task | null;
};

export function SubtasksPanel({
  config,
  modalTask,
  parentId,
  setParentId,
  subtasks,
  setSubtasks,
  allTasks,
  openTaskModal,
  parentTask,
  linkedSubtasks,
  danglingSubtaskIds,
  inlineSubtaskMap,
}: SubtasksPanelProps) {
  return (
    <div className="space-y-4 rounded-xl border border-gray-100 bg-white/70 p-4 dark:border-white/5 dark:bg-white/5">
      {/* Parent ticket */}
      <div className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Parent Ticket</p>
        {parentId ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => parentTask && openTaskModal(parentTask)}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && parentTask) { e.preventDefault(); openTaskModal(parentTask); } }}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 transition-colors hover:border-primary/30 hover:bg-primary/5 dark:border-white/5 dark:bg-black/20 dark:hover:bg-white/5"
          >
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">{parentId}</p>
              <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{parentTask?.title || 'Untitled'}</p>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setParentId(''); }}
              className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
              title="Detach parent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : modalTask?.id ? (
          <TicketPicker
            tasks={allTasks}
            config={config}
            excludeIds={[modalTask.id, ...subtasks]}
            placeholder="Search for parent ticket..."
            onSelect={(id) => setParentId(id)}
          />
        ) : (
          <p className="text-sm text-gray-500">Save the ticket first to set a parent.</p>
        )}
      </div>

      {/* Subtasks */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Subtasks</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Link existing tickets as child work items.</p>
        </div>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-300">
          {subtasks.length}
        </span>
      </div>
      {modalTask?.id ? (
        <TicketPicker
          tasks={allTasks}
          config={config}
          excludeIds={[modalTask.id, ...subtasks, ...(parentId ? [parentId] : [])]}
          placeholder="Search tickets to attach..."
          onSelect={(id) => setSubtasks((current) => [...current, id])}
        />
      ) : (
        <p className="text-sm text-gray-500">Save the ticket first, then attach existing subtasks.</p>
      )}
      {linkedSubtasks.length === 0 && danglingSubtaskIds.length === 0 ? (
        <p className="text-sm italic text-gray-500">No subtasks linked yet.</p>
      ) : (
        <div className="space-y-2">
          {linkedSubtasks.map((task) => (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              onClick={() => openTaskModal(task)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openTaskModal(task);
                }
              }}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 transition-colors hover:border-primary/30 hover:bg-primary/5 dark:border-white/5 dark:bg-black/20 dark:hover:bg-white/5"
            >
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">{task.id}</p>
                <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{task.title || 'Untitled Task'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <StatusBadge
                    status={task.status}
                    colorClass={getStatusColorClass(config, task.status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                  <span>{task.assignee || 'unassigned'} · {task.priority || 'None'}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSubtasks((current) => current.filter((subtaskId) => subtaskId !== task.id));
                }}
                className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                title="Detach subtask"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {danglingSubtaskIds.map((subtaskId) => {
            const inline = inlineSubtaskMap.get(subtaskId);
            return (
              <div key={subtaskId} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${inline ? 'border-gray-100 bg-gray-50 text-gray-700 dark:border-white/5 dark:bg-black/20 dark:text-gray-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                <div className="min-w-0 flex-1">
                  {inline ? (
                    <>
                      <p className="text-xs font-bold uppercase tracking-wider text-gray-400">{subtaskId}</p>
                      <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{inline.title || subtaskId}</p>
                      {inline.status && (
                        <StatusBadge
                          status={inline.status}
                          colorClass={getStatusColorClass(config, inline.status)}
                          className="mt-1 text-[10px] font-bold uppercase tracking-[0.16em]"
                        />
                      )}
                    </>
                  ) : (
                    <span>{subtaskId} is linked but not currently loaded.</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSubtasks((current) => current.filter((id) => id !== subtaskId))}
                  className="rounded-md p-1.5 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/10"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Layers } from 'lucide-react';
import type { Task } from '../../types';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardSubtaskPopover({ task, isOverlay, c }: { task: Task; isOverlay?: boolean; c: TaskCardController }) {
  const {
    subtaskPopoverOpen,
    isEpic,
    subtaskPopupRef,
    subtaskPopoverPos,
    subtaskDoneCount,
    subtaskTotal,
    subtaskIds,
    taskById,
    doneStatuses,
    setSubtaskPopoverOpen,
    openBoardTask,
  } = c;

  return createPortal(
    <AnimatePresence>
      {subtaskPopoverOpen && isEpic && !isOverlay && (
        <motion.div
          ref={subtaskPopupRef}
          key={`subtasks-popup-${task.id}`}
          initial={{ opacity: 0, y: 4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.12 }}
          style={{
            position: 'fixed',
            top: Math.min(subtaskPopoverPos.top, window.innerHeight - 700),
            left: Math.min(subtaskPopoverPos.left, window.innerWidth - 520),
            zIndex: 999999,
          }}
          className="w-[500px] max-h-[700px] overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-600 [&::-webkit-scrollbar-track]:bg-transparent"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sticky top-0 bg-white/95 dark:bg-[#1a1b23]/95 px-5 py-3.5 border-b border-gray-100 dark:border-white/5 backdrop-blur-xl">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-500" />
                <span className="text-sm font-bold text-gray-700 dark:text-gray-200">
                  Subtasks
                </span>
              </div>
              <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                {subtaskDoneCount}/{subtaskTotal} done
              </span>
            </div>
            <div className="h-2 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 dark:bg-emerald-400 transition-all"
                style={{ width: `${subtaskTotal > 0 ? (subtaskDoneCount / subtaskTotal) * 100 : 0}%` }}
              />
            </div>
          </div>
          <div className="p-3 space-y-2">
            {subtaskIds.map(childId => {
              const child = taskById.get(childId);
              const isDone = child && doneStatuses.has(child.status);
              const childSnippet = child?.body?.split('\n').find(line => line.trim() && !line.startsWith('#')) || '';
              return (
                <button
                  key={childId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSubtaskPopoverOpen(false);
                    if (child) openBoardTask(child);
                  }}
                  className="flex items-start gap-3 w-full p-3 text-left rounded-lg border border-gray-100 dark:border-white/5 hover:border-indigo-300 hover:bg-indigo-50/80 hover:shadow-sm dark:hover:border-indigo-500/30 dark:hover:bg-indigo-500/10 transition-all group/subtask"
                >
                  <span className={`flex-shrink-0 w-4 h-4 mt-0.5 rounded-full border-2 ${isDone ? 'bg-emerald-500 border-emerald-500' : child ? 'border-gray-300 dark:border-gray-600 bg-transparent' : 'border-red-300 bg-transparent'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] font-bold text-indigo-500 dark:text-indigo-400">{childId}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${isDone ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400'}`}>
                        {child?.status || 'Not found'}
                      </span>
                      {child?.priority && child.priority !== 'None' && (
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">{child.priority}</span>
                      )}
                    </div>
                    <span className={`text-sm font-medium leading-snug group-hover/subtask:text-indigo-700 dark:group-hover/subtask:text-indigo-300 transition-colors ${isDone ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-800 dark:text-gray-200'}`}>
                      {child?.title || childId}
                    </span>
                    {childSnippet && (
                      <p className={`text-xs mt-0.5 line-clamp-1 ${isDone ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400'}`}>
                        {childSnippet}
                      </p>
                    )}
                    {child?.assignee && child.assignee !== 'unassigned' && (
                      <div className="flex items-center gap-1 mt-1.5">
                        <User className="w-3 h-3 text-gray-400" />
                        <span className="text-[11px] text-gray-500 dark:text-gray-400">{child.assignee}</span>
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { Task } from '../../types';
import { TaskMarkdown } from '../TaskMarkdown';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardDescriptionPopup({ task, isOverlay, c }: { task: Task; isOverlay?: boolean; c: TaskCardController }) {
  const {
    isHovering,
    isThisTaskOpen,
    isOverlayOpen,
    actionMenuActive,
    ticketActions,
    contextMenuPos,
    popupRef,
    popupPos,
    setIsHovering,
    handleMouseLeave,
  } = c;

  return createPortal(
    <AnimatePresence>
      {isHovering && !contextMenuPos && !isOverlay && !isThisTaskOpen && !isOverlayOpen && !actionMenuActive && !ticketActions.launcherOpen && !ticketActions.startPromptOpen && task.body?.trim() && (
        <motion.div
          ref={popupRef}
          key={`popup-${task.id}`}
          initial={{ opacity: 0, y: 10, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          style={{
            position: 'fixed',
            top: popupPos.top,
            left: popupPos.left !== 'auto' ? popupPos.left : undefined,
            right: popupPos.right !== 'auto' ? popupPos.right : undefined,
            zIndex: 999999
          }}
          className={`w-[640px] max-h-[85vh] overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-600 [&::-webkit-scrollbar-track]:bg-transparent`}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={handleMouseLeave}
        >
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <TaskMarkdown body={task.body!.length > 4000 ? task.body!.slice(0, 4000) + '\n\n---\n*Truncated — open ticket for full view*' : task.body!} taskId={task.id} compact />
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

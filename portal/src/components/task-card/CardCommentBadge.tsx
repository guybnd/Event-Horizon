import { MessageCircle } from 'lucide-react';
import type { Task } from '../../types';
import type { TaskCardController } from '../../hooks/useTaskCardController';

export function CardCommentBadge({ task, c, compact = false, inline = false }: { task: Task; c: TaskCardController; compact?: boolean; inline?: boolean }) {
  const {
    openTaskModal,
    openCommentPopover,
    commentCloseTimeout,
    setIsHovering,
    hoverTimeout,
    commentHoverTimeout,
    commentPopoverOpen,
    commentBadgeRef,
    setCommentPopoverPos,
    commentOpenedByHover,
    setCommentPopoverOpen,
    isMouseOverCard,
    startDescriptionTimer,
    isPromptStatus,
    hasUnread,
    totalCommentCount,
    unreadCommentIds,
    config,
  } = c;

  // Two rendering modes. `inline` = a normal flow chip (used in the footer's comment section).
  // Default = the absolutely-positioned corner badge (still used by compact / PR cards that
  // have no standard footer). Visual states are shared: unread (amber, attention) > has
  // comments (neutral count) > none (muted "add a comment" affordance).
  const stateCls = hasUnread
    ? inline
      ? 'relative eh-unread-badge bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-amber-950 ring-1 ring-amber-300 hover:bg-amber-300 active:scale-95 dark:ring-amber-500/30'
      : `${compact ? 'top-2 right-2' : isPromptStatus ? '-top-3.5 right-7' : '-top-3.5 right-3'} eh-unread-badge px-2.5 py-1 text-[11px] font-bold bg-amber-400 text-amber-950 ring-2 ring-white shadow-md hover:bg-amber-300 hover:scale-110 active:scale-95 dark:ring-[#1f2028]`
    : totalCommentCount > 0
      ? inline
        ? 'bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500 hover:bg-primary/10 hover:text-primary active:scale-95 dark:bg-black/25 dark:text-gray-400 dark:hover:bg-primary/15 dark:hover:text-primary'
        : 'top-2 right-2 px-2 py-0.5 text-[10px] bg-gray-100/80 text-gray-400 opacity-0 group-hover:opacity-100 hover:bg-primary/10 hover:text-primary hover:scale-105 active:scale-95 dark:bg-black/30 dark:text-gray-500 dark:hover:bg-primary/15 dark:hover:text-primary'
      : inline
        ? 'px-1.5 py-0.5 text-[10px] font-medium text-gray-400 opacity-70 hover:bg-primary/10 hover:text-primary hover:opacity-100 active:scale-95 dark:text-gray-500 dark:hover:bg-primary/15 dark:hover:text-primary'
        : 'top-2 right-2 p-1 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-primary hover:scale-105 active:scale-95 dark:text-gray-600 dark:hover:text-primary';

  return (
    <button
      ref={commentBadgeRef}
      onClick={totalCommentCount > 0
        ? openCommentPopover
        : (e) => { e.stopPropagation(); openTaskModal(task); }
      }
      title={totalCommentCount === 0 ? 'Add a comment' : undefined}
      onMouseEnter={(e) => {
        if (totalCommentCount === 0) return;
        e.stopPropagation();
        // Cancel any pending close
        if (commentCloseTimeout.current !== null) {
          window.clearTimeout(commentCloseTimeout.current);
          commentCloseTimeout.current = null;
        }
        setIsHovering(false);
        if (hoverTimeout.current !== null) {
          window.clearTimeout(hoverTimeout.current);
          hoverTimeout.current = null;
        }
        if (commentHoverTimeout.current !== null) window.clearTimeout(commentHoverTimeout.current);
        // Hover-to-open the comment popover is opt-in (off by default); a click always opens it.
        if (config?.commentHoverPreviewEnabled && !commentPopoverOpen) {
          commentHoverTimeout.current = window.setTimeout(() => {
            if (!commentBadgeRef.current) return;
            const rect = commentBadgeRef.current.getBoundingClientRect();
            setCommentPopoverPos({ top: rect.bottom + 8, left: rect.left });
            commentOpenedByHover.current = true;
            setCommentPopoverOpen(true);
          }, 300);
        }
      }}
      onMouseLeave={() => {
        if (commentHoverTimeout.current !== null) {
          window.clearTimeout(commentHoverTimeout.current);
          commentHoverTimeout.current = null;
        }
        // Start close timer for hover-opened popover
        if (commentOpenedByHover.current && commentCloseTimeout.current === null) {
          commentCloseTimeout.current = window.setTimeout(() => {
            commentCloseTimeout.current = null;
            setCommentPopoverOpen(false);
            commentOpenedByHover.current = false;
            if (isMouseOverCard.current) startDescriptionTimer();
          }, 200);
        }
      }}
      className={`${inline ? 'flex flex-shrink-0' : 'absolute z-20 flex'} items-center gap-1 rounded-full font-semibold transition-all duration-200 ${stateCls}`}
    >
      <MessageCircle className="w-3.5 h-3.5" />
      {hasUnread ? <span>{unreadCommentIds.length}</span> : totalCommentCount > 0 && <span>{totalCommentCount}</span>}
    </button>
  );
}

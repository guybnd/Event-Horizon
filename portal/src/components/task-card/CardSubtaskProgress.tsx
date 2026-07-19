import { useMemo } from 'react';
import { MousePointerClick } from 'lucide-react';
import type { TaskCardController } from '../../hooks/useTaskCardController';
import { useAppSelector } from '../../store/useAppSelector';
import { MemberStateStrip, type MemberStripItem } from '../MemberLine';
import { getMemberState, MEMBER_STATE_ORDER } from '../../lib/memberState';

export function CardSubtaskProgress({ c }: { c: TaskCardController }) {
  const {
    subtaskBadgeRef,
    setSubtaskPopoverPos,
    setSubtaskPopoverOpen,
    setCommentPopoverOpen,
    setIsHovering,
    hoverTimeout,
    isMouseOverCard,
    subtaskPopoverOpen,
    startDescriptionTimer,
    subtaskTotal,
    subtaskDoneCount,
    taskById,
  } = c;

  // FLUX-1503: the full resolved subtask set (cross-column + PR-folded included, same set the
  // rollup counts above are already computed from — see the lockstep note in
  // useTaskCardController.tsx) — NOT `epicFoldedSubtasks`, which is the same-column-only subset
  // used by the epic's own deck.
  const prTicketIdByMember = useAppSelector((s) => s.prTicketIdByMember);
  const members: MemberStripItem[] = useMemo(
    () => Array.from(taskById.values()).map((task) => ({ task, prTicketId: prTicketIdByMember.get(task.id) })),
    [taskById, prTicketIdByMember],
  );

  return (
    <button
      ref={subtaskBadgeRef}
      onClick={(e) => {
        e.stopPropagation();
        if (!subtaskBadgeRef.current) return;
        const rect = subtaskBadgeRef.current.getBoundingClientRect();
        setSubtaskPopoverPos({ top: rect.bottom + 8, left: rect.left });
        setSubtaskPopoverOpen(prev => !prev);
        setCommentPopoverOpen(false);
        setIsHovering(false);
        if (hoverTimeout.current !== null) {
          window.clearTimeout(hoverTimeout.current);
          hoverTimeout.current = null;
        }
      }}
      onMouseEnter={(e) => {
        e.stopPropagation();
        if (hoverTimeout.current !== null) {
          window.clearTimeout(hoverTimeout.current);
          hoverTimeout.current = null;
        }
        setIsHovering(false);
        setCommentPopoverOpen(false);
      }}
      onMouseLeave={() => {
        if (isMouseOverCard.current && !subtaskPopoverOpen) startDescriptionTimer();
      }}
      title="Click to view subtasks"
      className="flex items-center gap-2 mb-3 w-full group/progress cursor-pointer rounded-md px-1.5 py-1 -mx-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors ring-1 ring-transparent hover:ring-indigo-200 dark:hover:ring-indigo-500/30"
    >
      <MemberStateStrip
        members={members}
        order={(item) => MEMBER_STATE_ORDER[getMemberState(item.task, item.batchTicket)]}
        className="flex-1 h-2"
      />
      <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 whitespace-nowrap group-hover/progress:text-indigo-600 dark:group-hover/progress:text-indigo-300 transition-colors flex items-center gap-1">
        {subtaskDoneCount}/{subtaskTotal} done
        <MousePointerClick className="w-3 h-3 opacity-0 group-hover/progress:opacity-100 transition-opacity" />
      </span>
    </button>
  );
}

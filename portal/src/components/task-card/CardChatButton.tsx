import { MessageSquarePlus } from 'lucide-react';
import { useDockActions } from '../DockProvider';
import type { Task } from '../../types';

/**
 * FLUX-603: the per-card "open chat" affordance — the card's primary, always-visible action.
 * It owns the prime top-right corner (the comment indicator moved to the footer to make room):
 * a solid accent button, compact at rest (icon only, so it never crowds the wrapping title)
 * that expands to reveal "Chat" and lifts on hover, and presses on click. At rest it's the only
 * filled-accent element on the card (the lifecycle action reveals on hover), so it reads as the
 * star without clashing. `stopPropagation` keeps the click from opening the task modal; the
 * clicked element anchors where the dock window spawns.
 *
 * `nudged` shifts it left so it clears the Require-Input alert that occupies the same corner.
 */
export function CardChatButton({ task, nudged = false }: { task: Task; nudged?: boolean }) {
  const { openChat } = useDockActions();
  return (
    <button
      type="button"
      title="Open chat in dock"
      aria-label={`Open chat for ${task.id}`}
      onClick={(e) => {
        e.stopPropagation();
        openChat(task.id, e.currentTarget);
      }}
      className={`group/chat absolute top-2 z-20 flex items-center gap-1 rounded-full bg-primary py-1 pl-1.5 pr-1.5 text-white shadow-sm ring-1 ring-white/25 transition-all duration-150 hover:-translate-y-px hover:bg-primary-hover hover:pr-2.5 hover:shadow-md active:translate-y-0 active:scale-95 dark:ring-white/10 ${nudged ? 'right-4' : 'right-2'}`}
    >
      <MessageSquarePlus className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="max-w-0 overflow-hidden whitespace-nowrap text-[10px] font-semibold leading-none opacity-0 transition-all duration-150 group-hover/chat:max-w-[36px] group-hover/chat:opacity-100">
        Chat
      </span>
    </button>
  );
}

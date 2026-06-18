import { MessageSquarePlus } from 'lucide-react';
import { useDockActions } from '../DockProvider';
import type { Task } from '../../types';

/**
 * FLUX-603: hover-revealed "chat" affordance on a ticket card. Opens that ticket's chat as a
 * floating dock window anchored to this button — even when the ticket has no active CLI
 * session (the window stays read-only until the first send). Sits just left of the comment
 * badge; `stopPropagation` keeps it from opening the task modal.
 */
export function CardChatButton({ task }: { task: Task }) {
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
      className="absolute top-2 right-8 z-20 rounded-full p-1 text-gray-300 opacity-0 transition-all duration-200 hover:scale-105 hover:text-primary active:scale-95 group-hover:opacity-100 dark:text-gray-600 dark:hover:text-primary"
    >
      <MessageSquarePlus className="h-3.5 w-3.5" />
    </button>
  );
}

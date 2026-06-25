import { useMemo, useState } from 'react';
import { Send, ExternalLink } from 'lucide-react';
import { useChatSession } from '../../hooks/useChatSession';
import { ChatView } from './ChatView';
import { ChatDiffPanel } from './ChatDiffPanel';
import { TicketContextCard, SessionMeter } from './chatContext';
import { parseQuickReplies } from './chatQuickReplies';
import { ChatRequireInputBanner } from './ChatRequireInputBanner';
import { TicketActions } from '../ticket-actions/TicketActions';
import { ChatPendingInteractions } from '../pendingInteractions';
import { useDockActions } from '../DockProvider';
import { useAppSelector, useConfig } from '../../store/useAppSelector';
import { getRequireInputStatus } from '../../workflow';
import type { Task } from '../../types';

/**
 * FLUX-602 spike: the per-ticket chat, mounted in the task modal.
 *
 * Thin modal-specific shell: a collapse toggle + the panel chrome. The actual
 * chat (transport + rendering) is the shared core — useChatSession(taskId) feeding
 * the dumb <ChatView/> — so the board popup (FLUX-603) and orchestrator dock
 * (FLUX-604) reuse the same pieces without forking.
 */
export function ChatPane({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  // FLUX-748: pass `working` (live running session) into the hook so its queue auto-dispatches on
  // the turn-completion edge.
  const chat = useChatSession(task.id, open, task.cliSession?.status === 'running');
  const { openChat } = useDockActions();
  const config = useConfig();
  // FLUX-694: board task list backing the composer's ticket autocomplete.
  const tickets = useAppSelector((s) => s.tasks) as Task[];
  const quickReplies = useMemo(
    () => parseQuickReplies(task, getRequireInputStatus(config)),
    [task, config],
  );
  // FLUX-752: surface a board Require-Input prompt in the chat — status OR the require-input
  // swimlane, matching the full modal's `isRequireInput` predicate.
  const isRequireInput = task.status === getRequireInputStatus(config) || task.swimlane === 'require-input';

  if (!open) {
    return (
      <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 py-2 text-xs font-semibold text-gray-500 hover:border-gray-400 hover:text-gray-700 dark:border-white/10 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Send className="h-3.5 w-3.5" /> Chat about this ticket
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
      <div className="mb-2 flex items-center justify-end">
        <button
          type="button"
          onClick={(e) => openChat(task.id, e.currentTarget)}
          title="Open this chat as a floating dock window"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-black/5 hover:text-primary dark:text-gray-400 dark:hover:bg-white/5"
        >
          <ExternalLink className="h-3.5 w-3.5" /> Pop out to dock
        </button>
      </div>
      {task.branch && (
        <div className="mb-2 overflow-hidden rounded-lg border border-gray-100 dark:border-white/5">
          <ChatDiffPanel task={task} />
        </div>
      )}
      <ChatView
        title="Chat (spike)"
        messages={chat.messages}
        liveText={chat.liveText}
        busy={chat.busy}
        error={chat.error}
        working={task.cliSession?.status === 'running'}
        activity={task.cliSession?.currentActivity}
        emptyHint={`Ask anything about ${task.id}. Runs the Claude CLI bound to this ticket.`}
        contextCard={<TicketContextCard task={task} />}
        quickReplies={quickReplies}
        linkifyTickets
        onSend={chat.send}
        queued={chat.queued}
        onEnqueue={chat.enqueue}
        onDequeue={chat.dequeue}
        onStop={chat.stop}
        onUploadImage={chat.uploadImage}
        awaitingInputBanner={isRequireInput ? <ChatRequireInputBanner task={task} /> : undefined}
        questionPicker={<ChatPendingInteractions conversationId={task.id} />}
        actions={<TicketActions task={task} variant="compact" />}
        diffBranch={task.branch}
        tickets={tickets}
        meter={<SessionMeter session={task.cliSession} config={config} />}
      />
    </div>
  );
}

import { useCallback, useMemo, useState } from 'react';
import { Send, ExternalLink, ClipboardCheck } from 'lucide-react';
import { useChatSession } from '../../hooks/useChatSession';
import { ChatView } from './ChatView';
import { ChatDiffPanel } from './ChatDiffPanel';
import { ChatPresenceRail, ChatOrchestrationBlock } from './ChatOrchestration';
import { TicketContextCard, SessionMeter } from './chatContext';
import { parseQuickReplies } from './chatQuickReplies';
import { parseRunProposal } from './chatRunProposal';
import { ChatRequireInputBanner } from './ChatRequireInputBanner';
import { TicketActions } from '../ticket-actions/TicketActions';
import { ChatPendingInteractions, useComposerAnswer, isPlanApprovalPending } from '../pendingInteractions';
import { useDockActions } from '../DockProvider';
import { useAppActions, useAppSelector, useConfig } from '../../store/useAppSelector';
import { getRequireInputStatus } from '../../workflow';
import { selectChatRunGroup, isActiveSession } from '../../orchestration';
import { stopTaskCliSession } from '../../api';
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
  const { openChat, openSideView, setSectionOpen, openPlanApproval } = useDockActions();
  const { openTaskFullView } = useAppActions();
  const config = useConfig();

  // FLUX-803: the live subagent run group for this chat (lead + ≥1 delegate sharing a groupId).
  // Null for an ordinary single-session chat, so both orchestration surfaces stay absent.
  const runGroup = useMemo(() => selectChatRunGroup(task), [task]);
  const runActive = !!runGroup && runGroup.sessions.some(isActiveSession);
  const openRun = useCallback(() => openTaskFullView(task), [openTaskFullView, task]);
  const stopOne = useCallback((sessionId: string) => { void stopTaskCliSession(task.id, { sessionId }); }, [task.id]);
  const stopAll = useCallback(() => {
    if (runGroup) void stopTaskCliSession(task.id, { groupId: runGroup.groupId });
  }, [task.id, runGroup]);
  // FLUX-694: board task list backing the composer's ticket autocomplete.
  const tickets = useAppSelector((s) => s.tasks) as Task[];
  // FLUX-805: a "suggest a supervisor run" proposal the chat agent emitted (an orchestratable intent
  // recognized in its latest turn) takes precedence over Require-Input quick replies — it renders as a
  // one-click confirm chip that sends the confirmation prompting the agent to launch the proposed fleet.
  const runProposal = useMemo(() => parseRunProposal(chat.messages), [chat.messages]);
  const quickReplies = useMemo(
    () =>
      runProposal
        ? [{ label: runProposal.label, value: runProposal.confirm, tone: 'primary' as const }]
        : parseQuickReplies(task, getRequireInputStatus(config)),
    [runProposal, task, config],
  );
  // FLUX-752: surface a board Require-Input prompt in the chat — status OR the require-input
  // swimlane, matching the full modal's `isRequireInput` predicate.
  const isRequireInput = task.status === getRequireInputStatus(config) || task.swimlane === 'require-input';

  // FLUX-923: composer-as-answer — a single-question ask_user_question parked for this chat (its own id
  // or an unrouted prompt claimed by the single live chat) can be answered from the composer. Mirrors
  // the dock ChatWindow path; multi-question prompts keep to the picker chips. Shared hook.
  const { answerPrompt, onAnswerQuestion } = useComposerAnswer(task.id);

  // FLUX-1362: revision metadata for the in-stream "new revision" markers.
  const artifactMarkers = useMemo(
    () => (task.artifacts?.revisions ?? []).map((r) => ({ rev: r.rev, title: r.title, createdAt: r.createdAt })),
    [task.artifacts?.revisions],
  );

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
      <div className="mb-2 flex items-center justify-between">
        {/* FLUX-1285: this legacy modal has no ChatDock sideview of its own, so the plan-approval
            panel (which mounts per-window inside ChatDock) needs its window opened first — mirrors
            AttentionDock's openToApprovePlan (open the window, then flag it to show the panel). */}
        <button
          type="button"
          onClick={() => { openChat(task.id); openPlanApproval(task.id); }}
          title="Open the full plan-review panel — view, annotate, and (if unresolved) approve or send it back"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-black/5 hover:text-primary dark:text-gray-400 dark:hover:bg-white/5"
        >
          <ClipboardCheck className="h-3.5 w-3.5" /> View Plan
        </button>
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
        answerPrompt={answerPrompt}
        onAnswerQuestion={onAnswerQuestion}
        actions={<TicketActions task={task} variant="compact" />}
        diffBranch={task.branch}
        tickets={tickets}
        meter={<SessionMeter session={task.cliSession} config={config} />}
        presenceRail={runActive ? (
          <ChatPresenceRail group={runGroup!} taskId={task.id} onOpenRun={openRun} onStopSession={stopOne} />
        ) : undefined}
        orchestrationBlock={runGroup ? (
          <ChatOrchestrationBlock group={runGroup} taskId={task.id} onOpenRun={openRun} onStopSession={stopOne} onStopAll={stopAll} />
        ) : undefined}
        artifactMarkers={artifactMarkers}
        // The task modal has no sideview of its own — opening a revision marker pops the chat out to
        // its dock window with the Grooming Artifact viewer revealed (FLUX-887 → FLUX-1362).
        onOpenArtifact={() => {
          openChat(task.id);
          openSideView(task.id);
          setSectionOpen('artifact', true);
        }}
        planReadyPresent={isPlanApprovalPending(task, config)}
      />
    </div>
  );
}

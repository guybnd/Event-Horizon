import { memo, useRef, useEffect, useMemo, useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Bot, X, Settings2 } from 'lucide-react';
import type { Task, CliFramework } from '../types';
import { stopTaskCliSession } from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { FrameworkSelector } from './FrameworkSelector';
import { groupSessions, isActiveSession } from '../orchestration';
import { SessionCard } from './SessionCard';
import { useDockActions } from './DockProvider';
import { usePendingInteractions } from './pendingInteractions';
import { ChatApprovalPanel } from './ApprovalPrompts';
import { ChatQuestionPicker } from './AskQuestionPrompts';

interface Props {
  tasks: Task[];
  onClose: () => void;
}

export const ActiveSessionsPopover = memo(function ActiveSessionsPopover({ tasks, onClose }: Props) {
  const { triggerRefresh, saveConfig } = useAppActions();
  const config = useAppSelector((s) => s.config);
  const { openChat } = useDockActions();
  // Shared pending-interaction queue (one SSE subscription). Reading it here — instead of a local copy —
  // is what makes resolving an approval/question in the popover sync every other surface (FLUX-962).
  const { approvals, questions, singleActiveConversationId } = usePendingInteractions();
  const popoverRef = useRef<HTMLDivElement>(null);
  // Tick once a second so elapsed-time labels stay live while the popover is open.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const handleDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [onClose]);

  const handleStop = useCallback(async (e: ReactMouseEvent, taskId: string) => {
    e.stopPropagation();
    try {
      await stopTaskCliSession(taskId, { stopAll: true });
      triggerRefresh();
    } catch (err) {
      console.error('Failed to stop session:', err);
    }
  }, [triggerRefresh]);

  // Clicking a card opens that session's CHAT in the dock (anchored to the clicked card), not the
  // ticket modal (FLUX-962). Capture the element before onClose unmounts the popover.
  const handleOpen = useCallback((e: ReactMouseEvent, taskId: string) => {
    const el = e.currentTarget as HTMLElement;
    openChat(taskId, el);
    onClose();
  }, [openChat, onClose]);

  const handleAgentChange = useCallback((v: string) => {
    if (config) {
      saveConfig({ ...config, defaultAgent: v as CliFramework | 'auto' });
    }
  }, [config, saveConfig]);

  const activeTasks = useMemo(() =>
    // FLUX-846: `isActiveSession` excludes a session the engine has terminalized (carries `endedAt`)
    // even if its `status` is stale — so a completed session never lingers here as forever-'Working'.
    tasks.filter(t => t.cliSession && isActiveSession(t.cliSession)),
    [tasks]
  );

  // Does this conversation currently have a pending approval/question? Mirrors the match used by the
  // reused panels (strict conversationId for approvals; questions also claim an UNROUTED prompt via
  // the single live chat, FLUX-923) so the card shows the panel — not the blockedReason fallback.
  const hasPendingFor = useCallback((taskId: string) =>
    approvals.some((a) => a.conversationId === taskId) ||
    questions.some((q) => q.conversationId === taskId || (q.conversationId == null && singleActiveConversationId === taskId)),
    [approvals, questions, singleActiveConversationId],
  );

  return (
    <div
      ref={popoverRef}
      className="absolute right-0 top-full z-[100] mt-2 w-[400px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-gray-200 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95"
    >
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-white/5">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Agent Management</h3>
        <button onClick={onClose} className="rounded-md p-1 transition-colors hover:bg-gray-100 dark:hover:bg-white/10">
          <X className="h-4 w-4 text-gray-400" />
        </button>
      </div>

      <div className="border-b border-gray-100 bg-gray-50/50 p-3 dark:border-white/5 dark:bg-white/5">
        <div className="flex flex-col gap-1.5">
           <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
             <Settings2 className="h-3 w-3" />
             Default Agent
           </div>
           <FrameworkSelector
             value={config?.defaultAgent || 'auto'}
             onChange={handleAgentChange}
             showAuto
             allowedFrameworks={['auto', 'claude', 'gemini', 'copilot']}
           />
        </div>
      </div>

      <div className="max-h-[380px] space-y-2 overflow-y-auto p-2">
        <div className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">
           <Bot className="h-3 w-3" />
           Active Sessions
        </div>
        {activeTasks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-gray-500">
              <Bot className="h-6 w-6" />
            </div>
            <div className="text-sm font-semibold text-gray-600 dark:text-gray-300">No agents running</div>
            <p className="max-w-[240px] text-xs leading-relaxed text-gray-400 dark:text-gray-500">
              Start an agent on a ticket and its live progress — activity, output, tokens and orchestration — shows up here.
            </p>
          </div>
        ) : (
          activeTasks.map(task => {
            const groups = groupSessions(task.cliSessions);
            const multi = groups.find(g => g.isMulti && g.sessions.some(isActiveSession));
            const pendingSlot = (
              <>
                <ChatApprovalPanel conversationId={task.id} />
                <ChatQuestionPicker conversationId={task.id} />
              </>
            );
            return (
              <SessionCard
                key={task.id}
                task={task}
                now={now}
                config={config}
                variant="full"
                session={multi ? null : task.cliSession}
                group={multi ?? null}
                onOpen={(e) => handleOpen(e, task.id)}
                onStop={(e) => handleStop(e, task.id)}
                pendingSlot={pendingSlot}
                hasPendingInteraction={hasPendingFor(task.id)}
              />
            );
          })
        )}
      </div>

      {activeTasks.length > 0 && (
        <div className="border-t border-gray-100 bg-gray-50 p-2 dark:border-white/5 dark:bg-black/20">
           <p className="text-center text-[9px] font-bold uppercase tracking-widest text-gray-400">
             {activeTasks.length} session{activeTasks.length > 1 ? 's' : ''} running
           </p>
        </div>
      )}
    </div>
  );
});

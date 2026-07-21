// FLUX-715: the board card's action cluster is now a thin adapter over the unified ticket-action
// renderer. All status→action logic (launch split-buttons, the Ready Review/Return/Finish cluster,
// template menus) lives in the shared registry + `useTicketActions` hook; the card just renders the
// `card` variant from the controller's shared instance. The launcher / start-prompt portals are
// rendered by <TicketActionsLaunchers> in TaskCard.
//
// FLUX-1603: while a session is LIVE on the ticket, the normal action cluster (Implement/Continue/
// Review/Finish/Move-to…) is irrelevant — launching another agent would 409/supersede the live one,
// and moving status mid-run is wrong. Swap the whole cluster for a single Stop button instead, in
// the same hover-reveal slot. Gate on `c.sessionState` (the live-SSE-derived signal `CardSessionRow`'s
// pill and ContextMenu's "Stop agent session" item already key off) rather than the polled
// `task.cliSession.status`, so this can't disagree with those at a turn boundary. `failed` is
// deliberately excluded — the normal buttons + CardSessionRow's Retry affordance stay.
import { useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import type { Task } from '../../types';
import type { TaskCardController } from '../../hooks/useTaskCardController';
import { TicketActionsView } from '../ticket-actions/TicketActions';
import { stopTaskCliSession } from '../../api';
import { ACTIVE_SESSION_STATUSES } from '../../orchestration';

export function CardActionButtons({ task, c }: { task: Task; c: TaskCardController }) {
  const sessionLive = (c.sessionState !== 'none' && c.sessionState !== 'failed') || !!c.clusterGroup;

  if (!sessionLive) {
    return <TicketActionsView ctl={c.ticketActions} variant="card" onActiveChange={c.setActionMenuActive} />;
  }

  return <StopOnlyControl task={task} />;
}

function StopOnlyControl({ task }: { task: Task }) {
  const [busy, setBusy] = useState(false);

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      // FLUX-918 (m3): a multi-agent/orchestration run has several live sessions at once — a bare
      // stop only cancels the most recent, leaving siblings running. Mirrors ContextMenu's
      // handleStopSession scoping verbatim.
      const activeSessionCount = (task.cliSessions ?? []).filter((s) => ACTIVE_SESSION_STATUSES.includes(s.status)).length;
      await stopTaskCliSession(task.id, activeSessionCount > 1 ? { stopAll: true } : undefined);
    } catch (err) {
      console.error('Failed to stop agent session:', err instanceof Error ? err.message : err);
    } finally {
      setBusy(false);
    }
  };

  // Same hover-reveal chrome the normal action cluster uses (TicketActionsView's card branch) so
  // the card's resting height/appearance is unchanged — Stop only appears on hover, in that slot.
  return (
    <div className="relative flex items-center justify-end gap-1.5 mt-0 max-h-0 overflow-hidden opacity-0 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:mt-2 group-hover:max-h-40 group-hover:overflow-visible group-hover:opacity-100">
      <button
        type="button"
        onClick={(e) => void handleStop(e)}
        disabled={busy}
        className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
        Stop
      </button>
    </div>
  );
}

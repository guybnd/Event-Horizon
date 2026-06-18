import { useState } from 'react';
import type { JSX } from 'react';
import { GitMerge, ChevronDown, ChevronRight, Check, X, Clock, AlertTriangle, Layers, ShieldCheck, Loader2, Bot, Wrench, RotateCcw, Undo2 } from 'lucide-react';
import type { Task } from '../types';
import { useApp } from '../AppContext';
import type { TaskCardController } from '../hooks/useTaskCardController';
import { TaskCard } from './TaskCard';
import { mergePr, retryPr, updateTask } from '../api';
import { launchPhaseDefault } from '../agentActions';
import { resolveEffectiveAgent } from '../utils';

// Shared PR action-button classes — equal-width (flex-1) + centered so the bar is symmetrical
// regardless of label length. Module-level so they're allocated once, not per render.
const PR_BTN = 'flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50';
const PR_BTN_PRIMARY = `${PR_BTN} bg-violet-600 text-white hover:bg-violet-700`;
const PR_BTN_OUTLINE = `${PR_BTN} border border-gray-200 text-gray-600 hover:border-violet-300 hover:bg-violet-50/60 hover:text-violet-700 dark:border-white/10 dark:text-gray-300 dark:hover:bg-violet-500/10`;
const PR_BTN_SECONDARY = `${PR_BTN} border border-gray-200 font-medium text-gray-500 hover:bg-gray-100 dark:border-white/10 dark:text-gray-400 dark:hover:bg-white/5`;
const PR_BTN_AMBER = `${PR_BTN} border border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10`;
const PR_BTN_VIOLET = `${PR_BTN} border border-violet-200 text-violet-700 hover:bg-violet-50/60 dark:border-violet-500/30 dark:text-violet-300 dark:hover:bg-violet-500/10`;

/**
 * The PR-specific BODY of a PR ticket's card (FLUX-567). Rendered INSIDE TaskCard when
 * `kind:'pr'`, so the PR card inherits the whole TaskCard shell — running-agent indicator,
 * right-click context menu, comment badge, and the review launcher (we reuse the
 * controller's `reviewModalOpen`). This section adds only the PR bits: state/review chips,
 * the folded-members deck (unwind → real compact member cards), and the PR action bar
 * (Review → launcher · Merge → squash-merge+advance · Open → full surface). The deck/fold
 * mechanic here is the primitive epics (FLUX-580) will reuse.
 */
export function PrDeckSection({ task, c }: { task: Task; c: TaskCardController }) {
  const { taskById, triggerRefresh, currentUser, config } = useApp();
  const [unwound, setUnwound] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeErr, setMergeErr] = useState('');
  // Retry-PR prompt (FLUX-593) — shown on a merged/closed PR card.
  const [retrying, setRetrying] = useState(false);
  const [retryReason, setRetryReason] = useState('');
  const [retryBranch, setRetryBranch] = useState(true);
  const [retryStart, setRetryStart] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryErr, setRetryErr] = useState('');
  // Rework prompt (FLUX-593) — sending an OPEN PR back to In Progress with the issue captured.
  const [reworking, setReworking] = useState(false);
  const [reworkReason, setReworkReason] = useState('');
  const [reworkStart, setReworkStart] = useState(false);
  const [reworkBusy, setReworkBusy] = useState(false);
  const [reworkErr, setReworkErr] = useState('');

  const members = (task.members ?? []).map((id) => taskById.get(id)).filter((t): t is Task => !!t);
  const memberCount = members.length;
  const changesRequested = task.swimlane === 'changes-requested';
  // Hide the open action bar (Review/Merge) once the PR is merged/closed OR the card is Done.
  const isResolved = task.prState === 'MERGED' || task.prState === 'CLOSED' || task.status === 'Done';
  // Retry on a SETTLED (Done) PR — merged (work landed but didn't hold) OR closed (abandoned
  // and worth another pass). Gated on status Done (a PR ticket only reaches Done once resolved)
  // so it never shows on a still-active card.
  const canRetry = task.status === 'Done';

  const doMerge = async () => {
    setMerging(true);
    setMergeErr('');
    try {
      await mergePr(task.id);
      triggerRefresh();
    } catch (e) {
      setMergeErr(e instanceof Error ? e.message : 'Merge failed');
    } finally {
      setMerging(false);
      setConfirmMerge(false);
    }
  };

  // Rework an OPEN PR (FLUX-593): you spotted an issue pre-merge → record what's wrong as a
  // comment on the PR, move it back to In Progress (same branch, no new ticket — syncPrTickets
  // preserves the status), and optionally launch a dev agent to address it.
  const doRework = async () => {
    const reason = reworkReason.trim();
    if (!reason) { setReworkErr('Describe what needs fixing.'); return; }
    setReworkBusy(true);
    setReworkErr('');
    try {
      await updateTask(task.id, {
        status: 'In Progress',
        updatedBy: currentUser,
        appendHistory: [{ type: 'comment', user: currentUser, comment: `Sent back to dev — issue found before merge:\n\n${reason}` }],
      } as Partial<Task>);
      if (reworkStart) {
        await launchPhaseDefault({
          taskId: task.id,
          framework: resolveEffectiveAgent(undefined, config?.defaultAgent),
          phase: 'implementation',
          currentUser,
          phaseDefaults: config?.phaseDefaults,
        }).catch(() => {});
      }
      triggerRefresh();
      setReworking(false);
      setReworkReason('');
    } catch (e) {
      setReworkErr(e instanceof Error ? e.message : 'Failed to send back to dev');
    } finally {
      setReworkBusy(false);
    }
  };

  // Retry a merged/closed PR: spawn a fresh linked ticket (reason + PR context), optionally on
  // a branch, optionally auto-launching a dev agent. Start-agent implies a branch (FLUX-593).
  const doRetry = async () => {
    const reason = retryReason.trim();
    if (!reason) { setRetryErr('A reason is required.'); return; }
    setRetryBusy(true);
    setRetryErr('');
    try {
      const { id } = await retryPr(task.id, { reason, createBranch: retryBranch || retryStart, updatedBy: currentUser });
      if (retryStart) {
        await launchPhaseDefault({
          taskId: id,
          framework: resolveEffectiveAgent(undefined, config?.defaultAgent),
          phase: 'implementation',
          currentUser,
          phaseDefaults: config?.phaseDefaults,
        }).catch(() => {});
      }
      triggerRefresh();
      setRetrying(false);
      setRetryReason('');
    } catch (e) {
      setRetryErr(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setRetryBusy(false);
    }
  };

  return (
    <div onClick={(e) => e.stopPropagation()}>
      {/* Status chips */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {prStateChip(task.prState)}
        {changesRequested && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
            <AlertTriangle className="h-3 w-3" /> Changes requested
          </span>
        )}
        {reviewChip(task.reviewDecision ?? null)}
        {/* Single-session running badge — when an agent (e.g. a review) runs ON the PR but
            isn't a live orchestration (no CardClusterPanel). Multi/orchestration sessions show
            the full HAND-OFF panel above instead. FLUX-567 regression fix. */}
        {!c.clusterGroup && c.hasActiveCliSession && task.cliSession && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 bot-assignee-glow">
            <Bot className="h-3 w-3" /> {task.cliSession.label}{c.currentActivity ? ` · ${c.currentActivity}` : ''}
          </span>
        )}
      </div>

      {/* Deck — folded members */}
      {memberCount > 0 ? (
        <div className="mb-1">
          <button
            onClick={() => setUnwound((u) => !u)}
            aria-expanded={unwound}
            aria-controls={`pr-deck-${task.id}`}
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-100/60 dark:text-violet-300 dark:hover:bg-violet-500/10"
          >
            {unwound ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <Layers className="h-3.5 w-3.5" />
            {memberCount} ticket{memberCount === 1 ? '' : 's'} in this PR
          </button>
          {unwound && (
            <div id={`pr-deck-${task.id}`} className="mt-1.5 border-l-2 border-violet-200 pl-2 dark:border-violet-500/30">
              {members.map((m) => (
                <TaskCard key={m.id} task={m} compact hideStatusBadge />
              ))}
            </div>
          )}
        </div>
      ) : (
        <p className="mb-1 text-[11px] italic text-gray-500 dark:text-gray-400">No tickets folded in yet — start work on a linked ticket to fold it in.</p>
      )}

      {/* PR-level actions — Review opens the launcher (reusing the controller's, which TaskCard
          renders); Merge squash-merges + advances members; Open shows the full PR surface.
          Hover-revealed to save space (like the grooming/todo card actions); forced open while
          the merge-confirm is active so it doesn't vanish mid-interaction (FLUX-593). */}
      {!isResolved && (reworking ? (
        <div className="mt-2 border-t border-violet-200/60 pt-2 dark:border-violet-500/20">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">Send back to dev</p>
          <textarea
            autoFocus
            value={reworkReason}
            onChange={(e) => setReworkReason(e.target.value)}
            placeholder="What needs fixing? (recorded on the PR + handed to whoever picks it up)"
            rows={2}
            className="w-full resize-none rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-800 outline-none focus:border-violet-400 dark:border-white/10 dark:bg-[#1f2028] dark:text-gray-100"
          />
          <label className="mt-1.5 flex cursor-pointer items-center gap-1 text-[10px] font-medium text-gray-600 dark:text-gray-300">
            <input type="checkbox" checked={reworkStart} onChange={(e) => setReworkStart(e.target.checked)} />
            Start a dev agent now (else just move it back)
          </label>
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <button disabled={reworkBusy || !reworkReason.trim()} onClick={doRework} className="flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50">
              {reworkBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />}
              {reworkBusy ? 'Sending…' : 'Send to dev'}
            </button>
            <button disabled={reworkBusy} onClick={() => { setReworking(false); setReworkErr(''); }} className="rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-white/5">Cancel</button>
          </div>
          {reworkErr && <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{reworkErr}</p>}
        </div>
      ) : (
        <div className={`flex items-center gap-1 border-violet-200/60 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] dark:border-violet-500/20 ${confirmMerge ? 'mt-2 max-h-40 overflow-visible border-t pt-2 opacity-100' : 'mt-0 max-h-0 overflow-hidden opacity-0 group-hover:mt-2 group-hover:max-h-20 group-hover:overflow-visible group-hover:border-t group-hover:pt-2 group-hover:opacity-100'}`}>
          {confirmMerge ? (
            <>
              <span className="mr-auto text-[11px] font-medium text-gray-600 dark:text-gray-300">Merge &amp; advance?</span>
              <button
                disabled={merging}
                onClick={doMerge}
                className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                {merging ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
                {merging ? 'Merging…' : 'Confirm'}
              </button>
              <button disabled={merging} onClick={() => setConfirmMerge(false)} className="rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-white/5">Cancel</button>
            </>
          ) : (
            <>
              {/* State-aware actions (FLUX-568/593):
                  - Active work (changes requested OR already In Progress) → Continue development
                    leads (launches a dev agent on the branch); primary when changes were requested.
                  - Awaiting (Ready) → Review + "Back to dev" (kick an open PR back to In Progress
                    when you spot an issue pre-merge — keeps the same branch). Merge is primary
                    unless changes were requested. All equal-width (flex-1) so the bar is symmetrical. */}
              {(changesRequested || task.status === 'In Progress') ? (
                <button
                  onClick={() => c.openLauncherInPhase('implementation')}
                  title="Continue development — launch a dev agent on this PR's branch"
                  className={changesRequested ? PR_BTN_PRIMARY : PR_BTN_OUTLINE}
                >
                  <Wrench className="h-3 w-3" /> Continue dev
                </button>
              ) : (
                <>
                  <button
                    onClick={() => c.openLauncherInPhase('review')}
                    title="Send for review — pick a reviewer agent/template and launch"
                    className={PR_BTN_OUTLINE}
                  >
                    <ShieldCheck className="h-3 w-3" /> Review
                  </button>
                  <button
                    onClick={() => { setReworkErr(''); setReworking(true); }}
                    title="Found an issue — send this open PR back to In Progress with a note on what to fix"
                    className={PR_BTN_AMBER}
                  >
                    <Undo2 className="h-3 w-3" /> Rework
                  </button>
                </>
              )}
              <button
                onClick={() => { setMergeErr(''); setConfirmMerge(true); }}
                title={changesRequested ? 'Merge anyway — review requested changes (squash-merge + advance tickets to Done)' : 'Squash-merge this PR and advance its tickets to Done'}
                className={changesRequested ? PR_BTN_SECONDARY : PR_BTN_PRIMARY}
              >
                <GitMerge className="h-3 w-3" /> Merge
              </button>
            </>
          )}
        </div>
      ))}

      {/* Settled (Done) PR → Retry (FLUX-593): a merged/closed PR is immutable, so this spawns
          a FRESH linked ticket carrying the reason + the PR's context (optionally a branch /
          auto-launched agent), rather than un-merging. Gated on status Done so it never shows
          on a still-active PR card; the resting button is hover-revealed to save space. */}
      {canRetry && (
        retrying ? (
          <div className="mt-2 border-t border-violet-200/60 pt-2 dark:border-violet-500/20">
            <textarea
              autoFocus
              value={retryReason}
              onChange={(e) => setRetryReason(e.target.value)}
              placeholder="Why retry? What still needs fixing…"
              rows={2}
              className="w-full resize-none rounded-md border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-800 outline-none focus:border-violet-400 dark:border-white/10 dark:bg-[#1f2028] dark:text-gray-100"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-medium text-gray-600 dark:text-gray-300">
              <label className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={retryBranch || retryStart} disabled={retryStart} onChange={(e) => setRetryBranch(e.target.checked)} />
                Create branch
              </label>
              <label className="flex cursor-pointer items-center gap-1">
                <input type="checkbox" checked={retryStart} onChange={(e) => setRetryStart(e.target.checked)} />
                Start agent now
              </label>
            </div>
            <div className="mt-1.5 flex items-center justify-end gap-1">
              <button
                disabled={retryBusy || !retryReason.trim()}
                onClick={doRetry}
                className="flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
              >
                {retryBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                {retryBusy ? 'Creating…' : 'Create retry'}
              </button>
              <button disabled={retryBusy} onClick={() => { setRetrying(false); setRetryErr(''); }} className="rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-white/5">Cancel</button>
            </div>
            {retryErr && <p role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-400">{retryErr}</p>}
          </div>
        ) : (
          <div className="mt-0 flex max-h-0 items-center gap-1 overflow-hidden border-violet-200/60 opacity-0 transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:mt-2 group-hover:max-h-12 group-hover:overflow-visible group-hover:border-t group-hover:pt-2 group-hover:opacity-100 dark:border-violet-500/20">
            <button
              onClick={() => { setRetryErr(''); setRetrying(true); }}
              title="Retry this PR — spawn a fresh ticket (with your reason + this PR's context) to continue the work"
              className={PR_BTN_VIOLET}
            >
              <RotateCcw className="h-3 w-3" /> Retry PR
            </button>
          </div>
        )
      )}
      {mergeErr && <p role="alert" className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">{mergeErr}</p>}
    </div>
  );
}

function prStateChip(state?: string) {
  const map: Record<string, { cls: string; label: string; icon?: JSX.Element }> = {
    OPEN: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', label: 'Open' },
    MERGED: { cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', label: 'Merged', icon: <GitMerge className="h-3 w-3" /> },
    CLOSED: { cls: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400', label: 'Closed' },
  };
  const m = map[state ?? 'OPEN'] ?? map.OPEN;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${m.cls}`}>{m.icon}{m.label}</span>;
}

function reviewChip(decision: string | null) {
  if (!decision) return null;
  const map: Record<string, { cls: string; icon: JSX.Element }> = {
    APPROVED: { cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', icon: <Check className="h-3 w-3" /> },
    CHANGES_REQUESTED: { cls: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300', icon: <X className="h-3 w-3" /> },
    REVIEW_REQUIRED: { cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300', icon: <Clock className="h-3 w-3" /> },
  };
  const m = map[decision];
  if (!m) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize ${m.cls}`}>
      {m.icon}{decision.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

import { useState } from 'react';
import { Bot, Hammer, PauseCircle, XCircle, CheckCircle2, ChevronUp, Maximize2, Circle, Search, Eye, Flag, Clock } from 'lucide-react';
import type { Task } from '../types';
import type { BatchTicket } from '../furnaceTypes';
import { getMemberState, MEMBER_STATE_META, ACTIVE_MEMBER_STATES, type MemberState } from '../lib/memberState';
import { useLiveSession, useFurnaceTicket } from '../store/useAppSelector';
import { TaskCard } from './TaskCard';

/** State glyph: a pulsing icon for the live phase-labeled states (grooming/implementing/reviewing/
 *  finalizing); distinct static icons for tempering/parked/failed/stalled (a live session gone
 *  quiet never pulses — that's the whole point); a plain dot for the neutral/terminal states
 *  (done/ready/queued). */
function StateGlyph({ state }: { state: MemberState }) {
  const color = MEMBER_STATE_META[state].glyphColor;
  switch (state) {
    case 'implementing':
      return <Bot className="h-3 w-3 shrink-0 animate-pulse" style={{ color }} aria-hidden />;
    case 'grooming':
      return <Search className="h-3 w-3 shrink-0 animate-pulse" style={{ color }} aria-hidden />;
    case 'reviewing':
      return <Eye className="h-3 w-3 shrink-0 animate-pulse" style={{ color }} aria-hidden />;
    case 'finalizing':
      return <Flag className="h-3 w-3 shrink-0 animate-pulse" style={{ color }} aria-hidden />;
    case 'stalled':
      return <Clock className="h-3 w-3 shrink-0" style={{ color }} aria-hidden />;
    case 'tempering':
      return <Hammer className="h-3 w-3 shrink-0" style={{ color }} aria-hidden />;
    case 'parked':
      return <PauseCircle className="h-3 w-3 shrink-0" style={{ color }} aria-hidden />;
    case 'failed':
      return <XCircle className="h-3 w-3 shrink-0" style={{ color }} aria-hidden />;
    default:
      return <Circle className="h-2 w-2 shrink-0 fill-current" style={{ color }} aria-hidden />;
  }
}

/**
 * Shared folded-member line (FLUX-1503) — reused by the PR deck and epic deck. Collapsed by
 * default: state glyph, monospace ticket id (always shown), truncated live-activity-or-title,
 * review verdict flag (only when `reviewState` is set), state label, expand affordance. Clicking
 * toggles to the full non-draggable `TaskCard` in place; clicking again collapses back to the
 * line. Owns its own expand/collapse state so PR and epic decks don't need to coordinate it —
 * ALWAYS collapsible by the user regardless of live-session state (no FLUX-1422 force-open here).
 */
export function MemberLine({ task, parentTask, batchTicket }: { task: Task; parentTask?: Task; batchTicket?: BatchTicket }) {
  const [expanded, setExpanded] = useState(false);
  const liveSession = useLiveSession(task.id);
  // FLUX-1503: resolve the batch ticket via the per-id store selector when the caller doesn't
  // already have it handy — same FLUX-626 isolation as `useLiveSession` above, so an unrelated
  // furnace tick only re-renders the ONE member line it actually touches, not every line on the
  // board. An explicit `batchTicket` prop (e.g. already resolved by a caller) wins when given.
  const batchTicketFromStore = useFurnaceTicket(task.id);
  const resolvedBatchTicket = batchTicket ?? batchTicketFromStore;
  const state = getMemberState(task, resolvedBatchTicket);
  const meta = MEMBER_STATE_META[state];

  if (expanded) {
    return (
      <div className="mb-1">
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mb-0.5 flex w-full items-center justify-center gap-1 rounded-md py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-400 transition-colors hover:bg-indigo-100/50 dark:hover:bg-indigo-500/10"
          title="Collapse back to line"
        >
          <ChevronUp className="h-2.5 w-2.5" /> collapse
        </button>
        <TaskCard task={task} parentTask={parentTask} />
      </div>
    );
  }

  // FLUX-1532: the line always shows the ticket's real title — the harness spinner verb
  // (`currentActivity`, e.g. "Thinking"/"Working") is content-free on its own, so it never replaces
  // the title as line text; it moves into the tooltip instead, and only while `state` is one of the
  // phase-labeled live states — gating on `state` (not raw session presence) means a finished or
  // stalled session's persisted `currentActivity` can never leak into the tooltip as if still live.
  const titleText = task.title || task.id;
  const liveActivity = ACTIVE_MEMBER_STATES.has(state)
    ? liveSession?.currentActivity ?? task.cliSession?.currentActivity
    : undefined;
  const attempts = task.temperAttempts ?? resolvedBatchTicket?.attempts;
  const label = state === 'tempering' && attempts && attempts > 0 ? `${meta.label} · attempt ${attempts}` : meta.label;
  const tooltip = `${task.id} · ${titleText}${liveActivity ? ` — ${liveActivity}` : ''} · ${label}`;

  return (
    <div className="group relative mb-1">
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={tooltip}
        className="flex w-full items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2 py-1 text-left shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-[#1c1d26] dark:hover:bg-gray-800/60"
      >
        <StateGlyph state={state} />
        <span className="shrink-0 font-mono text-[10px] text-gray-500 dark:text-gray-400">{task.id}</span>
        <span className="min-w-0 flex-1 line-clamp-1 group-hover:line-clamp-3 text-[11px] text-gray-700 dark:text-gray-200">
          {titleText}
        </span>
        {task.reviewState === 'approved' && <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden />}
        {task.reviewState === 'changes-requested' && <XCircle className="h-3 w-3 shrink-0 text-red-500" aria-hidden />}
        <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
          {label}
        </span>
        <Maximize2 className="h-3 w-3 shrink-0 text-gray-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </button>
    </div>
  );
}

export interface MemberStripItem {
  task: Task;
  batchTicket?: BatchTicket;
  /** FLUX-1503: set when this member is ALSO folded into a PR's own deck (PR precedence hides it
   *  from its epic's deck) — surfaced in the segment tooltip as "in PR-n" so the epic-card rollup
   *  strip doesn't silently omit where a cross-PR member actually lives. */
  prTicketId?: string;
}

/**
 * Segmented state strip (FLUX-1503) — one thin segment per member, colored by its resolved
 * `MemberState`. Pure/presentational: resolves state per item via `getMemberState`, but does not
 * reach into the store itself (perf — batch/live lookups are the consumer's job). `order` sorts
 * the segments (PR = burn order, epic/ghost = sorted-by-state); omit to use input order.
 */
export function MemberStateStrip({
  members,
  order,
  className,
  onSegmentClick,
}: {
  members: MemberStripItem[];
  order?: (item: MemberStripItem) => number;
  className?: string;
  onSegmentClick?: (task: Task) => void;
}) {
  if (members.length === 0) return null;
  const sorted = order ? [...members].sort((a, b) => order(a) - order(b)) : members;

  return (
    <div className={`flex items-center gap-px overflow-hidden rounded-full ${className ?? ''}`}>
      {sorted.map(({ task, batchTicket, prTicketId }) => (
        <MemberSegment key={task.id} task={task} batchTicket={batchTicket} prTicketId={prTicketId} onSegmentClick={onSegmentClick} />
      ))}
    </div>
  );
}

/** One strip segment, its own component so it can call `useFurnaceTicket` per-id (FLUX-626
 *  isolation) — a `.map()` callback can't safely call hooks per-iteration since the member list
 *  can change length/order across renders. */
function MemberSegment({
  task,
  batchTicket,
  prTicketId,
  onSegmentClick,
}: {
  task: Task;
  batchTicket?: BatchTicket;
  prTicketId?: string;
  onSegmentClick?: (task: Task) => void;
}) {
  const batchTicketFromStore = useFurnaceTicket(task.id);
  const resolvedBatchTicket = batchTicket ?? batchTicketFromStore;
  const state = getMemberState(task, resolvedBatchTicket);
  const meta = MEMBER_STATE_META[state];
  const attempts = task.temperAttempts ?? resolvedBatchTicket?.attempts;
  const tooltip = `${task.id} · ${state}${state === 'tempering' && attempts ? ` · attempt ${attempts}` : ''}${prTicketId ? ` · in ${prTicketId}` : ''}`;
  const className = 'h-1.5 min-w-[3px] flex-1 transition-opacity hover:opacity-80';
  const style = { backgroundColor: meta.color };

  // FLUX-1503 review fix: some consumers (e.g. CardSubtaskProgress, EpicGhostCard) render the
  // strip INSIDE their own parent <button> and rely on that outer click, never passing
  // `onSegmentClick` — an inner <button> there would be invalid `<button>`-in-`<button>` HTML
  // (React hydration warning) plus a keyboard-a11y regression (empty focusable tab stops). Only
  // render an interactive control when a click handler is actually supplied.
  if (!onSegmentClick) {
    return <span title={tooltip} className={className} style={style} aria-label={tooltip} />;
  }

  return (
    <button
      type="button"
      title={tooltip}
      onClick={() => onSegmentClick(task)}
      className={className}
      style={style}
      aria-label={tooltip}
    />
  );
}

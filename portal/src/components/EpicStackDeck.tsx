import { useState } from 'react';
import { Layers, ArrowUpRight } from 'lucide-react';
import type { Task, Config } from '../types';
import { useAppSelector } from '../store/useAppSelector';
import { getStatusColorClass } from '../statusStyles';
import { normalizeStatus } from '../workflow';
import { TaskDeck } from './TaskDeck';
import { MemberStateStrip, type MemberStripItem } from './MemberLine';
import { getMemberState, MEMBER_STATE_META, MEMBER_STATE_ORDER, PINNED_MEMBER_STATES } from '../lib/memberState';
import { ContextMenu } from './ContextMenu';

/**
 * Epic subtask deck (FLUX-699; FLUX-1503 replaced the peek/individually-expand mechanic with the
 * shared pin/hide `TaskDeck` body — members with a live or actionable state (tempering/
 * implementing/parked/failed) are ALWAYS pinned as a `MemberLine`, superseding the old FLUX-1422
 * force-open entirely: a pinned line is never forced open OR forced collapsed, the user is always
 * in control). The epic is the TOP card of a real deck: its full card is rendered by the column
 * ABOVE this component (same-column case) or by the reduced "ghost" card below (cross-column case).
 *
 * Two placements:
 *  - **Same-column** (no `epic` prop): the real epic card sits above; render just the deck.
 *  - **Cross-column** (`epic` set): the epic lives elsewhere, so render a reduced ~half-height
 *    "ghost" card of the epic (id · status · title · state strip · "K here", click-through) on top.
 */
export function EpicStackDeck({
  items,
  idPrefix,
  epic,
  epicSubtasks,
  openEpic,
}: {
  /** This column's slice of the epic's subtasks. Live/actionable ones pin as `MemberLine`s; the
   *  rest fold behind a toggle. */
  items: Task[];
  /** Stable id prefix for the deck's unwound container (aria-controls target). */
  idPrefix: string;
  /** Cross-column case: the epic these subtasks belong to (lives in another column). */
  epic?: Task;
  /** Cross-column case: the epic's FULL resolved subtask set (not just this column's cluster) —
   *  the ghost card's strip summarizes the epic's overall state, matching the pre-FLUX-1503
   *  `epicProgress` contract ("shows the epic's OVERALL completion, not just this column's
   *  cluster"). Falls back to `items` if omitted. */
  epicSubtasks?: Task[];
  /** Open the real epic (ghost-card click-through). */
  openEpic?: (task: Task) => void;
}) {
  const config = useAppSelector((s) => s.config);
  const furnaceTicketById = useAppSelector((s) => s.furnaceTicketById);
  if (items.length === 0) return null;

  const count = items.length;
  const stateOrder = (t: Task) => MEMBER_STATE_ORDER[getMemberState(t, furnaceTicketById[t.id])];

  return (
    // Same-column: pulled up under the epic card (cancels its mb-4) so the epic reads as the deck's
    // top card. Cross-column: the ghost card below is the top card, so no pull-up.
    <div id={`${idPrefix}-deck`} className={`relative ${epic ? '' : '-mt-3'} mb-3`} onClick={(e) => e.stopPropagation()}>
      {epic && (
        <EpicGhostCard
          epic={epic}
          subtasks={epicSubtasks ?? items}
          hereCount={count}
          openEpic={openEpic}
          config={config}
        />
      )}

      {/* Slim deck header: count + per-status breakdown dots (state-vocab colored for a pinned
          state, raw board-status colored otherwise — "temper/parked overlay wins"). */}
      <div className="flex items-center gap-1.5 px-1.5 pb-0.5 pt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500/80 dark:text-indigo-300/70">
          {count} subtask{count === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-[3px]">
          {items.slice(0, 14).map((t) => {
            const state = getMemberState(t, furnaceTicketById[t.id]);
            const overlay = PINNED_MEMBER_STATES.has(state);
            return (
              <span
                key={t.id}
                className={overlay ? 'h-1.5 w-1.5 rounded-full' : `h-1.5 w-1.5 rounded-full ${statusDot(getStatusColorClass(config, t.status))}`}
                style={overlay ? { backgroundColor: MEMBER_STATE_META[state].color } : undefined}
                title={`${t.id} · ${overlay ? MEMBER_STATE_META[state].label : normalizeStatus(t.status)}`}
              />
            );
          })}
        </div>
      </div>

      <div className="px-1.5">
        <TaskDeck
          id={`${idPrefix}-members`}
          items={items}
          label={(n) => `${n} more subtask${n === 1 ? '' : 's'}`}
          accent="indigo"
          order={stateOrder}
        />
      </div>
    </div>
  );
}

/**
 * Cross-column "ghost" of an epic that lives in another column (FLUX-699). ~Half a normal card:
 * id + status badge + full (2-line) title + a member-state strip (FLUX-1503, replaced the plain
 * done/total bar) + "K here · open epic". Click-through.
 */
function EpicGhostCard({
  epic,
  subtasks,
  hereCount,
  openEpic,
  config,
}: {
  epic: Task;
  subtasks: Task[];
  hereCount: number;
  openEpic?: (task: Task) => void;
  config: Config | null;
}) {
  const stripMembers: MemberStripItem[] = subtasks.map((task) => ({ task }));
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); openEpic?.(epic); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxPos({ x: e.clientX, y: e.clientY }); }}
        title={`Open ${epic.id} (right-click for actions)`}
        className="group/ghost flex w-full items-start gap-2 rounded-xl border border-l-[3px] border-indigo-300 border-l-indigo-400 bg-indigo-50/60 px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-indigo-100/60 dark:border-indigo-500/30 dark:border-l-indigo-500 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/15"
      >
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-300" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-indigo-400 dark:text-indigo-400/80">{epic.id}</span>
            <span className={`rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${getStatusColorClass(config, epic.status)}`}>
              {normalizeStatus(epic.status)}
            </span>
            <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-indigo-400 opacity-60 transition-opacity group-hover/ghost:opacity-100" />
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px] font-semibold text-indigo-900 dark:text-indigo-100">
            {epic.title || epic.id}
          </div>
          {stripMembers.length > 0 && (
            <div className="mt-1">
              <MemberStateStrip members={stripMembers} order={(item) => MEMBER_STATE_ORDER[getMemberState(item.task, item.batchTicket)]} className="h-1" />
            </div>
          )}
          <div className="mt-0.5 text-[10px] text-indigo-500/70 dark:text-indigo-300/60">
            {hereCount} here · open epic
          </div>
        </div>
      </button>
      {ctxPos && (
        // Right-click acts on the real epic (status, priority, assignee, archive, …); "launch" routes
        // to opening the epic, where the inline launcher lives (FLUX-699).
        <ContextMenu
          task={epic}
          position={ctxPos}
          onClose={() => setCtxPos(null)}
          onLaunchAgent={() => { setCtxPos(null); openEpic?.(epic); }}
        />
      )}
    </>
  );
}

/** Pull just the background colour out of a status colour class so a dot can tint by status. */
function statusDot(colorClass: string): string {
  const bg = colorClass.split(/\s+/).find((c) => c.startsWith('bg-') && !c.startsWith('bg-opacity'));
  return bg ?? 'bg-gray-300 dark:bg-gray-600';
}

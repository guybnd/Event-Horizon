import { useState, type MouseEvent } from 'react';
import { Layers, ArrowUpRight, Maximize2, ChevronUp } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Task, Config } from '../types';
import { TaskCard } from './TaskCard';
import { ContextMenu } from './ContextMenu';
import { CardChatButton } from './task-card/CardChatButton';
import { useAppSelector } from '../store/useAppSelector';
import { getStatusColorClass } from '../statusStyles';

/**
 * Epic subtask deck (FLUX-699). The epic is the TOP card of a real deck: its full card is rendered
 * by the column ABOVE this component, and each subtask "peeks" out directly beneath it as the title
 * sliver of the next card down. Peeks LIFT on hover and expand **individually** into full,
 * interactive (non-draggable) `TaskCard`s — so on a big epic you open only the ones you care about,
 * not all-or-nothing. An "expand all" escape hatch + a status breakdown live in a slim deck header.
 *
 * Two placements:
 *  - **Same-column** (no `epic` prop): the real epic card sits above; render just the deck.
 *  - **Cross-column** (`epic` set): the epic lives elsewhere, so render a reduced ~half-height
 *    "ghost" card of the epic (id · status · title · progress · "K here", click-through) on top.
 */
export function EpicStackDeck({
  items,
  idPrefix,
  epic,
  epicProgress,
  openEpic,
}: {
  /** The epic's subtasks. Title-only peeks; expand individually into full TaskCards. */
  items: Task[];
  /** Stable id prefix for expanded containers (aria-controls target). */
  idPrefix: string;
  /** Cross-column case: the epic these subtasks belong to (lives in another column). */
  epic?: Task;
  /** Cross-column case: the epic's overall completion, shown in the ghost card. */
  epicProgress?: { done: number; total: number };
  /** Open the real epic (ghost-card click-through). */
  openEpic?: (task: Task) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [ctxPos, setCtxPos] = useState<{ task: Task; x: number; y: number } | null>(null);
  const config = useAppSelector((s) => s.config);
  if (items.length === 0) return null;

  const count = items.length;
  const allOpen = open.size === count;

  const toggleOne = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (e: MouseEvent) => {
    e.stopPropagation();
    setOpen(allOpen ? new Set() : new Set(items.map((t) => t.id)));
  };

  return (
    // Same-column: pulled up under the epic card (cancels its mb-4) so the epic reads as the deck's
    // top card. Cross-column: the ghost card below is the top card, so no pull-up.
    <div id={`${idPrefix}-deck`} className={`group/deck relative ${epic ? '' : '-mt-3'} mb-3`} onClick={(e) => e.stopPropagation()}>
      {epic && <EpicGhostCard epic={epic} progress={epicProgress} hereCount={count} openEpic={openEpic} config={config} />}

      {/* Slim deck header: count + per-status breakdown dots + expand/collapse all. */}
      <div className="flex items-center gap-1.5 px-1.5 pb-0.5 pt-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500/80 dark:text-indigo-300/70">
          {count} subtask{count === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-[3px]">
          {items.slice(0, 14).map((t) => (
            <span key={t.id} className={`h-1.5 w-1.5 rounded-full ${statusDot(getStatusColorClass(config, t.status))}`} title={`${t.id} · ${t.status}`} />
          ))}
        </div>
        <button
          type="button"
          onClick={toggleAll}
          className="ml-auto rounded px-1 py-0.5 text-[10px] font-semibold text-indigo-500 transition-colors hover:bg-indigo-100/60 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <div className={`flex flex-col px-1.5 transition-all duration-200 ${open.size > 0 ? 'max-h-[2000px] opacity-100' : 'max-h-0 overflow-hidden opacity-0 group-hover/deck:max-h-[2000px] group-hover/deck:opacity-100'}`}>
        {items.map((t, i) => {
          if (open.has(t.id)) {
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.16 }}
                className="mb-1"
              >
                {/* Slim collapse handle above the full card (avoids colliding with the card's own
                    top-right chat button). */}
                <button
                  type="button"
                  onClick={() => toggleOne(t.id)}
                  className="mb-0.5 flex w-full items-center justify-center gap-1 rounded-md py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-400 transition-colors hover:bg-indigo-100/50 dark:hover:bg-indigo-500/10"
                  title="Collapse back to peek"
                >
                  <ChevronUp className="h-2.5 w-2.5" /> collapse
                </button>
                <TaskCard task={t} />
              </motion.div>
            );
          }
          // Collapsed peek — a title sliver that LIFTS on hover and reveals the expand affordance.
          const prevCollapsed = i > 0 && !open.has(items[i - 1].id);
          const marginTop = i === 0 ? (epic ? 4 : 0) : prevCollapsed ? -3 : 6;
          return (
            <div key={t.id} className="group/peek relative" style={{ marginTop, zIndex: count - i }}>
              <button
                type="button"
                onClick={() => toggleOne(t.id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxPos({ task: t, x: e.clientX, y: e.clientY }); }}
                title={`${t.id} · ${t.status} — click to expand (right-click for actions)`}
                className="flex w-full items-center gap-1.5 rounded-lg rounded-b-md border border-indigo-200/70 bg-white px-2 py-[5px] text-left shadow-sm transition-all duration-150 group-hover/peek:-translate-y-[2px] group-hover/peek:border-indigo-300 group-hover/peek:py-1.5 group-hover/peek:shadow-md dark:border-indigo-500/25 dark:bg-[#1c1d26] dark:group-hover/peek:border-indigo-500/50"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot(getStatusColorClass(config, t.status))}`} aria-hidden />
                <span className="min-w-0 flex-1 line-clamp-1 group-hover/peek:line-clamp-3 text-[11px] text-gray-700 dark:text-gray-200">{t.title || t.id}</span>
                {/* Revealed on hover: status chip + maximize hint. */}
                <span className={`hidden shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide group-hover/peek:inline-block ${getStatusColorClass(config, t.status)}`}>
                  {t.status}
                </span>
                <Maximize2 className="h-3 w-3 shrink-0 text-indigo-400 opacity-0 transition-opacity group-hover/peek:opacity-100" />
              </button>
            </div>
          );
        })}
      </div>
      {ctxPos && (
        // Right-click on a collapsed peek acts on that subtask (status, priority, assignee, archive,
        // …); "launch" ensures the subtask is expanded so its inline TaskCard launcher takes over,
        // mirroring how the ghost card routes launch to opening the epic (FLUX-701).
        <ContextMenu
          task={ctxPos.task}
          position={{ x: ctxPos.x, y: ctxPos.y }}
          onClose={() => setCtxPos(null)}
          onLaunchAgent={() => {
            const id = ctxPos.task.id;
            setCtxPos(null);
            setOpen((prev) => new Set(prev).add(id));
          }}
        />
      )}
    </div>
  );
}

/**
 * Cross-column "ghost" of an epic that lives in another column (FLUX-699). ~Half a normal card:
 * id + status badge + full (2-line) title + a completion bar + "K here · open epic". Click-through.
 */
function EpicGhostCard({
  epic,
  progress,
  hereCount,
  openEpic,
  config,
}: {
  epic: Task;
  progress?: { done: number; total: number };
  hereCount: number;
  openEpic?: (task: Task) => void;
  config: Config | null;
}) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className="relative">
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
              {epic.status}
            </span>
            <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-indigo-400 opacity-60 transition-opacity group-hover/ghost:opacity-100" />
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12px] font-semibold text-indigo-900 dark:text-indigo-100">
            {epic.title || epic.id}
          </div>
          {progress && progress.total > 0 && (
            <div className="mt-1 flex items-center gap-1.5">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-indigo-200/70 dark:bg-indigo-500/20">
                <div className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400" style={{ width: `${pct}%` }} />
              </div>
              <span className="shrink-0 tabular-nums text-[10px] font-semibold text-indigo-500 dark:text-indigo-300">{progress.done}/{progress.total}</span>
            </div>
          )}
          <div className="mt-0.5 text-[10px] text-indigo-500/70 dark:text-indigo-300/60">
            {hereCount} here · open epic
          </div>
        </div>
      </button>
      <CardChatButton task={epic} />
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
    </div>
  );
}

/** Pull just the background colour out of a status colour class so a dot can tint by status. */
function statusDot(colorClass: string): string {
  const bg = colorClass.split(/\s+/).find((c) => c.startsWith('bg-') && !c.startsWith('bg-opacity'));
  return bg ?? 'bg-gray-300 dark:bg-gray-600';
}

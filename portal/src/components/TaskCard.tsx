import { memo, useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { AlertCircle, GripVertical, GitPullRequest, Layers, Circle, ClipboardCheck, ClipboardX, Ban } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Task, TaskLiveEvent } from '../types';
import { ContextMenu } from './ContextMenu';
import { TicketActionsLaunchers } from './ticket-actions/TicketActions';
import type { StatusTint } from '../statusStyles';
import { useTaskCardController } from '../hooks/useTaskCardController';
import { useAppSelector } from '../store/useAppSelector';
import { isPlanApprovalPending, isGateParkedTicket } from './pendingInteractions';
import { CardCommentBadge } from './task-card/CardCommentBadge';
import { CardMetadataRow } from './task-card/CardMetadataRow';
import { CardClusterPanel } from './task-card/CardClusterPanel';
import { CardBranchRow } from './task-card/CardBranchRow';
import { CardSessionRow } from './task-card/CardSessionRow';
import { CardSubtaskProgress } from './task-card/CardSubtaskProgress';
import { CardAcceptanceCriteria } from './task-card/CardAcceptanceCriteria';
import { CardFooterRow } from './task-card/CardFooterRow';
import { CardActionButtons } from './task-card/CardActionButtons';
import { CardCommentPopover } from './task-card/CardCommentPopover';
import { CardSubtaskPopover } from './task-card/CardSubtaskPopover';
import { CardDescriptionPopup } from './task-card/CardDescriptionPopup';
import { PrDeckSection } from './PrDeckCard';
import { MergeConflictBanner } from './MergeConflictBanner';
import { SuccessMark } from '../motion/SuccessMark';
import { useFurnaceBatchMeta } from '../store/useAppSelector';
import { hueFromId, iconFor, batchBorderColor } from './furnace/furnaceVisuals';

// Violet wash for PR cards — a translucent violet gradient layered over the eh-card bg
// (inline so it beats eh-card's unlayered background). Module-level so it's allocated once,
// not per render of every card (FLUX-567 perf review).
const PR_CARD_STYLE = { backgroundImage: 'linear-gradient(135deg, rgba(139,92,246,0.13), rgba(139,92,246,0.02))' };

// FLUX-1553: constant-prop icons hoisted to module scope, same precedent as PR_CARD_STYLE above —
// skips lucide's createElement + camelCase-attr conversion on every card render. Each icon here
// renders with identical props at every call site; conditionally-styled icons stay inline.
const ALERT_CIRCLE_ICON = <AlertCircle className="w-5 h-5 text-amber-500 fill-amber-50 dark:fill-amber-950" />;
const ALERT_CIRCLE_PING_ICON = <AlertCircle className="w-5 h-5 text-amber-500 opacity-40" />;
const LAYERS_ICON = <Layers className="w-4 h-4 text-indigo-500 dark:text-indigo-300" />;
const CIRCLE_ICON_COMPACT = <Circle className="w-3 h-3 text-gray-300 dark:text-gray-600" />;
const CIRCLE_ICON_GRIP = <Circle className="w-3 h-3 text-gray-300 dark:text-gray-600 group-hover/grip:hidden" />;
const GRIP_VERTICAL_ICON = <GripVertical className="hidden w-4 h-4 text-gray-400 group-hover/grip:block" />;

export interface TaskCardProps {
  task: Task;
  parentTask?: Task;
  isOverlay?: boolean;
  liveEvent?: TaskLiveEvent;
  travelDirection?: -1 | 0 | 1;
  /** Per-column hue tint (full-wash board identity). Absent off-board. */
  columnTint?: StatusTint;
  /** Hide the per-card status badge — redundant under a column header on the board. */
  hideStatusBadge?: boolean;
  /** Compact in-deck rendering (FLUX-567): drop the branch + footer rows (assignee/cost/
   *  diffs/reporter) that the PR deck card already shows, keep description + actions. */
  compact?: boolean;
}

/**
 * Thin sortable wrapper (drag perf / "cardboard cutout"): owns the dnd-kit subscription and
 * applies the moving transform on a cheap outer div. The heavy body (TaskCardInner — its
 * 1000-line controller + deep subcomponent tree) is memoized and receives only stable props,
 * so it is NOT re-rendered as the card shifts during a drag. The board also freezes task
 * updates mid-drag (Board.tsx), so a shifting card just translates while frozen.
 */
export const TaskCard = memo(function TaskCard(props: TaskCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
    data: props.task,
  });
  return (
    <div
      ref={setNodeRef}
      data-task-id={props.task.id}
      style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.3 : 1 }}
    >
      <TaskCardInner {...props} dndAttributes={attributes} dndListeners={listeners} dndIsDragging={isDragging} />
    </div>
  );
});

interface TaskCardInnerProps extends TaskCardProps {
  dndAttributes?: DraggableAttributes;
  dndListeners?: DraggableSyntheticListeners;
  dndIsDragging?: boolean;
}

/**
 * The heavy card body. Also rendered directly (no sortable wrapper) by the DragOverlay.
 * Memoized with a custom comparison that ignores the dnd handle objects (recreated each
 * render) so a drag-shift never re-renders it — only `task`/stable props or the drag flag do.
 */
export const TaskCardInner = memo(function TaskCardInner({
  task,
  parentTask,
  isOverlay,
  liveEvent,
  travelDirection = 0,
  columnTint,
  hideStatusBadge = false,
  compact = false,
  dndAttributes,
  dndListeners,
  dndIsDragging = false,
}: TaskCardInnerProps) {
  const c = useTaskCardController({ task, parentTask, isOverlay, liveEvent, travelDirection, columnTint, hideStatusBadge, attributes: dndAttributes, listeners: dndListeners, isDragging: dndIsDragging });

  const config = useAppSelector((s) => s.config);
  const boardFx = config?.boardFx;
  // FLUX-1273: plan-approval / gate-parked earn their own corner chip (mutually exclusive with the
  // generic prompt-status badge below — gate-parked tickets already carry swimlane 'require-input',
  // so without this they'd only ever show the generic amber "awaiting input" glyph).
  const planApprovalPending = isPlanApprovalPending(task, config);
  // FLUX-1289: verdict-color the corner badge — amber for changes-requested, sky for approved —
  // instead of one color for either verdict.
  const planChangesRequested = planApprovalPending && task.planReviewState === 'changes-requested';
  const gateParked = !planApprovalPending && isGateParkedTicket(task);

  // Deterministic hue from ticket ID — stable across renders, unique per ticket.
  const foilHue = useMemo(() => hueFromId(task.id), [task.id]);

  // FLUX-1539: this card's owning Furnace batch, if any — drives the corner icon badge + border tint.
  const batchMeta = useFurnaceBatchMeta(task.id);

  const rustClass = useMemo(() => {
    if (boardFx?.ticketAgeRust === false || isOverlay || c.isSessionRunning) return '';
    // FLUX-725: max-activity date is pre-computed on the list digest (was a reduce over full history).
    const lastEntry = task.historyDigest?.lastActivityAt || undefined;
    if (!lastEntry) return '';
    const daysSince = (Date.now() - new Date(lastEntry).getTime()) / 86_400_000;
    if (daysSince >= 14) return 'card-rust-3';
    if (daysSince >= 7) return 'card-rust-2';
    if (daysSince >= 4) return 'card-rust-1';
    return '';
  }, [boardFx?.ticketAgeRust, isOverlay, c.isSessionRunning, task.historyDigest?.lastActivityAt]);

  const CardContainer = c.animationsEnabled && !c.isDragging && !isOverlay ? motion.div : 'div';

  // A PR ticket (FLUX-567) renders through this same card — inheriting session indicator,
  // context menu, comment badge — but with a PR-specific body (PrDeckSection) + violet identity.
  const isPrTicket = task.kind === 'pr';

  // FLUX-1539: transient state borders (session-running / PR / prompt-status) win over the batch
  // tint — the batch icon badge still shows in those states, only the border defers.
  const showBatchBorder = !!batchMeta && !c.isSessionRunning && !isPrTicket && !(c.isPromptStatus && !compact);

  return (
    <CardContainer
      {...c.layoutProps}
      style={{ ...c.style, zIndex: c.isThisTaskOpen || c.isAnimatingZ ? 60 : undefined }}
      className={`mb-4 group flex flex-col relative ${(c.priorityMenuOpen || c.effortMenuOpen || c.assigneeMenuOpen || c.tagMenuOpen || c.isEditingTitle || c.isHovering) ? 'z-40' : ''}`}
      onMouseEnter={c.handleMouseEnter}
      onMouseLeave={c.handleMouseLeave}
      onMouseOver={c.handleMouseOverSurface}
      onContextMenu={(e) => {
        if (isOverlay) return;
        e.preventDefault();
        e.stopPropagation();
        c.setContextMenuPos({ x: e.clientX, y: e.clientY });
        c.setCommentPopoverOpen(false);
        c.setIsHovering(false);
      }}
    >
      <motion.div ref={c.accentRef} {...c.contentAnimation} style={{ ...(isPrTicket ? PR_CARD_STYLE : c.columnTintStyle), ...(showBatchBorder ? { borderColor: batchBorderColor(batchMeta!.batchId) } : {}) }} className={`eh-card relative flex flex-col rounded-xl border p-0 shadow-sm transition-all ${rustClass} ${isOverlay ? 'shadow-2xl rotate-2 scale-105' : ''} ${c.isSessionRunning ? 'border-emerald-400 dark:border-emerald-500/60' : isPrTicket ? 'border-violet-400 dark:border-violet-500/60' : c.isPromptStatus && !compact ? 'border-amber-300 dark:border-amber-500/40 ring-1 ring-amber-200/50 dark:ring-amber-500/20' : ''} ${c.liveAnimationClass} ${c.liveAccentClass} ${c.hasUnread && !c.liveAccentClass ? 'ring-2 ring-amber-400/60 dark:ring-amber-500/40' : ''} ${c.isEpic && !isPrTicket ? 'border-l-[3px] border-l-indigo-400 dark:border-l-indigo-500' : ''}`}>
        {boardFx?.ticketDna !== false && (
          <div
            className="card-foil pointer-events-none absolute inset-0 rounded-xl"
            style={{ '--foil-hue': foilHue } as React.CSSProperties}
            aria-hidden
          />
        )}
        {c.isSessionRunning && !isOverlay && (
          <div className="pointer-events-none absolute inset-0 rounded-xl bot-border-breathe" />
        )}
        {c.showSuccessMark && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <SuccessMark size={36} />
          </div>
        )}
        {/* Comment indicator owns the top-right corner on every surface — normal, compact
            (folded-deck) member, and PR cards (FLUX-804 returned it here after FLUX-739 had
            relocated it to make room for a now-removed chat pill; the card body click already
            opens chat, FLUX-744). Corner states: unread → always-visible amber count; has
            comments → neutral count on hover; none → muted "add a comment" affordance on hover. */}
        {!isOverlay && (
          <CardCommentBadge task={task} c={c} compact={compact} />
        )}
        {planApprovalPending && !compact && (
          <div
            className="absolute -top-1.5 -right-1.5 z-10"
            title={planChangesRequested ? 'Plan review requested changes' : 'Plan ready for your approval'}
          >
            {planChangesRequested
              ? <ClipboardX className="w-5 h-5 text-amber-500 fill-amber-50 dark:fill-amber-950" />
              : <ClipboardCheck className="w-5 h-5 text-sky-500 fill-sky-50 dark:fill-sky-950" />}
          </div>
        )}
        {gateParked && !compact && (
          <div className="absolute -top-1.5 -right-1.5 z-10" title="Gate parked — stuck retrying">
            <Ban className="w-5 h-5 text-rose-500 fill-rose-50 dark:fill-rose-950" />
          </div>
        )}
        {!planApprovalPending && !gateParked && c.isPromptStatus && !compact && (
          <div className="absolute -top-1.5 -right-1.5 z-10">
            <div className="relative">
              {ALERT_CIRCLE_ICON}
              <div className="absolute inset-0 animate-ping">
                {ALERT_CIRCLE_PING_ICON}
              </div>
            </div>
          </div>
        )}
        {/* FLUX-1539: Furnace batch membership badge — top-LEFT corner (top-right is owned by the
            comment/status glyphs above). Stays visible even when a transient state border (session
            running / PR / prompt-status) preempts the batch border tint, so membership never fully
            disappears. */}
        {batchMeta && !compact && (() => {
          const BatchIcon = iconFor({ icon: batchMeta.icon });
          const color = batchBorderColor(batchMeta.batchId);
          return (
            <div
              className="absolute -top-1.5 -left-1.5 z-10 flex items-center justify-center w-5 h-5 rounded-full bg-white dark:bg-gray-900 shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              title={batchMeta.title}
            >
              <BatchIcon className="w-3 h-3" style={{ color }} />
            </div>
          );
        })()}
        <div className="flex flex-1">
          {/* Top-left type indicator (FLUX-567): PR (violet) / Epic (indigo) / normal ticket
              (gray). PR tickets are engine-managed (not drag-reordered) so they have no grip;
              others stay draggable (grab cursor) and reveal the grip on hover. */}
          {isPrTicket ? (
            <div className="w-8 flex items-start justify-center pt-3.5 shrink-0 text-violet-500 dark:text-violet-300" title="Pull request">
              <GitPullRequest className="w-4 h-4" />
            </div>
          ) : compact ? (
            /* Compact (PR deck) member: static type icon, no drag handle — PR members are owned by
               the PR lifecycle, not drag-reordered. Epic-deck subtask cards (FLUX-699) deliberately
               keep a LIVE grip: expanding one and dragging it is the intended way to move a
               clustered subtask out of a foreign column (a deck card looks/behaves like any card). */
            <div className="w-8 flex items-start justify-center pt-3.5 shrink-0" title={c.isEpic ? 'Epic' : 'Ticket'}>
              {c.isEpic ? LAYERS_ICON : CIRCLE_ICON_COMPACT}
            </div>
          ) : (
            <div
              {...c.listeners}
              {...c.attributes}
              title={c.isEpic ? 'Epic' : 'Ticket'}
              className="group/grip w-8 flex items-start justify-center pt-3.5 cursor-grab active:cursor-grabbing border-r border-transparent group-hover:border-gray-100 dark:group-hover:border-white/5 shrink-0"
            >
              {c.isEpic ? (
                LAYERS_ICON
              ) : (
                <>
                  {CIRCLE_ICON_GRIP}
                  {GRIP_VERTICAL_ICON}
                </>
              )}
            </div>
          )}

          <div
            className="flex-1 min-w-0 cursor-pointer p-3.5 pl-2.5 flex flex-col"
            onClick={(e) => {
              if (!isOverlay) {
                c.openBoardTask(task, e.currentTarget);
              }
            }}
          >
            <CardMetadataRow task={task} isOverlay={isOverlay} c={c} />

            {isPrTicket ? (
              /* PR ticket: PR-specific body (chips + folded-members deck + PR actions). The
                 shell around this (session indicator, comment badge, context menu, review
                 launcher) is inherited from TaskCard — FLUX-567 pivot. The orchestration
                 session panel is rendered here too so a review/agent running ON the PR shows
                 its live HAND-OFF panel, same as a normal card (regression fix). In compact
                 mode (a PR folded as a member — shouldn't happen) we DON'T recurse into another
                 deck; just show a one-line note (FLUX-567 QA defensive guard). */
              compact ? (
                <p className="text-[11px] italic text-violet-500 dark:text-violet-300">Pull request (open to view)</p>
              ) : (
                <>
                  {c.clusterGroup && c.clusterAgg && !isOverlay && (
                    <CardClusterPanel c={c} />
                  )}
                  <PrDeckSection task={task} c={c} />
                </>
              )
            ) : (
              <>
                <p className="eh-card-desc mb-3 text-xs leading-relaxed text-gray-600 line-clamp-3 dark:text-gray-400">
                  {c.snippet}
                </p>

                {/* FLUX-1270: generalized off PrDeckCard.tsx-only scoping — a plain ticket can also
                    carry `swimlane: 'merge-conflict'` (e.g. its branch was kept alive by
                    cleanupMergedBranch because a dependent PR still based off it). */}
                {!isOverlay && !compact && <MergeConflictBanner task={task} c={c} />}

                {c.clusterGroup && c.clusterAgg && !isOverlay && (
                  <CardClusterPanel c={c} />
                )}

                {task.branch && !isOverlay && !compact && (
                  <CardBranchRow task={task} c={c} />
                )}

                {/* Live single-agent session gets its own bounded full-width lane (FLUX-652) so its
                    variable-length progress/activity text can never push the card wider. Multi-session
                    runs render through CardClusterPanel above, so this is gated on !clusterGroup.
                    S10 (epic FLUX-996): also render for a crashed session (`sessionState === 'failed'`)
                    — otherwise a dead spawn is invisible on the card, the exact gap this ticket fixes. */}
                {(c.hasActiveCliSession || c.shouldShowProgress || c.sessionState === 'failed') && !c.clusterGroup && !isOverlay && !compact && (
                  <CardSessionRow task={task} c={c} />
                )}

                {c.isEpic && (
                  <CardSubtaskProgress c={c} />
                )}
                {/* The epic's subtask deck (the peeking card stack) renders BELOW this card at the
                    column level (FLUX-699): the epic card IS the deck's top card, not a container
                    for it. So nothing deck-related renders inside the card body here. */}

                {!compact && <CardAcceptanceCriteria body={task.body} />}

                {!compact && <CardFooterRow task={task} isOverlay={isOverlay} c={c} />}
                {/* member cards in a deck don't carry their own Finish/Review (compact) — the
                    PR card owns the lifecycle (FLUX-567). */}
                {!isOverlay && !compact && (
                  <CardActionButtons task={task} c={c} />
                )}
              </>
            )}
          </div>
        </div>
      </motion.div>

      <CardCommentPopover task={task} isOverlay={isOverlay} c={c} />

      <CardSubtaskPopover task={task} isOverlay={isOverlay} c={c} />

      <CardDescriptionPopup task={task} isOverlay={isOverlay} c={c} />

      {c.contextMenuPos && !isOverlay && (
        <ContextMenu
          task={task}
          position={c.contextMenuPos}
          onClose={() => c.setContextMenuPos(null)}
          onLaunchAgent={(templateId) => c.ticketActions.openLauncher(c.ticketActions.cardPhase, templateId ?? c.ticketActions.singleDefaultId)}
        />
      )}

      {/* FLUX-715: the orchestration launcher + Todo start-prompt portals, driven by the shared
          ticket-action controller (same instance the card's action buttons use). */}
      {!isOverlay && <TicketActionsLaunchers ctl={c.ticketActions} />}
    </CardContainer>
  );
}, (prev, next) =>
  // dndAttributes/dndListeners intentionally excluded — recreated each render; comparing them
  // would defeat the during-drag freeze (they only arm drag-start, which re-renders anyway).
  prev.task === next.task &&
  prev.parentTask === next.parentTask &&
  prev.isOverlay === next.isOverlay &&
  prev.liveEvent === next.liveEvent &&
  prev.travelDirection === next.travelDirection &&
  prev.columnTint === next.columnTint &&
  prev.hideStatusBadge === next.hideStatusBadge &&
  prev.compact === next.compact &&
  prev.dndIsDragging === next.dndIsDragging);

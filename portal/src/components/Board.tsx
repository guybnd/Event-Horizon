import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { DndContext, DragOverlay, useDroppable } from '@dnd-kit/core';
import type { DragEndEvent, DragMoveEvent, DragStartEvent, DropAnimation } from '@dnd-kit/core';
import { FurnaceDrawer, FURNACE_ACCENT, FURNACE_ACCENT_GLOW } from './FurnaceDrawer';
import { FURNACE_NEW_DROP_ID, FURNACE_REFRESH_EVENT } from '../furnaceTypes';
import { FURNACE_QUICK_DROP_WIDTH_PX, isFurnaceRailRevealTarget, makeFurnaceAwareCollision } from './furnaceRailReveal';
import { appendFurnaceTicket, createFurnaceBatch } from '../api';
import { arrayMove } from '@dnd-kit/sortable';
import { Column } from './Column';
import { StatusBadge } from './StatusBadge';
import { TaskCardInner } from './TaskCard';
import { createTask, updateTask, TASK_CREATED_LOCALLY_EVENT } from '../api';
import { useAppSelector, useAppActions, useParentByChildId } from '../store/useAppSelector';
import { buildStatusChangeHistory, applyOptimisticStatusChange, isMissingCommentError } from '../lib/ticketActions';
import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { Loader2, Upload, Sparkles, Flame, Rocket } from 'lucide-react';
import { TaskViewControls } from './TaskViewControls';
import { filterAndSortTasks } from '../taskSearch';
import { getStatusColorClass } from '../statusStyles';
import { ReleaseModal } from './ReleaseModal';
import { getArchiveStatus, getRequireInputStatus, normalizeStatus } from '../workflow';
import { collectPrMemberIds, collectEpicFoldedIds, collectCrossColumnClusters } from '../lib/decks';
import { ParseErrorButton } from './ParseErrorButton';
import { BootstrapPreview } from './BootstrapPreview';
import { useNotify } from '../hooks/useNotify';
import { useMotionTokens, COLD_BOOT_STAGGER_MS } from '../motion/tokens';
import { useCardFlight } from '../motion/useCardFlight';
import { Skeleton, SkeletonCard } from './ui/Skeleton';

// Stable empty array so columns with no tasks get a referentially-stable prop (memo-friendly).
const EMPTY_TASKS: Task[] = [];

// FLUX-795/FLUX-847 (Option 3, overriding the original FLUX-795 intent): per-session opt-out for
// the "add a note?" status-change prompt. Stored in sessionStorage so it lasts the browser session
// and resets on reload. With this on, Ready transfers go through SILENTLY — the skip flag rides
// along on the PUT (see applyStatusChange) so the engine's config-gated Ready comment check is
// relaxed too. Require Input still prompts reactively regardless: its comment IS the question,
// a hard engine invariant the flag can never relax.
const STATUS_NOTE_SKIP_KEY = 'eh-skip-status-note';
function skipStatusNote(): boolean {
  try { return sessionStorage.getItem(STATUS_NOTE_SKIP_KEY) === '1'; } catch { return false; }
}
function setSkipStatusNote(v: boolean): void {
  try {
    if (v) sessionStorage.setItem(STATUS_NOTE_SKIP_KEY, '1');
    else sessionStorage.removeItem(STATUS_NOTE_SKIP_KEY);
  } catch { /* sessionStorage unavailable — non-fatal */ }
}

// FLUX-786: mission body for the "Bootstrap with AI" starter ticket. The user launches a grooming/
// implementation agent on it; the agent scans the repo and creates the proposed tickets as subtasks.
const BOOTSTRAP_TICKET_BODY = `## Bootstrap my board

This is a starter ticket. **Launch an agent on it** (Grooming or Implementation) to populate your board automatically.

**Mission for the agent:** Scan this project — source layout, \`README\`, docs, config, dependencies, and any \`TODO\`/\`FIXME\` markers — and propose **5–8 high-value starter tickets** you'd recommend tackling first: setup gaps, quick wins, bugs, and the most valuable next features. Create each as a **subtask of this ticket** (use your ticket tools) with a clear title, a 1–2 sentence problem/why, and an effort estimate. Finish with a short summary of what you found and why you picked these.

_Created by the "Bootstrap with AI" action on the empty board. Delete this ticket once your board is populated._`;

// FLUX-1506: cold-load placeholder — ghost columns of ghost cards, roughly matching Column.tsx's
// `w-[320px] min-w-[280px]` shape, in place of the old centered spinner (which carried no layout
// information at all and made every board load flash-then-jump into its real shape).
function BoardSkeleton() {
  return (
    <div className="flex h-full min-h-0 gap-2 overflow-hidden pb-4">
      {Array.from({ length: 4 }).map((_, col) => (
        <div key={col} className="flex w-[320px] min-w-[280px] flex-1 max-w-[440px] flex-col gap-3 rounded-2xl eh-column p-3">
          <Skeleton variant="bar" className="h-4 w-1/2" />
          {Array.from({ length: 3 }).map((_, card) => (
            <SkeletonCard key={card} />
          ))}
        </div>
      ))}
    </div>
  );
}

const BOOT_ROLL_DURATION_MS = 400;
const BOOT_ROLL_STEPS = 12;
const BOOT_ROLL_INTERVAL_MS = BOOT_ROLL_DURATION_MS / BOOT_ROLL_STEPS;

function easeOutCubicBootRoll(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * FLUX-1547 Phase 4: rolls the raw `bootProgress.loaded` SSE value into a smooth count-up instead
 * of jumping straight to each new value — the engine emits in batches (today ~50 tickets, but the
 * cadence/step size is an engine-side detail that may change independently, including going
 * irregular under a parallel scan), so reading `loaded` directly makes the count visibly jump.
 * Mirrors `AnimatedCount`'s (FLUX-1520) fixed-duration retarget-from-ref algorithm instead of
 * estimating a rate from inter-event timing: every new target starts a fresh ~400ms ease from
 * wherever the display currently sits, so a mid-roll event retargets cleanly (no restart-from-zero,
 * no stale timer racing the new one) and a final event — including `phase: 'ready'` — always lands
 * exactly on its value once its own roll completes, never stalling short. `null` (no progress yet,
 * or `total` is 0) resets the display to 0 with no roll. Respects the same `instant` contract as
 * every other portal animation (reduced motion / animationsEnabled=false skips the roll).
 */
function useRollingBootCount(target: number | null): number {
  const { instant } = useMotionTokens();
  const [displayed, setDisplayed] = useState(target ?? 0);
  const displayedRef = useRef(displayed);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const value = target ?? 0;
    if (instant || target == null) {
      setDisplayed(value);
      return;
    }
    const from = displayedRef.current;
    if (from === value) return;

    let step = 0;
    timerRef.current = setInterval(() => {
      step += 1;
      if (step >= BOOT_ROLL_STEPS) {
        setDisplayed(value);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }
      const progress = easeOutCubicBootRoll(step / BOOT_ROLL_STEPS);
      setDisplayed(Math.round(from + (value - from) * progress));
    }, BOOT_ROLL_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [target, instant]);

  return displayed;
}

// FLUX-1540: cold-boot loading state. Wraps the FLUX-1506 ghost-column skeleton (which conveys
// board *shape*) with a centered, always-visible-text status line so a ~60s cold launch never
// reads as hung — plus real "Loaded X / Y tickets" progress once the engine's `bootProgress` SSE
// event (initDir's 50-file yield boundary) starts arriving. Falls back to an indeterminate sweep
// when no progress data has arrived yet (event missed, or the scan finished before the portal's
// SSE connection opened) — this must never render a static or stuck `0 / 0` frame.
function BoardLoadingState() {
  const bootProgress = useAppSelector((s) => s.bootProgress);
  const hasProgress = !!bootProgress && bootProgress.total > 0;
  // FLUX-1547 Phase 4: tween the count instead of reading `bootProgress.loaded` straight through —
  // see useRollingBootCount above.
  const displayedLoaded = useRollingBootCount(hasProgress ? bootProgress!.loaded : null);
  const total = hasProgress ? bootProgress!.total : 0;
  const pct = hasProgress ? Math.min(100, Math.round((displayedLoaded / total) * 100)) : null;
  const label = hasProgress
    ? `Loading tickets… ${displayedLoaded.toLocaleString()} / ${total.toLocaleString()}`
    : 'Starting Event Horizon…';

  return (
    <div className="relative h-full min-h-0" aria-busy="true" aria-live="polite" aria-label={label}>
      <BoardSkeleton />
      <div className="pointer-events-none absolute inset-x-0 top-12 flex flex-col items-center gap-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-lg bg-primary/10 p-1.5">
            <Rocket className="h-5 w-5 text-primary" />
          </div>
          <h1 className="text-[15px] font-extrabold tracking-[-0.03em]">Event Horizon</h1>
        </div>
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--eh-text-muted)' }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{label}</span>
        </div>
        <div className="h-1.5 w-64 overflow-hidden rounded-full bg-primary/10">
          {hasProgress ? (
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          ) : (
            <div className="eh-notif-indeterminate h-full w-1/3 rounded-full bg-primary" />
          )}
        </div>
      </div>
    </div>
  );
}

// FLUX-1533: a big, always-available Furnace drop target shown for the duration of a card drag when
// the Furnace drawer is closed — see the render-site comment in Board for why this exists instead of
// just relying on the drawer's own (drawer-open-only) useDroppable zones. Dropping here creates a new
// batch with the dragged ticket (handleDragEnd's existing FURNACE_NEW_DROP_ID branch); to append to an
// EXISTING batch, open the drawer first — its batch cards remain droppable as before.
//
// FLUX-1549: the zone is an absolutely-positioned overlay (out of document flow), so it never has a
// layout footprint on the board — a prior review fix (FLUX-1533) instead reserved its width as animated
// scroller `paddingRight`, which squished every `flex-1` column and re-flowed all their cards on every
// drag-start (the "huge lag" this ticket fixes). At rest it renders as a slim edge rail (just the flame
// icon peeking out); a purely-visual inner panel slides the rest of the way into view via a CSS
// `transform` (GPU-composited, no layout) once the dragged card nears the right edge — see
// `handleDragMove`'s reveal logic below, imperative ref+CSS-var, never `setState` (same pattern as the
// drag-tilt code).
//
// FLUX-1549 review fix: dnd-kit measures a droppable's collision rect ONCE at drag-start and does not
// re-measure it as a CSS `transform` animates (with the default `measuring` config, the `translate` dep
// on `useDroppableMeasuring` only feeds a disabled timeout path). Animating `transform` on the droppable
// node itself therefore froze its hit-area at the pre-reveal (mostly off-screen) position — only a
// sliver at the edge was actually droppable, contested by the now-unpadded last column. Fix: the
// `useDroppable` ref lives on a small FIXED-geometry rail (`FURNACE_RAIL_PEEK_PX` wide, pinned to the
// right edge, position/size NEVER transformed) — hit-testing always matches where that rail visually
// sits, at rest or revealed. The larger sliding panel below is a separate `pointer-events-none`
// decorative child; it never intercepts drops, so it can safely visually cover the last column without
// hijacking its drops (the original FLUX-1533 concern).
// FLUX-1570: FURNACE_QUICK_DROP_WIDTH_PX now lives in furnaceRailReveal.ts — makeFurnaceAwareCollision
// needs it too (the pointer hit-band must match the panel width exactly), so it's defined once there.
// Rest-state sliver width: how much of the rail (just the flame icon) peeks out at the right edge
// before the pointer nears and it slides fully into view. Also the real droppable's fixed width — see
// the FLUX-1549 review-fix comment above.
const FURNACE_RAIL_PEEK_PX = 40;
// The hidden transform offset: the rail's own width minus the peeking sliver.
const FURNACE_RAIL_HIDDEN_OFFSET_PX = FURNACE_QUICK_DROP_WIDTH_PX - FURNACE_RAIL_PEEK_PX;

function FurnaceQuickDropZone({ railRef }: { railRef: React.RefObject<HTMLDivElement | null> }) {
  const { setNodeRef, isOver } = useDroppable({ id: FURNACE_NEW_DROP_ID });
  return (
    <div
      ref={railRef}
      className="pointer-events-none absolute inset-y-2 right-2 z-30"
      style={{ width: FURNACE_QUICK_DROP_WIDTH_PX }}
    >
      {/* Decorative reveal panel — visual affordance only, never the drop target. `pointer-events-none`
          so it can't shadow the real (fixed-position) rail below or intercept native pointer handling. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed transition-transform duration-150 ease-out"
        style={{
          width: FURNACE_QUICK_DROP_WIDTH_PX,
          borderColor: FURNACE_ACCENT,
          background: isOver ? FURNACE_ACCENT_GLOW : 'var(--eh-surface)',
          boxShadow: '0 20px 48px -12px rgba(0, 0, 0, 0.35), 0 0 32px -4px var(--eh-furnace-accent-glow)',
          transform: `translateX(var(--eh-furnace-reveal, ${FURNACE_RAIL_HIDDEN_OFFSET_PX}px))`,
        }}
      >
        <Flame className="h-6 w-6 shrink-0" style={{ color: FURNACE_ACCENT }} />
        <div className="whitespace-nowrap text-sm font-medium" style={{ color: FURNACE_ACCENT }}>
          {isOver ? 'Drop to send to the Furnace' : 'Drag here to add to the Furnace'}
        </div>
      </div>
      {/* Real drop target: fixed size + position, never transformed — this is what dnd-kit actually
          measures once at drag-start and hit-tests for the rest of the drag. Pinned to match the rail
          sliver that's always on-screen, revealed or not. */}
      <div
        ref={setNodeRef}
        data-testid="furnace-quick-drop-zone"
        className="pointer-events-auto absolute inset-y-0 right-0 rounded-2xl"
        style={{ width: FURNACE_RAIL_PEEK_PX }}
      />
    </div>
  );
}

// FLUX-1141: memoized so an unrelated AppContent re-render (terminal/furnace toggle, the 5s
// furnace-status poll) doesn't re-invoke this whole ~700-line tree — furnaceOpen/onCloseFurnace
// are its only props and stay stable across those toggles, so the memo boundary actually bails.
export const Board = memo(function Board({ furnaceOpen, onCloseFurnace, active = true }: { furnaceOpen?: boolean; onCloseFurnace?: () => void; active?: boolean } = {}) {
  // FLUX-1507: Board is kept mounted across view switches (FLUX-983 — remounting it is the
  // expensive path) and only ever toggled via CSS visibility from the parent. `active` drives a
  // crossfade+drift matching the other views' AnimatePresence transition instead of App.tsx's old
  // instant `display` swap; the parent still delays flipping to `display:none` until this fade
  // finishes, so the FLUX-983 "no layout space while hidden" property is unchanged.
  const boardTokens = useMotionTokens();
  // FLUX-1525: drop-settle animation for the drag overlay. dnd-kit's `dropAnimation` is
  // Web-Animations-API based, so it can't consume `boardTokens.spring` (a framer-motion
  // Transition) — `springSettleMs` + an overshoot bezier is the WAAPI-compatible stand-in.
  // `null` disables dnd-kit's own default drop animation entirely (instant snap).
  const dragDropAnimation: DropAnimation | null = useMemo(() => (
    boardTokens.instant
      ? null
      : { duration: boardTokens.springSettleMs, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
  ), [boardTokens.instant, boardTokens.springSettleMs]);
  // FLUX-1507: card flight between columns — see useCardFlight.ts.
  const { beginFlight: beginCardFlight } = useCardFlight();
  // FLUX-1519: cold-boot cascade — plays once per app lifetime. Board stays mounted across view
  // switches (see the FLUX-1507 comment above), so this ref alone gates every refetch/SSE update/
  // view-switch after the first real render from replaying the entrance.
  //
  // Flipping `hasBooted.current` is deliberately deferred to a macrotask (not mutated inline during
  // render, and not even a plain `useEffect(() => {...}, [])`) — mount reliably produces more than
  // one synchronous render pass before it settles (the external-store subscriptions behind
  // `useAppSelector` force a consistency re-render right after commit, and a bare passive effect
  // fires *between* those passes, not after all of them). Flipping too early drops the entrance
  // mid-cascade on whichever pass comes after — most visibly on cards, where the wrapper element
  // itself changes type (`motion.div` → `div`), so React remounts it and the in-flight animation is
  // lost outright. A macrotask reliably runs after every pass mount schedules synchronously.
  const hasBooted = useRef(false);
  useEffect(() => {
    const id = setTimeout(() => { hasBooted.current = true; }, 0);
    return () => clearTimeout(id);
  }, []);
  const liveTasks = useAppSelector((s) => s.tasks);
  // FLUX-982: seed local `tasks` from the already-loaded store snapshot instead of `[]`. Board
  // fully unmounts/remounts on view switch (App.tsx `{view === 'board' && <Board />}`), and the
  // effect below that syncs `liveTasks` into local state only runs AFTER the first commit — so an
  // empty initial value meant every return to Board painted a blank board for a frame before
  // popping in, reading as a "reload". `liveTasks` is already resolved above by the time this
  // lazy initializer runs, so remounting now paints with real data immediately.
  const [tasks, setTasks] = useState<Task[]>(() => liveTasks);
  const notify = useNotify();
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  // FLUX-1525: velocity-following tilt on the drag overlay. Imperative (ref + CSS var), never
  // React state — onDragMove fires on every pointer move, so a setState here would reintroduce
  // the FLUX-629 per-frame-render regression.
  const dragOverlayRef = useRef<HTMLDivElement>(null);
  const dragTiltRef = useRef({ smoothedDeg: 0, prevDeltaX: 0 });
  // FLUX-1549: imperative handle to the Furnace quick-drop rail — reveal is driven by a CSS var set
  // in handleDragMove, same reasoning as dragTiltRef above (per-frame, must never be React state).
  const furnaceRailRef = useRef<HTMLDivElement>(null);
  const [releaseModalTasks, setReleaseModalTasks] = useState<Task[] | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  // FLUX-1487: drives the floating Furnace panel's slide-in-from-right entrance transition —
  // starts false so the first paint is the pre-transition state, then flips true next frame.
  const [furnacePanelMounted, setFurnacePanelMounted] = useState(false);
  const { triggerRefresh, openTaskModal } = useAppActions();
  const currentProject = useAppSelector((s) => s.currentProject);
  const isModalOpen = useAppSelector((s) => s.isModalOpen);
  const [bootstrapping, setBootstrapping] = useState(false);
  const tasksLoading = useAppSelector((s) => s.tasksLoading);
  const taskLiveEvents = useAppSelector((s) => s.taskLiveEvents);
  const columnLiveEvents = useAppSelector((s) => s.columnLiveEvents);
  const pinnedTasks = useAppSelector((s) => s.pinnedTasks);
  const config = useAppSelector((s) => s.config);
  const boardFx = config?.boardFx;
  const currentUser = useAppSelector((s) => s.currentUser);
  const searchQuery = useAppSelector((s) => s.searchQuery);
  // FLUX-791: defer the query feeding the filter/sort memo so typing in the board filter stays
  // responsive — the heavy filterAndSortTasks pass + board re-render runs as a non-urgent update.
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const sortOption = useAppSelector((s) => s.sortOption);
  const filterAssignee = useAppSelector((s) => s.filterAssignee);
  const filterPriority = useAppSelector((s) => s.filterPriority);
  const filterTag = useAppSelector((s) => s.filterTag);
  const filterUnreadOnly = useAppSelector((s) => s.filterUnreadOnly);
  const filterWorktree = useAppSelector((s) => s.filterWorktree);
  // FLUX-1200: the other filter/sort selectors got the same synchronous re-render + full
  // filterAndSortTasks pass as `searchQuery` did before FLUX-791, but only that one was deferred.
  // Defer the rest the same way — the toolbar control itself (a select/checkbox, not a text input)
  // still updates instantly; only the resulting board re-render + filter pass becomes non-urgent.
  const deferredSortOption = useDeferredValue(sortOption);
  const deferredFilterAssignee = useDeferredValue(filterAssignee);
  const deferredFilterPriority = useDeferredValue(filterPriority);
  const deferredFilterTag = useDeferredValue(filterTag);
  const deferredFilterUnreadOnly = useDeferredValue(filterUnreadOnly);
  const deferredFilterWorktree = useDeferredValue(filterWorktree);
  const worktreeBranches = useAppSelector((s) => s.worktreeBranches);
  const readComments = useAppSelector((s) => s.readComments);
  const parseErrors = useAppSelector((s) => s.parseErrors);

  const scrollerRef = useRef<HTMLDivElement>(null);

  // FLUX-786: seed a "Bootstrap my board" Grooming ticket and open it. The user launches an agent
  // on it to scan the repo and propose starter tickets — we don't auto-spawn an agent from a click.
  const handleBootstrapWithAi = useCallback(async () => {
    if (bootstrapping) return;
    setBootstrapping(true);
    try {
      const task = await createTask({
        projectKey: currentProject || 'PROJECT',
        author: currentUser,
        title: 'Bootstrap my board',
        status: 'Grooming',
        body: BOOTSTRAP_TICKET_BODY,
        assignee: 'Agent',
      });
      triggerRefresh();
      openTaskModal(task);
    } catch (err) {
      console.error('[bootstrap] failed to create starter ticket:', err);
    } finally {
      setBootstrapping(false);
    }
  }, [bootstrapping, currentProject, currentUser, triggerRefresh, openTaskModal]);

  const [pendingStatusChange, setPendingStatusChange] = useState<{taskId: string, newStatus: string, oldStatus: string} | null>(null);
  const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
  const [optimisticTasks, setOptimisticTasks] = useState<Record<string, Task>>({});
  const [commentText, setCommentText] = useState('');
  const [skipFutureNotes, setSkipFutureNotes] = useState(false); // FLUX-795: modal checkbox

  // Sync local tasks with liveTasks + optimistic overrides.
  // FLUX-619 / drag perf: while a drag is in progress, DON'T re-sync — a poll/SSE update
  // mid-drag re-renders every (heavy) card under the cursor, tanking drag to a crawl and
  // making cards jump. The effect re-runs when `activeTask` clears (drop), so it catches up.
  useEffect(() => {
    if (activeTask) return;
    setTasks(liveTasks.map(task => {
      if (movingTaskIds.has(task.id) && optimisticTasks[task.id]) {
        return optimisticTasks[task.id];
      }
      return task;
    }));
  }, [liveTasks, movingTaskIds, optimisticTasks, activeTask]);

  // FLUX-1300: when THIS tab's own createTask() resolves, scroll the new card into view once it
  // mounts (creation triggers an immediate `triggerRefresh()`, but the card only renders a beat
  // later via that async task-list fetch). Bounded wait so a card that never renders here (e.g.
  // created into a status this board doesn't show) doesn't leave a dangling pending scroll.
  const pendingScrollTaskRef = useRef<{ id: string; expiresAt: number } | null>(null);
  useEffect(() => {
    const handleCreatedLocally = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) pendingScrollTaskRef.current = { id, expiresAt: Date.now() + 8000 };
    };
    window.addEventListener(TASK_CREATED_LOCALLY_EVENT, handleCreatedLocally);
    return () => window.removeEventListener(TASK_CREATED_LOCALLY_EVENT, handleCreatedLocally);
  }, []);

  useEffect(() => {
    const pending = pendingScrollTaskRef.current;
    if (!pending) return;
    if (Date.now() > pending.expiresAt) {
      pendingScrollTaskRef.current = null;
      return;
    }
    const card = document.querySelector(`[data-task-id="${pending.id}"]`);
    if (!card) return;
    pendingScrollTaskRef.current = null;
    card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }, [tasks]);

  // Clean up movingTaskIds once liveTasks catches up to the optimistic state
  useEffect(() => {
    if (movingTaskIds.size === 0) return;

    const tasksToRemove: string[] = [];
    for (const taskId of movingTaskIds) {
      const liveTask = liveTasks.find(t => t.id === taskId);
      const optimisticTask = optimisticTasks[taskId];
      if (liveTask && optimisticTask && liveTask.status === optimisticTask.status && liveTask.order === optimisticTask.order) {
        tasksToRemove.push(taskId);
      }
    }

    if (tasksToRemove.length > 0) {
      setMovingTaskIds(prev => {
        const next = new Set(prev);
        tasksToRemove.forEach(id => next.delete(id));
        return next;
      });
      setOptimisticTasks(prev => {
        const next = { ...prev };
        tasksToRemove.forEach(id => delete next[id]);
        return next;
      });
    }
  }, [liveTasks, optimisticTasks, movingTaskIds]);

  // FLUX-1487: reset to the pre-transition state whenever the panel closes, then flip to
  // "mounted" on the next frame while it's open so the slide-in transition has a starting frame.
  useEffect(() => {
    if (!furnaceOpen) {
      setFurnacePanelMounted(false);
      return;
    }
    const raf = requestAnimationFrame(() => setFurnacePanelMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [furnaceOpen]);

  useEffect(() => {
    const fn = (e: Event) => {
      setReleaseModalTasks((e as CustomEvent<{ tasks: Task[] | null }>).detail.tasks);
    };
    window.addEventListener('flux:open-release-modal', fn);
    return () => window.removeEventListener('flux:open-release-modal', fn);
  }, []);

  const archiveStatus = config ? getArchiveStatus(config) : null;
  const requireInputStatus = config ? getRequireInputStatus(config) : null;
  const hasSwimlanes = config?.swimlanes && config.swimlanes.length > 0;
  // Memoized so the filter (and the whole chain keyed off it) only re-runs when tasks/config
  // actually change — not on every Board re-render (e.g. each SSE activity tick). (FLUX-611)
  // Flow arrows: count status_change history entries in last 24h for each column→column pair.
  const columnFlowCounts = useMemo(() => {
    if (boardFx?.columnFlowArrows === false) return null;
    const cutoff = Date.now() - 86_400_000;
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      // FLUX-725: status_change stream now comes pre-filtered to 24h on the list digest; re-apply
      // the cutoff so the count stays exact across the memo's lifetime.
      for (const sc of task.historyDigest?.statusChanges24h ?? []) {
        if (!sc.from || !sc.to || new Date(sc.date).getTime() < cutoff) continue;
        const key = `${sc.from}→${sc.to}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return counts;
  }, [tasks, boardFx?.columnFlowArrows]);

  // Done-streak count (tickets that reached a done-ish status today). A board-level aggregate —
  // computed ONCE here instead of inside every Column via a whole-`s.tasks` subscription that
  // re-rendered all columns on any task change (FLUX-724). Only the Done column renders it.
  const doneStreakCount = useMemo(() => {
    if (boardFx?.doneStreak === false) return 0;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    let count = 0;
    for (const task of tasks) {
      // todayStart is always within the last 24h, so the digest's statusChanges24h is a superset.
      for (const sc of task.historyDigest?.statusChanges24h ?? []) {
        if (!/done/i.test(sc.to ?? '')) continue;
        if (new Date(sc.date).getTime() >= todayMs) { count++; break; }
      }
    }
    return count;
  }, [tasks, boardFx?.doneStreak]);

  const boardTasks = useMemo(() => config ? tasks.filter((task) =>
    task.status !== 'Released' &&
    task.status !== archiveStatus &&
    // FLUX-1225: a Scratch Chat (kind:'scratch') is a freeform conversation, not board work — it
    // never renders in a column or contributes a column. Excluding it here (the same choke point
    // that drops Released/Archived) keeps it out of decks, allColumns, and columnTasksByStatus.
    task.kind !== 'scratch' &&
    !config.hiddenStatuses?.some((hiddenStatus) => hiddenStatus.name === task.status)
  ) : [], [tasks, config, archiveStatus]);
  const allColumns = useMemo(() => {
    if (!config) return [];
    // Normalize first (FLUX-1075): a missing/invalid status must not slip an `undefined` entry
    // into this array — every downstream consumer (titleChars, Column props) assumes a string.
    const extraStatuses = Array.from(new Set(boardTasks.map(t => normalizeStatus(t.status))))
      .filter(s => !config.columns?.find(c => c.name === s) && !config.hiddenStatuses?.find(h => h.name === s));
    const cols = [...(config.columns?.map(c => c.name).filter(c => c !== archiveStatus) || []), ...extraStatuses];
    // Hide the "Require Input" column when swimlanes are active — tickets stay in their workflow column.
    // Safety: keep the column visible if any tasks still have that status (pre-migration).
    if (hasSwimlanes) {
      const anyTasksStillInRIStatus = boardTasks.some(t => t.status === requireInputStatus);
      if (!anyTasksStillInRIStatus) {
        return cols.filter(c => c !== requireInputStatus);
      }
    }
    return cols;
  }, [boardTasks, config, archiveStatus, requireInputStatus, hasSwimlanes]);
  const columnOrder = useMemo(() => new Map(allColumns.map((columnId, index) => [columnId, index])), [allColumns]);
  // FLUX-1553: shared store-level selector (AppContext computes this once per `tasks` update)
  // instead of a board-local `resolveParentByChildId(tasks)` recompute every Board render.
  const parentByChildId = useParentByChildId();
  // Union of every PR ticket's work-gated members — these fold into the PR deck and are
  // excluded from their own columns. Memoized so the Set isn't rebuilt every Board render
  // (FLUX-567 perf review).
  const foldedMemberIds = useMemo(() => collectPrMemberIds(tasks), [tasks]);
  // Epic deck (FLUX-580): a subtask in the SAME column as its epic folds into the epic's card,
  // mirroring PR members. PR membership wins (a PR-folded subtask is never also epic-folded).
  // Memoized alongside the rest of the chain (FLUX-611 perf).
  const epicFoldedIds = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return collectEpicFoldedIds(tasks, byId, foldedMemberIds);
  }, [tasks, foldedMemberIds]);
  // Everything pulled out of its own column into a deck (PR members ∪ epic subtasks).
  const deckedIds = useMemo(() => {
    if (foldedMemberIds.size === 0 && epicFoldedIds.size === 0) return null;
    const ids = new Set(foldedMemberIds);
    epicFoldedIds.forEach((id) => ids.add(id));
    return ids;
  }, [foldedMemberIds, epicFoldedIds]);

  // Filter + sort once per input change (was recomputed on EVERY render — incl. each SSE
  // activity/progress tick during agent sessions, the main board-sluggishness cause). (FLUX-611)
  const visibleTasks = useMemo(() => config ? filterAndSortTasks(boardTasks, config, {
    searchQuery: deferredSearchQuery,
    sortOption: deferredSortOption,
    filterAssignee: deferredFilterAssignee,
    filterPriority: deferredFilterPriority,
    filterTag: deferredFilterTag,
    filterUnreadOnly: deferredFilterUnreadOnly,
    filterWorktree: deferredFilterWorktree,
    worktreeBranches,
    readComments,
    requireInputStatus: getRequireInputStatus(config),
    pinnedTasks,
  }) : [], [boardTasks, config, deferredSearchQuery, deferredSortOption, deferredFilterAssignee, deferredFilterPriority, deferredFilterTag, deferredFilterUnreadOnly, deferredFilterWorktree, worktreeBranches, readComments, pinnedTasks]);

  // Cross-column subtask clusters (FLUX-677): ≥2 subtasks of one epic that piled up in a column
  // the epic isn't in collapse under a proxy deck there. Computed over visibleTasks so search/
  // filters apply, and excluding the same-column-folded set (epicFoldedIds) + PR members so a
  // child can't both fold and cluster — shared rule with the column exclusion below, no drift.
  const crossColumnClusters = useMemo(() => {
    const byId = new Map(visibleTasks.map((t) => [t.id, t]));
    return collectCrossColumnClusters(visibleTasks, byId, foldedMemberIds, epicFoldedIds);
  }, [visibleTasks, foldedMemberIds, epicFoldedIds]);

  // Decked tasks (FLUX-567 PR members + FLUX-580 epic subtasks + FLUX-677 cross-column clusters)
  // fold INTO a deck, so they don't render as loose cards in their own columns. Memoized alongside
  // the chain.
  const deckedTasks = useMemo(() => {
    const clustered = crossColumnClusters.clusteredIds;
    if (!deckedIds && clustered.size === 0) return visibleTasks;
    return visibleTasks.filter(t => !deckedIds?.has(t.id) && !clustered.has(t.id));
  }, [visibleTasks, deckedIds, crossColumnClusters]);

  // Same-column epic decks (FLUX-699): per epic, its same-column folded subtasks — rendered as a
  // peeking card stack directly BELOW the epic card (the epic is the deck's top card, not a
  // container). Resolved over visibleTasks so a filtered-out subtask's peek is hidden too; same
  // `epicFoldedIds` set that excludes them from the column flow, so no drift. Keyed by epic id.
  const foldedByEpic = useMemo(() => {
    const m = new Map<string, Task[]>();
    if (epicFoldedIds.size === 0) return m;
    const byId = new Map(visibleTasks.map((t) => [t.id, t]));
    for (const epic of visibleTasks) {
      if (!epic.subtasks?.length) continue;
      const kids: Task[] = [];
      for (const entry of epic.subtasks) {
        const cid = normalizeSubtaskId(entry);
        if (!epicFoldedIds.has(cid)) continue;
        const child = byId.get(cid);
        if (child && child.status === epic.status) kids.push(child);
      }
      if (kids.length) m.set(epic.id, kids);
    }
    return m;
  }, [visibleTasks, epicFoldedIds]);

  // Bucket tasks by column ONCE, instead of `deckedTasks.filter(...)` per-column on every
  // render (was O(columns × tasks) per render and handed Column a fresh array each time,
  // defeating its memo). (FLUX-611)
  const columnTasksByStatus = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of deckedTasks) {
      // Same normalization as allColumns — keeps the bucket key in sync with the column id
      // a status-less ticket actually renders under (FLUX-1075).
      const status = normalizeStatus(t.status);
      const arr = map.get(status);
      if (arr) arr.push(t);
      else map.set(status, [t]);
    }
    return map;
  }, [deckedTasks]);

  const getTaskTravelDirection = useCallback((taskId: string) => {
    const liveEvent = taskLiveEvents[taskId];
    if (!liveEvent || liveEvent.kind !== 'moved' || !liveEvent.fromStatus || !liveEvent.toStatus) {
      return 0;
    }

    const fromIndex = columnOrder.get(liveEvent.fromStatus);
    const toIndex = columnOrder.get(liveEvent.toStatus);

    if (fromIndex == null || toIndex == null) {
      return 0;
    }

    return Math.sign(toIndex - fromIndex) as -1 | 0 | 1;
  }, [taskLiveEvents, columnOrder]);

  if ((tasksLoading && tasks.length === 0) || !config) {
    return <BoardLoadingState />;
  }

  // FLUX-1519: `boardTokens.instant` already folds in both animationsEnabled and
  // prefers-reduced-motion, so the reduced-motion path is a genuine no-op below.
  const playEntrance = !hasBooted.current && !boardTokens.instant;

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find(t => t.id === active.id);
    if (task) setActiveTask(task);
    dragTiltRef.current.smoothedDeg = 0;
    dragTiltRef.current.prevDeltaX = 0;
    dragOverlayRef.current?.style.setProperty('--eh-drag-tilt', '0deg');
  };

  const handleDragMove = (event: DragMoveEvent) => {
    if (!boardTokens.instant) {
      const tilt = dragTiltRef.current;
      const incrementX = event.delta.x - tilt.prevDeltaX;
      tilt.prevDeltaX = event.delta.x;
      // Low-pass filter so the tilt follows velocity smoothly instead of jittering frame to frame,
      // then map to degrees clamped to ±5° per the acceptance criteria.
      tilt.smoothedDeg = tilt.smoothedDeg * 0.8 + incrementX * 0.2;
      const deg = Math.max(-5, Math.min(5, tilt.smoothedDeg));
      dragOverlayRef.current?.style.setProperty('--eh-drag-tilt', `${deg}deg`);
    }

    // FLUX-1549: reveal the Furnace rail once the dragged card nears the scroller's right edge —
    // `event.active.rect.current.translated` is the card's live on-screen rect (dnd-kit applies the
    // pointer delta for us), so this needs no separate pointer tracking. Written via CSS var + ref,
    // never setState — see furnaceRailRef's declaration.
    if (furnaceRailRef.current && scrollerRef.current) {
      const scrollerRect = scrollerRef.current.getBoundingClientRect();
      const near = isFurnaceRailRevealTarget(event.active.rect.current.translated, scrollerRect);
      furnaceRailRef.current.style.setProperty('--eh-furnace-reveal', near ? '0px' : `${FURNACE_RAIL_HIDDEN_OFFSET_PX}px`);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
    dragTiltRef.current.smoothedDeg = 0;
    dragTiltRef.current.prevDeltaX = 0;
    dragOverlayRef.current?.style.setProperty('--eh-drag-tilt', '0deg');
    if (!over) return;

    const activeTaskId = active.id as string;
    const overId = over.id as string;

    // FLUX-1053: a board card dropped onto a Furnace batch (append) or the new-batch zone (create).
    if (overId.startsWith('furnace:')) {
      try {
        if (overId === FURNACE_NEW_DROP_ID) {
          const dropped = tasks.find((x) => x.id === activeTaskId);
          await createFurnaceBatch({ title: dropped?.title || activeTaskId, ticketIds: [activeTaskId] });
        } else if (overId.startsWith('furnace:batch:')) {
          await appendFurnaceTicket(overId.slice('furnace:batch:'.length), activeTaskId);
        }
        window.dispatchEvent(new CustomEvent(FURNACE_REFRESH_EVENT));
      } catch (err) {
        console.error('Furnace drop failed:', err instanceof Error ? err.message : err);
      }
      return;
    }

    const activeTaskObj = tasks.find(t => t.id === activeTaskId);
    if (!activeTaskObj) return;

    // Check if overId is a task or a column
    const overTask = tasks.find(t => t.id === overId);
    const targetStatus = overTask ? overTask.status : overId;

    // Case 1: Moving to a DIFFERENT column
    if (activeTaskObj.status !== targetStatus) {
      // Respect the config setting for status change comments.
      // If disabled, we try to move silently and only prompt if the backend requires it (e.g. for Ready/Require Input)
      if (config.requireCommentOnStatusChange && !skipStatusNote()) {
        setPendingStatusChange({ taskId: activeTaskId, newStatus: targetStatus, oldStatus: activeTaskObj.status });
        return;
      }
      
      // Calculate order for the new column (append to end)
      const targetColumnTasks = tasks.filter(t => t.status === targetStatus);
      const maxOrder = targetColumnTasks.reduce((max, t) => Math.max(max, t.order ?? 0), -1);
      const newOrder = maxOrder + 1;

      await applyStatusChange(activeTaskId, targetStatus, activeTaskObj.status, undefined, newOrder);
    }
    // Case 2: Reordering within SAME column
    else if (overTask && activeTaskId !== overId) {
      const columnTasks = tasks
        .filter(t => t.status === targetStatus)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      const oldIndex = columnTasks.findIndex(t => t.id === activeTaskId);
      const newIndex = columnTasks.findIndex(t => t.id === overId);

      const newOrderedTasks = arrayMove(columnTasks, oldIndex, newIndex);
      const changedTasks = newOrderedTasks.map((t, index) => ({ ...t, order: index }));

      // Update local state optimistically
      setMovingTaskIds(prev => {
        const next = new Set(prev);
        changedTasks.forEach(t => next.add(t.id));
        return next;
      });
      setOptimisticTasks(prev => {
        const next = { ...prev };
        changedTasks.forEach(t => next[t.id] = t);
        return next;
      });

      // Persist changes
      try {
        await Promise.all(changedTasks.map((t) =>
          updateTask(t.id, { order: t.order, updatedBy: currentUser })
        ));
        triggerRefresh();
      } catch (err) {
        console.error('Failed to persist reorder:', err);
        setMovingTaskIds(prev => {
          const next = new Set(prev);
          changedTasks.forEach(t => next.delete(t.id));
          return next;
        });
        setOptimisticTasks(prev => {
          const next = { ...prev };
          changedTasks.forEach(t => delete next[t.id]);
          return next;
        });
        triggerRefresh();
      }
    }
  };

  const applyStatusChange = async (taskId: string, newStatus: string, oldStatus: string, comment?: string, newOrder?: number) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // FLUX-1507: measure the card's rect BEFORE the optimistic state below moves it — must run
    // synchronously, ahead of every `setState` in this function (see useCardFlight.ts).
    if (newStatus !== oldStatus) beginCardFlight(taskId);

    // Shared with the chat action bar (FLUX-610) — `from` pinned to the explicit oldStatus
    // so optimistic state never skews the recorded transition. FLUX-725: send the history DELTA via
    // `appendHistory` (the list payload no longer carries full `history`), and fold the move into the
    // optimistic card's digest so its history-derived chips stay correct until the server confirms.
    const appendHistory = buildStatusChangeHistory({ ...task, status: oldStatus }, newStatus, currentUser, comment);

    const finalOrder = newOrder ?? (task.order || 0);
    const optimisticTask = {
      ...task,
      status: newStatus,
      order: finalOrder,
      historyDigest: applyOptimisticStatusChange(task.historyDigest, oldStatus, newStatus, comment, currentUser),
    };

    setMovingTaskIds(prev => new Set(prev).add(taskId));
    setOptimisticTasks(prev => ({ ...prev, [taskId]: optimisticTask }));

    try {
      await updateTask(taskId, {
        status: newStatus,
        order: finalOrder,
        appendHistory,
        updatedBy: currentUser,
        // FLUX-847: session skip relaxes only the engine's config-gated Ready check — Require
        // Input still rejects comment-less moves below, which is what drives the reactive prompt.
        ...(skipStatusNote() ? { skipCommentRequirement: true } : {}),
      });
      triggerRefresh();
    } catch (err) {
      console.error(err);

      // Reactive prompting: if the engine still requires a comment (Require Input, or Ready with
      // skip off), show the modal instead of alerting.
      if (isMissingCommentError(err)) {
        setMovingTaskIds(prev => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
        setOptimisticTasks(prev => {
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        setPendingStatusChange({ taskId, newStatus, oldStatus });
        return;
      }

      const errMessage = err instanceof Error ? err.message : '';
      setMovingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      setOptimisticTasks(prev => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      notify.error('Failed to update task: ' + errMessage);
    }
    setPendingStatusChange(null);
    setCommentText('');
    setSkipFutureNotes(false);
  };

  // FLUX-1570: dnd-kit's default `pointerWithin` only sees the Furnace quick-drop panel's real
  // (fixed 40px, FLUX-1549) droppable node, so a drop anywhere else on the visible panel falls
  // through to the Done column underneath. Override the collision result across the whole panel
  // while it's mounted (`!furnaceOpen && activeTask` — matches the render condition below); with the
  // drawer open this is a no-op passthrough so its own batch-card droppables are untouched. Built
  // fresh each render (cheap closure, no hook) — this function sits after the loading-state early
  // return above, so it can't be a `useMemo`/other hook without violating rules-of-hooks.
  const furnaceAwareCollisionDetection = makeFurnaceAwareCollision({
    isQuickDropMounted: () => !furnaceOpen && !!activeTask,
    getScrollerRect: () => scrollerRef.current?.getBoundingClientRect() ?? null,
  });

  return (
    <>
      <motion.div
        className="flex h-full min-h-0 flex-col gap-0"
        animate={{
          opacity: active ? 1 : 0,
          y: active ? 0 : (boardTokens.crossfadeDirection === 'down' ? boardTokens.crossfadeDriftPx : -boardTokens.crossfadeDriftPx),
          scale: (isModalOpen && !boardTokens.instant) ? 0.96 : 1,
        }}
        transition={{ default: boardTokens.fade, scale: boardTokens.spring }}
        style={{ pointerEvents: active ? 'auto' : 'none' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <TaskViewControls
              title="Board filters"
              searchPlaceholder="Filter cards in this board"
              visibleCount={visibleTasks.length}
              totalCount={boardTasks.length}
              itemLabel="board tickets"
            />
          </div>
          <ParseErrorButton errors={parseErrors} />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {boardTasks.length === 0 && !tasksLoading && (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <p className="text-sm text-gray-500 dark:text-gray-400">No tickets yet.</p>
              <div className="flex flex-col items-center gap-2">
                <button
                  onClick={handleBootstrapWithAi}
                  disabled={bootstrapping}
                  className="board-accent-button flex items-center gap-2 rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {bootstrapping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Bootstrap with AI
                </button>
                <button
                  onClick={() => setShowBootstrap(true)}
                  className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-5 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:hover:bg-white/10"
                >
                  <Upload className="h-4 w-4" />
                  Import from project
                </button>
                <p className="mt-1 max-w-xs text-center text-xs text-gray-400">
                  Bootstrap creates a starter ticket; launch an agent on it to scan your repo and propose tickets.
                </p>
              </div>
            </div>
          )}
          <DndContext onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd} collisionDetection={furnaceAwareCollisionDetection}>
            <div className="relative flex h-full min-h-0">
            <div
              ref={scrollerRef}
              data-testid="board-scroller"
              className="flex min-h-full flex-1 gap-2 pb-4 items-stretch overflow-x-auto"
            >
              {allColumns.map((columnId, idx) => {
                const prevCol = idx > 0 ? allColumns[idx - 1] : null;
                const nextCol = idx < allColumns.length - 1 ? allColumns[idx + 1] : null;
                // Outbound flow in the last 24h: tickets that moved back to the previous column
                // (left) vs forward to the next column (right) — chips flanking the title (FLUX-723).
                const flowLeft = prevCol && columnFlowCounts ? (columnFlowCounts[`${columnId}→${prevCol}`] ?? 0) : 0;
                const flowRight = nextCol && columnFlowCounts ? (columnFlowCounts[`${columnId}→${nextCol}`] ?? 0) : 0;
                // Uniform hue-bar width across all columns ≈ the widest title (FLUX-723).
                const maxTitleChars = Math.max(1, ...allColumns.map((c) => c.length));
                return (
                  <Column
                    key={columnId}
                    id={columnId}
                    title={columnId}
                    tasks={columnTasksByStatus.get(columnId) ?? EMPTY_TASKS}
                    clusters={crossColumnClusters.byColumn.get(columnId)}
                    foldedByEpic={foldedByEpic}
                    parentByChildId={parentByChildId}
                    liveEvent={columnLiveEvents[columnId]}
                    taskLiveEvents={taskLiveEvents}
                    getTaskTravelDirection={getTaskTravelDirection}
                    flowLeft={flowLeft}
                    flowRight={flowRight}
                    titleChars={maxTitleChars}
                    doneStreakCount={doneStreakCount}
                    bootEntranceDelayMs={playEntrance ? idx * COLD_BOOT_STAGGER_MS : undefined}
                  />
                );
              })}
            </div>
            {furnaceOpen && (
              <div
                className={`absolute inset-y-2 right-2 w-[404px] z-30 overflow-hidden rounded-2xl border transition-all duration-[280ms] ease-out ${
                  furnacePanelMounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
                }`}
                style={{
                  borderColor: 'var(--eh-border)',
                  boxShadow: '0 20px 48px -12px rgba(0, 0, 0, 0.35), 0 0 32px -4px var(--eh-furnace-accent-glow)',
                }}
              >
                <FurnaceDrawer onClose={onCloseFurnace} />
              </div>
            )}
            {/* FLUX-1533: without the drawer open, dragging a card near the Furnace icon has no drop
                target at all (the drawer — and its useDroppable zones — only mount while furnaceOpen).
                Surface a large stand-in target, same footprint as the real panel, for the duration of
                any card drag so dropping into the Furnace doesn't require opening the drawer first.
                It reuses FURNACE_NEW_DROP_ID, so handleDragEnd's existing new-batch handling covers it.
                FLUX-1549: it's a zero-footprint overlay (see the FurnaceQuickDropZone comment above) —
                the scroller no longer reserves any space for it. */}
            {!furnaceOpen && activeTask && <FurnaceQuickDropZone railRef={furnaceRailRef} />}
            </div>
            <DragOverlay dropAnimation={dragDropAnimation}>
              {activeTask
                ? (
                  <div
                    ref={dragOverlayRef}
                    className={[boardFx?.dragTrail !== false && 'drag-trail-overlay', !boardTokens.instant && 'drag-lift'].filter(Boolean).join(' ') || undefined}
                  >
                    <TaskCardInner task={activeTask} parentTask={parentByChildId.get(activeTask.id)} isOverlay />
                  </div>
                )
                : null}
            </DragOverlay>
          </DndContext>
        </div>
      </motion.div>

      {pendingStatusChange && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="eh-surface-overlay p-6 rounded-xl shadow-2xl w-[400px] border eh-border">
            <h3 className="text-lg font-bold mb-2">Update Status</h3>
            <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <span>Moving task to</span>
              <StatusBadge
                status={pendingStatusChange.newStatus}
                colorClass={getStatusColorClass(config, pendingStatusChange.newStatus)}
                className="text-[10px] font-bold uppercase tracking-[0.16em]"
              />
              <span>Add a quick note?</span>
            </p>
            <textarea
              autoFocus
              className="w-full bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 outline-none focus:border-primary resize-none text-sm mb-4 h-24"
              placeholder="Optional comment..."
              value={commentText} onChange={e => setCommentText(e.target.value)}
            />
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipFutureNotes}
                  onChange={e => setSkipFutureNotes(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
                />
                Don't ask again this session
              </label>
              <div className="flex gap-3">
                <button
                  onClick={() => { setPendingStatusChange(null); setSkipFutureNotes(false); setCommentText(''); }}
                  className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer transition-colors"
                >Cancel</button>
                <button
                  onClick={() => {
                    // FLUX-795: persist the opt-out for the session before applying this move.
                    if (skipFutureNotes) setSkipStatusNote(true);
                    applyStatusChange(pendingStatusChange.taskId, pendingStatusChange.newStatus, pendingStatusChange.oldStatus, commentText);
                  }}
                  className="board-accent-button px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium cursor-pointer transition-colors"
                >Save Update</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {releaseModalTasks && (
        <ReleaseModal tasks={releaseModalTasks} onClose={() => setReleaseModalTasks(null)} />
      )}
      {showBootstrap && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm pointer-events-auto">
          <div className="eh-surface-overlay p-6 rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto border eh-border">
            <h3 className="text-lg font-bold mb-4 text-gray-900 dark:text-white">Import from project</h3>
            <BootstrapPreview
              onComplete={() => { setShowBootstrap(false); triggerRefresh(); }}
              onSkip={() => setShowBootstrap(false)}
            />
          </div>
        </div>
      )}
    </>
  );
});

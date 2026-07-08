import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { FurnaceDrawer } from './FurnaceDrawer';
import { FURNACE_NEW_DROP_ID, FURNACE_REFRESH_EVENT } from '../furnaceTypes';
import { appendFurnaceTicket, createFurnaceBatch } from '../api';
import { arrayMove } from '@dnd-kit/sortable';
import { Column } from './Column';
import { StatusBadge } from './StatusBadge';
import { TaskCardInner } from './TaskCard';
import { createTask, updateTask, TASK_CREATED_LOCALLY_EVENT } from '../api';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { buildStatusChangeHistory, applyOptimisticStatusChange, isMissingCommentError } from '../lib/ticketActions';
import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { Loader2, Upload, Sparkles } from 'lucide-react';
import { TaskViewControls } from './TaskViewControls';
import { filterAndSortTasks } from '../taskSearch';
import { getStatusColorClass } from '../statusStyles';
import { ReleaseModal } from './ReleaseModal';
import { getArchiveStatus, getRequireInputStatus, normalizeStatus } from '../workflow';
import { collectPrMemberIds, collectEpicFoldedIds, collectCrossColumnClusters } from '../lib/decks';
import { ParseErrorButton } from './ParseErrorButton';
import { BootstrapPreview } from './BootstrapPreview';

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

// FLUX-1141: memoized so an unrelated AppContent re-render (terminal/furnace toggle, the 5s
// furnace-status poll) doesn't re-invoke this whole ~700-line tree — furnaceOpen/onCloseFurnace
// are its only props and stay stable across those toggles, so the memo boundary actually bails.
export const Board = memo(function Board({ furnaceOpen, onCloseFurnace }: { furnaceOpen?: boolean; onCloseFurnace?: () => void } = {}) {
  const liveTasks = useAppSelector((s) => s.tasks);
  // FLUX-982: seed local `tasks` from the already-loaded store snapshot instead of `[]`. Board
  // fully unmounts/remounts on view switch (App.tsx `{view === 'board' && <Board />}`), and the
  // effect below that syncs `liveTasks` into local state only runs AFTER the first commit — so an
  // empty initial value meant every return to Board painted a blank board for a frame before
  // popping in, reading as a "reload". `liveTasks` is already resolved above by the time this
  // lazy initializer runs, so remounting now paints with real data immediately.
  const [tasks, setTasks] = useState<Task[]>(() => liveTasks);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [releaseModalTasks, setReleaseModalTasks] = useState<Task[] | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const { triggerRefresh, openTaskModal } = useAppActions();
  const currentProject = useAppSelector((s) => s.currentProject);
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
  const parentByChildId = useMemo(() => {
    const map = new Map<string, Task>();
    [...tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach((candidateParent) => {
        candidateParent.subtasks?.forEach((entry) => {
          const childId = normalizeSubtaskId(entry);
          if (!map.has(childId)) {
            map.set(childId, candidateParent);
          }
        });
      });
    return map;
  }, [tasks]);
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
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const task = tasks.find(t => t.id === active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);
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
      alert('Failed to update task: ' + errMessage);
    }
    setPendingStatusChange(null);
    setCommentText('');
    setSkipFutureNotes(false);
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-0">
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
          <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd} collisionDetection={pointerWithin}>
            <div className="flex h-full min-h-0">
            <div ref={scrollerRef} className="flex min-h-full flex-1 gap-2 pb-4 items-stretch overflow-x-auto">
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
                  />
                );
              })}
            </div>
            {furnaceOpen && (
              <div className="w-[380px] shrink-0 h-full overflow-hidden border-l" style={{ borderColor: 'var(--eh-border)' }}>
                <FurnaceDrawer onClose={onCloseFurnace} />
              </div>
            )}
            </div>
            <DragOverlay>
              {activeTask
                ? <div className={boardFx?.dragTrail !== false ? 'drag-trail-overlay' : undefined}><TaskCardInner task={activeTask} parentTask={parentByChildId.get(activeTask.id)} isOverlay /></div>
                : null}
            </DragOverlay>
          </DndContext>
        </div>
      </div>

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

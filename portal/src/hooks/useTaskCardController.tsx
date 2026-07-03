/* eslint-disable react-hooks/exhaustive-deps -- extracted verbatim from TaskCard; deps deliberately preserved to keep original effect/handler semantics (no behavior change). */
import { useState, useRef, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import type { Task, TaskLiveEvent, AgentSessionEntry, AgentSessionProgress } from '../types';
import { isAgentSession, normalizeSubtaskId } from '../types';
import { AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import { useAppSelector, useAppActions, useLiveSession, shallowEqual } from '../store/useAppSelector';
import { useDockActions } from '../components/DockProvider';
import { sendTaskCliInput, updateTask, detachWorktree } from '../api';
import { useTicketActions } from './useTicketActions';
import { type LaunchPhase } from '../agentActions';
import { getReadyForMergeStatus, isPromptableStatus, isTaskAwaitingInput, classifyCardSessionState } from '../workflow';
import { epicDeckSubtasks } from '../lib/decks';
import { isEpic as isEpicTask, getDoneStatuses } from '../lib/epics';
import { groupSessions, aggregateGroup, isGroupLive, isCombinerPending } from '../orchestration';
import { useAnimationControls } from 'framer-motion';
import { tintFill, type StatusTint } from '../statusStyles';

// Stable empty subtask list so non-epic cards get a referentially-stable selector
// result and never re-render when an unrelated task changes (FLUX-625).
const EMPTY_SUBTASKS: Task[] = [];

// Strip inline markdown from the one-line card snippet (FLUX-652) so syntax like
// `**Depends on P1–P3.**` renders as clean text instead of leaking literal asterisks into the
// 3-line clamp. Block syntax (headings) is already filtered out before this runs.
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/`([^`]+)`/g, '$1')                // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // links / images → label text
    .replace(/(\*\*|__)(.*?)\1/g, '$2')         // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')            // italic
    .replace(/~~(.*?)~~/g, '$1')                // strikethrough
    .replace(/^\s*[-*+]\s+/, '')                // leading list bullet
    .replace(/^\s*>\s?/, '')                    // blockquote marker
    .trim();
}

export interface TaskCardControllerArgs {
  task: Task;
  parentTask?: Task;
  isOverlay?: boolean;
  liveEvent?: TaskLiveEvent;
  travelDirection?: -1 | 0 | 1;
  columnTint?: StatusTint;
  hideStatusBadge?: boolean;
  /** dnd-kit bits owned by the thin <TaskCard> wrapper (which calls useSortable) and passed
   *  in — so this heavy controller does NOT subscribe to dnd-kit and isn't re-run as the card
   *  shifts during a drag. (drag perf) */
  attributes?: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  isDragging?: boolean;
}

export function useTaskCardController({
  task,
  parentTask,
  isOverlay,
  liveEvent,
  travelDirection = 0,
  columnTint,
  hideStatusBadge = false,
  attributes,
  listeners,
  isDragging = false,
}: TaskCardControllerArgs) {
  const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];
  const { openTask, openTaskModal, openTaskFullView, saveConfig, triggerRefresh, ensureReadStateLoaded, markCommentRead: ctxMarkCommentRead, markAllCommentsRead: ctxMarkAllCommentsRead, refreshWorktrees, setView, setChangesFocus } = useAppActions();
  // FLUX-744: opening a ticket from a card now lands in the chat-aligned view with its sideview open
  // (via the dock) instead of the center modal — see `openBoardTask`.
  const { openTicket } = useDockActions();
  const config = useAppSelector((s) => s.config);
  const currentUser = useAppSelector((s) => s.currentUser);
  // Fine-grained slices (FLUX-625): select per-card derived values so a worktree or
  // read-state change for some OTHER card doesn't re-render this one.
  const hasWorktree = useAppSelector((s) => !!task.branch && s.worktreeBranches.has(task.branch));
  const worktreeChangedFiles = useAppSelector((s) => (task.branch ? s.worktrees.find((w) => w.branch === task.branch)?.changedFiles ?? 0 : 0));
  // Which Changes-view section this card links to: its live worktree (if it has
  // uncommitted changes) or its stored committed diff (Done/finished tickets — the
  // "Recently merged" section, which only carries done-ish statuses).
  const hasStoredDiff = ['Done', 'Released', 'Archived'].includes(task.status) && (task.diffSummary?.length ?? 0) > 0;
  const diffFocusKey = hasWorktree && worktreeChangedFiles > 0 && task.branch
    ? task.branch
    : hasStoredDiff
      ? `done:${task.id}`
      : null;
  const [detachState, setDetachState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [detachMsg, setDetachMsg] = useState<string | null>(null);
  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [isTagRowOverflowing, setIsTagRowOverflowing] = useState(false);
  const [isTagAreaActive, setIsTagAreaActive] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [priorityName, setPriorityName] = useState(task.priority || 'None');
  const [effortName, setEffortName] = useState(task.effort || 'None');
  const [assigneeName, setAssigneeName] = useState(task.assignee || 'unassigned');
  const [titleValue, setTitleValue] = useState(task.title || '');
  const [tagNames, setTagNames] = useState(task.tags || []);
  const priorityMenuRef = useRef<HTMLDivElement | null>(null);
  const effortMenuRef = useRef<HTMLDivElement | null>(null);
  const assigneeMenuRef = useRef<HTMLDivElement | null>(null);
  const tagMenuRef = useRef<HTMLDivElement | null>(null);
  const tagPreviewRowRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [commentPopoverOpen, setCommentPopoverOpen] = useState(false);
  const [commentPopoverPos, setCommentPopoverPos] = useState({ top: 0, left: 0 });
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [popoverReplyTarget, setPopoverReplyTarget] = useState<string | null>(null);
  const [popoverReplyDraft, setPopoverReplyDraft] = useState('');
  const [popoverReplySaving, setPopoverReplySaving] = useState(false);
  const commentBadgeRef = useRef<HTMLButtonElement | null>(null);
  const commentPopupRef = useRef<HTMLDivElement | null>(null);
  const commentHoverTimeout = useRef<number | null>(null);
  const commentOpenedByHover = useRef(false);
  const commentCloseTimeout = useRef<number | null>(null);
  const isMouseOverCard = useRef(false);
  const lastCardRectRef = useRef<DOMRect | null>(null);
  const effortLabel = effortName && effortName !== 'None' ? effortName : null;
  const [subtaskPopoverOpen, setSubtaskPopoverOpen] = useState(false);
  const [subtaskPopoverPos, setSubtaskPopoverPos] = useState({ top: 0, left: 0 });
  const subtaskBadgeRef = useRef<HTMLButtonElement | null>(null);
  const subtaskPopupRef = useRef<HTMLDivElement | null>(null);
  const tagAreaHoverTimeout = useRef<number | null>(null);

  const subtaskIds = useMemo(() => task.subtasks?.map(normalizeSubtaskId) ?? [], [task.subtasks]);
  // Share the epic definition + done-status set with the Epics screen via lib/epics so the
  // card and the roadmap view can never drift on what counts as done (FLUX-678).
  const isEpic = isEpicTask(task);

  const doneStatuses = useMemo(() => getDoneStatuses(config), [config]);

  // NOTE: this rollup arithmetic is intentionally duplicated from computeEpicRollup (lib/epics)
  // rather than calling it — the card resolves subtasks through the memoized useAppSelector below
  // for render perf. It MUST stay in lockstep with computeEpicRollup (same total = declared count,
  // done = resolved-in-done-set, dangling = not-done); a divergence reintroduces the board↔Epics
  // drift FLUX-678 eliminated. Only isEpic + getDoneStatuses are actually shared.
  const resolvedSubtasks = useAppSelector(
    (s) => (isEpic ? subtaskIds.map((id) => s.taskById.get(id)).filter((t): t is Task => !!t) : EMPTY_SUBTASKS),
    shallowEqual,
  );
  const subtaskDoneCount = useMemo(
    () => resolvedSubtasks.filter(t => doneStatuses.has(t.status)).length,
    [resolvedSubtasks, doneStatuses]
  );
  const subtaskTotal = subtaskIds.length;
  // Per-card subtask lookup (FLUX-625): only this epic's resolved children, so the
  // subtask popover re-renders when one of THEM changes — not on any board task change.
  const subtaskById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of resolvedSubtasks) map.set(t.id, t);
    return map;
  }, [resolvedSubtasks]);
  // Epic deck contents (FLUX-580): this epic's subtasks that share its column and aren't
  // already folded into a PR deck (PR precedence). The card folds these into an indigo deck,
  // mirroring the board's column exclusion (collectEpicFoldedIds) — same rule, no drift.
  const prMemberIds = useAppSelector((s) => s.prMemberIds);
  const epicFoldedSubtasks = useMemo(
    () => (isEpic ? epicDeckSubtasks(task, resolvedSubtasks, prMemberIds) : EMPTY_SUBTASKS),
    [isEpic, task, resolvedSubtasks, prMemberIds]
  );

  // dnd-kit attributes/listeners/isDragging arrive from the <TaskCard> wrapper via args (above).

  useEffect(() => {
    setPriorityName(task.priority || 'None');
  }, [task.priority]);

  useEffect(() => {
    setEffortName(task.effort || 'None');
  }, [task.effort]);

  useEffect(() => {
    setAssigneeName(task.assignee || 'unassigned');
  }, [task.assignee]);

  useEffect(() => {
    setTitleValue(task.title || '');
  }, [task.title]);

  useEffect(() => {
    setTagNames(task.tags || []);
  }, [task.tags]);

  useEffect(() => {
    ensureReadStateLoaded(task.id);
  }, [task.id, ensureReadStateLoaded]);

  useEffect(() => {
    if (!isEditingTitle) return undefined;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
    return undefined;
  }, [isEditingTitle]);

  useEffect(() => {
    if (!priorityMenuOpen && !effortMenuOpen && !assigneeMenuOpen && !tagMenuOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!priorityMenuRef.current?.contains(event.target as Node)) {
        setPriorityMenuOpen(false);
      }
      if (!effortMenuRef.current?.contains(event.target as Node)) {
        setEffortMenuOpen(false);
      }
      if (!assigneeMenuRef.current?.contains(event.target as Node)) {
        setAssigneeMenuOpen(false);
      }
      if (!tagMenuRef.current?.contains(event.target as Node)) {
        setTagMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPriorityMenuOpen(false);
        setEffortMenuOpen(false);
        setAssigneeMenuOpen(false);
        setTagMenuOpen(false);
        setIsEditingTitle(false);
        setTitleValue(task.title || '');
        setContextMenuPos(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [priorityMenuOpen, effortMenuOpen, assigneeMenuOpen, tagMenuOpen, task.title]);

  // transform/transition/opacity for the drag live on the thin <TaskCard> wrapper now — this
  // style only carries the column-move shift variable. (drag perf)
  const style: CSSProperties & Record<string, string | number | undefined> = {};

  if (liveEvent?.kind === 'moved') {
    style['--task-shift-x'] = `${travelDirection * 42}px`;
  }

  const rawSnippetLine = task.body?.split('\n').find(line => line.trim() && !line.startsWith('#'));
  const snippet = (rawSnippetLine && stripInlineMarkdown(rawSnippetLine)) || 'No description provided';

  const readCommentIdsList = useAppSelector((s) => s.readComments[task.id]);
  const readCommentIds = useMemo(() => new Set(readCommentIdsList ?? []), [readCommentIdsList]);
  const hasActiveCliSession = Boolean(task.cliSession && ['pending', 'running', 'waiting-input'].includes(task.cliSession.status));
  // FLUX-626: prefer the SSE-fed `liveSessions` slice (instant) over the polled cliSession
  // value, so activity ticks update this card without churning the whole tasks array.
  const liveSession = useLiveSession(task.id);
  const currentActivity = hasActiveCliSession ? (liveSession?.currentActivity ?? task.cliSession?.currentActivity ?? 'Running') : undefined;
  // FLUX-909: the parked-vs-running sub-state for the single-session row. `waiting-input` is
  // overloaded (blocked-on-user vs clean idle turn-end), so classify it from the task signals.
  // Prefer the live SSE status so the pill flips the instant a turn ends (same rationale as
  // `currentActivity` above), and keep `hasActiveCliSession` unchanged — other call sites depend on
  // it covering all three active statuses.
  const sessionState = classifyCardSessionState(task, liveSession?.status, config);

  // Multi-agent cluster: show the most recent multi-session run group while it is
  // still live (workers running, or a combiner still owed). Grouping ALL sessions
  // — not just active ones — keeps completed/failed agents visible as the run
  // unfolds, instead of having them vanish one by one as each finishes.
  const clusterGroup = useMemo(() => {
    const groups = groupSessions(task.cliSessions ?? []);
    return groups.find(g => g.isMulti && isGroupLive(g, aggregateGroup(g))) ?? null;
  }, [task.cliSessions]);
  const clusterAgg = useMemo(() => (clusterGroup ? aggregateGroup(clusterGroup) : null), [clusterGroup]);
  const clusterCombinerPending = useMemo(
    () => (clusterGroup && clusterAgg ? isCombinerPending(clusterGroup, clusterAgg) : false),
    [clusterGroup, clusterAgg]
  );

  // Check agent session history for recent activity
  const agentProgressEnabled = config?.agentProgress?.enabled !== false;
  const agentProgressDelay = (config?.agentProgress?.inlineDelay ?? 2) * 1000;
  const recentAgentSession = task.history?.find(
    (entry): entry is AgentSessionEntry => isAgentSession(entry) && entry.status === 'active'
  );
  // FLUX-626: live progress streams into the liveSessions slice (keyed by sessionId), not the
  // polled history — prefer it while the session is active so the card's inline progress updates.
  const liveProgress = recentAgentSession?.sessionId
    ? liveSession?.progressBySession?.[recentAgentSession.sessionId]
    : undefined;
  const latestProgress: AgentSessionProgress | undefined = (liveProgress && liveProgress.length > 0)
    ? liveProgress[liveProgress.length - 1]
    : recentAgentSession?.progress?.[recentAgentSession.progress.length - 1];
  const showAgentProgress = agentProgressEnabled && recentAgentSession && latestProgress;
  const sessionAge = recentAgentSession?.startedAt
    ? Date.now() - new Date(recentAgentSession.startedAt).getTime()
    : 0;
  const shouldShowProgress = showAgentProgress && sessionAge >= agentProgressDelay;

  const isPromptStatus = isPromptableStatus(task.status, config) || isTaskAwaitingInput(task);
  const readyForMergeStatus = getReadyForMergeStatus(config);
  const isReadyForMerge = task.status === readyForMergeStatus;
  // FLUX-715: the launch/dispatch/transition slice now lives in the shared useTicketActions hook.
  // The card renders its buttons from `ticketActions` (via <TicketActionsView variant="card">) and
  // the launcher + start-prompt portals via <TicketActionsLaunchers>. Only branch-copy and the
  // "is an action menu open" flag (for hover-popup suppression) stay card-local.
  const ticketActions = useTicketActions(task);
  const [branchCopied, setBranchCopied] = useState(false);
  const [actionMenuActive, setActionMenuActive] = useState(false);
  const comments = task.history?.filter(e => e.type === 'comment') ?? [];
  const topLevelComments = [...comments.filter(c => !c.replyTo)].reverse();
  const repliesByParentId = new Map<string, typeof comments>();
  for (const c of comments) {
    if (c.replyTo) {
      const bucket = repliesByParentId.get(c.replyTo) ?? [];
      bucket.push(c);
      repliesByParentId.set(c.replyTo, bucket);
    }
  }
  const unreadComments = comments.filter(c => c.id && !readCommentIds.has(c.id) && c.user !== currentUser);
  const hasUnread = unreadComments.length > 0;

  const submitPopoverReply = async (parentId: string) => {
    if (!popoverReplyDraft.trim()) return;
    setPopoverReplySaving(true);
    try {
      const message = popoverReplyDraft.trim();
      // If a session is paused (waiting-input), route the reply to it so the
      // agent is resumed with the user's answer. The input route logs to history
      // server-side, so no separate history write is needed.
      const sessionResumable = task.cliSession && task.cliSession.status === 'waiting-input';
      if (sessionResumable) {
        await sendTaskCliInput(task.id, message, currentUser);
      } else {
        // FLUX-725: append the reply as a delta (the card task carries only a history digest now).
        const replyEntry = {
          type: 'comment' as const,
          user: currentUser,
          comment: message,
          replyTo: parentId,
        };
        await updateTask(task.id, { appendHistory: [replyEntry], updatedBy: currentUser } as Partial<Task>);
      }
      triggerRefresh();
      setPopoverReplyTarget(null);
      setPopoverReplyDraft('');
    } finally {
      setPopoverReplySaving(false);
    }
  };

  // Inline "close worktree" (detach): removes the dedicated worktree but keeps the
  // branch, surfacing any uncommitted work back onto the main tree. Optimistic —
  // refreshes worktrees + tasks so the badge clears without a manual page reload.
  const handleCardDetach = async () => {
    setDetachState('busy');
    try {
      const r = await detachWorktree(task.id);
      const label = r.outcome === 'applied'
        ? 'Work returned to main tree'
        : r.outcome === 'stashed'
          ? `Kept as stash ${r.stashRef?.slice(0, 8) ?? ''}`.trim()
          : 'Worktree closed';
      setDetachMsg(label);
      refreshWorktrees();
      triggerRefresh();
      setTimeout(() => { setDetachMsg(null); setDetachState('idle'); }, 4000);
    } catch (err) {
      setDetachMsg(err instanceof Error ? err.message.slice(0, 80) : 'Close failed');
      setDetachState('idle');
      setTimeout(() => setDetachMsg(null), 5000);
    }
  };

  // PR-deck launch shortcuts (FLUX-568) route through the shared launcher with an explicit phase
  // so the phase is set deterministically (the board default would mislabel the next Review).
  const openLauncherInPhase = (phase: LaunchPhase, templateId?: string) =>
    ticketActions.openLauncher(phase, templateId);

  const getTagColor = (tagName: string) => {
    const tagObj = config?.tags?.find(t => t.name === tagName);
    return tagObj?.color || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  };

  const getPriorityIcon = (priorityName: string) => {
    const p = config?.priorities?.find(p => p.name === priorityName);
    const color = p?.color || 'text-gray-400';
    switch (p?.icon) {
      case 'AlertCircle': return <AlertCircle className={`w-3.5 h-3.5 ${color}`} />;
      case 'ChevronUp': return <ChevronUp className={`w-3.5 h-3.5 ${color}`} />;
      case 'ChevronDown': return <ChevronDown className={`w-3.5 h-3.5 ${color}`} />;
      case 'Equal':
      case 'Equals': return <Equal className={`w-3.5 h-3.5 ${color}`} />;
      default: return null;
    }
  };

  const saveInlineUpdate = async <K extends keyof Task>(field: K, nextValue: Task[K], onRollback: () => void) => {
    try {
      await updateTask(task.id, { [field]: nextValue, updatedBy: currentUser } as Partial<Task>);
      triggerRefresh();
    } catch (error) {
      console.error(`Failed to update ${String(field)}:`, error);
      onRollback();
    }
  };

  const handlePriorityChange = async (nextPriority: string) => {
    const previousPriority = priorityName;
    setPriorityName(nextPriority);
    setPriorityMenuOpen(false);
    try {
      await updateTask(task.id, { priority: nextPriority, updatedBy: currentUser } as Partial<Task>);
      triggerRefresh();
    } catch (error) {
      console.error('Failed to update priority:', error);
      setPriorityName(previousPriority);
    }
  };

  const handleEffortChange = async (nextEffort: string) => {
    const previousEffort = effortName;
    setEffortName(nextEffort);
    setEffortMenuOpen(false);
    try {
      await updateTask(task.id, { effort: nextEffort, updatedBy: currentUser } as Partial<Task>);
      triggerRefresh();
    } catch (error) {
      console.error('Failed to update effort:', error);
      setEffortName(previousEffort);
    }
  };

  const handleAssigneeChange = async (nextAssignee: string) => {
    const previousAssignee = assigneeName;
    setAssigneeName(nextAssignee);
    setAssigneeMenuOpen(false);
    await saveInlineUpdate('assignee', nextAssignee, () => setAssigneeName(previousAssignee));
  };

  const handleTitleSave = async () => {
    const trimmedTitle = titleValue.trim();
    const nextTitle = trimmedTitle || task.title || 'Untitled Task';
    const previousTitle = task.title || '';
    setTitleValue(nextTitle);
    setIsEditingTitle(false);

    if (nextTitle === previousTitle) {
      return;
    }

    await saveInlineUpdate('title', nextTitle, () => setTitleValue(previousTitle));
  };

  const handleTagToggle = async (tagName: string) => {
    const previousTags = tagNames;
    const nextTags = previousTags.includes(tagName)
      ? previousTags.filter((tag) => tag !== tagName)
      : [...previousTags, tagName];
    setTagNames(nextTags);
    await saveInlineUpdate('tags', nextTags, () => setTagNames(previousTags));
  };

  const allUsers = config?.users?.map((user) => user.name) || [];
  const allTags = config?.tags?.map((tag) => tag.name) || [];
  const visibleTitle = titleValue || 'Untitled Task';
  const visibleAssignee = assigneeName || 'unassigned';
  const liveAnimationClass = !isOverlay && liveEvent
    ? liveEvent.kind === 'created'
      ? 'task-live-created'
      : liveEvent.kind === 'moved'
        ? 'task-live-moved'
        : 'task-live-updated'
    : '';
  const liveAccentClass = !isOverlay && liveEvent
    ? liveEvent.kind === 'created'
      ? 'ring-2 ring-emerald-200/80 dark:ring-emerald-500/20'
      : liveEvent.kind === 'moved'
        ? 'ring-2 ring-sky-200/80 dark:ring-sky-500/20'
        : 'ring-1 ring-primary/20'
    : '';

  // Full-wash column identity: tint the card body + add a hue left stripe so it
  // reads as belonging to its column. Applied inline because .eh-card sets
  // background/border-color as unlayered rules that beat Tailwind utilities.
  // The inline stripe overrides the epic indigo className border on-board (epics
  // still get the column hue, and stay marked by the "Epic" badge); off-board no
  // tint is passed so the indigo border still shows. Active-session cards keep
  // their emerald border as a live-state signal, so defer the stripe only there.
  const showColumnTint = !!columnTint && !isOverlay;
  const columnTintStyle: CSSProperties = showColumnTint
    ? {
        backgroundImage: tintFill(columnTint!, 0.04),
        ...(!hasActiveCliSession
          ? { borderLeft: `3px solid rgba(${columnTint!.rgb}, 0.4)` }
          : {}),
      }
    : {};

  // FLUX-744: open a ticket honoring the boardCardOpenMode preference (default 'chat'). In chat mode we
  // open the chat-aligned view with its sideview, anchored to spawn from the clicked card. 'full'/'popup'
  // keep opening the center modal. A task with no id (a not-yet-created draft) always uses the modal.
  const openBoardTask = (nextTask: Task, from?: HTMLElement | null) => {
    if (!nextTask.id) { openTask(nextTask); return; }
    const mode = config?.boardCardOpenMode || 'chat';
    if (mode === 'full') openTaskFullView(nextTask);
    else if (mode === 'popup') openTaskModal(nextTask);
    else openTicket(nextTask.id, from);
  };

  const animationsEnabled = config?.animationsEnabled ?? true;
  const speedMap = { fast: 0.2, normal: 0.4, slow: 0.7 };
  const duration = speedMap[config?.animationSpeed || 'normal'];

  // FLUX-629: the per-card framer-motion FLIP (layoutId) forced a layout measurement
  // (getBoundingClientRect) on EVERY re-render of every card — it collapsed drag to
  // ~1fps (already disabled mid-drag) and taxed every poll/SSE re-render the same way.
  // We drop layoutId on the board: cross-column moves still get visual feedback via the
  // live-event accent classes (liveAccentClass / liveAnimationClass). Gating layoutId to
  // only moved cards can't work — framer-motion needs the PRE-move render to also carry
  // the id to compute the FLIP baseline, which a post-hoc 'moved' flag doesn't provide.
  const layoutProps = {};

  const isThisTaskOpen = useAppSelector((s) => s.isModalOpen && s.modalTask?.id === task.id);
  const isOverlayOpen = useAppSelector((s) => s.isOverlayOpen);
  const [isAnimatingZ, setIsAnimatingZ] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const rattleControls = useAnimationControls();
  const prevLiveOutputLenRef = useRef<number>(task.cliSession?.liveOutput?.length ?? 0);

  useEffect(() => {
    if (!animationsEnabled || !hasActiveCliSession) return;
    const currentLen = task.cliSession?.liveOutput?.length ?? 0;
    if (currentLen > prevLiveOutputLenRef.current) {
      prevLiveOutputLenRef.current = currentLen;
      rattleControls.start({ x: [0, -3, 3, -2, 2, 0], transition: { duration: 0.35, ease: 'easeInOut' } });
    }
  }, [task.cliSession?.liveOutput, animationsEnabled, hasActiveCliSession, rattleControls]);
  const [popupPos, setPopupPos] = useState({ cardTop: 0, cardHeight: 0, top: 0, left: 'auto' as number | string, right: 'auto' as number | string });
  const hoverTimeout = useRef<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Immediately dismiss any pending/visible description popup when a blocking overlay or the
  // agent dropdown opens, so it can never appear on top of (or be triggered through) them.
  useEffect(() => {
    if (!isOverlayOpen && !actionMenuActive && !ticketActions.launcherOpen && !ticketActions.startPromptOpen) return;
    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
    setIsHovering(false);
  }, [isOverlayOpen, actionMenuActive, ticketActions.launcherOpen, ticketActions.startPromptOpen]);

  useEffect(() => {
    if (isHovering && popupRef.current) {
      const rect = popupRef.current.getBoundingClientRect();
      const popupHeight = rect.height;
      const windowHeight = window.innerHeight;

      let finalTop = popupPos.top; // Default logic fallback
      const isSmall = popupHeight < (windowHeight / 3);

      if (isSmall) {
        const cardCenterY = popupPos.cardTop + (popupPos.cardHeight / 2);
        finalTop = cardCenterY - (popupHeight / 2);
      }

      // Keep within screen bounds (16px from edges)
      const minTop = 16;
      const maxTop = Math.max(minTop, windowHeight - popupHeight - 16);
      finalTop = Math.max(minTop, Math.min(finalTop, maxTop));

      popupRef.current.style.top = `${finalTop}px`;
    }
  }, [isHovering, popupPos]);

  const openCommentPopover = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!commentBadgeRef.current) return;
    const rect = commentBadgeRef.current.getBoundingClientRect();
    setCommentPopoverPos({ top: rect.bottom + 8, left: rect.left });
    setCommentPopoverOpen(true);
    commentOpenedByHover.current = false;
    if (commentCloseTimeout.current !== null) {
      window.clearTimeout(commentCloseTimeout.current);
      commentCloseTimeout.current = null;
    }
    setIsHovering(false);
    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
    if (commentHoverTimeout.current !== null) {
      window.clearTimeout(commentHoverTimeout.current);
      commentHoverTimeout.current = null;
    }
  };

  const markCommentRead = (commentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    ctxMarkCommentRead(task.id, commentId);
  };

  const handleMouseEnter = (event: React.MouseEvent<HTMLDivElement>) => {
    isMouseOverCard.current = true;
    if (!config?.hoverPopupsEnabled) return;
    if (isDragging) return;
    if (isOverlayOpen) return;
    if (priorityMenuOpen || effortMenuOpen || assigneeMenuOpen || tagMenuOpen || isEditingTitle) return;
    if (actionMenuActive || ticketActions.launcherOpen || ticketActions.startPromptOpen) return;
    // If comment popover is open and was opened by a click (not hover), don't start description timer
    if (commentPopoverOpen && !commentOpenedByHover.current) return;
    // Don't trigger the description popup when the mouse enters via the comment badge
    if (commentBadgeRef.current?.contains(event.target as Node)) return;

    // Calculate direction before showing
    const currentCard = event.currentTarget.getBoundingClientRect();
    lastCardRectRef.current = currentCard;
    const margin = 16;
    const popupWidth = 640;

    let left: number | string = currentCard.right + margin;
    let right: number | string = 'auto';

    if (currentCard.right + popupWidth + margin > window.innerWidth) {
      left = 'auto';
      right = window.innerWidth - currentCard.left + margin;
    }

    let topVal = currentCard.top;
    if (topVal > 180) {
      topVal = 180;
    }

    setPopupPos({
      cardTop: currentCard.top,
      cardHeight: currentCard.height,
      top: topVal,
      left,
      right
    });

    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
    }

    const delay = config?.hoverPopupDelay ?? 1500;
    hoverTimeout.current = window.setTimeout(() => {
      setIsHovering(true);
    }, delay);
  };

  const startDescriptionTimer = () => {
    if (!config?.hoverPopupsEnabled || isDragging || !lastCardRectRef.current) return;
    if (isOverlayOpen) return;
    if (actionMenuActive || ticketActions.launcherOpen || ticketActions.startPromptOpen) return;
    if (hoverTimeout.current !== null) window.clearTimeout(hoverTimeout.current);
    const delay = config?.hoverPopupDelay ?? 1500;
    hoverTimeout.current = window.setTimeout(() => {
      if (isMouseOverCard.current) setIsHovering(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    isMouseOverCard.current = false;
    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
    setIsHovering(false);
    // Close hover-opened comment popover after a small delay so moving to it doesn't flicker
    if (commentOpenedByHover.current && commentCloseTimeout.current === null) {
      commentCloseTimeout.current = window.setTimeout(() => {
        commentCloseTimeout.current = null;
        setCommentPopoverOpen(false);
        commentOpenedByHover.current = false;
        // If mouse is still over the card, restart description timer
        if (isMouseOverCard.current) startDescriptionTimer();
      }, 200);
    }
  };

  useEffect(() => {
    return () => {
      if (hoverTimeout.current !== null) window.clearTimeout(hoverTimeout.current);
      if (commentHoverTimeout.current !== null) window.clearTimeout(commentHoverTimeout.current);
      if (commentCloseTimeout.current !== null) window.clearTimeout(commentCloseTimeout.current);
      if (tagAreaHoverTimeout.current !== null) window.clearTimeout(tagAreaHoverTimeout.current);
    };
  }, []);

  useEffect(() => {
    if (!commentPopoverOpen) return undefined;
    const handlePointerDown = (e: MouseEvent) => {
      if (!commentBadgeRef.current?.contains(e.target as Node) && !commentPopupRef.current?.contains(e.target as Node)) {
        setCommentPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [commentPopoverOpen]);

  useEffect(() => {
    if (!subtaskPopoverOpen) return undefined;
    const handlePointerDown = (e: MouseEvent) => {
      if (!subtaskBadgeRef.current?.contains(e.target as Node) && !subtaskPopupRef.current?.contains(e.target as Node)) {
        setSubtaskPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [subtaskPopoverOpen]);

  useEffect(() => {
    const el = tagPreviewRowRef.current;
    if (!el) return undefined;

    const recompute = () => {
      // Only show trailing fade when collapsed row is truly clipping content.
      setIsTagRowOverflowing(el.scrollWidth > el.clientWidth + 1);
    };

    recompute();

    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    window.addEventListener('resize', recompute);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [tagNames, tagMenuOpen]);

  useEffect(() => {
    if (isThisTaskOpen) {
      setIsAnimatingZ(true);
    } else if (isAnimatingZ) {
      const t = setTimeout(() => setIsAnimatingZ(false), (duration + 0.3) * 1000);
      return () => clearTimeout(t);
    }
  }, [isThisTaskOpen, duration, isAnimatingZ]);

  const contentAnimation = animationsEnabled ? {
    initial: false,
    animate: { opacity: isThisTaskOpen ? 0 : 1 },
    transition: isThisTaskOpen ? { duration: 0.1 } : { duration: 0.2, delay: duration }
  } : {};

  return {
    EFFORT_OPTIONS,
    config,
    saveConfig,
    currentUser,
    openTaskModal,
    openTaskFullView,
    ctxMarkAllCommentsRead,
    taskById: subtaskById,
    setView,
    setChangesFocus,
    hasWorktree,
    worktreeChangedFiles,
    diffFocusKey,
    detachState, setDetachState,
    detachMsg,
    priorityMenuOpen, setPriorityMenuOpen,
    effortMenuOpen, setEffortMenuOpen,
    assigneeMenuOpen, setAssigneeMenuOpen,
    tagMenuOpen, setTagMenuOpen,
    isTagRowOverflowing,
    isTagAreaActive, setIsTagAreaActive,
    isEditingTitle, setIsEditingTitle,
    priorityName,
    effortName,
    assigneeName,
    titleValue, setTitleValue,
    tagNames,
    priorityMenuRef,
    effortMenuRef,
    assigneeMenuRef,
    tagMenuRef,
    tagPreviewRowRef,
    titleInputRef,
    commentPopoverOpen, setCommentPopoverOpen,
    commentPopoverPos, setCommentPopoverPos,
    contextMenuPos, setContextMenuPos,
    popoverReplyTarget, setPopoverReplyTarget,
    popoverReplyDraft, setPopoverReplyDraft,
    popoverReplySaving,
    commentBadgeRef,
    commentPopupRef,
    commentHoverTimeout,
    commentOpenedByHover,
    commentCloseTimeout,
    isMouseOverCard,
    effortLabel,
    subtaskPopoverOpen, setSubtaskPopoverOpen,
    subtaskPopoverPos, setSubtaskPopoverPos,
    subtaskBadgeRef,
    subtaskPopupRef,
    tagAreaHoverTimeout,
    subtaskIds,
    isEpic,
    doneStatuses,
    subtaskDoneCount,
    subtaskTotal,
    epicFoldedSubtasks,
    attributes, listeners, isDragging,
    style,
    snippet,
    readCommentIds,
    hasActiveCliSession,
    currentActivity,
    sessionState,
    clusterGroup,
    clusterAgg,
    clusterCombinerPending,
    latestProgress,
    shouldShowProgress,
    isPromptStatus,
    isReadyForMerge,
    branchCopied, setBranchCopied,
    comments,
    topLevelComments,
    repliesByParentId,
    unreadComments,
    hasUnread,
    submitPopoverReply,
    handleCardDetach,
    // FLUX-715: the unified ticket-action controller (drives <TicketActionsView variant="card">
    // + <TicketActionsLaunchers>). `actionMenuActive` flags an open launch menu/picker for
    // hover-popup suppression; `openLauncherInPhase` is the PR-deck shortcut.
    ticketActions,
    actionMenuActive, setActionMenuActive,
    openLauncherInPhase,
    getTagColor,
    getPriorityIcon,
    handlePriorityChange,
    handleEffortChange,
    handleAssigneeChange,
    handleTitleSave,
    handleTagToggle,
    allUsers,
    allTags,
    visibleTitle,
    visibleAssignee,
    liveAnimationClass,
    liveAccentClass,
    columnTintStyle,
    openBoardTask,
    animationsEnabled,
    layoutProps,
    isOverlayOpen,
    isThisTaskOpen,
    isAnimatingZ,
    isHovering, setIsHovering,
    rattleControls,
    popupPos,
    hoverTimeout,
    popupRef,
    openCommentPopover,
    markCommentRead,
    handleMouseEnter,
    startDescriptionTimer,
    handleMouseLeave,
    contentAnimation,
    hideStatusBadge,
    parentTask,
  };
}

export type TaskCardController = ReturnType<typeof useTaskCardController>;

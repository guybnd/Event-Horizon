/* eslint-disable react-hooks/exhaustive-deps -- extracted verbatim from TaskCard; deps deliberately preserved to keep original effect/handler semantics (no behavior change). */
import { useState, useRef, useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import type { Task, TaskLiveEvent, AgentSessionEntry, AgentSessionProgress } from '../types';
import { isAgentSession, normalizeSubtaskId } from '../types';
import { AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import { useAppSelector, useAppActions, useLiveSession, shallowEqual } from '../store/useAppSelector';
import { sendTaskCliInput, updateTask, fetchWorkflows, detachWorktree, type WorkflowTemplate } from '../api';
import { runAgentAction, launchOrchestration, launchPhaseDefault, getOrchestrationMode, phaseCombiner, phaseLaunchStatus, resolvePhaseDefaultId, statusToPhase, type LaunchPhase } from '../agentActions';
import { type OrchestrationLaunchPlan } from '../components/OrchestrationLauncher';
import { getArchiveStatus, getReadyForMergeStatus, isPromptableStatus, isTaskAwaitingInput } from '../workflow';
import { groupSessions, aggregateGroup, isGroupLive, isCombinerPending } from '../orchestration';
import { resolveEffectiveAgent } from '../utils';
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
  const { openTaskModal, openTaskFullView, saveConfig, triggerRefresh, ensureReadStateLoaded, markCommentRead: ctxMarkCommentRead, markAllCommentsRead: ctxMarkAllCommentsRead, refreshWorktrees, setView, setChangesFocus } = useAppActions();
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
  const isEpic = subtaskIds.length > 0;

  const doneStatuses = useMemo(
    () => new Set(['Done', 'Released', getArchiveStatus(config)].filter(Boolean)),
    [config]
  );

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
        setReviewSelectorOpen(false);
        setReturnPromptOpen(false);
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
  const [finishBusy, setFinishBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [reviewSelectorOpen, setReviewSelectorOpen] = useState(false);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [launcherPhase, setLauncherPhase] = useState<LaunchPhase>('review');
  const [launcherTemplateId, setLauncherTemplateId] = useState<string | undefined>(undefined);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [returnPromptOpen, setReturnPromptOpen] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const [returnBusy, setReturnBusy] = useState(false);
  const [showStartPrompt, setShowStartPrompt] = useState(false);
  const [branchCopied, setBranchCopied] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [finishMenuOpen, setFinishMenuOpen] = useState(false);
  const [phaseTemplates, setPhaseTemplates] = useState<WorkflowTemplate[] | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const finishMenuRef = useRef<HTMLDivElement | null>(null);
  const reviewSelectorRef = useRef<HTMLDivElement | null>(null);
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
        const replyEntry = {
          type: 'comment' as const,
          user: currentUser,
          date: new Date().toISOString(),
          comment: message,
          replyTo: parentId,
        };
        const newHistory = [...(task.history || []), replyEntry];
        await updateTask(task.id, { history: newHistory, updatedBy: currentUser } as Partial<Task>);
      }
      triggerRefresh();
      setPopoverReplyTarget(null);
      setPopoverReplyDraft('');
    } finally {
      setPopoverReplySaving(false);
    }
  };

  const sendFinishCommand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setFinishBusy(true);
    try {
      const command = `finish ${task.id}`;
      if (hasActiveCliSession) {
        await sendTaskCliInput(task.id, command, currentUser);
      } else {
        const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
        await runAgentAction({
          taskId: task.id,
          framework,
          action: { kind: 'command', verb: 'finish' },
          currentUser,
          phase: 'finalize',
        });
      }
      triggerRefresh();
    } finally {
      setFinishBusy(false);
    }
  };

  const statusActionMap: Record<string, { label: string; verb: 'groom' | 'implement' | 'finish' }> = {
    'Grooming': { label: 'Start grooming', verb: 'groom' },
    'Todo': { label: 'Implement', verb: 'implement' },
    'In Progress': { label: 'Continue', verb: 'implement' },
  };
  const statusAction = !hasActiveCliSession && !isReadyForMerge ? statusActionMap[task.status] : null;

  // Returns false if no persona could be resolved (caller should fall back to the launcher UI).
  const launchPhaseSession = async (phase: LaunchPhase): Promise<boolean> => {
    const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
    const result = await launchPhaseDefault({
      taskId: task.id,
      framework,
      phase,
      currentUser,
      phaseDefaults: config?.phaseDefaults,
    });
    return result !== null;
  };

  const sendStatusAction = async (e: React.MouseEvent, skipBranchPrompt = false) => {
    e.stopPropagation();
    if (!statusAction) return;
    if (task.status === 'Todo' && !task.branch && !skipBranchPrompt) {
      setShowStartPrompt(true);
      return;
    }
    setActionBusy(true);
    try {
      const phase: LaunchPhase = statusAction.verb === 'groom' ? 'grooming' : 'implementation';
      await launchPhaseSession(phase);
      triggerRefresh();
    } finally {
      setActionBusy(false);
    }
  };

  const handleStartPromptConfirm = async (_branch: string | null) => {
    setShowStartPrompt(false);
    setActionBusy(true);
    try {
      await launchPhaseSession('implementation');
      triggerRefresh();
    } finally {
      setActionBusy(false);
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

  const openAgentLauncher = (variant: 'single' | 'multi') => {
    const phase = statusToPhase(task.status, { readyStatus: readyForMergeStatus });
    setLauncherPhase(phase);
    setLauncherTemplateId(`builtin-${phase}-${variant}`);
    setReviewModalOpen(true);
  };

  const cardPhase = statusToPhase(task.status, { readyStatus: readyForMergeStatus });

  // Lazily load templates the first time the agent menu is opened.
  const toggleAgentMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setAgentMenuOpen((open) => !open);
    if (phaseTemplates === null) {
      fetchWorkflows().then(setPhaseTemplates).catch(() => setPhaseTemplates([]));
    }
  };

  // Templates that configure the current phase.
  const templatesForCardPhase = useMemo(
    () => (phaseTemplates ?? []).filter((w) => w.phases?.[cardPhase as keyof typeof w.phases]),
    [phaseTemplates, cardPhase],
  );
  const singleDefaultId = resolvePhaseDefaultId(config?.phaseDefaults, cardPhase, 'single');
  const multiDefaultId = resolvePhaseDefaultId(config?.phaseDefaults, cardPhase, 'multi');
  const singleDefaultName = templatesForCardPhase.find((w) => w.id === singleDefaultId)?.name;
  const multiDefaultName = templatesForCardPhase.find((w) => w.id === multiDefaultId)?.name;
  const otherCardTemplates = templatesForCardPhase.filter(
    (w) => w.id !== singleDefaultId && w.id !== multiDefaultId,
  );

  const openLauncherWithTemplate = (templateId: string) => {
    setAgentMenuOpen(false);
    setLauncherPhase(cardPhase);
    setLauncherTemplateId(templateId);
    setReviewModalOpen(true);
  };

  // Open the launcher pinned to an explicit phase (FLUX-568). The PR deck's Review and
  // Continue-development buttons both route through here so the phase is set deterministically
  // — relying on the default launcherPhase ('review') would leave it stale after a
  // Continue-development ('implementation') open, mislabelling the next Review.
  const openLauncherInPhase = (phase: LaunchPhase, templateId?: string) => {
    setLauncherPhase(phase);
    setLauncherTemplateId(templateId);
    setReviewModalOpen(true);
  };

  // Finalize templates (docs check / commit / ticket tidy / merge PR) for the Finish menu.
  const finalizeTemplates = useMemo(
    () => (phaseTemplates ?? []).filter((w) => w.phases?.finalize),
    [phaseTemplates],
  );
  const finalizeSingleId = resolvePhaseDefaultId(config?.phaseDefaults, 'finalize', 'single');
  const finalizeMultiId = resolvePhaseDefaultId(config?.phaseDefaults, 'finalize', 'multi');
  const finalizeSingleName = finalizeTemplates.find((w) => w.id === finalizeSingleId)?.name;
  const finalizeMultiName = finalizeTemplates.find((w) => w.id === finalizeMultiId)?.name;
  const otherFinalizeTemplates = finalizeTemplates.filter(
    (w) => w.id !== finalizeSingleId && w.id !== finalizeMultiId,
  );

  const toggleFinishMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFinishMenuOpen((open) => !open);
    if (phaseTemplates === null) {
      fetchWorkflows().then(setPhaseTemplates).catch(() => setPhaseTemplates([]));
    }
  };

  // Open the launcher in the finalize phase (independent of the card's status phase).
  const openFinalizeLauncher = (templateId: string) => {
    setFinishMenuOpen(false);
    setLauncherPhase('finalize');
    setLauncherTemplateId(templateId);
    setReviewModalOpen(true);
  };

  // Primary one-click: launch the phase's single default.
  const launchSingleDefault = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setAgentMenuOpen(false);
    if (task.status === 'Todo' && !task.branch) { setShowStartPrompt(true); return; }
    setReviewBusy(true);
    try {
      const launched = await launchPhaseSession(cardPhase);
      if (!launched) { openAgentLauncher('single'); return; }
      triggerRefresh();
    } finally {
      setReviewBusy(false);
    }
  };

  const handleCardReviewLaunch = async (plan: OrchestrationLaunchPlan) => {
    setReviewModalOpen(false);
    setReviewBusy(true);
    try {
      const framework = resolveEffectiveAgent(undefined, config?.defaultAgent);
      // A single selected agent launches standalone — bypass orchestration gating entirely.
      if (plan.personas.length === 1) {
        await runAgentAction({
          taskId: task.id,
          framework,
          action: { kind: 'persona', personaId: plan.personas[0].id, focusComment: plan.comment || undefined },
          currentUser,
          effortOverride: plan.effort,
          preStatus: phaseLaunchStatus(launcherPhase),
          phase: launcherPhase,
        });
        triggerRefresh();
        return;
      }
      const def = getOrchestrationMode(plan.mode);
      const participants = plan.personas.map(p => ({
        role: `${launcherPhase}:${p.id}`,
        label: p.label,
        personaId: p.id,
        focusComment: plan.comment || undefined,
      }));
      // Combiner/lead persona: use explicit lead from plan (supervisor picker), else phase default.
      const combiner = plan.leadPersona
        ? { personaId: plan.leadPersona.id, label: plan.leadPersona.label }
        : phaseCombiner(launcherPhase, plan.mode);
      const lead = def.hasLead && combiner
        ? { role: combiner.personaId, label: combiner.label, personaId: combiner.personaId }
        : undefined;
      await launchOrchestration({
        taskId: task.id,
        framework,
        mode: plan.mode,
        participants,
        lead,
        currentUser,
        effortOverride: plan.effort,
        preStatus: phaseLaunchStatus(launcherPhase),
        phase: launcherPhase,
      });
      triggerRefresh();
    } finally {
      setReviewBusy(false);
    }
  };

  const sendReturn = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!returnReason.trim()) return;
    setReturnBusy(true);
    try {
      const comment = returnReason.trim();
      const newHistory = [...(task.history || []), { type: 'comment' as const, user: currentUser, date: new Date().toISOString(), comment }];
      await updateTask(task.id, { status: 'In Progress', history: newHistory, updatedBy: currentUser } as Partial<Task>);
      triggerRefresh();
      setReturnPromptOpen(false);
      setReturnReason('');
    } finally {
      setReturnBusy(false);
    }
  };

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
  const boardCardOpenMode = config?.boardCardOpenMode || 'full';
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

  const openBoardTask = (nextTask: Task) => {
    if (boardCardOpenMode === 'full') {
      openTaskFullView(nextTask);
      return;
    }

    openTaskModal(nextTask);
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
    if (!isOverlayOpen && !agentMenuOpen && !finishMenuOpen && !reviewSelectorOpen && !returnPromptOpen) return;
    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
    setIsHovering(false);
  }, [isOverlayOpen, agentMenuOpen, finishMenuOpen, reviewSelectorOpen, returnPromptOpen]);

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
    if (agentMenuOpen || finishMenuOpen || reviewSelectorOpen || returnPromptOpen || reviewModalOpen || showStartPrompt) return;
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
    if (agentMenuOpen || finishMenuOpen || reviewSelectorOpen || returnPromptOpen || reviewModalOpen || showStartPrompt) return;
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
    if (!reviewSelectorOpen && !returnPromptOpen) return undefined;
    const handlePointerDown = (e: MouseEvent) => {
      if (reviewSelectorRef.current && !reviewSelectorRef.current.contains(e.target as Node)) {
        setReviewSelectorOpen(false);
        setReturnPromptOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [reviewSelectorOpen, returnPromptOpen]);

  useEffect(() => {
    if (!agentMenuOpen) return undefined;
    const handlePointerDown = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!finishMenuOpen) return undefined;
    const handlePointerDown = (e: MouseEvent) => {
      if (finishMenuRef.current && !finishMenuRef.current.contains(e.target as Node)) {
        setFinishMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [finishMenuOpen]);

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
    attributes, listeners, isDragging,
    style,
    snippet,
    readCommentIds,
    hasActiveCliSession,
    currentActivity,
    clusterGroup,
    clusterAgg,
    clusterCombinerPending,
    latestProgress,
    shouldShowProgress,
    isPromptStatus,
    isReadyForMerge,
    finishBusy,
    actionBusy,
    reviewSelectorOpen, setReviewSelectorOpen,
    reviewModalOpen, setReviewModalOpen,
    launcherPhase,
    launcherTemplateId,
    reviewBusy,
    returnPromptOpen, setReturnPromptOpen,
    returnReason, setReturnReason,
    returnBusy,
    showStartPrompt, setShowStartPrompt,
    branchCopied, setBranchCopied,
    agentMenuOpen,
    finishMenuOpen,
    agentMenuRef,
    finishMenuRef,
    reviewSelectorRef,
    comments,
    topLevelComments,
    repliesByParentId,
    unreadComments,
    hasUnread,
    submitPopoverReply,
    sendFinishCommand,
    statusAction,
    sendStatusAction,
    handleStartPromptConfirm,
    handleCardDetach,
    toggleAgentMenu,
    singleDefaultId,
    multiDefaultId,
    singleDefaultName,
    multiDefaultName,
    otherCardTemplates,
    openLauncherWithTemplate,
    openLauncherInPhase,
    finalizeSingleId,
    finalizeMultiId,
    finalizeSingleName,
    finalizeMultiName,
    otherFinalizeTemplates,
    toggleFinishMenu,
    openFinalizeLauncher,
    launchSingleDefault,
    handleCardReviewLaunch,
    sendReturn,
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

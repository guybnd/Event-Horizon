import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Bot, Zap } from 'lucide-react';
import { useApp } from '../AppContext';
import { createTask, deleteTask, fetchTask, sendTaskCliInput, updateTask } from '../api';
import { runAgentAction, launchOrchestration, launchPhaseDefault, getOrchestrationMode, phaseCombiner, phaseLaunchStatus, type LaunchPhase } from '../agentActions';
import { type OrchestrationLaunchPlan } from '../components/OrchestrationLauncher';
import { isAgentSession } from '../types';
import type { HistoryEntry, InlineSubtask, Task } from '../types';
import { DEFAULT_READY_FOR_MERGE_STATUS, getRequireInputStatus } from '../workflow';
import { useTaskForm } from './useTaskForm';
import { useCliSession } from './useCliSession';
import { useImageAttachment } from './useImageAttachment';
import type { CommentBoxHandle } from '../components/task-modal/CommentBox';
import { groupSessions, isActiveSession } from '../orchestration';

const ACTIVITY_FILTER_STORAGE_KEY = 'flux.activityFilter';

type ActivityFilter = 'all' | 'decisions' | 'sessions';

function getInitialActivityFilter(): ActivityFilter {
  if (typeof window === 'undefined') return 'all';
  const stored = window.localStorage.getItem(ACTIVITY_FILTER_STORAGE_KEY);
  if (stored === 'decisions' || stored === 'sessions') return stored;
  return 'all';
}

export function useTaskModalController() {
  const {
    isModalOpen,
    closeModal,
    modalTask,
    setModalTask,
    openTaskModal,
    openModalScrollToComments,
    clearOpenModalScrollToComments,
    openModalInFullView,
    currentProject,
    currentUser,
    refreshTrigger,
    triggerRefresh,
    config,
    saveConfig,
    readComments,
    ensureReadStateLoaded,
    markCommentRead: ctxMarkCommentRead,
    markAllCommentsRead: ctxMarkAllCommentsRead,
    tasks: allTasks,
  } = useApp();

  const liveOutputRef = useRef<HTMLPreElement>(null);
  const commentBoxRef = useRef<CommentBoxHandle>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const commentSectionRef = useRef<HTMLDivElement>(null);
  const promptModalRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const returnToWorkReasonRef = useRef<HTMLTextAreaElement>(null);

  const {
    title, setTitle,
    body, setBody,
    status, setStatus,
    assignee, setAssignee,
    tags, setTags,
    priority, setPriority,
    effort, setEffort,
    effortLevel, setEffortLevel,
    implementationLink, setImplementationLink,
    subtasks, setSubtasks,
    parentId, setParentId,
    saving, setSaving,
    saveError, setSaveError,
    isDirty: formIsDirty,
    openedTaskIdRef,
  } = useTaskForm(modalTask);

  const {
    cliSession, setCliSession,
    cliSessionBusy, setCliSessionBusy,
    cliSessionError, setCliSessionError,
    selectedCliFramework, setSelectedCliFramework,
    skipPermissions, setSkipPermissions,
    sessionIsActive,
    launchSession,
    stopSession,
    stopGroup,
  } = useCliSession({ isModalOpen, taskId: modalTask?.id, liveOutputRef, onSessionChange: triggerRefresh });

  // Active multi-agent run group (2+ sessions sharing a groupId) for the Run View.
  const activeRunGroup = useMemo(() => {
    const groups = groupSessions(modalTask?.cliSessions);
    return groups.find(g => g.isMulti && g.sessions.some(isActiveSession)) ?? null;
  }, [modalTask?.cliSessions]);

  const [requireInputDraft, setRequireInputDraft] = useState('');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(getInitialActivityFilter);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [collapsedThreads, setCollapsedThreads] = useState<Record<string, boolean>>({});
  const [responseDestination, setResponseDestination] = useState('Todo');
  const [returnToWorkOpen, setReturnToWorkOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isWideMode, setIsWideMode] = useState(false);
  const [isFullView, setIsFullView] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(true);
  const [isCommentBoxVisible, setIsCommentBoxVisible] = useState(false);
  const [commentAssetError, setCommentAssetError] = useState('');
  const [replyAssetError, setReplyAssetError] = useState('');
  const [isUploadingCommentAsset, setIsUploadingCommentAsset] = useState(false);
  const [isUploadingReplyAsset, setIsUploadingReplyAsset] = useState(false);
  const [isTaskLoading, setIsTaskLoading] = useState(false);
  const [finishBusy, setFinishBusy] = useState(false);
  const [finishError, setFinishError] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [showStartPrompt, setShowStartPrompt] = useState(false);
  const [diffViewFile, setDiffViewFile] = useState<string | null>(null);

  const {
    handleCommentPaste,
    handleCommentDragOver,
    handleCommentDrop,
    handleReplyPaste,
    handleReplyDragOver,
    handleReplyDrop,
  } = useImageAttachment({
    taskId: modalTask?.id,
    commentBoxRef,
    replyDraft,
    setReplyDraft,
    commentRef,
    replyTextareaRef,
    setCommentAssetError,
    setIsUploadingCommentAsset,
    setReplyAssetError,
    setIsUploadingReplyAsset,
  });

  const isDirty = formIsDirty;

  useEffect(() => {
    if (modalTask?.id) ensureReadStateLoaded(modalTask.id);
  }, [modalTask?.id, ensureReadStateLoaded]);

  // useLayoutEffect so isFullView is committed before the browser paints.
  // Without this, the first render has isModalOpen=true + isFullView=false (popup),
  // then a deferred render flips to isFullView=true (full view). AnimatePresence
  // captures both, causing a visible double-open and a lingering popup underneath.
  useLayoutEffect(() => {
    if (!isModalOpen) return;
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'full' || openModalInFullView) setIsFullView(true);
  }, [isModalOpen, openModalInFullView, config]);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [isModalOpen, isFullView, title]);

  useEffect(() => {
    if (!isModalOpen || modalTask?.id) return;
    const timer = setTimeout(() => titleRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isModalOpen, modalTask?.id]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (isPromptModalOpen && promptModalRef.current && !promptModalRef.current.contains(event.target as Node)) {
        setIsPromptModalOpen(false);
      }
    };
    if (isPromptModalOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isPromptModalOpen]);

  useEffect(() => {
    if (!isFullView) return;
    const currentRef = commentSectionRef.current;
    if (!currentRef) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setIsCommentBoxVisible(true);
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    observer.observe(currentRef);
    return () => observer.disconnect();
  }, [isFullView, modalTask?.id]);

  useEffect(() => {
    if (!isFullView || !openModalScrollToComments) return;
    const timer = setTimeout(() => {
      commentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      clearOpenModalScrollToComments();
    }, 100);
    return () => clearTimeout(timer);
  }, [isFullView, openModalScrollToComments, clearOpenModalScrollToComments]);

  // Reset per-ticket UI state when a different ticket opens.
  useEffect(() => {
    if (!modalTask) return;
    if (openedTaskIdRef.current === modalTask.id) return;
    commentBoxRef.current?.reset();
    setRequireInputDraft('');
    setReplyTargetId(null);
    setReplyDraft('');
    setCollapsedThreads({});
    setResponseDestination('Todo');
    setReturnToWorkOpen(false);
    if (returnToWorkReasonRef.current) returnToWorkReasonRef.current.value = '';
    setConfirmDiscard(false);
    setConfirmDelete(false);
    setIsWideMode(false);
    setIsFullView(!!modalTask.id && new URLSearchParams(window.location.search).get('view') === 'full');
    setIsPromptModalOpen(true);
    setIsCommentBoxVisible(false);
    setCommentAssetError('');
    setReplyAssetError('');
    setIsUploadingCommentAsset(false);
    setIsUploadingReplyAsset(false);
    setCliSessionBusy(false);
    setCliSessionError('');
    // sync cliSession from the freshly loaded task
    setCliSession(modalTask.cliSession || null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalTask?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACTIVITY_FILTER_STORAGE_KEY, activityFilter);
  }, [activityFilter]);

  useEffect(() => {
    if (!isModalOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      handleCloseAttempt();
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSidebar) return;
      setSidebarWidth(() => Math.max(250, Math.min(window.innerWidth * 0.5, window.innerWidth - e.clientX)));
    };
    const handleMouseUp = () => setIsDraggingSidebar(false);

    if (isDraggingSidebar) {
      document.body.style.cursor = 'col-resize';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      document.body.style.cursor = '';
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
    };
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const hasPendingTicket = url.searchParams.has('ticket');
    if (isModalOpen && modalTask?.id) {
      url.searchParams.set('ticket', modalTask.id);
      url.searchParams.set('view', isFullView ? 'full' : 'popup');
    } else if (!modalTask?.id && hasPendingTicket) {
      return;
    } else {
      url.searchParams.delete('ticket');
      url.searchParams.delete('view');
    }
    window.history.replaceState({}, '', url);
  }, [isModalOpen, isFullView, modalTask?.id]);

  useEffect(() => {
    if (!isModalOpen || !modalTask?.id) return;
    setIsTaskLoading(true);
    fetchTask(modalTask.id)
      .then((task) => startTransition(() => { setModalTask(task); setIsTaskLoading(false); }))
      .catch((err) => { console.error(err); setIsTaskLoading(false); });
  }, [isModalOpen, modalTask?.id, refreshTrigger]);

  const allStatuses = config ? [...config.columns, ...config.hiddenStatuses].map((item) => item.name) : [];
  const allUsers = config?.users.map((item) => item.name) || [];
  const allTags = config?.tags.map((item) => item.name) || [];
  const availablePriorities = config && config.priorities.length > 0 ? config.priorities : [{ name: 'None', icon: 'Equal', color: 'text-gray-400' }];
  const requireInputStatus = getRequireInputStatus(config);
  const readyForMergeStatus = config?.readyForMergeStatus?.trim() || DEFAULT_READY_FOR_MERGE_STATUS;
  const promptableStatuses = Array.from(new Set([requireInputStatus, readyForMergeStatus]));
  const requireInputDestinations = allStatuses.filter((item) => !promptableStatuses.includes(item));

  const isRequireInput = status === requireInputStatus || modalTask?.swimlane === 'require-input';
  // PR tickets (kind:'pr') are never "ready for merge" in the normal-ticket sense — they merge
  // via the PR card / PrPanel, not the `finish <id>` handoff. Excluding them here suppresses the
  // non-PR finish prompt (banner + floating "finish" surface) for PR tickets in both modal views
  // (FLUX-593); their PR surface is PrPanel, gated separately on kind:'pr'.
  const isReadyForMerge = status === readyForMergeStatus && modalTask?.kind !== 'pr';
  const isPromptStatus = isRequireInput || isReadyForMerge;
  const lastComment = useMemo(() => {
    if (!modalTask?.history) return undefined;
    // For swimlane-based require-input, show the question from the swimlane_change entry
    if (modalTask.swimlane === 'require-input') {
      const swimlaneEntry = [...modalTask.history].reverse().find(
        (e) => e.type === 'swimlane_change' && e.action === 'set' && e.swimlane === 'require-input' && e.comment
      );
      if (swimlaneEntry) return swimlaneEntry;
    }
    return [...modalTask.history].reverse().find((entry) => entry.type === 'comment');
  }, [modalTask?.history, modalTask?.swimlane]);
  const createdAt = modalTask?.history?.[0]?.date;
  const updatedAt = modalTask?.history?.[modalTask.history.length - 1]?.date;

  const preRequireInputStatus = useMemo(() => {
    const history = modalTask?.history || [];
    const idx = [...history].reverse().findIndex(
      (e) => e.type === 'status_change' && e.to === requireInputStatus
    );
    if (idx === -1) return null;
    const entry = [...history].reverse()[idx];
    if (entry.type !== 'status_change') return null;
    return entry.from;
  }, [modalTask?.history, requireInputStatus]);

  const preReadyStatus = useMemo(() => {
    const history = modalTask?.history || [];
    const entry = [...history].reverse().find(
      (e) => e.type === 'status_change' && e.to === readyForMergeStatus
    );
    if (entry?.type !== 'status_change') return requireInputDestinations[0] || 'In Progress';
    const from = entry.from || null;
    if (!from || promptableStatuses.includes(from)) return requireInputDestinations[0] || 'In Progress';
    return from;
  }, [modalTask?.history, readyForMergeStatus, promptableStatuses, requireInputDestinations]);

  useEffect(() => {
    if (!isRequireInput) return;
    const preferred = preRequireInputStatus && requireInputDestinations.includes(preRequireInputStatus)
      ? preRequireInputStatus
      : requireInputDestinations[0] || 'Todo';
    setResponseDestination(preferred);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRequireInput, requireInputStatus, modalTask?.id]);

  const { topLevelEntries, repliesByParent } = useMemo(() => {
    const activityHistory = modalTask?.history || [];
    const filtered = activityFilter === 'decisions'
      ? activityHistory.filter((entry) =>
          entry.type === 'comment' ||
          entry.type === 'status_change' ||
          (isAgentSession(entry) && entry.outcome)
        )
      : activityFilter === 'sessions'
      ? activityHistory.filter((entry) => isAgentSession(entry))
      : activityHistory;
    const replies = new Map<string, HistoryEntry[]>();
    const topLevel: HistoryEntry[] = [];
    filtered.forEach((entry) => {
      if (entry.type === 'comment' && entry.replyTo) {
        const existing = replies.get(entry.replyTo) || [];
        existing.push(entry);
        replies.set(entry.replyTo, existing);
        return;
      }
      topLevel.push(entry);
    });
    return { filteredHistory: filtered, topLevelEntries: topLevel, repliesByParent: replies };
  }, [modalTask?.history, activityFilter]);

  // Build lookup for inline subtask objects (which carry title/status metadata)
  const inlineSubtaskMap = useMemo(() => {
    const map = new Map<string, InlineSubtask>();
    (modalTask?.subtasks || []).forEach((entry) => {
      if (typeof entry !== 'string' && entry.id) map.set(entry.id, entry);
    });
    return map;
  }, [modalTask?.subtasks]);

  const linkedSubtasks = subtasks
    .map((subtaskId) => allTasks.find((task) => task.id === subtaskId))
    .filter((task): task is Task => Boolean(task));
  const danglingSubtaskIds = subtasks.filter((subtaskId) => !linkedSubtasks.some((task) => task.id === subtaskId));

  const handleCloseAttempt = () => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    closeModal();
  };

  const handleSave = async (customHistory?: HistoryEntry[], keepOpen = false) => {
    setSaving(true);
    setSaveError(null);
    const payload = { title, body, status, assignee, tags, priority, effort, effortLevel: effortLevel || undefined, implementationLink: implementationLink.trim(), subtasks, parentId: parentId || undefined, order: modalTask?.order };
    const historyUpdates: HistoryEntry[] = customHistory || [];
    const pendingComment = commentBoxRef.current?.getValue()?.trim() ?? '';

    if (!customHistory && pendingComment) {
      historyUpdates.push({
        type: 'comment',
        user: currentUser,
        date: new Date().toISOString(),
        comment: pendingComment,
      });
      commentBoxRef.current?.reset();
    }

    try {
      if (modalTask?.id) {
        if (!customHistory && modalTask.status && modalTask.status !== status) {
          historyUpdates.push({
            type: 'status_change',
            from: modalTask.status,
            to: status,
            user: currentUser,
            date: new Date().toISOString(),
            comment: pendingComment ? 'Included with comment' : undefined,
          });
        }
        const newHistory: HistoryEntry[] = [...(modalTask.history || []), ...historyUpdates];
        const updatedTask = await updateTask(modalTask.id, {
          ...payload,
          history: newHistory,
          updatedBy: currentUser,
        });
        setModalTask(updatedTask);
      } else {
        const createdTask = await createTask({ ...payload, history: historyUpdates, projectKey: currentProject, author: currentUser });
        setModalTask(createdTask);
      }
      triggerRefresh();
      if (!keepOpen && !customHistory) closeModal();
    } catch (error) {
      console.error(error);
      setSaveError(error instanceof Error ? error.message : 'Failed to save changes. Make sure the engine is running.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!modalTask?.id) return;
    setSaving(true);
    setSaveError(null);
    try {
      await deleteTask(modalTask.id);
      triggerRefresh();
      closeModal();
    } catch (error) {
      console.error(error);
      setSaveError(error instanceof Error ? error.message : 'Failed to delete task. Make sure the engine is running.');
    } finally {
      setSaving(false);
    }
  };

  const sendCommentDirectly = async () => {
    const commentText = commentBoxRef.current?.getValue()?.trim() ?? '';
    if (!commentText || !modalTask?.id) return;
    if (cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status)) {
      setCliSessionBusy(true);
      setCliSessionError('');
      commentBoxRef.current?.reset();
      try {
        const nextSession = await sendTaskCliInput(modalTask.id, commentText, currentUser);
        setCliSession(nextSession);
        triggerRefresh();
      } catch (error) {
        commentBoxRef.current?.setValue(commentText);
        setCliSessionError(error instanceof Error ? error.message : 'Failed to send message to active CLI session.');
      } finally {
        setCliSessionBusy(false);
      }
      return;
    }
    const commentEntry: HistoryEntry = { type: 'comment', user: currentUser, date: new Date().toISOString(), comment: commentText };
    commentBoxRef.current?.reset();
    await handleSave([commentEntry], true);
  };

  const sendReplyDirectly = useCallback(async (parentId: string) => {
    if (!replyDraft.trim() || !modalTask?.id) return;
    const replyText = replyDraft.trim();
    if (cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status)) {
      setCliSessionBusy(true);
      setCliSessionError('');
      setReplyDraft('');
      setReplyTargetId(null);
      try {
        const nextSession = await sendTaskCliInput(modalTask.id, replyText, currentUser);
        setCliSession(nextSession);
        triggerRefresh();
      } catch (error) {
        setReplyDraft(replyText);
        setReplyTargetId(parentId);
        setCliSessionError(error instanceof Error ? error.message : 'Failed to send reply to active CLI session.');
      } finally {
        setCliSessionBusy(false);
      }
      return;
    }
    const replyEntry: HistoryEntry = { type: 'comment', user: currentUser, date: new Date().toISOString(), comment: replyText, replyTo: parentId };
    setReplyDraft('');
    setReplyTargetId(null);
    await handleSave([replyEntry], true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyDraft, cliSession, modalTask?.id, currentUser, triggerRefresh]);

  const submitRequireInputResponse = async () => {
    const responseComment = requireInputDraft.trim();
    if (!modalTask?.id || !responseComment) return;

    const isSwimlaneOnly = modalTask.swimlane === 'require-input' && status !== requireInputStatus;
    const submittedAt = new Date().toISOString();
    const lastAgentComment = [...(modalTask.history || [])].reverse().find(
      (e) => e.type === 'comment' && e.id
    );

    setSaving(true);
    try {
      // If there's an active CLI session, send input to it — the engine clears
      // the swimlane server-side and resumes the agent with the user's answer.
      const hasActiveSession = cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status);
      if (hasActiveSession) {
        const nextSession = await sendTaskCliInput(modalTask.id, responseComment, currentUser);
        setCliSession(nextSession);
        const idsToMark: string[] = [];
        if (lastAgentComment?.id) idsToMark.push(lastAgentComment.id);
        if (idsToMark.length > 0) ctxMarkAllCommentsRead(modalTask.id, idsToMark);
        setRequireInputDraft('');
        triggerRefresh();
        closeModal();
        return;
      }

      if (isSwimlaneOnly) {
        // Swimlane-based: clear swimlane, keep current status, post reply
        const historyUpdates: HistoryEntry[] = [
          {
            type: 'comment',
            user: currentUser,
            date: submittedAt,
            comment: responseComment,
            ...(lastAgentComment?.id ? { replyTo: lastAgentComment.id } : {}),
          },
          {
            type: 'swimlane_change',
            swimlane: 'require-input',
            action: 'cleared',
            user: currentUser,
            date: submittedAt,
          },
        ];
        const updatedTask = await updateTask(modalTask.id, {
          title, body, status, assignee, tags, priority, effort,
          effortLevel: effortLevel || undefined,
          implementationLink: implementationLink.trim(),
          swimlane: null,
          order: modalTask.order,
          history: [...(modalTask.history || []), ...historyUpdates],
          updatedBy: currentUser,
        });
        const idsToMarkRead: string[] = [];
        if (lastAgentComment?.id) idsToMarkRead.push(lastAgentComment.id);
        const newResponseComment = [...(updatedTask.history || [])].reverse().find(
          (e) => e.type === 'comment' && e.user === currentUser && e.date === submittedAt
        );
        if (newResponseComment?.id) idsToMarkRead.push(newResponseComment.id);
        if (idsToMarkRead.length > 0) ctxMarkAllCommentsRead(updatedTask.id, idsToMarkRead);
        setModalTask(updatedTask);
        setRequireInputDraft('');
        triggerRefresh();
        closeModal();
      } else {
        // Legacy status-based: change status and post reply
        const targetStatus = requireInputDestinations.includes(responseDestination)
          ? responseDestination
          : requireInputDestinations[0] || 'Todo';
        const historyUpdates: HistoryEntry[] = [
          {
            type: 'comment',
            user: currentUser,
            date: submittedAt,
            comment: responseComment,
            ...(lastAgentComment?.id ? { replyTo: lastAgentComment.id } : {}),
          },
          {
            type: 'status_change',
            from: status,
            to: targetStatus,
            user: currentUser,
            date: submittedAt,
            comment: 'Response submitted',
          },
        ];
        const updatedTask = await updateTask(modalTask.id, {
          title, body, status: targetStatus, assignee, tags, priority, effort,
          effortLevel: effortLevel || undefined,
          implementationLink: implementationLink.trim(),
          swimlane: null,
          order: modalTask.order,
          history: [...(modalTask.history || []), ...historyUpdates],
          updatedBy: currentUser,
        });
        const newResponseComment = [...(updatedTask.history || [])].reverse().find(
          (e) => e.type === 'comment' && e.user === currentUser && e.date === submittedAt
        );
        const idsToMarkRead: string[] = [];
        if (lastAgentComment?.id) idsToMarkRead.push(lastAgentComment.id);
        if (newResponseComment?.id) idsToMarkRead.push(newResponseComment.id);
        if (idsToMarkRead.length > 0) ctxMarkAllCommentsRead(updatedTask.id, idsToMarkRead);
        setModalTask(updatedTask);
        setRequireInputDraft('');
        setStatus(targetStatus);
        triggerRefresh();
        closeModal();
      }
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleReturnToWork = useCallback(async ({ launch = false }: { launch?: boolean } = {}) => {
    if (!modalTask?.id) return;
    const submittedAt = new Date().toISOString();
    const reason = (returnToWorkReasonRef.current?.value ?? '').trim();
    const lastReadySummary = [...(modalTask.history || [])].reverse().find(
      (e) => e.type === 'comment' && e.id
    );
    setSaving(true);
    try {
      const newEntries: HistoryEntry[] = [];
      if (reason) {
        newEntries.push({
          type: 'comment',
          user: currentUser,
          date: submittedAt,
          comment: reason,
          ...(lastReadySummary?.id ? { replyTo: lastReadySummary.id } : {}),
        });
      }
      newEntries.push({
        type: 'status_change',
        from: readyForMergeStatus,
        to: preReadyStatus,
        user: currentUser,
        date: submittedAt,
        comment: 'Returned to work',
      });
      const updatedTask = await updateTask(modalTask.id, {
        title, body, status: preReadyStatus, assignee, tags, priority, effort,
        effortLevel: effortLevel || undefined,
        implementationLink: implementationLink.trim(),
        order: modalTask.order,
        history: [...(modalTask.history || []), ...newEntries],
        updatedBy: currentUser,
      });
      setReturnToWorkOpen(false);
      if (returnToWorkReasonRef.current) returnToWorkReasonRef.current.value = '';
      triggerRefresh();
      if (launch) {
        await launchSession();
      } else {
        setModalTask(updatedTask);
        setStatus(preReadyStatus);
      }
      closeModal();
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  }, [modalTask, currentUser, readyForMergeStatus, preReadyStatus, title, body, assignee, tags, priority, effort, effortLevel, implementationLink, setModalTask, triggerRefresh, closeModal, launchSession]);

  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [launcherPhase, setLauncherPhase] = useState<LaunchPhase>('review');

  const openLauncher = useCallback((phase: LaunchPhase) => {
    setLauncherPhase(phase);
    setReviewError('');
    setReviewModalOpen(true);
  }, []);

  const handleReviewLaunch = useCallback(async (plan: OrchestrationLaunchPlan) => {
    if (!modalTask?.id) return;
    setReviewBusy(true);
    setReviewError('');
    try {
      // A single selected agent launches standalone — bypass orchestration gating.
      if (plan.personas.length === 1) {
        const session = await runAgentAction({
          taskId: modalTask.id,
          framework: selectedCliFramework,
          action: { kind: 'persona', personaId: plan.personas[0].id, focusComment: plan.comment || undefined },
          currentUser,
          skipPermissions,
          effortOverride: plan.effort,
          preStatus: phaseLaunchStatus(launcherPhase),
          phase: launcherPhase,
        });
        if (session) setCliSession(session);
        if (plan.branch) setModalTask({ ...modalTask, branch: plan.branch });
        setReviewModalOpen(false);
        triggerRefresh();
        closeModal();
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
      const { sessions, errors } = await launchOrchestration({
        taskId: modalTask.id,
        framework: selectedCliFramework,
        mode: plan.mode,
        participants,
        lead,
        currentUser,
        skipPermissions,
        effortOverride: plan.effort,
        preStatus: phaseLaunchStatus(launcherPhase),
        phase: launcherPhase,
      });
      if (sessions.length > 0) setCliSession(sessions[0]);
      if (errors.length > 0) {
        const total = sessions.length + errors.length;
        setReviewError(`${sessions.length} of ${total} agents started. Failed: ${errors.join('; ')}`);
        triggerRefresh();
        return;
      }
      if (plan.branch) setModalTask({ ...modalTask, branch: plan.branch });
      setReviewModalOpen(false);
      triggerRefresh();
      closeModal();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Failed to start agent sessions.');
    } finally {
      setReviewBusy(false);
    }
  }, [modalTask?.id, selectedCliFramework, skipPermissions, currentUser, launcherPhase, setCliSession, setModalTask, triggerRefresh, closeModal]);

  const sendFinishCommand = useCallback(async () => {
    if (!modalTask?.id) return;
    const command = `finish ${modalTask.id}`;
    const hasActiveSession = Boolean(cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status));
    setFinishBusy(true);
    setFinishError('');
    try {
      if (hasActiveSession) {
        const nextSession = await sendTaskCliInput(modalTask.id, command, currentUser);
        setCliSession(nextSession);
      } else {
        const nextSession = await runAgentAction({
          taskId: modalTask.id,
          framework: selectedCliFramework,
          action: { kind: 'command', verb: 'finish' },
          currentUser,
          skipPermissions,
          phase: 'finalize',
        });
        setCliSession(nextSession);
      }
      triggerRefresh();
    } catch (error) {
      setFinishError(error instanceof Error ? error.message : 'Failed to send finish command.');
    } finally {
      setFinishBusy(false);
    }
  }, [modalTask?.id, cliSession, currentUser, selectedCliFramework, skipPermissions, setCliSession, triggerRefresh]);

  const handleLaunchWithBranchCheck = useCallback(async () => {
    if (modalTask && status === 'Todo' && !modalTask.branch) {
      setShowStartPrompt(true);
      return;
    }
    await launchSession();
  }, [modalTask, status, launchSession]);

  const handleStartPromptConfirm = useCallback(async () => {
    setShowStartPrompt(false);
    await launchSession();
  }, [launchSession]);

  const handleGrooming = useCallback(async () => {
    if (!modalTask?.id) return;
    setCliSessionBusy(true);
    setCliSessionError('');
    try {
      const session = await launchPhaseDefault({
        taskId: modalTask.id,
        framework: selectedCliFramework,
        phase: 'grooming',
        currentUser,
        skipPermissions,
        phaseDefaults: config?.phaseDefaults,
      });
      setCliSession(session);
      triggerRefresh();
    } catch (error) {
      setCliSessionError(error instanceof Error ? error.message : 'Failed to start grooming session.');
    } finally {
      setCliSessionBusy(false);
    }
  }, [modalTask?.id, selectedCliFramework, skipPermissions, currentUser, config?.phaseDefaults, setCliSession, triggerRefresh, setCliSessionBusy, setCliSessionError]);

  const handleToggleReply = useCallback((entryId: string | undefined) => {
    setReplyTargetId((current) => current === entryId ? null : entryId || null);
    setReplyDraft('');
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyTargetId(null);
    setReplyDraft('');
  }, []);

  const handleToggleCollapsed = useCallback((entryId: string) => {
    setCollapsedThreads((current) => ({ ...current, [entryId]: !current[entryId] }));
  }, []);

  const handleClearReplyAssetError = useCallback(() => setReplyAssetError(''), []);

  const readCommentIds = new Set(readComments[modalTask?.id ?? ''] ?? []);
  const unreadCommentCount = (modalTask?.history || []).filter(
    (e) => e.type === 'comment' && e.id && !readCommentIds.has(e.id) && e.user !== currentUser
  ).length;

  const groomingBanner = useMemo(() => status === 'Grooming' ? (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-primary/20 bg-primary/5 p-4 dark:border-primary/30 dark:bg-primary/10">
      <div className="flex gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-1.5 text-primary dark:bg-primary/20">
          <Zap className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-primary">Grooming phase</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            This ticket needs a concrete implementation plan. Click <strong>Start Grooming</strong> to have the agent analyze requirements and update the body.
          </p>
        </div>
      </div>
      <button
        disabled={cliSessionBusy || sessionIsActive}
        onClick={handleGrooming}
        className="shrink-0 flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-white shadow-md transition-all hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Bot className="h-4 w-4" />
        {cliSessionBusy ? 'Starting...' : 'Start Grooming'}
      </button>
    </div>
  ) : null, [status, cliSessionBusy, sessionIsActive, handleGrooming]);

  const requireInputBanner = useMemo(() => (isRequireInput && lastComment) ? (
    <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-900/20">
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">Response Needed</p>
        <p className="whitespace-pre-wrap text-sm text-amber-700 dark:text-amber-400">{lastComment.comment}</p>
        <p className="mt-1.5 text-[10px] text-amber-500/70">
          {lastComment.user} · {new Date(lastComment.date).toLocaleString()}
        </p>
      </div>
    </div>
  ) : null, [isRequireInput, lastComment]);

  const readyForMergeBanner = useMemo(() => isReadyForMerge ? (
    <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-900/20">
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">Merge review requested</p>
        <p className="whitespace-pre-wrap text-sm text-amber-700 dark:text-amber-400">
          This ticket is waiting in {readyForMergeStatus} for your review and finalization. Look over the ticket and diffs, then click <strong>Tell agent to finish</strong> to close the work.
        </p>
      </div>
    </div>
  ) : null, [isReadyForMerge, readyForMergeStatus]);

  const isSwimlaneOnly = modalTask?.swimlane === 'require-input' && status !== requireInputStatus;
  const hasActiveSessionForPrompt = Boolean(cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status));
  const cliSessionActive = Boolean(cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status));

  return {
    // context
    isModalOpen, closeModal, modalTask, setModalTask, openTaskModal,
    currentUser, triggerRefresh, config, saveConfig,
    ctxMarkCommentRead, ctxMarkAllCommentsRead, allTasks,
    // refs
    liveOutputRef, commentBoxRef, commentRef, replyTextareaRef,
    commentSectionRef, promptModalRef, titleRef, returnToWorkReasonRef,
    // form
    title, setTitle, body, setBody, status, setStatus,
    assignee, setAssignee, tags, setTags, priority, setPriority,
    effort, setEffort, effortLevel, setEffortLevel,
    implementationLink, setImplementationLink, subtasks, setSubtasks,
    parentId, setParentId, saving, saveError,
    // cli session
    cliSession, cliSessionBusy, cliSessionError,
    selectedCliFramework, setSelectedCliFramework,
    skipPermissions, setSkipPermissions,
    sessionIsActive, stopSession, stopGroup,
    activeRunGroup,
    // ui state
    requireInputDraft, setRequireInputDraft,
    activityFilter, setActivityFilter,
    replyTargetId, replyDraft, setReplyDraft,
    collapsedThreads,
    responseDestination, setResponseDestination,
    returnToWorkOpen, setReturnToWorkOpen,
    confirmDiscard, setConfirmDiscard,
    confirmDelete, setConfirmDelete,
    isWideMode, setIsWideMode,
    isFullView, setIsFullView,
    sidebarWidth,
    setIsDraggingSidebar,
    isPromptModalOpen, setIsPromptModalOpen,
    isCommentBoxVisible, setIsCommentBoxVisible,
    commentAssetError,
    replyAssetError,
    isUploadingCommentAsset,
    isUploadingReplyAsset,
    isTaskLoading,
    finishBusy, finishError,
    reviewBusy, reviewError,
    showStartPrompt, setShowStartPrompt,
    diffViewFile, setDiffViewFile,
    // image attachment
    handleCommentPaste, handleCommentDragOver, handleCommentDrop,
    handleReplyPaste, handleReplyDragOver, handleReplyDrop,
    // derived
    isDirty,
    allStatuses, allUsers, allTags, availablePriorities,
    readyForMergeStatus,
    requireInputDestinations,
    isRequireInput, isReadyForMerge, isPromptStatus,
    createdAt, updatedAt,
    topLevelEntries, repliesByParent,
    inlineSubtaskMap,
    linkedSubtasks, danglingSubtaskIds,
    readCommentIds, unreadCommentCount,
    isSwimlaneOnly, hasActiveSessionForPrompt, cliSessionActive,
    // banners
    groomingBanner, requireInputBanner, readyForMergeBanner,
    // handlers
    handleCloseAttempt, handleSave, handleDelete,
    sendCommentDirectly, sendReplyDirectly, submitRequireInputResponse,
    handleReturnToWork, openLauncher, handleReviewLaunch,
    sendFinishCommand, handleLaunchWithBranchCheck, handleStartPromptConfirm,
    handleGrooming, handleToggleReply, handleCancelReply,
    handleToggleCollapsed, handleClearReplyAssetError,
    // launcher
    reviewModalOpen, setReviewModalOpen, launcherPhase,
  };
}

export type TaskModalController = ReturnType<typeof useTaskModalController>;

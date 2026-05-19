import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Equal,
  Maximize2,
  MessageSquare,
  PanelRight,
  Save,
  Square,
  SendHorizontal,
  Trash2,
  X,
  Bot,
  Zap,
} from 'lucide-react';
import { useApp } from '../AppContext';
import { createTask, deleteTask, fetchTask, sendTaskCliInput, startTaskCliSession, updateTask } from '../api';
import { LaunchAgentSplitButton } from './LaunchAgentSplitButton';
import type { ReviewPersona } from './CodeReviewButton';
import { isAgentSession } from '../types';
import type { Config, HistoryEntry, InlineSubtask, Task } from '../types';
import { FRAMEWORK_ICONS } from '../constants';

import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import { TaskDescriptionSurface } from './TaskDescriptionSurface';
import { DEFAULT_READY_FOR_MERGE_STATUS, getRequireInputStatus } from '../workflow';
import { motion, AnimatePresence } from 'framer-motion';
import { useTaskForm } from '../hooks/useTaskForm';
import { useCliSession } from '../hooks/useCliSession';
import { useImageAttachment } from '../hooks/useImageAttachment';
import { MetadataPanel } from './task-modal/MetadataPanel';
import { CommentBox } from './task-modal/CommentBox';
import type { CommentBoxHandle } from './task-modal/CommentBox';
import { CliSessionPanel } from './task-modal/CliSessionPanel';
import { ReadyForMergePrompt } from './task-modal/ReadyForMergePrompt';
import { TokenBadge } from './TokenBadge';
import { HistoryList } from './task-modal/HistoryList';
const ACTIVITY_FILTER_STORAGE_KEY = 'flux.activityFilter';

type ActivityFilter = 'all' | 'decisions' | 'sessions';

function getInitialActivityFilter(): ActivityFilter {
  if (typeof window === 'undefined') return 'all';
  const stored = window.localStorage.getItem(ACTIVITY_FILTER_STORAGE_KEY);
  if (stored === 'decisions' || stored === 'sessions') return stored;
  return 'all';
}

function getPriorityIcon(priorityName: string, config: Config | null, className = 'h-4 w-4') {
  const priority = config?.priorities.find((item) => item.name === priorityName);
  const color = priority?.color || 'text-gray-400';
  switch (priority?.icon) {
    case 'AlertCircle':
      return <AlertCircle className={`${className} ${color}`} />;
    case 'ChevronUp':
      return <ChevronUp className={`${className} ${color}`} />;
    case 'ChevronDown':
      return <ChevronDown className={`${className} ${color}`} />;
    case 'Equal':
      return <Equal className={`${className} ${color}`} />;
    default:
      return <Equal className={`${className} text-gray-400`} />;
  }
}

export function TaskModal() {
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
  } = useCliSession({ isModalOpen, taskId: modalTask?.id, liveOutputRef, onSessionChange: triggerRefresh });

  const [requireInputDraft, setRequireInputDraft] = useState('');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(getInitialActivityFilter);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [collapsedThreads, setCollapsedThreads] = useState<Record<string, boolean>>({});
  const [responseDestination, setResponseDestination] = useState('Todo');
  const [returnToWorkOpen, setReturnToWorkOpen] = useState(false);
  const [subtaskToAdd, setSubtaskToAdd] = useState('');
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

  useEffect(() => {
    if (!isModalOpen) return;
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'full' || openModalInFullView) startTransition(() => setIsFullView(true));
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
    setSubtaskToAdd('');
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

  const isRequireInput = status === requireInputStatus;
  const isReadyForMerge = status === readyForMergeStatus;
  const isPromptStatus = isRequireInput || isReadyForMerge;
  const lastComment = modalTask?.history?.slice().reverse().find((entry) => entry.type === 'comment');
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
  const availableSubtasks = allTasks
    .filter((task) => task.id !== modalTask?.id && !subtasks.includes(task.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  const handleCloseAttempt = () => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    closeModal();
  };

  const handleSave = async (customHistory?: any[], keepOpen = false) => {
    setSaving(true);
    setSaveError(null);
    const payload = { title, body, status, assignee, tags, priority, effort, effortLevel: effortLevel || undefined, implementationLink: implementationLink.trim(), subtasks, order: modalTask?.order };
    let historyUpdates: any[] = customHistory || [];
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
    } catch (error: any) {
      console.error(error);
      setSaveError(error.message || 'Failed to save changes. Make sure the engine is running.');
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
    } catch (error: any) {
      console.error(error);
      setSaveError(error.message || 'Failed to delete task. Make sure the engine is running.');
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
      } catch (error: any) {
        commentBoxRef.current?.setValue(commentText);
        setCliSessionError(error?.message || 'Failed to send message to active CLI session.');
      } finally {
        setCliSessionBusy(false);
      }
      return;
    }
    const commentEntry = { type: 'comment', user: currentUser, date: new Date().toISOString(), comment: commentText };
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
      } catch (error: any) {
        setReplyDraft(replyText);
        setReplyTargetId(parentId);
        setCliSessionError(error?.message || 'Failed to send reply to active CLI session.');
      } finally {
        setCliSessionBusy(false);
      }
      return;
    }
    const replyEntry = { type: 'comment', user: currentUser, date: new Date().toISOString(), comment: replyText, replyTo: parentId };
    setReplyDraft('');
    setReplyTargetId(null);
    await handleSave([replyEntry], true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyDraft, cliSession, modalTask?.id, currentUser, triggerRefresh]);

  const submitRequireInputResponse = async () => {
    const responseComment = requireInputDraft.trim();
    if (!modalTask?.id || !responseComment) return;
    const targetStatus = requireInputDestinations.includes(responseDestination)
      ? responseDestination
      : requireInputDestinations[0] || 'Todo';
    const submittedAt = new Date().toISOString();
    const lastAgentComment = [...(modalTask.history || [])].reverse().find(
      (e) => e.type === 'comment' && e.id
    );
    const historyUpdates = [
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
    setSaving(true);
    try {
      const updatedTask = await updateTask(modalTask.id, {
        title, body, status: targetStatus, assignee, tags, priority, effort,
        effortLevel: effortLevel || undefined,
        implementationLink: implementationLink.trim(),
        order: modalTask.order,
        history: [...(modalTask.history || []), ...historyUpdates],
        updatedBy: currentUser,
      } as any);
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
      const responseEntry = (updatedTask.history || []).find(
        (e: HistoryEntry) => e.type === 'comment' && e.date === submittedAt && e.user === currentUser,
      );
      const idsToMark: string[] = [];
      if (lastAgentComment?.id) idsToMark.push(lastAgentComment.id);
      if (responseEntry?.id) idsToMark.push(responseEntry.id);
      if (idsToMark.length > 0) ctxMarkAllCommentsRead(modalTask.id, idsToMark);
      triggerRefresh();
      closeModal();
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
      const newEntries: any[] = [];
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
      } as any);
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

  const handleSendForCodeReview = useCallback(async (persona: ReviewPersona) => {
    if (!modalTask?.id) return;
    setReviewBusy(true);
    setReviewError('');
    try {
      await updateTask(modalTask.id, { status: 'In Progress' });
      const session = await startTaskCliSession(modalTask.id, selectedCliFramework, persona.prompt, skipPermissions);
      setCliSession(session);
      triggerRefresh();
      closeModal();
    } catch (error: any) {
      setReviewError(error?.message || 'Failed to start review session.');
    } finally {
      setReviewBusy(false);
    }
  }, [modalTask?.id, selectedCliFramework, skipPermissions, setCliSession, triggerRefresh, closeModal]);

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
        const nextSession = await startTaskCliSession(modalTask.id, selectedCliFramework, command);
        setCliSession(nextSession);
      }
      triggerRefresh();
    } catch (error: any) {
      setFinishError(error?.message || 'Failed to send finish command.');
    } finally {
      setFinishBusy(false);
    }
  }, [modalTask?.id, cliSession, currentUser, selectedCliFramework, triggerRefresh]);

  const handleGrooming = useCallback(async () => {
    if (!modalTask?.id) return;
    setCliSessionBusy(true);
    setCliSessionError('');
    try {
      const session = await startTaskCliSession(modalTask.id, selectedCliFramework, `groom ${modalTask.id}`, skipPermissions);
      setCliSession(session);
      triggerRefresh();
    } catch (error: any) {
      setCliSessionError(error?.message || 'Failed to start grooming session.');
    } finally {
      setCliSessionBusy(false);
    }
  }, [modalTask?.id, selectedCliFramework, skipPermissions, setCliSession, triggerRefresh]);

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

  const activityFilterTabs = (
    <div className="flex items-center gap-2 flex-wrap">
      {(['all', 'decisions', 'sessions'] as ActivityFilter[]).map((filter) => (
        <button
          key={filter}
          type="button"
          onClick={() => setActivityFilter(filter)}
          className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
            activityFilter === filter
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/15'
          }`}
        >
          {filter === 'all' ? 'All' : filter === 'decisions' ? 'Decisions' : 'Sessions'}
        </button>
      ))}
      {unreadCommentCount > 0 && (
        <button
          type="button"
          onClick={() => modalTask?.id && ctxMarkAllCommentsRead(modalTask.id, (modalTask.history || []).filter(e => e.type === 'comment' && e.id).map(e => e.id!))}
          className="ml-auto rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25"
        >
          Mark all read ({unreadCommentCount})
        </button>
      )}
    </div>
  );

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

  if (!config || (!isModalOpen && !modalTask)) return null;

  const requireInputPrompt = isRequireInput && modalTask?.id ? (
    <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm dark:border-amber-500/30 dark:from-amber-900/20 dark:to-[#1a1b23]">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 p-2 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">Awaiting your input</p>
          <h3 className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">Respond and route the ticket</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Answer the pending question, then choose where the ticket should go next.</p>
        </div>
      </div>
      <div className="space-y-4">
        {requireInputBanner}
        {groomingBanner}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Your response</label>
          <textarea
            ref={commentRef}
            autoFocus
            className="h-44 w-full resize-none rounded-xl border border-amber-200 bg-white px-4 py-3 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-amber-500/20 dark:bg-black/30"
            value={requireInputDraft}
            onChange={(event) => setRequireInputDraft(event.target.value)}
            placeholder="Type the answer you want to send back..."
          />
        </div>
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
          <div>
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Send ticket to</label>
            <select
              className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
              value={responseDestination}
              onChange={(event) => setResponseDestination(event.target.value)}
            >
              {requireInputDestinations.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <button
              disabled={saving || !requireInputDraft.trim()}
              onClick={submitRequireInputResponse}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <SendHorizontal className="h-4 w-4" />
              {saving ? 'Submitting...' : 'Send Response'}
            </button>
            <button
              onClick={() => setIsFullView(true)}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
            >
              <Maximize2 className="h-4 w-4" />
              Open full ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const cliSessionActive = Boolean(cliSession && ['pending', 'running', 'waiting-input'].includes(cliSession.status));
  const readyForMergePrompt = isReadyForMerge && modalTask?.id ? (
    <ReadyForMergePrompt
      taskId={modalTask.id}
      readyForMergeBanner={readyForMergeBanner}
      saving={saving}
      finishBusy={finishBusy}
      finishError={finishError}
      returnToWorkOpen={returnToWorkOpen}
      reviewBusy={reviewBusy}
      reviewError={reviewError}
      cliSessionActive={cliSessionActive}
      isFullView={isFullView}
      returnToWorkReasonRef={returnToWorkReasonRef}
      onReturnToWork={() => void handleReturnToWork()}
      onReturnToWorkAndLaunch={() => void handleReturnToWork({ launch: true })}
      onFinish={sendFinishCommand}
      onCodeReview={handleSendForCodeReview}
      onSetReturnToWorkOpen={setReturnToWorkOpen}
      onSetIsFullView={setIsFullView}
      onSetIsPromptModalOpen={setIsPromptModalOpen}
    />
  ) : null;

  const animationsEnabled = config?.animationsEnabled ?? true;
  const speedMap = { fast: 0.2, normal: 0.4, slow: 0.7 };
  const duration = speedMap[config?.animationSpeed || 'normal'];
  const Container = animationsEnabled ? motion.div : 'div';
  const layoutProps = animationsEnabled ? {
    layoutId: `ticket-${modalTask?.id}`,
    transition: { type: 'spring' as const, bounce: 0.15, duration: duration + 0.3 },
    style: { zIndex: 60 }
  } : {};
  const contentAnimation = animationsEnabled ? {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.2, delay: duration * 0.4 } },
    exit: { opacity: 0, transition: { duration: 0.05, delay: 0 } },
  } : {};

  const metadataPanelProps = {
    status, setStatus,
    assignee, setAssignee,
    priority, setPriority,
    effort, setEffort,
    effortLevel, setEffortLevel,
    implementationLink, setImplementationLink,
    tags, setTags,
    allStatuses, allUsers, allTags,
    configTags: config?.tags ?? [],
    availablePriorities,
  };

  const subtasksPanel = (
    <div className="space-y-4 rounded-xl border border-gray-100 bg-white/70 p-4 dark:border-white/5 dark:bg-white/5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Subtasks</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Link existing tickets as child work items.</p>
        </div>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-600 dark:bg-white/10 dark:text-gray-300">
          {subtasks.length}
        </span>
      </div>
      {modalTask?.id ? (
        <div className="flex gap-2">
          <select
            className="flex-1 min-w-0 cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
            value={subtaskToAdd}
            onChange={(event) => setSubtaskToAdd(event.target.value)}
          >
            <option value="">Attach existing ticket...</option>
            {availableSubtasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.id} - {task.title || 'Untitled Task'}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!subtaskToAdd}
            onClick={() => {
              if (!subtaskToAdd) return;
              setSubtasks((current) => [...current, subtaskToAdd]);
              setSubtaskToAdd('');
            }}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Attach
          </button>
        </div>
      ) : (
        <p className="text-sm text-gray-500">Save the ticket first, then attach existing subtasks.</p>
      )}
      {linkedSubtasks.length === 0 && danglingSubtaskIds.length === 0 ? (
        <p className="text-sm italic text-gray-500">No subtasks linked yet.</p>
      ) : (
        <div className="space-y-2">
          {linkedSubtasks.map((task) => (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              onClick={() => openTaskModal(task)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openTaskModal(task);
                }
              }}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 transition-colors hover:border-primary/30 hover:bg-primary/5 dark:border-white/5 dark:bg-black/20 dark:hover:bg-white/5"
            >
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">{task.id}</p>
                <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{task.title || 'Untitled Task'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <StatusBadge
                    status={task.status}
                    colorClass={getStatusColorClass(config, task.status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                  <span>{task.assignee || 'unassigned'} · {task.priority || 'None'}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setSubtasks((current) => current.filter((subtaskId) => subtaskId !== task.id));
                }}
                className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                title="Detach subtask"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {danglingSubtaskIds.map((subtaskId) => {
            const inline = inlineSubtaskMap.get(subtaskId);
            return (
              <div key={subtaskId} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${inline ? 'border-gray-100 bg-gray-50 text-gray-700 dark:border-white/5 dark:bg-black/20 dark:text-gray-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'}`}>
                <div className="min-w-0 flex-1">
                  {inline ? (
                    <>
                      <p className="text-xs font-bold uppercase tracking-wider text-gray-400">{subtaskId}</p>
                      <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{inline.title || subtaskId}</p>
                      {inline.status && (
                        <StatusBadge
                          status={inline.status}
                          colorClass={getStatusColorClass(config, inline.status)}
                          className="mt-1 text-[10px] font-bold uppercase tracking-[0.16em]"
                        />
                      )}
                    </>
                  ) : (
                    <span>{subtaskId} is linked but not currently loaded.</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSubtasks((current) => current.filter((id) => id !== subtaskId))}
                  className="rounded-md p-1.5 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/10"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const detailsPanel = (
    <div className="space-y-4 rounded-xl border border-gray-100 bg-white/70 p-4 dark:border-white/5 dark:bg-white/5">
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Ticket</p>
        <p className="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-200">{modalTask?.id || 'New Task'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Created By</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{modalTask?.createdBy || currentUser}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Updated By</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{modalTask?.updatedBy || currentUser}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Created</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{createdAt ? new Date(createdAt).toLocaleString() : 'Not recorded'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Last Activity</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{updatedAt ? new Date(updatedAt).toLocaleString() : 'Not recorded'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Effort</p>
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{effort && effort !== 'None' ? effort : 'Not set'}</p>
      </div>
      <div>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Implementation Link</p>
        {implementationLink.trim() ? (
          <a
            href={implementationLink.trim()}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block break-all text-sm text-primary underline underline-offset-2"
          >
            {implementationLink.trim()}
          </a>
        ) : (
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">Not set</p>
        )}
      </div>
      {modalTask?.id && (
        <CliSessionPanel
          cliSession={cliSession}
          cliSessionBusy={cliSessionBusy}
          cliSessionError={cliSessionError}
          selectedCliFramework={selectedCliFramework}
          setSelectedCliFramework={setSelectedCliFramework}
          skipPermissions={skipPermissions}
          setSkipPermissions={setSkipPermissions}
          sessionIsActive={sessionIsActive}
          liveOutputRef={liveOutputRef}
          config={config}
          tokenMetadata={modalTask.tokenMetadata}
          onLaunch={launchSession}
          onStop={stopSession}
          onToggleDisplayMode={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
        />
      )}
      {modalTask?.id && (
        <button
          onClick={() => setConfirmDelete(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
        >
          <Trash2 className="h-4 w-4" />
          Delete Task
        </button>
      )}
    </div>
  );

  const historyListProps = {
    topLevelEntries,
    repliesByParent,
    collapsedThreads,
    replyTargetId,
    replyDraft,
    replyAssetError,
    isUploadingReplyAsset,
    saving,
    readCommentIds,
    currentUser,
    isRequireInput,
    taskId: modalTask?.id,
    config,
    replyTextareaRef,
    onMarkCommentRead: ctxMarkCommentRead,
    onToggleReply: handleToggleReply,
    onSetReplyDraft: setReplyDraft,
    onClearReplyAssetError: handleClearReplyAssetError,
    onToggleCollapsed: handleToggleCollapsed,
    onSendReply: sendReplyDirectly,
    onCancelReply: handleCancelReply,
    onReplyPaste: handleReplyPaste,
    onReplyDragOver: handleReplyDragOver,
    onReplyDrop: handleReplyDrop,
  };

  const commentBoxProps = {
    onPaste: handleCommentPaste,
    onDragOver: handleCommentDragOver,
    onDrop: handleCommentDrop,
    onSend: sendCommentDirectly,
    saving,
    isUploading: isUploadingCommentAsset,
    assetError: commentAssetError,
    isRequireInput,
    disabled: !modalTask?.id,
    textareaRef: commentRef,
  };

  return (
    <AnimatePresence>
      {isModalOpen && config && !isFullView && (
        <motion.div
          key="modal-overlay"
          initial={animationsEnabled ? { opacity: 0 } : undefined}
          animate={animationsEnabled ? { opacity: 1 } : undefined}
          exit={animationsEnabled ? { opacity: 0 } : undefined}
          transition={{ duration: 0.2 }}
          className="pointer-events-auto fixed inset-0 z-[55] bg-black/40 backdrop-blur-sm"
          onClick={handleCloseAttempt}
        />
      )}

      {isModalOpen && config && isFullView && (
        <Container
          key="modal-content-full"
          {...layoutProps}
          className="pointer-events-auto fixed inset-3 z-[60] flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]"
        >
          <motion.div {...contentAnimation} className="flex h-full w-full flex-col overflow-hidden">
          {saveError && (
            <div className="bg-red-500/10 text-red-600 dark:text-red-400 px-5 py-3 text-sm font-medium border-b border-red-500/20 text-center flex items-center justify-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {saveError}
            </div>
          )}
          <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-5 py-4 dark:border-white/5 dark:bg-black/20">
            <div className="flex min-w-0 flex-1 items-center gap-4 mr-4">
              <button
                onClick={handleCloseAttempt}
                className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Board
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{modalTask?.id || 'New Task'}</p>
                  <StatusBadge
                    status={status}
                    colorClass={getStatusColorClass(config, status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                </div>
                <textarea
                  ref={titleRef}
                  rows={1}
                  className="mt-1 w-full resize-none overflow-hidden bg-transparent text-lg font-semibold text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    event.target.style.height = 'auto';
                    event.target.style.height = event.target.scrollHeight + 'px';
                  }}
                  placeholder="Task title..."
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                disabled={saving || !isDirty}
                onClick={() => handleSave(undefined, true)}
                className={`flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-semibold shadow-sm ${
                  isDirty
                    ? 'cursor-pointer bg-primary text-white shadow-primary/20 hover:bg-primary-hover'
                    : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/10'
                }`}
              >
                <Save className="h-4 w-4" />
                {saving ? 'Saving...' : 'Save'}
              </button>
              {modalTask && (
                <TokenBadge
                  data={modalTask.tokenMetadata}
                  config={config}
                  variant="modal"
                  onToggle={config ? () => void saveConfig({ ...config, tokenDisplayMode: config.tokenDisplayMode === 'tokens' ? 'cost' : 'tokens' }) : undefined}
                />
              )}
              {modalTask?.id && (() => {
                if (sessionIsActive && cliSession) {
                  const statusColor = cliSession.status === 'running' ? 'bg-green-500' : cliSession.status === 'waiting-input' ? 'bg-amber-500' : 'bg-gray-400';
                  return (
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 dark:border-white/10 dark:bg-white/5 dark:text-gray-200">
                        <span className={`h-2 w-2 rounded-full ${statusColor} animate-pulse`} />
                        Agent {cliSession.status}
                      </span>
                      <button
                        type="button"
                        disabled={cliSessionBusy}
                        onClick={stopSession}
                        className="flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/5"
                      >
                        <Square className="h-3 w-3" />
                        Stop
                      </button>
                    </div>
                  );
                }
                return (
                  <LaunchAgentSplitButton
                    size="sm"
                    busy={cliSessionBusy}
                    disabled={!modalTask?.id}
                    onLaunch={launchSession}
                    icon={FRAMEWORK_ICONS[selectedCliFramework]}
                  />
                );
              })()}
              <button onClick={handleCloseAttempt} className="rounded p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {isTaskLoading && !modalTask?.body && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 p-6 animate-pulse">
              <div className="h-4 w-1/3 rounded bg-gray-200 dark:bg-white/10" />
              <div className="h-4 w-2/3 rounded bg-gray-200 dark:bg-white/10" />
              <div className="h-4 w-1/2 rounded bg-gray-200 dark:bg-white/10" />
              <div className="h-4 w-3/4 rounded bg-gray-200 dark:bg-white/10" />
            </div>
          )}

          <div className="grid min-h-0 flex-1 relative" style={{ gridTemplateColumns: `minmax(0,1fr) ${sidebarWidth}px`, display: isTaskLoading && !modalTask?.body ? 'none' : undefined }}>
            {isFullView && isPromptStatus && (
              <>
                <div
                  ref={promptModalRef}
                  className={`absolute top-6 left-6 z-50 rounded-2xl bg-white/95 backdrop-blur-md shadow-2xl dark:bg-[#1a1b23]/95 border border-amber-200 dark:border-amber-500/30 transition-all duration-300 origin-top-right ${isPromptModalOpen ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto' : 'opacity-0 scale-50 -translate-y-4 pointer-events-none'}`}
                  style={{ right: `${sidebarWidth + 24}px` }}
                >
                  <div className="flex justify-between items-center border-b border-gray-100 px-4 py-2 dark:border-white/5">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">Prompt Active</span>
                    <button onClick={() => setIsPromptModalOpen(false)} className="p-1 hover:bg-gray-100 rounded dark:hover:bg-white/10 text-gray-500 transition-colors">
                      <X className="w-4 h-4"/>
                    </button>
                  </div>
                  <div className="p-2 max-h-[80vh] overflow-y-auto">
                    {isRequireInput ? requireInputPrompt : readyForMergePrompt}
                  </div>
                </div>
                <div
                  className={`absolute top-6 z-40 transition-all duration-300 pointer-events-auto ${!isPromptModalOpen ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none'}`}
                  style={{ right: `${sidebarWidth + 24}px` }}
                >
                  <button
                    onClick={() => setIsPromptModalOpen(true)}
                    className="relative flex items-center justify-center p-[2px] overflow-hidden rounded-full shadow-lg hover:scale-105 transition-transform"
                  >
                    <span className="absolute top-1/2 left-1/2 block aspect-square w-[300px] -translate-x-1/2 -translate-y-1/2 animate-[spin_2s_linear_infinite] bg-[conic-gradient(from_0deg,transparent_0_340deg,rgba(255,255,255,0.8)_360deg)]" style={{ willChange: 'transform' }}></span>
                    <div className="relative flex items-center gap-2 bg-amber-500 text-white px-4 py-2 rounded-full font-bold hover:bg-amber-600 transition-colors w-full h-full">
                      <MessageSquare className="w-4 h-4" />
                      Prompt Pending
                    </div>
                  </button>
                </div>
              </>
            )}

            <div className="min-h-0 border-r border-gray-200 dark:border-white/10 overflow-y-auto relative">
              <div className="flex flex-col min-h-full">
                {(requireInputBanner || groomingBanner) && (
                  <div className="border-b border-gray-200 p-6 dark:border-white/10">
                    {requireInputBanner}
                    {groomingBanner}
                  </div>
                )}
                <div className="flex-1 flex flex-col border-b border-gray-200 dark:border-white/10">
                  <div className="flex items-center justify-between px-6 py-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Description</p>
                      <p className="text-sm text-gray-500">Rendered markdown by default, editable in place.</p>
                    </div>
                  </div>
                  <div className="flex-1 px-6 pb-6 min-h-[200px]">
                    <TaskDescriptionSurface
                      key={`${modalTask?.id || 'new-task'}-full`}
                      value={body}
                      onChange={setBody}
                      taskId={modalTask?.id}
                      mode="full"
                      emptyMessage="No description yet."
                    />
                  </div>
                </div>

                <div ref={commentSectionRef} className="px-6 py-4 flex flex-col relative pb-8">
                  <div className="flex items-center justify-between gap-4 mb-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Activity & Comments</p>
                    {activityFilterTabs}
                  </div>
                  <div className="flex-1 mb-8"><HistoryList {...historyListProps} /></div>
                  {(!isRequireInput) && (
                    <div className="sticky bottom-0 mt-8 pt-4 pb-2 z-10 w-full bg-gradient-to-t from-gray-50/95 via-gray-50/95 to-transparent dark:from-[#1a1b23]/95 dark:via-[#1a1b23]/95 dark:to-transparent pointer-events-none">
                      <div className="pointer-events-auto">
                        {!isCommentBoxVisible ? (
                          <div className="flex justify-end">
                            <button
                              onClick={() => setIsCommentBoxVisible(true)}
                              className="bg-primary text-white px-4 py-2 rounded-full font-bold shadow-md hover:bg-primary-hover text-sm"
                            >
                              Reply
                            </button>
                          </div>
                        ) : (
                          <div className="rounded-xl shadow-lg border border-gray-200 bg-white dark:bg-[#1f2028] dark:border-white/10 backdrop-blur-md w-full">
                            <CommentBox ref={commentBoxRef} {...commentBoxProps} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div
              className="absolute top-0 bottom-0 z-40 w-2 cursor-col-resize hover:bg-primary/20 hover:backdrop-blur-sm transition-colors"
              style={{ right: `${sidebarWidth - 4}px` }}
              onMouseDown={(e) => { e.preventDefault(); setIsDraggingSidebar(true); }}
            />

            <aside className="min-h-0 min-w-0 overflow-y-auto bg-gray-50/80 p-6 dark:bg-black/10" style={{ width: `${sidebarWidth}px`, overflowX: 'hidden' }}>
              <div className="space-y-6 w-full">
                <MetadataPanel {...metadataPanelProps} />
                {subtasksPanel}
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/10">
                  <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
                    {getPriorityIcon(priority, config)}
                    {priority}
                  </div>
                </div>
                {detailsPanel}
              </div>
            </aside>
          </div>
          </motion.div>
        </Container>
      )}

      {isModalOpen && config && !isFullView && (
        <Rnd
          key="modal-content-popup"
          enableUserSelectHack={false}
          default={{ x: window.innerWidth / 2 - 400, y: Math.max(30, window.innerHeight * 0.05), width: 800, height: window.innerHeight * 0.9 }}
          minWidth={640}
          minHeight={420}
          bounds="window"
          dragHandleClassName="modal-handle"
          className="pointer-events-auto !z-[60]"
        >
          <Container
            {...layoutProps}
            className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
            <motion.div {...contentAnimation} className="flex h-full w-full flex-col overflow-hidden">
            {saveError && (
              <div className="bg-red-500/10 text-red-600 dark:text-red-400 px-4 py-2.5 text-sm font-medium border-b border-red-500/20 text-center flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {saveError}
              </div>
            )}
            <div className="modal-handle flex shrink-0 items-center justify-between cursor-move border-b border-gray-100 bg-gray-50 px-4 py-3 dark:border-white/5 dark:bg-black/20">
              <div className="flex flex-col flex-1 min-w-0 mr-4">
                <div className="mb-0.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  <span>
                    {modalTask?.id ? modalTask.id : 'New Task'}{' '}
                    {isDirty && <span className="ml-1 lowercase italic normal-case text-amber-500">(Unsaved changes)</span>}
                  </span>
                  <StatusBadge
                    status={status}
                    colorClass={getStatusColorClass(config, status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                </div>
                <textarea
                  ref={titleRef}
                  rows={1}
                  className="mt-1 w-full resize-none overflow-hidden bg-transparent text-lg font-semibold text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    event.target.style.height = 'auto';
                    event.target.style.height = event.target.scrollHeight + 'px';
                  }}
                  placeholder="Task title..."
                />
              </div>
              <div className="flex items-center gap-2.5">
                {modalTask?.id && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    title="Delete Task"
                    className="rounded p-1.5 text-red-400 transition-colors hover:bg-red-500 hover:text-white"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => setIsWideMode((current) => !current)}
                  title="Toggle Wide Mode"
                  className="rounded bg-gray-200/50 p-1.5 text-gray-400 transition-colors hover:text-primary dark:bg-white/5"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setIsFullView(true)}
                  title="Full View"
                  className="flex items-center gap-1.5 rounded-md bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200 dark:bg-white/10 dark:text-gray-200 dark:hover:bg-white/15"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  Full View
                </button>
                <button
                  disabled={saving || !isDirty}
                  onClick={() => handleSave()}
                  className={`flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-semibold shadow-sm ${
                    isDirty
                      ? 'cursor-pointer bg-primary text-white shadow-primary/20 hover:bg-primary-hover'
                      : 'cursor-not-allowed bg-gray-200 text-gray-400 dark:bg-white/10'
                  }`}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button onClick={handleCloseAttempt} className="cursor-pointer text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-white">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-sm text-gray-800 dark:text-gray-200">
              {isRequireInput ? requireInputPrompt : (
                <>
                  {requireInputBanner}
                  {groomingBanner}
                </>
              )}

              <div className="space-y-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/10">
                <MetadataPanel {...metadataPanelProps} variant="popup" isWideMode={isWideMode} />
              </div>

              <div className="flex min-h-[280px] flex-1 flex-col gap-2">
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Description</label>
                <TaskDescriptionSurface
                  key={`${modalTask?.id || 'new-task'}-popup`}
                  value={body}
                  onChange={setBody}
                  taskId={modalTask?.id}
                  mode="popup"
                  emptyMessage="No description yet."
                />
              </div>

              {subtasksPanel}

              {cliSession?.liveOutput && (
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Live Output</p>
                  <pre
                    ref={liveOutputRef}
                    className="max-h-48 overflow-y-auto rounded-lg bg-gray-900 p-2 text-[10px] leading-relaxed text-gray-200 dark:bg-black/60 whitespace-pre-wrap break-words"
                  >
                    {cliSession.liveOutput}
                  </pre>
                </div>
              )}

              <div className="border-t border-gray-200 pt-4 dark:border-white/10">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-300">
                    <MessageSquare className="h-4 w-4" /> Activity & Comments
                  </h3>
                  {activityFilterTabs}
                </div>
                <div className="mb-4"><HistoryList {...historyListProps} /></div>
                {!isRequireInput && <CommentBox ref={commentBoxRef} {...commentBoxProps} />}
                {isReadyForMerge && readyForMergePrompt}
              </div>
            </div>
            </motion.div>
          </Container>
        </Rnd>
      )}

      {confirmDelete && (
        <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
            <h3 className="mb-2 text-lg font-bold text-red-500">Delete Task?</h3>
            <p className="mb-6 text-sm text-gray-500">
              Are you absolutely sure you want to delete this task? This will permanently delete the markdown file from disk.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDelete(false)}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={saving}
                className="cursor-pointer rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                {saving ? 'Deleting...' : 'Delete Task'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[400px] rounded-xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
            <h3 className="mb-2 text-lg font-bold">Discard changes?</h3>
            <p className="mb-6 text-sm text-gray-500">You have unsaved changes. Are you sure you want to close without saving?</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setConfirmDiscard(false)}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
              >
                Keep Editing
              </button>
              <button
                onClick={() => {
                  setConfirmDiscard(false);
                  closeModal();
                }}
                className="cursor-pointer rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600"
              >
                Discard Changes
              </button>
              <button
                onClick={() => {
                  setConfirmDiscard(false);
                  void handleSave(undefined, isFullView);
                }}
                className="cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </AnimatePresence>
  );
}

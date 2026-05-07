import { useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Equal,
  Maximize2,
  MessageSquare,
  PanelRight,
  Save,
  SendHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../AppContext';
import { createTask, deleteTask, fetchTasks, updateTask } from '../api';
import type { Config, HistoryEntry, TagDef, Task } from '../types';
import { StatusBadge } from './StatusBadge';
import { getStatusColorClass } from '../statusStyles';
import { buildUnsupportedImageMessage, uploadTaskImageMarkdownLinks } from '../taskAssetUploads';
import { normalizeTaskMarkdownBody, TaskDescriptionSurface } from './TaskDescriptionSurface';
import { TaskMarkdown } from './TaskMarkdown';
import { DEFAULT_READY_FOR_MERGE_STATUS, getRequireInputStatus } from '../workflow';

const ACTIVITY_FILTER_STORAGE_KEY = 'flux.activityFilter';

type ActivityFilter = 'all' | 'comments';

function getInitialActivityFilter(): ActivityFilter {
  if (typeof window === 'undefined') return 'all';
  const stored = window.localStorage.getItem(ACTIVITY_FILTER_STORAGE_KEY);
  return stored === 'comments' ? 'comments' : 'all';
}

function TagSelector({
  tags,
  onChange,
  availableTags,
  configTags,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  availableTags: string[];
  configTags: TagDef[];
}) {
  const [input, setInput] = useState('');
  const [focused, setFocused] = useState(false);

  const addTag = (tag: string) => {
    if (!tags.includes(tag)) onChange([...tags, tag]);
    setInput('');
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((currentTag) => currentTag !== tag));
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && input.trim()) {
      event.preventDefault();
      addTag(input.trim());
    } else if (event.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  const unselected = availableTags.filter(
    (tag) => !tags.includes(tag) && tag.toLowerCase().includes(input.toLowerCase())
  );

  return (
    <div className="relative flex-1">
      <div
        className={`flex min-h-[38px] w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors ${
          focused
            ? 'border-primary'
            : 'border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-black/20'
        }`}
        onClick={() => document.getElementById('tag-input')?.focus()}
      >
        {tags.map((tag) => {
          const color =
            configTags.find((configTag) => configTag.name === tag)?.color ||
            'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
          return (
            <span key={tag} className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${color}`}>
              {tag}
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  removeTag(tag);
                }}
                className="hover:opacity-70"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}
        <input
          id="tag-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          className="min-w-[60px] flex-1 bg-transparent text-sm text-gray-800 outline-none dark:text-gray-200"
          placeholder={tags.length === 0 ? 'Add tags...' : ''}
        />
      </div>
      {focused && unselected.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-[60] mt-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl dark:border-white/10 dark:bg-[#252630]">
          {unselected.map((tag) => (
            <div
              key={tag}
              onMouseDown={(event) => {
                event.preventDefault();
                addTag(tag);
              }}
              className="cursor-pointer px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5"
            >
              {tag}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];
  const {
    isModalOpen,
    closeModal,
    modalTask,
    setModalTask,
    openTaskModal,
    currentProject,
    currentUser,
    refreshTrigger,
    triggerRefresh,
    config,
  } = useApp();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('Todo');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<string>('None');
  const [effort, setEffort] = useState<string>('None');
  const [implementationLink, setImplementationLink] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newComment, setNewComment] = useState('');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(getInitialActivityFilter);
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [collapsedThreads, setCollapsedThreads] = useState<Record<string, boolean>>({});
  const [responseDestination, setResponseDestination] = useState('Todo');
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
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [subtaskToAdd, setSubtaskToAdd] = useState('');

  const commentRef = useRef<HTMLTextAreaElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const commentSectionRef = useRef<HTMLDivElement>(null);
  const promptModalRef = useRef<HTMLDivElement>(null);

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
      if (entry.isIntersecting) {
        setIsCommentBoxVisible(true);
      }
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    observer.observe(currentRef);
    return () => observer.disconnect();
  }, [isFullView, modalTask?.id]);

  useEffect(() => {
    if (modalTask) {
      setTitle(modalTask.title || '');
      setBody(modalTask.body || '');
      setStatus(modalTask.status || 'Todo');
      setAssignee(modalTask.assignee || 'unassigned');
      setTags(modalTask.tags || []);
      setPriority(modalTask.priority || 'None');
      setEffort(modalTask.effort || 'None');
      setImplementationLink(modalTask.implementationLink || '');
      setSubtasks(modalTask.subtasks || []);
      setNewComment('');
      setReplyTargetId(null);
      setReplyDraft('');
      setCollapsedThreads({});
      setResponseDestination('Todo');
      setConfirmDiscard(false);
      setConfirmDelete(false);
      setIsWideMode(false);
      setIsFullView(new URLSearchParams(window.location.search).get('view') === 'full');
      setCommentAssetError('');
      setReplyAssetError('');
      setIsUploadingCommentAsset(false);
      setIsUploadingReplyAsset(false);
    }
  }, [modalTask]);

  useEffect(() => {
    if (!isModalOpen) return;

    fetchTasks()
      .then(setAllTasks)
      .catch(console.error);
  }, [isModalOpen, refreshTrigger]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACTIVITY_FILTER_STORAGE_KEY, activityFilter);
  }, [activityFilter]);

  useEffect(() => {
    if (!isModalOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isFullView) {
        handleCloseAttempt();
        return;
      }
      handleCloseAttempt();
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSidebar) return;
      setSidebarWidth((prev) => Math.max(250, Math.min(window.innerWidth * 0.5, window.innerWidth - e.clientX)));
    };
    
    const handleMouseUp = () => {
      setIsDraggingSidebar(false);
    };

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

  const originalPayload = JSON.stringify({
    title: modalTask?.title || '',
    body: normalizeTaskMarkdownBody(modalTask?.body || ''),
    status: modalTask?.status || 'Todo',
    assignee: modalTask?.assignee || 'unassigned',
    tags: modalTask?.tags || [],
    priority: modalTask?.priority || 'None',
    effort: modalTask?.effort || 'None',
    implementationLink: modalTask?.implementationLink || '',
    subtasks: modalTask?.subtasks || [],
  });

  const currentPayload = JSON.stringify({
    title,
    body: normalizeTaskMarkdownBody(body),
    status,
    assignee,
    tags,
    priority,
    effort,
    implementationLink,
    subtasks,
  });
  const isDirty = originalPayload !== currentPayload || newComment.trim() !== '';

  useEffect(() => {
    if (!isRequireInput) return;
    if (requireInputDestinations.includes(responseDestination)) return;
    setResponseDestination(requireInputDestinations[0] || 'Todo');
  }, [isRequireInput, requireInputDestinations, responseDestination]);

  if (!isModalOpen || !config) return null;

  const activityHistory = modalTask?.history || [];
  const filteredHistory = activityFilter === 'comments'
    ? activityHistory.filter((entry) => entry.type === 'comment')
    : activityHistory;
  const repliesByParent = new Map<string, HistoryEntry[]>();
  const topLevelEntries: HistoryEntry[] = [];

  filteredHistory.forEach((entry) => {
    if (entry.type === 'comment' && entry.replyTo) {
      const replies = repliesByParent.get(entry.replyTo) || [];
      replies.push(entry);
      repliesByParent.set(entry.replyTo, replies);
      return;
    }
    topLevelEntries.push(entry);
  });

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
    const payload = { title, body, status, assignee, tags, priority, effort, implementationLink: implementationLink.trim(), subtasks, order: modalTask?.order };
    let historyUpdates: any[] = customHistory || [];

    if (!customHistory && newComment.trim()) {
      historyUpdates.push({
        type: 'comment',
        user: currentUser,
        date: new Date().toISOString(),
        comment: newComment.trim(),
      });
      setNewComment('');
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
            comment: newComment.trim() ? 'Included with comment' : undefined,
          });
        }

        const newHistory = [...(modalTask.history || []), ...historyUpdates];
        const updatedTask = await updateTask(modalTask.id, {
          ...payload,
          history: newHistory,
          updatedBy: currentUser,
        } as any);
        setModalTask(updatedTask);
      } else {
        await createTask({ ...payload, history: historyUpdates, projectKey: currentProject, author: currentUser });
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
    if (!newComment.trim() || !modalTask?.id) return;

    const commentEntry = {
      type: 'comment',
      user: currentUser,
      date: new Date().toISOString(),
      comment: newComment.trim(),
    };

    setNewComment('');
    await handleSave([commentEntry], true);
  };

  const sendReplyDirectly = async (parentId: string) => {
    if (!replyDraft.trim() || !modalTask?.id) return;

    const replyEntry = {
      type: 'comment',
      user: currentUser,
      date: new Date().toISOString(),
      comment: replyDraft.trim(),
      replyTo: parentId,
    };

    setReplyDraft('');
    setReplyTargetId(null);
    await handleSave([replyEntry], true);
  };

  const submitRequireInputResponse = async () => {
    if (!modalTask?.id || !newComment.trim()) return;

    const targetStatus = requireInputDestinations.includes(responseDestination)
      ? responseDestination
      : requireInputDestinations[0] || 'Todo';
    const submittedAt = new Date().toISOString();
    const responseComment = newComment.trim();
    const historyUpdates = [
      {
        type: 'comment',
        user: currentUser,
        date: submittedAt,
        comment: responseComment,
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
        title,
        body,
        status: targetStatus,
        assignee,
        tags,
        priority,
        effort,
        implementationLink: implementationLink.trim(),
        order: modalTask.order,
        history: [...(modalTask.history || []), ...historyUpdates],
        updatedBy: currentUser,
      } as any);
      setModalTask(updatedTask);
      setNewComment('');
      setStatus(targetStatus);
      triggerRefresh();
      closeModal();
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const insertTextIntoDraft = (
    currentValue: string,
    setValue: (value: string) => void,
    targetTextArea: HTMLTextAreaElement | null,
    text: string,
    selectionStart?: number,
    selectionEnd?: number,
  ) => {
    const start = selectionStart ?? targetTextArea?.selectionStart ?? currentValue.length;
    const end = selectionEnd ?? targetTextArea?.selectionEnd ?? currentValue.length;
    const nextValue = currentValue.substring(0, start) + text + currentValue.substring(end);

    setValue(nextValue);

    setTimeout(() => {
      if (!targetTextArea) {
        return;
      }

      const nextCursorPosition = start + text.length;
      targetTextArea.focus();
      targetTextArea.setSelectionRange(nextCursorPosition, nextCursorPosition);
    }, 0);
  };

  const attachImageFilesToDraft = async ({
    files,
    currentValue,
    setValue,
    targetTextArea,
    selectionStart,
    selectionEnd,
    setError,
    setUploading,
  }: {
    files: File[];
    currentValue: string;
    setValue: (value: string) => void;
    targetTextArea: HTMLTextAreaElement | null;
    selectionStart?: number;
    selectionEnd?: number;
    setError: (value: string) => void;
    setUploading: (value: boolean) => void;
  }) => {
    if (files.length === 0) {
      return;
    }

    if (!modalTask?.id) {
      setError('Save the ticket before attaching images.');
      return;
    }

    setUploading(true);
    setError('');

    try {
      const { markdownLinks, unsupportedFiles } = await uploadTaskImageMarkdownLinks(modalTask.id, files);

      if (markdownLinks.length === 0) {
        setError(buildUnsupportedImageMessage(unsupportedFiles));
        return;
      }

      insertTextIntoDraft(currentValue, setValue, targetTextArea, markdownLinks.join('\n\n'), selectionStart, selectionEnd);

      if (unsupportedFiles.length > 0) {
        setError(buildUnsupportedImageMessage(unsupportedFiles));
      }
    } catch (error) {
      console.error(error);
      setError(error instanceof Error ? error.message : 'Failed to attach image.');
    } finally {
      setUploading(false);
    }
  };

  const attachCommentImageFiles = async (files: File[], selectionStart?: number, selectionEnd?: number) => {
    await attachImageFilesToDraft({
      files,
      currentValue: newComment,
      setValue: setNewComment,
      targetTextArea: commentRef.current,
      selectionStart,
      selectionEnd,
      setError: setCommentAssetError,
      setUploading: setIsUploadingCommentAsset,
    });
  };

  const attachReplyImageFiles = async (files: File[], selectionStart?: number, selectionEnd?: number) => {
    await attachImageFilesToDraft({
      files,
      currentValue: replyDraft,
      setValue: setReplyDraft,
      targetTextArea: replyTextareaRef.current,
      selectionStart,
      selectionEnd,
      setError: setReplyAssetError,
      setUploading: setIsUploadingReplyAsset,
    });
  };

  const handleCommentPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void attachCommentImageFiles(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  };

  const handleCommentDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleCommentDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void attachCommentImageFiles(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  };

  const handleReplyPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void attachReplyImageFiles(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  };

  const handleReplyDragOver = (event: React.DragEvent<HTMLTextAreaElement>) => {
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleReplyDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    void attachReplyImageFiles(files, event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
  };

  const metadataFields = (
    <div className="space-y-5 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-white/5 dark:bg-black/10">
      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Status</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {allStatuses.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Assignee</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={assignee}
          onChange={(event) => setAssignee(event.target.value)}
        >
          <option value="unassigned">Unassigned</option>
          {allUsers.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Priority</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        >
          {availablePriorities.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Effort</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={effort}
          onChange={(event) => setEffort(event.target.value)}
        >
          {EFFORT_OPTIONS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Implementation Link</label>
        <input
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
          value={implementationLink}
          onChange={(event) => setImplementationLink(event.target.value)}
          placeholder="https://github.com/..."
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
        <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={config.tags} />
      </div>
    </div>
  );

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
          {danglingSubtaskIds.map((subtaskId) => (
            <div key={subtaskId} className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              <span>{subtaskId} is linked but not currently loaded.</span>
              <button
                type="button"
                onClick={() => setSubtasks((current) => current.filter((id) => id !== subtaskId))}
                className="rounded-md p-1.5 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
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

  const activityFilterTabs = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setActivityFilter('all')}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
          activityFilter === 'all'
            ? 'bg-primary text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/15'
        }`}
      >
        All Activity
      </button>
      <button
        type="button"
        onClick={() => setActivityFilter('comments')}
        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
          activityFilter === 'comments'
            ? 'bg-primary text-white'
            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/15'
        }`}
      >
        Comments Only
      </button>
    </div>
  );

  const historyList = (
    <div className="space-y-4">
      {topLevelEntries.length === 0 ? (
        <p className="text-sm italic text-gray-500">No activity yet.</p>
      ) : (
        [...topLevelEntries].map((entry, index) => {
          const replies = entry.id ? repliesByParent.get(entry.id) || [] : [];
          const isCollapsed = entry.id ? collapsedThreads[entry.id] : false;

          return (
          <div key={`${entry.id || entry.date}-${index}`} className="flex gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
              {entry.type === 'status_change' ? (
                <ArrowRight className="h-3 w-3 text-primary" />
              ) : (
                <MessageSquare className="h-3 w-3 text-primary" />
              )}
            </div>
            <div className="flex-1 rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{entry.user}</span>
                  {entry.type === 'comment' && entry.id && (
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-300">
                      {entry.id}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-gray-500">{new Date(entry.date).toLocaleString()}</span>
              </div>
              {entry.type === 'status_change' && (
                <div className="mb-1.5 flex items-center gap-2 text-xs text-gray-500">
                  Moved from <StatusBadge status={entry.from || 'Unknown'} colorClass={getStatusColorClass(config, entry.from || '')} className="text-[10px] font-bold uppercase tracking-[0.16em]" />
                  <ArrowRight className="h-3 w-3" />
                  <StatusBadge status={entry.to || 'Unknown'} colorClass={getStatusColorClass(config, entry.to || '')} className="text-[10px] font-bold uppercase tracking-[0.16em]" />
                </div>
              )}
              {entry.comment && <TaskMarkdown body={entry.comment} taskId={modalTask?.id} compact imageMode={entry.type === 'comment' ? 'comment' : 'inline'} emptyMessage="" />}

              {entry.type === 'comment' && !entry.replyTo && modalTask?.id && !isRequireInput && (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReplyTargetId((current) => current === entry.id ? null : entry.id || null);
                      setReplyDraft('');
                    }}
                    className="rounded-md px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                  >
                    Reply
                  </button>
                  {replies.length > 0 && entry.id && (
                    <button
                      type="button"
                      onClick={() => setCollapsedThreads((current) => ({ ...current, [entry.id!]: !current[entry.id!] }))}
                      className="rounded-md px-2 py-1 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-200 dark:hover:bg-white/10"
                    >
                      {isCollapsed ? `Show replies (${replies.length})` : `Hide replies (${replies.length})`}
                    </button>
                  )}
                </div>
              )}

              {replyTargetId === entry.id && !isRequireInput && (
                <div className="mt-3 rounded-lg border border-primary/20 bg-white p-3 dark:border-primary/20 dark:bg-[#1f2028]">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">Replying inline</p>
                  <textarea
                    ref={replyTextareaRef}
                    className="h-24 w-full resize-none rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-primary dark:border-white/10 dark:bg-black/20"
                    value={replyDraft}
                    onChange={(event) => {
                      setReplyDraft(event.target.value);
                      if (replyAssetError) {
                        setReplyAssetError('');
                      }
                    }}
                    onPaste={handleReplyPaste}
                    onDragOver={handleReplyDragOver}
                    onDrop={handleReplyDrop}
                    placeholder="Write a reply..."
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-gray-500 dark:text-gray-400">
                    <span>Paste or drop PNG, JPG, or SVG images.</span>
                    {isUploadingReplyAsset && <span className="font-semibold text-primary">Uploading image...</span>}
                  </div>
                  {replyAssetError && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      {replyAssetError}
                    </div>
                  )}
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setReplyTargetId(null);
                        setReplyDraft('');
                      }}
                      className="rounded-md px-3 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-200 dark:hover:bg-white/10"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={saving || isUploadingReplyAsset || !replyDraft.trim()}
                      onClick={() => entry.id && void sendReplyDirectly(entry.id)}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving ? 'Replying...' : 'Reply'}
                    </button>
                  </div>
                </div>
              )}

              {replies.length > 0 && !isCollapsed && (
                <div className="mt-4 space-y-3 border-l-2 border-primary/20 pl-4">
                  {replies.map((reply) => (
                    <div key={reply.id || reply.date} className="rounded-lg border border-gray-100 bg-white p-3 dark:border-white/5 dark:bg-[#1f2028]">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{reply.user}</span>
                          {reply.id && (
                            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-white/10 dark:text-gray-300">
                              {reply.id}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-gray-500">{new Date(reply.date).toLocaleString()}</span>
                      </div>
                      {reply.comment && <TaskMarkdown body={reply.comment} taskId={modalTask?.id} compact imageMode="comment" emptyMessage="" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )})
      )}
    </div>
  );

  const commentComposer = (
    <div className="relative">
      <textarea
        ref={commentRef}
        autoFocus={isRequireInput}
        style={{ minHeight: '80px' }}
        className="w-full resize-none overflow-hidden rounded-xl border border-gray-200 bg-white px-4 py-3 pb-12 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-white/10 dark:bg-black/40 transition-all"
        value={newComment}
        onChange={(event) => {
          setNewComment(event.target.value);
          if (commentAssetError) {
            setCommentAssetError('');
          }
          event.target.style.height = 'auto';
          event.target.style.height = event.target.scrollHeight + 'px';
        }}
        onPaste={handleCommentPaste}
        onDragOver={handleCommentDragOver}
        onDrop={handleCommentDrop}
        placeholder={isRequireInput ? 'Type your response...' : 'Add a comment...'}
      />
      <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span>Paste or drop PNG, JPG, or SVG images to attach them.</span>
        {isUploadingCommentAsset && <span className="font-semibold text-primary">Uploading image...</span>}
      </div>
      {commentAssetError && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          {commentAssetError}
        </div>
      )}
      <div className="absolute bottom-3 right-3 flex items-center">
        <button
          disabled={saving || isUploadingCommentAsset || !newComment.trim() || !modalTask?.id}
          onClick={sendCommentDirectly}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
          {saving ? 'Sending...' : 'Send'}
        </button>
      </div>
    </div>
  );

  const requireInputBanner = isRequireInput && lastComment ? (
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
  ) : null;

  const readyForMergeBanner = isReadyForMerge ? (
    <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-900/20">
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">Merge review requested</p>
        <p className="whitespace-pre-wrap text-sm text-amber-700 dark:text-amber-400">
          This ticket is waiting in {readyForMergeStatus} for your review and finalization. Look over the ticket and diffs, then type the finish command in chat.
        </p>
      </div>
    </div>
  ) : null;

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

      {requireInputBanner}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_180px]">
        <div>
          <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Your response</label>
          <textarea
            ref={commentRef}
            autoFocus
            className="h-44 w-full resize-none rounded-xl border border-amber-200 bg-white px-4 py-3 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-amber-500/20 dark:bg-black/30"
            value={newComment}
            onChange={(event) => setNewComment(event.target.value)}
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
              disabled={saving || !newComment.trim()}
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

  const readyForMergePrompt = isReadyForMerge && modalTask?.id ? (
    <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm dark:border-amber-500/30 dark:from-amber-900/20 dark:to-[#1a1b23]">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-xl bg-amber-100 p-2 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-600 dark:text-amber-300">Ready for final review</p>
          <h3 className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">Review and finish the ticket</h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">After reviewing the diff and ticket details, tell the agent <span className="font-semibold text-gray-900 dark:text-gray-100">finish {modalTask.id}</span> to create the final commit and close the work.</p>
        </div>
      </div>

      {readyForMergeBanner}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="rounded-xl border border-gray-200 bg-white/80 p-4 text-sm text-gray-600 dark:border-white/10 dark:bg-black/20 dark:text-gray-300">
          <p className="font-semibold text-gray-900 dark:text-gray-100">Suggested command</p>
          <p className="mt-2 rounded-lg bg-gray-100 px-3 py-2 font-mono text-sm text-gray-800 dark:bg-black/30 dark:text-gray-200">finish {modalTask.id}</p>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">This status is configurable in Settings, but the finalization handoff is always driven by the agent command after your review.</p>
        </div>

        <div className="space-y-2 rounded-xl border border-gray-200 bg-white/80 p-4 dark:border-white/10 dark:bg-black/20">
          <button
            onClick={() => {
              void navigator.clipboard.writeText(`finish ${modalTask.id}`);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
          >
            <SendHorizontal className="h-4 w-4" />
            Copy finish command
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
  ) : null;

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center">
      <div
        className="pointer-events-auto absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={isFullView ? undefined : handleCloseAttempt}
      />

      {isFullView ? (
        <div className="pointer-events-auto absolute inset-3 flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
          {saveError && (
            <div className="bg-red-500/10 text-red-600 dark:text-red-400 px-5 py-3 text-sm font-medium border-b border-red-500/20 text-center flex items-center justify-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {saveError}
            </div>
          )}
          <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-5 py-4 dark:border-white/5 dark:bg-black/20">
            <div className="flex min-w-0 items-center gap-4">
              <button
                onClick={handleCloseAttempt}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Board
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{modalTask?.id || 'New Task'}</p>
                  <StatusBadge
                    status={status}
                    colorClass={getStatusColorClass(config, status)}
                    className="text-[10px] font-bold uppercase tracking-[0.16em]"
                  />
                </div>
                <h2 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{title || 'Untitled Task'}</h2>
              </div>
            </div>
            <div className="flex items-center gap-3">
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
              <button onClick={handleCloseAttempt} className="rounded p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 relative" style={{ gridTemplateColumns: `minmax(0,1fr) ${sidebarWidth}px` }}>
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
                     <span className="absolute top-1/2 left-1/2 block aspect-square w-[300px] -translate-x-1/2 -translate-y-1/2 animate-[spin_2s_linear_infinite] bg-[conic-gradient(from_0deg,transparent_0_340deg,rgba(255,255,255,0.8)_360deg)]"></span>
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
                {requireInputBanner && <div className="border-b border-gray-200 p-6 dark:border-white/10">{requireInputBanner}</div>}

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
                  
                  <div className="flex-1 mb-8">{historyList}</div>
                  
                  {(!isPromptStatus) && (
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
                            {commentComposer}
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
              onMouseDown={(e) => {
                e.preventDefault();
                setIsDraggingSidebar(true);
              }}
            />

            <aside className="min-h-0 min-w-0 overflow-y-auto bg-gray-50/80 p-6 dark:bg-black/10" style={{ width: `${sidebarWidth}px`, overflowX: 'hidden' }}>
              <div className="space-y-6 w-full">
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Title</label>
                  <textarea
                    rows={1}
                    className="w-full resize-none overflow-hidden rounded-lg border border-gray-200 bg-white px-3 py-2 text-base font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-black/40"
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      event.target.style.height = 'auto';
                      event.target.style.height = event.target.scrollHeight + 'px';
                    }}
                    placeholder="Task title..."
                  />
                </div>
                {metadataFields}
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
        </div>
      ) : (
        <Rnd
          default={{ x: window.innerWidth / 2 - 400, y: Math.max(30, window.innerHeight * 0.05), width: 800, height: window.innerHeight * 0.9 }}
          minWidth={640}
          minHeight={420}
          bounds="window"
          dragHandleClassName="modal-handle"
          className="pointer-events-auto"
        >
          <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
            {saveError && (
              <div className="bg-red-500/10 text-red-600 dark:text-red-400 px-4 py-2.5 text-sm font-medium border-b border-red-500/20 text-center flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {saveError}
              </div>
            )}
            <div className="modal-handle flex shrink-0 items-center justify-between cursor-move border-b border-gray-100 bg-gray-50 px-4 py-3 dark:border-white/5 dark:bg-black/20">
              <div className="flex flex-col">
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
                <h2 className="leading-none font-semibold text-gray-800 dark:text-gray-200">{title || 'Untitled Task'}</h2>
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
              {isRequireInput ? requireInputPrompt : requireInputBanner}

              <div className={isWideMode ? 'flex items-center gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-white/5 dark:bg-black/10' : 'space-y-3 rounded-xl border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/10'}>
                <div className={isWideMode ? 'mr-4 flex-1' : 'min-w-0'}>
                  <div>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Title</label>
                    <textarea
                      rows={1}
                      className={`w-full resize-none overflow-hidden rounded-lg border border-gray-200 px-3 py-2 font-medium outline-none focus:border-primary dark:border-white/10 ${
                        isWideMode ? 'bg-white text-sm dark:bg-black/40' : 'bg-gray-50 text-[15px] dark:bg-black/20'
                      }`}
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

                <div className={isWideMode ? 'flex items-end gap-4' : 'flex flex-wrap items-end gap-3'}>
                  <div className={isWideMode ? 'w-32' : 'w-36'}>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Status</label>
                    <select
                      className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                    >
                      {allStatuses.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={isWideMode ? 'w-32' : 'w-40'}>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Assignee</label>
                    <select
                      className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                      value={assignee}
                      onChange={(event) => setAssignee(event.target.value)}
                    >
                      <option value="unassigned">Unassigned</option>
                      {allUsers.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={isWideMode ? 'w-40' : 'w-40'}>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Priority</label>
                    <select
                      className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                      value={priority}
                      onChange={(event) => setPriority(event.target.value)}
                    >
                      {availablePriorities.map((item) => (
                        <option key={item.name} value={item.name}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={isWideMode ? 'w-28' : 'w-28'}>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Effort</label>
                    <select
                      className="w-full cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-[#252630]"
                      value={effort}
                      onChange={(event) => setEffort(event.target.value)}
                    >
                      {EFFORT_OPTIONS.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={isWideMode ? 'w-64' : 'min-w-[240px] flex-1'}>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
                    <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={config.tags} />
                  </div>
                </div>
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

              <div className="border-t border-gray-200 pt-4 dark:border-white/10">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-300">
                    <MessageSquare className="h-4 w-4" /> Activity & Comments
                  </h3>
                  {activityFilterTabs}
                </div>
                <div className="mb-4">{historyList}</div>
                {!isPromptStatus && commentComposer}
                {isReadyForMerge && readyForMergePrompt}
              </div>
            </div>
          </div>
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
    </div>
  );
}
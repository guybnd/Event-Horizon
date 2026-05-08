import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task, TaskLiveEvent } from '../types';
import { User, GripVertical, AlertCircle, ChevronUp, ChevronDown, Equal, MessageCircle } from 'lucide-react';
import { useApp } from '../AppContext';
import { updateTask } from '../api';
import { isPromptableStatus, relativeTime } from '../workflow';
import { motion, AnimatePresence } from 'framer-motion';
import { TaskMarkdown } from './TaskMarkdown';
import { ContextMenu } from './ContextMenu';

export function TaskCard({
  task,
  parentTask,
  isOverlay,
  liveEvent,
  travelDirection = 0,
}: {
  task: Task;
  parentTask?: Task;
  isOverlay?: boolean;
  liveEvent?: TaskLiveEvent;
  travelDirection?: -1 | 0 | 1;
}) {
  const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];
  const { openTaskModal, openTaskFullView, config, currentUser, triggerRefresh, readComments, ensureReadStateLoaded, markCommentRead: ctxMarkCommentRead, markAllCommentsRead: ctxMarkAllCommentsRead } = useApp();
  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
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
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const [commentPopoverOpen, setCommentPopoverOpen] = useState(false);
  const [commentPopoverPos, setCommentPopoverPos] = useState({ top: 0, left: 0 });
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [popoverReplyTarget, setPopoverReplyTarget] = useState<string | null>(null);
  const [popoverReplyDraft, setPopoverReplyDraft] = useState('');
  const [popoverReplySaving, setPopoverReplySaving] = useState(false);
  const commentBadgeRef = useRef<HTMLButtonElement | null>(null);
  const commentPopupRef = useRef<HTMLDivElement | null>(null);
  const effortLabel = effortName && effortName !== 'None' ? effortName : null;
  
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: task,
  });

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

  const style: CSSProperties & Record<string, string | number | undefined> = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  if (liveEvent?.kind === 'moved') {
    style['--task-shift-x'] = `${travelDirection * 42}px`;
  }

  const snippet = task.body?.split('\n').find(line => line.trim() && !line.startsWith('#')) || 'No description provided';

  const readCommentIds = new Set(readComments[task.id] ?? []);

  const isPromptStatus = isPromptableStatus(task.status, config);
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
  const unreadComments = comments.filter(c => c.id && !readCommentIds.has(c.id));
  const hasUnread = unreadComments.length > 0;

  const submitPopoverReply = async (parentId: string) => {
    if (!popoverReplyDraft.trim()) return;
    setPopoverReplySaving(true);
    try {
      const replyEntry = {
        type: 'comment' as const,
        user: currentUser,
        date: new Date().toISOString(),
        comment: popoverReplyDraft.trim(),
        replyTo: parentId,
      };
      const newHistory = [...(task.history || []), replyEntry];
      await updateTask(task.id, { history: newHistory, updatedBy: currentUser } as any);
      triggerRefresh();
      setPopoverReplyTarget(null);
      setPopoverReplyDraft('');
    } finally {
      setPopoverReplySaving(false);
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
      await updateTask(task.id, { [field]: nextValue, updatedBy: currentUser } as any);
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
      await updateTask(task.id, { priority: nextPriority, updatedBy: currentUser } as any);
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
      await updateTask(task.id, { effort: nextEffort, updatedBy: currentUser } as any);
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

  const CardContainer = animationsEnabled && !isDragging && !isOverlay ? motion.div : 'div';
  const layoutProps = animationsEnabled && !isDragging && !isOverlay ? { 
    layoutId: `ticket-${task.id}`,
    transition: { type: 'spring' as const, bounce: 0.15, duration: duration + 0.3 } 
  } : {};

  const { isModalOpen, modalTask } = useApp();
  const isThisTaskOpen = isModalOpen && modalTask?.id === task.id;
  const [isAnimatingZ, setIsAnimatingZ] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [popupPos, setPopupPos] = useState({ cardTop: 0, cardHeight: 0, top: 0, left: 'auto' as number | string, right: 'auto' as number | string });
  const hoverTimeout = useRef<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

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
    // Close the description hover popup when the comment popover opens
    setIsHovering(false);
    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
  };

  const markCommentRead = (commentId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    ctxMarkCommentRead(task.id, commentId);
  };

  const handleMouseEnter = (event: any) => {
    if (!config?.hoverPopupsEnabled) return;
    if (isDragging) return;
    if (priorityMenuOpen || effortMenuOpen || assigneeMenuOpen || tagMenuOpen || isEditingTitle || commentPopoverOpen) return;
    
    // Calculate direction before showing
    const currentCard = event.currentTarget.getBoundingClientRect();
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

  const handleMouseLeave = () => {
    if (hoverTimeout.current !== null) {
      window.clearTimeout(hoverTimeout.current);
      hoverTimeout.current = null;
    }
    setIsHovering(false);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeout.current !== null) {
        window.clearTimeout(hoverTimeout.current);
      }
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

  return (
    <CardContainer
      {...layoutProps}
      ref={setNodeRef}
      style={{ ...style, zIndex: isThisTaskOpen || isAnimatingZ ? 60 : undefined }}
      className={`mb-3 group flex flex-col relative ${(priorityMenuOpen || effortMenuOpen || assigneeMenuOpen || tagMenuOpen || isEditingTitle || isHovering) ? 'z-40' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onContextMenu={(e) => {
        if (isOverlay) return;
        e.preventDefault();
        e.stopPropagation();
        setContextMenuPos({ x: e.clientX, y: e.clientY });
        setCommentPopoverOpen(false);
        setIsHovering(false);
      }}
    >
      <motion.div {...contentAnimation} className={`relative flex flex-col rounded-xl border bg-white/80 dark:bg-[#252630]/80 backdrop-blur-md p-0 shadow-sm hover:border-primary/50 hover:shadow-md transition-all ${isOverlay ? 'shadow-2xl rotate-2 scale-105' : ''} ${isPromptStatus ? 'border-amber-300 dark:border-amber-500/40 ring-1 ring-amber-200/50 dark:ring-amber-500/20' : 'border-gray-200/50 dark:border-white/5'} ${liveAnimationClass} ${liveAccentClass} ${hasUnread && !liveAccentClass ? 'ring-2 ring-amber-400/60 dark:ring-amber-500/40' : ''}`}>
        {isPromptStatus && (
          <div className="absolute -top-1.5 -right-1.5 z-10">
            <div className="relative">
              <AlertCircle className="w-5 h-5 text-amber-500 fill-amber-50 dark:fill-amber-950" />
              <div className="absolute inset-0 animate-ping">
                <AlertCircle className="w-5 h-5 text-amber-500 opacity-40" />
              </div>
            </div>
          </div>
        )}
        <div className="flex flex-1">
          <div 
            {...listeners} 
            {...attributes} 
            className="w-8 flex items-center justify-center cursor-grab active:cursor-grabbing border-r border-transparent group-hover:border-gray-100 dark:group-hover:border-white/5 text-gray-300 hover:text-gray-500 transition-colors shrink-0"
          >
            <GripVertical className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

          <div 
            className="flex-1 p-3 pl-2 cursor-pointer flex flex-col"
            onClick={() => {
              if (!isOverlay) {
                openBoardTask(task);
              }
            }}
          >
            <div className="flex flex-col items-start mb-2">
              {isEditingTitle && !isOverlay ? (
                <input
                  ref={titleInputRef}
                  value={titleValue}
                  onChange={(event) => setTitleValue(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => void handleTitleSave()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleTitleSave();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setTitleValue(task.title || '');
                      setIsEditingTitle(false);
                    }
                  }}
                  className="mb-0.5 w-full rounded border border-primary/30 bg-white px-2 py-1 text-sm font-semibold leading-snug text-gray-900 outline-none dark:border-primary/40 dark:bg-[#1f2028] dark:text-gray-100"
                />
              ) : (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!isOverlay) {
                      setIsEditingTitle(true);
                      setPriorityMenuOpen(false);
                      setEffortMenuOpen(false);
                      setAssigneeMenuOpen(false);
                      setTagMenuOpen(false);
                    }
                  }}
                  className="mb-0.5 text-left font-semibold text-gray-900 transition-colors group-hover:text-primary dark:text-gray-100 text-sm leading-snug"
                >
                  {visibleTitle}
                </button>
              )}
              <div className="flex items-center gap-1.5 relative">
                <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 tracking-wider">
                  {task.id}
                </span>
                {parentTask && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openBoardTask(parentTask);
                    }}
                    className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/15"
                  >
                    -&gt; {parentTask.id}
                  </button>
                )}
                {!isOverlay && (
                  <div ref={effortMenuRef} className="relative">
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setEffortMenuOpen((open) => !open);
                        setPriorityMenuOpen(false);
                      }}
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${effortLabel ? 'bg-sky-100 text-sky-700 hover:bg-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/20' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-black/20 dark:text-gray-400 dark:hover:bg-black/30'}`}
                    >
                      <span>{effortLabel || 'Effort'}</span>
                    </button>
                    {effortMenuOpen && (
                      <div
                        className="absolute left-0 top-full z-[90] mt-1 min-w-24 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {EFFORT_OPTIONS.map((option) => (
                          <button
                            key={option}
                            onClick={() => handleEffortChange(option)}
                            className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div ref={priorityMenuRef} className="relative">
                {!isOverlay && config?.priorities?.length ? (
                  <>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        setPriorityMenuOpen(open => !open);
                        setEffortMenuOpen(false);
                      }}
                      className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 transition-colors hover:bg-gray-200 dark:bg-black/20 dark:text-gray-300 dark:hover:bg-black/30"
                    >
                      {getPriorityIcon(priorityName)}
                      <span>{priorityName}</span>
                    </button>
                    {priorityMenuOpen && (
                      <div
                        className="absolute left-0 top-full z-[90] mt-1 min-w-32 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {config.priorities.map(priority => (
                          <button
                            key={priority.name}
                            onClick={() => handlePriorityChange(priority.name)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                          >
                            {getPriorityIcon(priority.name)}
                            <span>{priority.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  getPriorityIcon(priorityName)
                )}
                </div>
              </div>
            </div>
            
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-3 line-clamp-2">
              {snippet}
            </p>

            <div className="flex flex-wrap items-center justify-between gap-2 mt-auto">
              <div ref={tagMenuRef} className="relative flex flex-wrap gap-1.5">
                {!isOverlay && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setTagMenuOpen((open) => !open);
                      setPriorityMenuOpen(false);
                      setEffortMenuOpen(false);
                      setAssigneeMenuOpen(false);
                    }}
                    className="rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 transition-colors hover:border-primary hover:text-primary dark:border-white/15 dark:text-gray-400"
                  >
                    {tagNames.length ? 'Edit tags' : 'Add tags'}
                  </button>
                )}
                {tagNames.map(tag => (
                  <button
                    key={tag}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!isOverlay) {
                        setTagMenuOpen(true);
                        setPriorityMenuOpen(false);
                        setEffortMenuOpen(false);
                        setAssigneeMenuOpen(false);
                      }
                    }}
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getTagColor(tag)}`}
                  >
                    {tag}
                  </button>
                ))}
                {tagMenuOpen && !isOverlay && (
                  <div
                    className="absolute left-0 top-full z-[90] mt-1 min-w-40 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {allTags.length ? allTags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => void handleTagToggle(tag)}
                        className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs ${tagNames.includes(tag) ? 'bg-gray-100 text-gray-900 dark:bg-white/10 dark:text-white' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5'}`}
                      >
                        <span>{tag}</span>
                        <span>{tagNames.includes(tag) ? 'On' : 'Off'}</span>
                      </button>
                    )) : (
                      <div className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">No tags configured</div>
                    )}
                  </div>
                )}
              </div>
              {!isOverlay && (
                <button
                  ref={comments.length > 0 ? commentBadgeRef : undefined}
                  onClick={comments.length > 0
                    ? openCommentPopover
                    : (e) => { e.stopPropagation(); openTaskModal(task); }
                  }
                  title={comments.length > 0 ? `${comments.length} comment${comments.length === 1 ? '' : 's'}` : 'Add a comment'}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold transition-all duration-150 hover:scale-105 active:scale-95 ${
                    comments.length === 0
                      ? 'bg-gray-100/60 text-gray-400 hover:bg-primary/10 hover:text-primary dark:bg-white/5 dark:text-gray-600 dark:hover:bg-primary/15 dark:hover:text-primary'
                      : hasUnread
                        ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 hover:shadow-sm dark:bg-amber-500/15 dark:text-amber-300 dark:hover:bg-amber-500/25'
                        : 'bg-gray-100 text-gray-500 hover:bg-primary/10 hover:text-primary hover:shadow-sm dark:bg-black/20 dark:text-gray-400 dark:hover:bg-primary/15 dark:hover:text-primary'
                  }`}
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  {comments.length > 0 && <span>{comments.length}</span>}
                  {hasUnread && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
                </button>
              )}
              <div ref={assigneeMenuRef} className="relative ml-auto">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!isOverlay) {
                      setAssigneeMenuOpen((open) => !open);
                      setPriorityMenuOpen(false);
                      setEffortMenuOpen(false);
                      setTagMenuOpen(false);
                    }
                  }}
                  className="flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-black/20 dark:text-gray-400"
                >
                  <User className="w-3 h-3" />
                  <span className="font-medium text-[10px]">{visibleAssignee === 'unassigned' ? 'Unassigned' : visibleAssignee}</span>
                </button>
                {assigneeMenuOpen && !isOverlay && (
                  <div
                    className="absolute right-0 top-full z-[90] mt-1 min-w-32 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-[#252630]"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      onClick={() => void handleAssigneeChange('unassigned')}
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                    >
                      Unassigned
                    </button>
                    {allUsers.map((user) => (
                      <button
                        key={user}
                        onClick={() => void handleAssigneeChange(user)}
                        className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-white/5"
                      >
                        {user}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {createPortal(
        <AnimatePresence>
          {commentPopoverOpen && !isOverlay && (
            <motion.div
              ref={commentPopupRef}
              key={`comments-popup-${task.id}`}
              initial={{ opacity: 0, y: 4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.12 }}
              style={{
                position: 'fixed',
                top: Math.min(commentPopoverPos.top, window.innerHeight - 480),
                left: Math.min(commentPopoverPos.left, window.innerWidth - 420),
                zIndex: 999999,
              }}
              className="w-[420px] max-h-[480px] overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-600 [&::-webkit-scrollbar-track]:bg-transparent"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 bg-white/95 dark:bg-[#1a1b23]/95 px-3 py-2 border-b border-gray-100 dark:border-white/5 backdrop-blur-xl flex items-center justify-between">
                <span className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  Comments ({comments.length}){unreadComments.length > 0 ? ` · ${unreadComments.length} unread` : ''}
                </span>
                {unreadComments.length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      ctxMarkAllCommentsRead(task.id, comments.filter(c => c.id).map(c => c.id!));
                    }}
                    className="text-[10px] font-semibold text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              <div className="divide-y divide-gray-100 dark:divide-white/5">
                {topLevelComments.map((c, i) => {
                  const isUnreadItem = !!(c.id && !readCommentIds.has(c.id));
                  const replies = c.id ? (repliesByParentId.get(c.id) ?? []) : [];
                  const isReplying = popoverReplyTarget === (c.id ?? null);
                  return (
                    <div key={c.id || i} className="p-3">
                      {/* top-level comment */}
                      <div
                        onClick={isUnreadItem && c.id ? (e) => markCommentRead(c.id!, e) : undefined}
                        className={`rounded-lg p-2.5 transition-colors ${isUnreadItem ? 'bg-amber-50/60 dark:bg-amber-500/5 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-500/10' : 'bg-gray-50/60 dark:bg-white/3'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-semibold text-gray-700 dark:text-gray-300">{c.user}</span>
                          <span className="text-[10px] text-gray-400 dark:text-gray-500">{relativeTime(c.date)}</span>
                          {isUnreadItem && (
                            <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-500 dark:text-amber-400">
                              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-amber-400" />
                              click to mark read
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">{c.comment}</p>
                        {c.id && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setPopoverReplyTarget(isReplying ? null : c.id!); setPopoverReplyDraft(''); }}
                            className="mt-1.5 text-[10px] font-semibold text-primary hover:text-primary/80 transition-colors"
                          >
                            {isReplying ? 'Cancel' : 'Reply'}
                          </button>
                        )}
                      </div>
                      {/* inline reply box */}
                      {isReplying && (
                        <div className="mt-2 ml-4 border-l-2 border-primary/20 pl-3">
                          <textarea
                            autoFocus
                            value={popoverReplyDraft}
                            onChange={(e) => setPopoverReplyDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitPopoverReply(c.id!);
                              if (e.key === 'Escape') { setPopoverReplyTarget(null); setPopoverReplyDraft(''); }
                            }}
                            placeholder="Write a reply… (Ctrl+Enter to send)"
                            className="w-full resize-none rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-primary dark:border-white/10 dark:bg-black/20 dark:text-gray-200"
                            rows={3}
                          />
                          <div className="mt-1.5 flex justify-end gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); setPopoverReplyTarget(null); setPopoverReplyDraft(''); }}
                              className="rounded-md px-2 py-1 text-[10px] font-semibold text-gray-500 hover:bg-gray-100 dark:hover:bg-white/10"
                            >Cancel</button>
                            <button
                              disabled={!popoverReplyDraft.trim() || popoverReplySaving}
                              onClick={(e) => { e.stopPropagation(); void submitPopoverReply(c.id!); }}
                              className="rounded-md bg-primary px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
                            >{popoverReplySaving ? 'Sending…' : 'Send'}</button>
                          </div>
                        </div>
                      )}
                      {/* threaded replies */}
                      {replies.length > 0 && (
                        <div className="mt-2 ml-4 space-y-1.5 border-l-2 border-gray-200/70 dark:border-white/10 pl-3">
                          {replies.map((r, ri) => {
                            const isUnreadReply = !!(r.id && !readCommentIds.has(r.id));
                            return (
                              <div
                                key={r.id || ri}
                                onClick={isUnreadReply && r.id ? (e) => markCommentRead(r.id!, e) : undefined}
                                className={`rounded-md p-2 transition-colors ${isUnreadReply ? 'bg-amber-50/60 dark:bg-amber-500/5 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-500/10' : ''}`}
                              >
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-[10px] font-semibold text-gray-700 dark:text-gray-300">{r.user}</span>
                                  <span className="text-[10px] text-gray-400 dark:text-gray-500">{relativeTime(r.date)}</span>
                                  {isUnreadReply && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-400" />}
                                </div>
                                <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">{r.comment}</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {createPortal(
        <AnimatePresence>
          {isHovering && !isOverlay && !isThisTaskOpen && task.body?.trim() && (
            <motion.div
              ref={popupRef}
              key={`popup-${task.id}`}
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              style={{ 
                position: 'fixed',
                top: popupPos.top,
                left: popupPos.left !== 'auto' ? popupPos.left : undefined,
                right: popupPos.right !== 'auto' ? popupPos.right : undefined,
                zIndex: 999999
              }}
              className={`w-[640px] max-h-[85vh] overflow-y-auto rounded-xl border border-gray-200/80 bg-white/95 p-6 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#1a1b23]/95 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300 dark:[&::-webkit-scrollbar-thumb]:bg-gray-600 [&::-webkit-scrollbar-track]:bg-transparent`}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => setIsHovering(true)}
              onMouseLeave={handleMouseLeave}
            >
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <TaskMarkdown body={task.body} taskId={task.id} compact />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {contextMenuPos && !isOverlay && (
        <ContextMenu
          task={task}
          position={contextMenuPos}
          onClose={() => setContextMenuPos(null)}
        />
      )}
    </CardContainer>
  );
}

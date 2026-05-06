import { useEffect, useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '../types';
import { User, GripVertical, AlertCircle, ChevronUp, ChevronDown, Equal } from 'lucide-react';
import { useApp } from '../AppContext';
import { updateTask } from '../api';
import { isPromptableStatus } from '../workflow';

export function TaskCard({ task, parentTask, isOverlay }: { task: Task, parentTask?: Task, isOverlay?: boolean }) {
  const EFFORT_OPTIONS = ['None', 'XS', 'S', 'M', 'L', 'XL'];
  const { openTaskModal, config, currentUser, triggerRefresh } = useApp();
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
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [priorityMenuOpen, effortMenuOpen, assigneeMenuOpen, tagMenuOpen, task.title]);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  const snippet = task.body?.split('\n').find(line => line.trim() && !line.startsWith('#')) || 'No description provided';

  const isPromptStatus = isPromptableStatus(task.status, config);

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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white/80 dark:bg-[#252630]/80 backdrop-blur-md p-0 rounded-xl shadow-sm border hover:border-primary/50 hover:shadow-md transition-all mb-3 group flex flex-col relative ${(priorityMenuOpen || effortMenuOpen || assigneeMenuOpen || tagMenuOpen || isEditingTitle) ? 'z-40' : ''} ${isOverlay ? 'shadow-2xl rotate-2 scale-105' : ''} ${isPromptStatus ? 'border-amber-300 dark:border-amber-500/40 ring-1 ring-amber-200/50 dark:ring-amber-500/20' : 'border-gray-200/50 dark:border-white/5'}`}
    >
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
          onClick={() => openTaskModal(task)}
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
                    openTaskModal(parentTask);
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
    </div>
  );
}

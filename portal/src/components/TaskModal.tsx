import { useEffect, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bold,
  ChevronDown,
  ChevronUp,
  Code,
  Equal,
  Eye,
  Link as LinkIcon,
  List,
  Maximize2,
  MessageSquare,
  PanelRight,
  Pencil,
  Save,
  SendHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../AppContext';
import { createTask, deleteTask, updateTask } from '../api';
import type { Config, TagDef } from '../types';

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

function MarkdownPreview({ body }: { body: string }) {
  return (
    <div className="max-w-none text-sm leading-7 text-gray-700 dark:text-gray-300">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-4 text-3xl font-bold text-gray-900 dark:text-gray-100">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-8 text-2xl font-semibold text-gray-900 dark:text-gray-100">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-6 text-xl font-semibold text-gray-900 dark:text-gray-100">{children}</h3>,
          p: ({ children }) => <p className="mb-4 whitespace-pre-wrap">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 list-disc space-y-1 pl-6">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 list-decimal space-y-1 pl-6">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          a: ({ children, href }) => (
            <a className="text-primary underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return <code className="block overflow-x-auto rounded-lg bg-black/90 p-4 text-sm text-gray-100">{children}</code>;
            }
            return <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800 dark:bg-black/30 dark:text-gray-100">{children}</code>;
          },
          pre: ({ children }) => <pre className="mb-4 overflow-x-auto rounded-lg bg-black/90">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="mb-4 border-l-4 border-primary/40 pl-4 italic text-gray-600 dark:text-gray-400">
              {children}
            </blockquote>
          ),
          table: ({ children }) => <table className="mb-4 w-full border-collapse overflow-hidden rounded-lg">{children}</table>,
          thead: ({ children }) => <thead className="bg-gray-100 dark:bg-white/5">{children}</thead>,
          th: ({ children }) => <th className="border border-gray-200 px-3 py-2 text-left dark:border-white/10">{children}</th>,
          td: ({ children }) => <td className="border border-gray-200 px-3 py-2 dark:border-white/10">{children}</td>,
        }}
      >
        {body || 'No description yet.'}
      </ReactMarkdown>
    </div>
  );
}

export function TaskModal() {
  const {
    isModalOpen,
    closeModal,
    modalTask,
    setModalTask,
    currentProject,
    currentUser,
    triggerRefresh,
    config,
  } = useApp();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('Todo');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<string>('None');
  const [saving, setSaving] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isWideMode, setIsWideMode] = useState(false);
  const [isFullView, setIsFullView] = useState(false);
  const [isEditingDescription, setIsEditingDescription] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (modalTask) {
      setTitle(modalTask.title || '');
      setBody(modalTask.body || '');
      setStatus(modalTask.status || 'Todo');
      setAssignee(modalTask.assignee || 'unassigned');
      setTags(modalTask.tags || []);
      setPriority(modalTask.priority || 'None');
      setNewComment('');
      setConfirmDiscard(false);
      setConfirmDelete(false);
      setIsWideMode(false);
      setIsFullView(new URLSearchParams(window.location.search).get('view') === 'full');
      setIsEditingDescription(false);
    }
  }, [modalTask]);

  useEffect(() => {
    if (!isModalOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isFullView) {
        setIsFullView(false);
        return;
      }
      handleCloseAttempt();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

  if (!isModalOpen || !config) return null;

  const allStatuses = [...config.columns, ...config.hiddenStatuses].map((item) => item.name);
  const allUsers = config.users.map((item) => item.name);
  const allTags = config.tags.map((item) => item.name);
  const availablePriorities = config.priorities.length > 0 ? config.priorities : [{ name: 'None', icon: 'Equal', color: 'text-gray-400' }];

  const isRequireInput = status === 'Require Input';
  const lastComment = modalTask?.history?.slice().reverse().find((entry) => entry.type === 'comment');
  const createdAt = modalTask?.history?.[0]?.date;
  const updatedAt = modalTask?.history?.[modalTask.history.length - 1]?.date;

  const originalPayload = JSON.stringify({
    title: modalTask?.title || '',
    body: modalTask?.body || '',
    status: modalTask?.status || 'Todo',
    assignee: modalTask?.assignee || 'unassigned',
    tags: modalTask?.tags || [],
    priority: modalTask?.priority || 'None',
  });

  const currentPayload = JSON.stringify({ title, body, status, assignee, tags, priority });
  const isDirty = originalPayload !== currentPayload || newComment.trim() !== '';

  const handleCloseAttempt = () => {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    closeModal();
  };

  const handleSave = async (customHistory?: any[], keepOpen = false) => {
    setSaving(true);
    const payload = { title, body, status, assignee, tags, priority, order: modalTask?.order };
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
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!modalTask?.id) return;
    setSaving(true);
    try {
      await deleteTask(modalTask.id);
      triggerRefresh();
      closeModal();
    } catch (error) {
      console.error(error);
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

  const insertMarkdown = (prefix: string, suffix = '') => {
    if (!textareaRef.current) return;
    const start = textareaRef.current.selectionStart;
    const end = textareaRef.current.selectionEnd;
    const selectedText = body.substring(start, end);

    const nextBody = body.substring(0, start) + prefix + selectedText + suffix + body.substring(end);
    setBody(nextBody);

    setTimeout(() => {
      if (!textareaRef.current) return;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(start + prefix.length, end + prefix.length);
    }, 0);
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
        <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
        <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={config.tags} />
      </div>
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

  const editorToolbar = (
    <div className="flex items-center gap-1 border-b border-gray-200 bg-gray-100/50 p-2 dark:border-white/10 dark:bg-white/5">
      <button onClick={() => insertMarkdown('**', '**')} title="Bold" className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"><Bold className="h-4 w-4" /></button>
      <button onClick={() => insertMarkdown('*', '*')} title="Italic" className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"><Pencil className="h-4 w-4" /></button>
      <button onClick={() => insertMarkdown('- ')} title="Bullet List" className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"><List className="h-4 w-4" /></button>
      <button onClick={() => insertMarkdown('`', '`')} title="Code" className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"><Code className="h-4 w-4" /></button>
      <button onClick={() => insertMarkdown('[', '](url)')} title="Link" className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"><LinkIcon className="h-4 w-4" /></button>
    </div>
  );

  const descriptionEditor = (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-black/20">
      {editorToolbar}
      <textarea
        ref={textareaRef}
        className="w-full flex-1 resize-none bg-transparent px-4 py-3 font-mono text-sm leading-relaxed outline-none"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Markdown supported..."
      />
    </div>
  );

  const historyList = (
    <div className="space-y-4">
      {!modalTask?.history || modalTask.history.length === 0 ? (
        <p className="text-sm italic text-gray-500">No activity yet.</p>
      ) : (
        [...modalTask.history].reverse().map((entry, index) => (
          <div key={`${entry.date}-${index}`} className="flex gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
              {entry.type === 'status_change' ? (
                <ArrowRight className="h-3 w-3 text-primary" />
              ) : (
                <MessageSquare className="h-3 w-3 text-primary" />
              )}
            </div>
            <div className="flex-1 rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-white/5 dark:bg-black/20">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">{entry.user}</span>
                <span className="text-[10px] text-gray-500">{new Date(entry.date).toLocaleString()}</span>
              </div>
              {entry.type === 'status_change' && (
                <div className="mb-1.5 flex items-center gap-2 text-xs text-gray-500">
                  Moved from <span className="font-semibold text-gray-700 dark:text-gray-300">{entry.from}</span>
                  <ArrowRight className="h-3 w-3" />
                  <span className="font-semibold text-gray-700 dark:text-gray-300">{entry.to}</span>
                </div>
              )}
              {entry.comment && <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">{entry.comment}</p>}
            </div>
          </div>
        ))
      )}
    </div>
  );

  const commentComposer = (
    <div className="relative">
      <textarea
        ref={commentRef}
        autoFocus={isRequireInput}
        className="h-28 w-full resize-none rounded-xl border border-gray-200 bg-white px-4 py-3 pb-12 text-sm outline-none placeholder:text-gray-400 focus:border-primary dark:border-white/10 dark:bg-black/40"
        value={newComment}
        onChange={(event) => setNewComment(event.target.value)}
        placeholder={isRequireInput ? 'Type your response...' : 'Add a comment...'}
      />
      <div className="absolute bottom-3 right-3 flex items-center">
        <button
          disabled={saving || !newComment.trim() || !modalTask?.id}
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

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="pointer-events-auto absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={isFullView ? undefined : handleCloseAttempt}
      />

      {isFullView ? (
        <div className="pointer-events-auto fixed inset-3 flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#1a1b23]">
          <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-5 py-4 dark:border-white/5 dark:bg-black/20">
            <div className="flex min-w-0 items-center gap-4">
              <button
                onClick={() => setIsFullView(false)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Board
              </button>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{modalTask?.id || 'New Task'}</p>
                <h2 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{title || 'Untitled Task'}</h2>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsEditingDescription((current) => !current)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
              >
                {isEditingDescription ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                {isEditingDescription ? 'Preview' : 'Edit'}
              </button>
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

          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-h-0 border-r border-gray-200 dark:border-white/10">
              <div className="flex h-full min-h-0 flex-col">
                {requireInputBanner && <div className="border-b border-gray-200 p-6 dark:border-white/10">{requireInputBanner}</div>}

                <div className="min-h-0 flex-[3] border-b border-gray-200 dark:border-white/10">
                  <div className="flex items-center justify-between px-6 py-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Description</p>
                      <p className="text-sm text-gray-500">Rendered markdown by default, editable in place.</p>
                    </div>
                    <button
                      onClick={() => setIsEditingDescription((current) => !current)}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white"
                    >
                      {isEditingDescription ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                      {isEditingDescription ? 'Preview' : 'Edit Description'}
                    </button>
                  </div>
                  <div className="h-[calc(100%-72px)] overflow-y-auto px-6 pb-6">
                    {isEditingDescription ? descriptionEditor : <MarkdownPreview body={body} />}
                  </div>
                </div>

                <div className="min-h-0 flex-[2] flex-col">
                  <div className="border-b border-gray-200 px-6 py-4 dark:border-white/10">
                    <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Activity & Comments</p>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{historyList}</div>
                  <div className="border-t border-gray-200 px-6 py-4 dark:border-white/10">{commentComposer}</div>
                </div>
              </div>
            </div>

            <aside className="min-h-0 overflow-y-auto bg-gray-50/80 p-6 dark:bg-black/10">
              <div className="space-y-6">
                <div>
                  <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Title</label>
                  <input
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base font-medium outline-none focus:border-primary dark:border-white/10 dark:bg-black/40"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Task title..."
                  />
                </div>
                {metadataFields}
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
            <div className="modal-handle flex shrink-0 items-center justify-between cursor-move border-b border-gray-100 bg-gray-50 px-5 py-4 dark:border-white/5 dark:bg-black/20">
              <div className="flex flex-col">
                <span className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  {modalTask?.id ? modalTask.id : 'New Task'}{' '}
                  {isDirty && <span className="ml-1 lowercase italic normal-case text-amber-500">(Unsaved changes)</span>}
                </span>
                <h2 className="leading-none font-semibold text-gray-800 dark:text-gray-200">{title || 'Untitled Task'}</h2>
              </div>
              <div className="flex items-center gap-3">
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

            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 text-sm text-gray-800 dark:text-gray-200">
              {requireInputBanner}

              <div className={isWideMode ? 'flex items-center gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-white/5 dark:bg-black/10' : 'grid grid-cols-3 gap-6'}>
                <div className={isWideMode ? 'mr-4 flex-1' : 'col-span-2 flex flex-col space-y-4'}>
                  <div>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Title</label>
                    <input
                      className={`w-full rounded-lg border border-gray-200 px-3 py-2 font-medium outline-none focus:border-primary dark:border-white/10 ${
                        isWideMode ? 'bg-white text-sm dark:bg-black/40' : 'bg-gray-50 text-base dark:bg-black/20'
                      }`}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="Task title..."
                    />
                  </div>
                </div>

                <div className={isWideMode ? 'flex items-end gap-4' : 'col-span-1 h-fit space-y-5 rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-white/5 dark:bg-black/10'}>
                  <div className={isWideMode ? 'w-32' : ''}>
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

                  <div className={isWideMode ? 'w-32' : ''}>
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

                  <div className={isWideMode ? 'w-40' : ''}>
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

                  <div className={isWideMode ? 'w-64' : ''}>
                    <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Tags</label>
                    <TagSelector tags={tags} onChange={setTags} availableTags={allTags} configTags={config.tags} />
                  </div>
                </div>
              </div>

              <div className="flex min-h-[300px] flex-1 flex-col">
                <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-gray-400">Description</label>
                {descriptionEditor}
              </div>

              <div className="mt-2 border-t border-gray-200 pt-6 dark:border-white/10">
                <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-300">
                  <MessageSquare className="h-4 w-4" /> Activity & Comments
                </h3>
                <div className="mb-6">{historyList}</div>
                {commentComposer}
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
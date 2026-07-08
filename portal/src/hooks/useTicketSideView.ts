import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppSelector, useAppActions } from '../store/useAppSelector';
import { fetchTask, updateTask } from '../api';
import { isAgentSession, normalizeSubtaskId } from '../types';
import type { HistoryEntry, HistoryEntryDraft, InlineSubtask, Task } from '../types';
import { getRequireInputStatus } from '../workflow';
import { useTaskForm } from './useTaskForm';
import { useImageAttachment } from './useImageAttachment';
import type { CommentBoxHandle } from '../components/task-modal/CommentBox';

type ActivityFilter = 'all' | 'decisions' | 'sessions';

/**
 * FLUX-734: a compact, task-scoped controller for the chat-window ticket sideview.
 *
 * Deliberately a *separate, smaller sibling* of `useTaskModalController` rather than a refactor
 * of it: the modal controller is a singleton bound to the global `modalTask` and carries a lot of
 * surface the sideview doesn't need (URL sync, dialogs, full-view toggle, CLI-session launch,
 * orchestration launcher). Re-implementing the slice the sideview needs in an isolated hook means
 * the existing modal can't regress, at the cost of some intentional duplication. Extracting a
 * shared core that both consume — and retiring the legacy modal — is the documented follow-up.
 *
 * Persistence reuses the SAME `updateTask` API the modal's `handleSave` uses (no forked write
 * path); comments here are pure history appends (ticket annotations), distinct from the sibling
 * chat window, which is the surface for talking to the agent.
 */
export function useTicketSideView(task: Task) {
  const { triggerRefresh, ensureReadStateLoaded, openTaskModal, markCommentRead, markAllCommentsRead } = useAppActions();
  const currentUser = useAppSelector((s) => s.currentUser);
  const config = useAppSelector((s) => s.config);
  const allTasks = useAppSelector((s) => s.tasks) as Task[];
  const readComments = useAppSelector((s) => s.readComments);
  const refreshTrigger = useAppSelector((s) => s.refreshTrigger);

  // The dock hands us the board's (possibly history-digested) task; fetch the full ticket so the
  // activity log / subtasks are complete, and re-fetch whenever the app signals a refresh.
  const [fullTask, setFullTask] = useState<Task>(task);
  useEffect(() => {
    setFullTask(task);
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps -- identity-keyed reset; field churn is reconciled by the fetch below.

  useEffect(() => {
    let cancelled = false;
    fetchTask(task.id)
      .then((t) => { if (!cancelled) setFullTask(t); })
      .catch(() => { /* keep the board copy on transient failure */ });
    return () => { cancelled = true; };
  }, [task.id, refreshTrigger]);

  useEffect(() => {
    ensureReadStateLoaded(task.id);
  }, [task.id, ensureReadStateLoaded]);

  const form = useTaskForm(fullTask);

  // FLUX-744: keep the panel live without a reopen. The dock passes the store's copy of this task
  // (`task`), which the app re-fetches on every `taskUpdated` SSE (via loadTasks) — but `fullTask`
  // above only re-fetched on an explicit `refreshTrigger`, so an external status/metadata change
  // (an agent move, a board edit) didn't surface here until the ticket was reopened. Reconcile the
  // live metadata into `fullTask` with NO network round-trip (the store already fetched it — this is
  // the performance-safe path) and preserve the richer fetched history/subtasks (the task-list
  // payload is history-digested, which is why we full-fetch above). Guards:
  //   • A `lastLiveMetaRef` signature gate means we only act on a genuine change — and never re-apply
  //     a stale `task` right after a local save (which sets `fullTask` before loadTasks catches up),
  //     so the bar never flickers back to pre-save values.
  //   • Skipped while the form is dirty/saving so an in-progress edit is never clobbered.
  const liveMetaSig = [
    task.status, task.priority, task.assignee, task.effort, task.effortLevel,
    task.title, task.implementationLink, task.parentId, (task.tags || []).join(','),
    // FLUX-924: include the artifacts pointer so an artifact-only publish (which changes no
    // metadata field above) still triggers this reconcile — otherwise the side panel misses a
    // freshly published artifact until the chat window is minimized/reopened.
    task.artifacts?.latest ?? 0, task.artifacts?.revisions?.length ?? 0,
    // FLUX-963: include the description body so an external `update_ticket` body change surfaces
    // live too — every other field already did, `body` was the one gap. The raw string is already
    // in memory (the list endpoint returns it), so this costs no round-trip.
    task.body ?? '',
  ].join('|');
  const lastLiveMetaRef = useRef(liveMetaSig);
  useEffect(() => {
    if (lastLiveMetaRef.current === liveMetaSig) return;
    if (form.isDirty || form.saving) return;
    lastLiveMetaRef.current = liveMetaSig;
    setFullTask((prev) => {
      if (prev.id !== task.id) return prev;
      const sameTags = (prev.tags ?? []).length === (task.tags ?? []).length
        && (prev.tags ?? []).every((t, i) => t === (task.tags ?? [])[i]);
      // FLUX-924: artifacts is append-only and `latest` increments on every publish, so the two
      // scalars (latest pointer + revision count) detect any publish without walking the array.
      const sameArtifacts = (prev.artifacts?.latest ?? 0) === (task.artifacts?.latest ?? 0)
        && (prev.artifacts?.revisions?.length ?? 0) === (task.artifacts?.revisions?.length ?? 0);
      if (
        (prev.title ?? '') === (task.title ?? '')
        && prev.status === task.status
        && (prev.assignee ?? '') === (task.assignee ?? '')
        && (prev.priority ?? '') === (task.priority ?? '')
        && (prev.effort ?? '') === (task.effort ?? '')
        && (prev.effortLevel ?? '') === (task.effortLevel ?? '')
        && (prev.implementationLink ?? '') === (task.implementationLink ?? '')
        && (prev.parentId ?? '') === (task.parentId ?? '')
        && sameTags
        && sameArtifacts
        && (prev.body ?? '') === (task.body ?? '')
      ) return prev;
      return {
        ...prev,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        tags: task.tags,
        priority: task.priority,
        effort: task.effort,
        effortLevel: task.effortLevel,
        implementationLink: task.implementationLink,
        parentId: task.parentId,
        artifacts: task.artifacts,
        body: task.body,
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the live metadata signature; `task` fields are read inside via that snapshot.
  }, [liveMetaSig, form.isDirty, form.saving]);

  const commentBoxRef = useRef<CommentBoxHandle>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);

  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [replyTargetId, setReplyTargetId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [collapsedThreads, setCollapsedThreads] = useState<Record<string, boolean>>({});
  const [commentAssetError, setCommentAssetError] = useState('');
  const [replyAssetError, setReplyAssetError] = useState('');
  const [isUploadingCommentAsset, setIsUploadingCommentAsset] = useState(false);
  const [isUploadingReplyAsset, setIsUploadingReplyAsset] = useState(false);

  // Reset per-ticket transient UI when the bound ticket changes.
  useEffect(() => {
    commentBoxRef.current?.reset();
    setReplyTargetId(null);
    setReplyDraft('');
    setCollapsedThreads({});
    setCommentAssetError('');
    setReplyAssetError('');
  }, [task.id]);

  const {
    handleCommentPaste, handleCommentDragOver, handleCommentDrop,
    handleReplyPaste, handleReplyDragOver, handleReplyDrop,
  } = useImageAttachment({
    taskId: fullTask.id,
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

  // ── Derived config lists (mirror the modal controller) ────────────────────────────────────
  const allStatuses = config ? [...config.columns, ...config.hiddenStatuses].map((item) => item.name) : [];
  const allUsers = config?.users.map((item) => item.name) || [];
  const allTags = config?.tags.map((item) => item.name) || [];
  const availablePriorities = config && config.priorities.length > 0
    ? config.priorities
    : [{ name: 'None', icon: 'Equal', color: 'text-gray-400' }];
  const requireInputStatus = getRequireInputStatus(config);
  const isRequireInput = form.status === requireInputStatus || fullTask.swimlane === 'require-input';

  const createdAt = fullTask.history?.[0]?.date;
  const updatedAt = fullTask.history?.[fullTask.history.length - 1]?.date;

  // ── Activity grouping (threaded replies + filter), same shape HistoryList expects ─────────
  const { topLevelEntries, repliesByParent } = useMemo(() => {
    const history = fullTask.history || [];
    const filtered = activityFilter === 'decisions'
      ? history.filter((e) => e.type === 'comment' || e.type === 'status_change' || (isAgentSession(e) && e.outcome))
      : activityFilter === 'sessions'
        ? history.filter((e) => isAgentSession(e))
        : history;
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
    return { topLevelEntries: topLevel, repliesByParent: replies };
  }, [fullTask.history, activityFilter]);

  // ── Subtask derivations ───────────────────────────────────────────────────────────────────
  const inlineSubtaskMap = useMemo(() => {
    const map = new Map<string, InlineSubtask>();
    (fullTask.subtasks || []).forEach((entry) => {
      if (typeof entry !== 'string' && entry.id) map.set(entry.id, entry);
    });
    return map;
  }, [fullTask.subtasks]);
  const linkedSubtasks = form.subtasks
    .map((id) => allTasks.find((t) => t.id === id))
    .filter((t): t is Task => Boolean(t));
  const danglingSubtaskIds = form.subtasks.filter((id) => !linkedSubtasks.some((t) => t.id === id));
  const parentTask = form.parentId ? allTasks.find((t) => t.id === form.parentId) ?? null : null;

  // ── Read state ──────────────────────────────────────────────────────────────────────────
  const readCommentIds = new Set(readComments[fullTask.id ?? ''] ?? []);
  const unreadCommentCount = (fullTask.history || []).filter(
    (e) => e.type === 'comment' && e.id && !readCommentIds.has(e.id) && e.user !== currentUser,
  ).length;

  // ── Persistence (same updateTask write path as the modal) ─────────────────────────────────
  // FLUX-1303: accepts `appendHistory` deltas (preferred over rebuilding a full `history` array)
  // and returns the updated task, or null on failure, so callers like PlanApprovalPanel can tell a
  // failed save apart from success instead of closing over a swallowed error. FLUX-1308: the engine
  // now reconciles a submitted full `history` array by entry identity (not array length), so a
  // stale snapshot no longer silently drops entries either way — appendHistory remains preferred
  // since it never depends on a snapshot at all.
  const persist = useCallback(async (updates: Partial<Task> & { appendHistory?: HistoryEntryDraft[] }): Promise<Task | null> => {
    if (!fullTask.id) return null;
    form.setSaving(true);
    form.setSaveError(null);
    try {
      const updated = await updateTask(fullTask.id, { ...updates, updatedBy: currentUser });
      setFullTask(updated);
      triggerRefresh();
      return updated;
    } catch (error) {
      form.setSaveError(error instanceof Error ? error.message : 'Failed to save. Is the engine running?');
      return null;
    } finally {
      form.setSaving(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullTask.id, fullTask.history, currentUser, triggerRefresh]);

  /** Persist the editable form (title/body/metadata), folding in a status_change entry and any
   *  pending comment text — mirrors the modal's `handleSave`. */
  const save = useCallback(async () => {
    if (!fullTask.id) return;
    const now = new Date().toISOString();
    const pendingComment = commentBoxRef.current?.getValue()?.trim() ?? '';
    const historyUpdates: HistoryEntry[] = [];
    if (pendingComment) {
      historyUpdates.push({ type: 'comment', user: currentUser, date: now, comment: pendingComment });
      commentBoxRef.current?.reset();
    }
    if (fullTask.status && fullTask.status !== form.status) {
      historyUpdates.push({
        type: 'status_change',
        from: fullTask.status,
        to: form.status,
        user: currentUser,
        date: now,
        comment: pendingComment ? 'Included with comment' : undefined,
      });
    }
    await persist({
      title: form.title,
      body: form.body,
      status: form.status,
      assignee: form.assignee,
      tags: form.tags,
      priority: form.priority,
      effort: form.effort,
      effortLevel: form.effortLevel || undefined,
      implementationLink: form.implementationLink.trim(),
      subtasks: form.subtasks,
      parentId: form.parentId || undefined,
      order: fullTask.order,
      appendHistory: historyUpdates,
    });
  }, [fullTask, form.title, form.body, form.status, form.assignee, form.tags, form.priority, form.effort, form.effortLevel, form.implementationLink, form.subtasks, form.parentId, currentUser, persist]);

  /** FLUX-740: discard unsaved edits — reset every editable form field back to the loaded ticket.
   *  Lives on the controller (not the view) so the unified save/discard affordance in the metadata
   *  bar and any in-panel control share one implementation. */
  const discard = useCallback(() => {
    // FLUX-736 (part 3): intentionally we do NOT clear a typed-but-unsent CommentBox draft here — a
    // pending comment is arguably not a form edit, so discard only resets the editable form fields.

    form.setTitle(fullTask.title || '');
    form.setBody(fullTask.body || '');
    form.setStatus(fullTask.status || 'Todo');
    form.setAssignee(fullTask.assignee || 'unassigned');
    form.setTags(fullTask.tags || []);
    form.setPriority(fullTask.priority || 'None');
    form.setEffort(fullTask.effort || 'None');
    form.setEffortLevel(fullTask.effortLevel || '');
    form.setImplementationLink(fullTask.implementationLink || '');
    form.setSubtasks((fullTask.subtasks || []).map(normalizeSubtaskId));
    form.setParentId(fullTask.parentId || '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- form setters are stable; reset reads the latest task.
  }, [fullTask]);

  /** Append a bare comment/reply to history WITHOUT persisting unsaved metadata edits — keeps
   *  "annotate the ticket" cleanly separate from the dirty-form Save flow. */
  const appendComment = useCallback(async (entry: HistoryEntry) => {
    if (!fullTask.id) return;
    await persist({ appendHistory: [entry] });
  }, [fullTask.id, persist]);

  const sendComment = useCallback(async () => {
    const text = commentBoxRef.current?.getValue()?.trim() ?? '';
    if (!text || !fullTask.id) return;
    commentBoxRef.current?.reset();
    await appendComment({ type: 'comment', user: currentUser, date: new Date().toISOString(), comment: text });
  }, [fullTask.id, currentUser, appendComment]);

  const sendReply = useCallback(async (parentId: string) => {
    const text = replyDraft.trim();
    if (!text || !fullTask.id) return;
    setReplyDraft('');
    setReplyTargetId(null);
    await appendComment({ type: 'comment', user: currentUser, date: new Date().toISOString(), comment: text, replyTo: parentId });
  }, [replyDraft, fullTask.id, currentUser, appendComment]);

  const handleToggleReply = useCallback((entryId: string | undefined) => {
    setReplyTargetId((current) => (current === entryId ? null : entryId || null));
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

  return {
    // task + config
    task: fullTask,
    // ActivityFilterTabs / SubtasksPanel consume these under the TaskModalController field names.
    modalTask: fullTask,
    config,
    currentUser,
    allTasks,
    openTaskModal,
    ctxMarkCommentRead: markCommentRead,
    ctxMarkAllCommentsRead: markAllCommentsRead,
    // form
    ...form,
    // refs
    commentBoxRef, commentRef, replyTextareaRef,
    // derived lists
    allStatuses, allUsers, allTags, availablePriorities,
    requireInputStatus, isRequireInput,
    createdAt, updatedAt,
    // activity
    activityFilter, setActivityFilter,
    topLevelEntries, repliesByParent,
    replyTargetId, replyDraft, setReplyDraft, collapsedThreads,
    readCommentIds, unreadCommentCount,
    // subtasks
    inlineSubtaskMap, linkedSubtasks, danglingSubtaskIds, parentTask,
    // comment asset state
    commentAssetError, replyAssetError, isUploadingCommentAsset, isUploadingReplyAsset,
    handleCommentPaste, handleCommentDragOver, handleCommentDrop,
    handleReplyPaste, handleReplyDragOver, handleReplyDrop,
    // handlers
    // FLUX-1273: `persist` is exposed (raw, alongside the higher-level `save`) so a caller that needs
    // to bundle staged header-field edits together with its OWN commit-specific fields (e.g. the plan-
    // approval panel's Approve/Send-back/Ask-in-chat, which also set `planReviewState`/`status`/a
    // verdict-specific history entry) can do so in ONE write — `save()` itself doesn't know about
    // fields outside the standard ticket form.
    persist, save, discard, sendComment, sendReply,
    handleToggleReply, handleCancelReply, handleToggleCollapsed, handleClearReplyAssetError,
  };
}

export type TicketSideViewController = ReturnType<typeof useTicketSideView>;

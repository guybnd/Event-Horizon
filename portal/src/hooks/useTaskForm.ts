import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { normalizeTaskMarkdownBody } from '../components/TaskDescriptionSurface';

export function useTaskForm(modalTask: Task | Partial<Task> | null | undefined) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [status, setStatus] = useState('Todo');
  const [assignee, setAssignee] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [priority, setPriority] = useState<string>('None');
  const [effort, setEffort] = useState<string>('None');
  const [effortLevel, setEffortLevel] = useState<string>('');
  const [implementationLink, setImplementationLink] = useState('');
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const openedTaskIdRef = useRef<string | undefined>(undefined);
  // Tracks the last ticket ID whose state has been fully synced from modalTask.
  // isDirty is suppressed until this matches modalTask.id to prevent false-dirty
  // flashes on open caused by stale state from the previous ticket.
  const syncedTaskIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!modalTask) return;

    const isNewTicket = openedTaskIdRef.current !== modalTask.id;

    const nextTitle = modalTask.title || '';
    const nextBody = modalTask.body || '';
    const nextStatus = modalTask.status || 'Todo';
    const nextAssignee = modalTask.assignee || 'unassigned';
    const nextPriority = modalTask.priority || 'None';
    const nextEffort = modalTask.effort || 'None';
    const nextThinkingBudget = (modalTask as any).effortLevel || '';
    const nextLink = modalTask.implementationLink || '';

    if (isNewTicket) {
      setTitle(nextTitle);
      setBody(nextBody);
      setStatus(nextStatus);
      setAssignee(nextAssignee);
      setTags(modalTask.tags || []);
      setPriority(nextPriority);
      setEffort(nextEffort);
      setEffortLevel(nextThinkingBudget);
      setImplementationLink(nextLink);
      setSubtasks(modalTask.subtasks || []);
    } else {
      setTitle((prev) => (prev !== nextTitle ? nextTitle : prev));
      setBody((prev) => (prev !== nextBody ? nextBody : prev));
      setStatus((prev) => (prev !== nextStatus ? nextStatus : prev));
      setAssignee((prev) => (prev !== nextAssignee ? nextAssignee : prev));
      setTags((prev) => {
        const next = modalTask.tags || [];
        return prev.length !== next.length || prev.some((t, i) => t !== next[i]) ? next : prev;
      });
      setPriority((prev) => (prev !== nextPriority ? nextPriority : prev));
      setEffort((prev) => (prev !== nextEffort ? nextEffort : prev));
      setEffortLevel((prev) => (prev !== nextThinkingBudget ? nextThinkingBudget : prev));
      setImplementationLink((prev) => (prev !== nextLink ? nextLink : prev));
      setSubtasks((prev) => {
        const next = modalTask.subtasks || [];
        return prev.length !== next.length || prev.some((s, i) => s !== next[i]) ? next : prev;
      });
    }

    if (isNewTicket) {
      openedTaskIdRef.current = modalTask.id;
    }
    syncedTaskIdRef.current = modalTask.id;
  }, [modalTask]);

  const originalPayload = useMemo(() => JSON.stringify({
    title: modalTask?.title || '',
    body: normalizeTaskMarkdownBody(modalTask?.body || ''),
    status: modalTask?.status || 'Todo',
    assignee: modalTask?.assignee || 'unassigned',
    tags: modalTask?.tags || [],
    priority: modalTask?.priority || 'None',
    effort: modalTask?.effort || 'None',
    effortLevel: (modalTask as any)?.effortLevel || '',
    implementationLink: modalTask?.implementationLink || '',
    subtasks: modalTask?.subtasks || [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [modalTask]);

  const currentPayload = useMemo(() => JSON.stringify({
    title,
    body: normalizeTaskMarkdownBody(body),
    status,
    assignee,
    tags,
    priority,
    effort,
    effortLevel,
    implementationLink,
    subtasks,
  }), [title, body, status, assignee, tags, priority, effort, effortLevel, implementationLink, subtasks]);

  const isDirty = syncedTaskIdRef.current === modalTask?.id && originalPayload !== currentPayload;

  return {
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
    isDirty,
    originalPayload,
    currentPayload,
    openedTaskIdRef,
  };
}

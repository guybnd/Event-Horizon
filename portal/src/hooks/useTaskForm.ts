import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { normalizeTaskMarkdownBody } from '../taskMarkdownUtils';

type TaskFormValues = {
  title: string;
  body: string;
  status: string;
  assignee: string;
  tags: string[];
  priority: string;
  effort: string;
  effortLevel: string;
  implementationLink: string;
  subtasks: string[];
  parentId: string;
};

// Serialize the editable form fields into a stable, comparison-ready string.
// Body is normalized (line endings / trailing whitespace) so semantically
// identical markdown compares equal. Used both for the live form payload and for
// the baseline snapshot captured at sync time, so the two are always built the
// same way and cannot drift apart through asymmetric normalization.
function serializeTaskFormValues(values: TaskFormValues) {
  return JSON.stringify({
    title: values.title,
    body: normalizeTaskMarkdownBody(values.body),
    status: values.status,
    assignee: values.assignee,
    tags: values.tags,
    priority: values.priority,
    effort: values.effort,
    effortLevel: values.effortLevel,
    implementationLink: values.implementationLink,
    subtasks: values.subtasks,
    parentId: values.parentId,
  });
}

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
  const [parentId, setParentId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const openedTaskIdRef = useRef<string | undefined>(undefined);
  // Tracks the last ticket ID whose state has been fully synced from modalTask.
  // isDirty is suppressed until this matches modalTask.id to prevent false-dirty
  // flashes on open caused by stale state from the previous ticket.
  const syncedTaskIdRef = useRef<string | undefined>(undefined);
  // Snapshot of the form payload captured the moment state was last synced from
  // modalTask. isDirty compares the live payload against this baseline, so a
  // re-sync that keeps the same ticket id (e.g. the post-open fetchTask refresh)
  // updates the baseline in lockstep and can never register as a spurious edit —
  // which previously trapped the close/discard flow on an unedited ticket.
  const baselinePayloadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!modalTask) return;

    const isNewTicket = openedTaskIdRef.current !== modalTask.id;

    const nextTitle = modalTask.title || '';
    const nextBody = modalTask.body || '';
    const nextStatus = modalTask.status || 'Todo';
    const nextAssignee = modalTask.assignee || 'unassigned';
    const nextPriority = modalTask.priority || 'None';
    const nextEffort = modalTask.effort || 'None';
    const nextThinkingBudget = modalTask.effortLevel || '';
    const nextLink = modalTask.implementationLink || '';
    const nextParentId = modalTask.parentId || '';

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
      setSubtasks((modalTask.subtasks || []).map(normalizeSubtaskId));
      setParentId(nextParentId);
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
        const next = (modalTask.subtasks || []).map(normalizeSubtaskId);
        return prev.length !== next.length || prev.some((s, i) => s !== next[i]) ? next : prev;
      });
      setParentId((prev) => (prev !== nextParentId ? nextParentId : prev));
    }

    baselinePayloadRef.current = serializeTaskFormValues({
      title: nextTitle,
      body: nextBody,
      status: nextStatus,
      assignee: nextAssignee,
      tags: modalTask.tags || [],
      priority: nextPriority,
      effort: nextEffort,
      effortLevel: nextThinkingBudget,
      implementationLink: nextLink,
      subtasks: (modalTask.subtasks || []).map(normalizeSubtaskId),
      parentId: nextParentId,
    });

    if (isNewTicket) {
      openedTaskIdRef.current = modalTask.id;
    }
    syncedTaskIdRef.current = modalTask.id;
  }, [modalTask]);

  const currentPayload = useMemo(() => serializeTaskFormValues({
    title, body, status, assignee, tags, priority, effort, effortLevel, implementationLink, subtasks, parentId,
  }), [title, body, status, assignee, tags, priority, effort, effortLevel, implementationLink, subtasks, parentId]);

  // Dirty only once the form has been synced for the current ticket (id guard) and
  // the live payload has diverged from the baseline captured at that sync. Comparing
  // against the synced baseline — rather than re-deriving an "original" from
  // modalTask on every render — means a same-id refresh of modalTask can never flash
  // a false-dirty state and send X / Esc / overlay-click into the discard prompt.
  const isDirty =
    syncedTaskIdRef.current === modalTask?.id &&
    baselinePayloadRef.current !== null &&
    currentPayload !== baselinePayloadRef.current;

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
    parentId, setParentId,
    saving, setSaving,
    saveError, setSaveError,
    isDirty,
    openedTaskIdRef,
  };
}

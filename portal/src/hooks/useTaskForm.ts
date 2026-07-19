import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../types';
import { normalizeSubtaskId } from '../types';
import { normalizeTaskMarkdownBody } from '../taskMarkdownUtils';

export type TaskFormValues = {
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

/** FLUX-979: the metadata fields that save instantly on change instead of joining the free-text
 *  dirty/Save-button flow — see `setInstantField`/`getInstantField` below. */
export type InstantFieldName = 'status' | 'assignee' | 'priority' | 'effort' | 'effortLevel' | 'implementationLink' | 'tags';

const FORM_FIELD_KEYS = [
  'title', 'body', 'status', 'assignee', 'tags', 'priority', 'effort',
  'effortLevel', 'implementationLink', 'subtasks', 'parentId',
] as const satisfies readonly (keyof TaskFormValues)[];

interface FormSetters {
  title: (v: string) => void;
  body: (v: string) => void;
  status: (v: string) => void;
  assignee: (v: string) => void;
  tags: (v: string[]) => void;
  priority: (v: string) => void;
  effort: (v: string) => void;
  effortLevel: (v: string) => void;
  implementationLink: (v: string) => void;
  subtasks: (v: string[]) => void;
  parentId: (v: string) => void;
}

// TS can't narrow an indexed-access type from a runtime switch over a widened `keyof` union (the
// setters live on separate useState calls, not one record), so each branch calls its setter
// directly and casts the incoming value to the type that branch's key statically has.
function applyFormField(setters: FormSetters, key: keyof TaskFormValues, value: TaskFormValues[keyof TaskFormValues]) {
  switch (key) {
    case 'title': setters.title(value as string); return;
    case 'body': setters.body(value as string); return;
    case 'status': setters.status(value as string); return;
    case 'assignee': setters.assignee(value as string); return;
    case 'tags': setters.tags(value as string[]); return;
    case 'priority': setters.priority(value as string); return;
    case 'effort': setters.effort(value as string); return;
    case 'effortLevel': setters.effortLevel(value as string); return;
    case 'implementationLink': setters.implementationLink(value as string); return;
    case 'subtasks': setters.subtasks(value as string[]); return;
    case 'parentId': setters.parentId(value as string); return;
  }
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function fieldEqual(key: keyof TaskFormValues, a: TaskFormValues[keyof TaskFormValues], b: TaskFormValues[keyof TaskFormValues]): boolean {
  if (key === 'body') return normalizeTaskMarkdownBody(a as string) === normalizeTaskMarkdownBody(b as string);
  if (key === 'tags' || key === 'subtasks') return arraysEqual(a as string[], b as string[]);
  return a === b;
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
  // FLUX-979: baseline is now the raw per-field snapshot captured at the last sync (was a single
  // serialized blob) so dirtiness and reconciliation can both be computed FIELD BY FIELD instead of
  // all-or-nothing. isDirty (below) still folds every field into one boolean for callers that only
  // care "is anything unsaved" (the close/discard guard, the beforeunload guard).
  const baselineRef = useRef<TaskFormValues | null>(null);

  const live: TaskFormValues = {
    title, body, status, assignee, tags, priority, effort, effortLevel, implementationLink, subtasks, parentId,
  };

  useEffect(() => {
    if (!modalTask) return;

    const isNewTicket = openedTaskIdRef.current !== modalTask.id;

    const next: TaskFormValues = {
      title: modalTask.title || '',
      body: modalTask.body || '',
      status: modalTask.status || 'Todo',
      assignee: modalTask.assignee || 'unassigned',
      tags: modalTask.tags || [],
      priority: modalTask.priority || 'None',
      effort: modalTask.effort || 'None',
      effortLevel: modalTask.effortLevel || '',
      implementationLink: modalTask.implementationLink || '',
      subtasks: (modalTask.subtasks || []).map(normalizeSubtaskId),
      parentId: modalTask.parentId || '',
    };

    const setters: FormSetters = {
      title: setTitle, body: setBody, status: setStatus, assignee: setAssignee, tags: setTags,
      priority: setPriority, effort: setEffort, effortLevel: setEffortLevel,
      implementationLink: setImplementationLink, subtasks: setSubtasks, parentId: setParentId,
    };

    if (isNewTicket) {
      FORM_FIELD_KEYS.forEach((key) => applyFormField(setters, key, next[key]));
      baselineRef.current = next;
      openedTaskIdRef.current = modalTask.id;
      syncedTaskIdRef.current = modalTask.id;
      return;
    }

    // FLUX-736 / FLUX-979: a same-id re-sync (the sideview re-fetches on every refreshTrigger, and
    // the sibling chat agent fires refreshes while the user edits) must NOT clobber unsaved field
    // edits. Originally (FLUX-736) this was all-or-nothing: ANY dirty field skipped reconciliation
    // for EVERY field, which is exactly the lost-update bug this ticket reports — an agent's fresh
    // description got held stale (and then silently overwritten on save) just because the user had
    // an unrelated unsaved title edit. Reconciliation is now PER FIELD: a field the user hasn't
    // touched always live-updates to the latest server value (so the agent's edit becomes visible
    // immediately); only a field the user has actively diverged from baseline keeps its draft.
    const baseline = baselineRef.current;
    const nextBaseline = { ...next };
    FORM_FIELD_KEYS.forEach((key) => {
      const isDirtyField = baseline !== null && !fieldEqual(key, live[key], baseline[key]);
      if (isDirtyField) {
        // Keep the user's draft AND the stale baseline it's measured against, so isDirty stays
        // true and the pending edit survives this refresh. (Cast: TS won't let an indexed write
        // use a generic `keyof` key even though both sides are the same TaskFormValues shape.)
        (nextBaseline as Record<string, unknown>)[key] = (baseline as Record<string, unknown>)[key];
        return;
      }
      applyFormField(setters, key, next[key]);
    });
    baselineRef.current = nextBaseline;
    syncedTaskIdRef.current = modalTask.id;
  // FLUX-736: the live field values read inside (for the dirty check) are deliberately NOT deps — the
  // sync must run only when `modalTask` changes, never re-fire on a keystroke; the closed-over values
  // reflect the render that triggered this re-sync, which is exactly the dirty snapshot we want.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalTask]);

  // Per-field dirty set — the structural fix (FLUX-979 section B/C): a dropdown field the user just
  // picked is dirty only until its instant save round-trips (see `setInstantField` callers), and
  // reconciliation above only ever holds back the fields actually in this set.
  const dirtyFields = useMemo(() => {
    const result = new Set<keyof TaskFormValues>();
    if (syncedTaskIdRef.current !== modalTask?.id || !baselineRef.current) return result;
    const baseline = baselineRef.current;
    FORM_FIELD_KEYS.forEach((key) => {
      if (!fieldEqual(key, live[key], baseline[key])) result.add(key);
    });
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalTask?.id, title, body, status, assignee, tags, priority, effort, effortLevel, implementationLink, subtasks, parentId]);

  const isDirty = dirtyFields.size > 0;

  /** Mark fields as clean against a just-committed server value, WITHOUT touching live state (the
   *  caller already applied the optimistic setter before persisting). Used after an instant
   *  metadata save succeeds, so the field never shows as unsaved once the round-trip completes.
   *
   *  FLUX-1568 robustness note: this mutates `baselineRef`, which is NOT itself a `dirtyFields`
   *  dependency — the field only visibly clears because the reconcile effect above churns fresh
   *  `subtasks`/`tags` array references on every sync (`applyFormField` unconditionally re-sets
   *  them), forcing the memo to recompute. Works reliably today; if reconcile is ever optimized to
   *  skip no-op array setStates, a field cleared here would stay stuck showing "unsaved" until some
   *  unrelated state change forced a recompute. */
  const markFieldsClean = useCallback((patch: Partial<TaskFormValues>) => {
    if (!baselineRef.current) return;
    baselineRef.current = { ...baselineRef.current, ...patch };
  }, []);

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
    dirtyFields,
    markFieldsClean,
    openedTaskIdRef,
  };
}

export type TaskFormController = ReturnType<typeof useTaskForm>;

/** FLUX-979: shared field-name-to-getter/setter dispatch for the "save instantly on change"
 *  metadata fields (status/assignee/priority/effort/effortLevel/implementationLink/tags) — used by
 *  both `useTaskModalController` and `useTicketSideView` so the instant-save-with-rollback logic
 *  isn't duplicated per controller. */
export function getInstantField(form: TaskFormController, field: InstantFieldName): string | string[] {
  switch (field) {
    case 'status': return form.status;
    case 'assignee': return form.assignee;
    case 'priority': return form.priority;
    case 'effort': return form.effort;
    case 'effortLevel': return form.effortLevel;
    case 'implementationLink': return form.implementationLink;
    case 'tags': return form.tags;
  }
}

export function setInstantField(form: TaskFormController, field: InstantFieldName, value: string | string[]): void {
  switch (field) {
    case 'status': form.setStatus(value as string); return;
    case 'assignee': form.setAssignee(value as string); return;
    case 'priority': form.setPriority(value as string); return;
    case 'effort': form.setEffort(value as string); return;
    case 'effortLevel': form.setEffortLevel(value as string); return;
    case 'implementationLink': form.setImplementationLink(value as string); return;
    case 'tags': form.setTags(value as string[]); return;
  }
}

/** FLUX-1568: normalize a value before it's compared/persisted as an instant-save field — only
 *  `implementationLink` needs this today (free text; the manual full-form `save()` already trims
 *  via `form.implementationLink.trim()`, so the blur-save path must match it or the two paths can
 *  persist different values for the same input). */
export function normalizeInstantFieldValue(field: InstantFieldName, value: string | string[]): string | string[] {
  return field === 'implementationLink' ? (value as string).trim() : value;
}

/** FLUX-1568: true when `value` (already normalized) matches what's currently persisted on the
 *  loaded task — used to skip an instant save's network round trip on a no-op blur/change (e.g.
 *  clicking into the implementationLink input and tabbing back out without editing it). Mirrors
 *  the same per-field defaulting `useTaskForm`'s sync effect applies, so "loaded" and "live"
 *  values compare equal. */
export function isInstantFieldUnchanged(
  task: Task | Partial<Task> | null | undefined,
  field: InstantFieldName,
  value: string | string[],
): boolean {
  let loaded: string | string[];
  switch (field) {
    case 'status': loaded = task?.status || 'Todo'; break;
    case 'assignee': loaded = task?.assignee || 'unassigned'; break;
    case 'priority': loaded = task?.priority || 'None'; break;
    case 'effort': loaded = task?.effort || 'None'; break;
    case 'effortLevel': loaded = task?.effortLevel || ''; break;
    case 'implementationLink': loaded = task?.implementationLink || ''; break;
    case 'tags': loaded = task?.tags || []; break;
  }
  return field === 'tags' ? arraysEqual(value as string[], loaded as string[]) : value === loaded;
}

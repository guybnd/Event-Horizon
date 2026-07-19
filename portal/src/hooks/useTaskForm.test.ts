// @vitest-environment jsdom
// FLUX-1568: test coverage for FLUX-979's per-field dirty/reconcile logic — previously untested.
// The core fix under test: a same-id re-sync (the sideview/modal re-fetch on refresh) must
// reconcile PER FIELD, not all-or-nothing — an untouched field live-updates from the fresh server
// value even while a *different* field is mid-edit, and only the actively-dirty field holds its
// stale baseline (and keeps `isDirty` true) until the user saves or discards.
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTaskForm } from './useTaskForm';
import type { Task } from '../types';

const BASE_TASK: Task = {
  id: 'FLUX-1',
  status: 'Todo',
  title: 'Original title',
  body: 'Original body',
  assignee: 'unassigned',
  tags: ['a'],
  priority: 'None',
  effort: 'None',
  implementationLink: '',
  order: 0,
};

describe('useTaskForm (FLUX-979 per-field dirty/reconcile)', () => {
  it('live-updates an untouched field on refresh while a different field is mid-edit (lost-update fix)', () => {
    const { result, rerender } = renderHook(({ task }) => useTaskForm(task), {
      initialProps: { task: BASE_TASK as Task | null },
    });

    // Initial sync for a new ticket id populates every field and establishes the baseline.
    expect(result.current.title).toBe('Original title');
    expect(result.current.body).toBe('Original body');
    expect(result.current.isDirty).toBe(false);

    // User starts editing the title but has not touched body.
    act(() => result.current.setTitle('User is typing a new title'));
    expect(result.current.dirtyFields.has('title')).toBe(true);
    expect(result.current.dirtyFields.has('body')).toBe(false);

    // Server refresh arrives (same ticket id) with a fresh body from e.g. an agent edit.
    const refreshed: Task = { ...BASE_TASK, body: 'Agent updated the body' };
    rerender({ task: refreshed });

    // The untouched body field live-updates to the fresh server value immediately.
    expect(result.current.body).toBe('Agent updated the body');
    expect(result.current.dirtyFields.has('body')).toBe(false);

    // The dirty title field keeps the user's in-progress draft — NOT clobbered by the refresh.
    expect(result.current.title).toBe('User is typing a new title');
    expect(result.current.dirtyFields.has('title')).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it('holds a dirty field against its stale baseline across repeated refreshes until saved/discarded', () => {
    const { result, rerender } = renderHook(({ task }) => useTaskForm(task), {
      initialProps: { task: BASE_TASK as Task | null },
    });

    act(() => result.current.setTitle('Draft title'));

    // Multiple refreshes land while the field stays dirty (no other field changed server-side).
    rerender({ task: { ...BASE_TASK } });
    rerender({ task: { ...BASE_TASK } });

    expect(result.current.title).toBe('Draft title');
    expect(result.current.dirtyFields.has('title')).toBe(true);
    expect(result.current.isDirty).toBe(true);
  });

  it('clears dirty state once the live value is edited back to match the (possibly refreshed) baseline', () => {
    const { result, rerender } = renderHook(({ task }) => useTaskForm(task), {
      initialProps: { task: BASE_TASK as Task | null },
    });

    act(() => result.current.setAssignee('someone-else'));
    expect(result.current.dirtyFields.has('assignee')).toBe(true);

    // A refresh with an unrelated field change does not touch the still-dirty assignee.
    rerender({ task: { ...BASE_TASK, priority: 'High' } });
    expect(result.current.dirtyFields.has('assignee')).toBe(true);
    expect(result.current.priority).toBe('High'); // untouched field reconciled live

    // User reverts their edit back to the held baseline value.
    act(() => result.current.setAssignee('unassigned'));
    expect(result.current.dirtyFields.has('assignee')).toBe(false);
    expect(result.current.isDirty).toBe(false);
  });

  it('resets the baseline wholesale (no per-field reconcile) when the ticket id changes', () => {
    const { result, rerender } = renderHook(({ task }) => useTaskForm(task), {
      initialProps: { task: BASE_TASK as Task | null },
    });

    act(() => result.current.setTitle('Unsaved draft on ticket 1'));
    expect(result.current.isDirty).toBe(true);

    const otherTask: Task = { ...BASE_TASK, id: 'FLUX-2', title: 'Ticket 2 title', body: 'Ticket 2 body' };
    rerender({ task: otherTask });

    // Opening a different ticket discards the previous ticket's draft and starts clean.
    expect(result.current.title).toBe('Ticket 2 title');
    expect(result.current.isDirty).toBe(false);
  });

  it('markFieldsClean patches the baseline, but dirtyFields only reflects it on a subsequent render (FLUX-1568 known caveat)', () => {
    const { result } = renderHook(({ task }) => useTaskForm(task), {
      initialProps: { task: BASE_TASK as Task | null },
    });

    // Simulates an instant-save field: the caller already applied the optimistic setter.
    act(() => result.current.setPriority('High'));
    expect(result.current.dirtyFields.has('priority')).toBe(true);

    // markFieldsClean only mutates the baseline ref — `dirtyFields` is a useMemo keyed on live
    // field values, NOT on the baseline ref, so a ref-only mutation with no accompanying state
    // update doesn't force a recompute. In production this is masked because callers always pair
    // it with a `setFullTask`/`setModalTask` call that changes identity and forces a re-render —
    // see the caveat documented on `markFieldsClean` in useTaskForm.ts.
    act(() => result.current.markFieldsClean({ priority: 'High' }));
    expect(result.current.priority).toBe('High');
    expect(result.current.dirtyFields.has('priority')).toBe(true);

    // Any subsequent live-state change forces the memo to recompute against the now-patched
    // baseline, at which point the field correctly reads clean.
    act(() => result.current.setAssignee('someone-else'));
    expect(result.current.dirtyFields.has('priority')).toBe(false);
  });

  it('treats body-whitespace/markdown normalization as equal, not dirty', () => {
    const { result } = renderHook(({ task }) => useTaskForm(task), {
      initialProps: { task: { ...BASE_TASK, body: 'Line one\nLine two' } as Task | null },
    });

    // A value that normalizes to the same markdown (e.g. trailing-newline noise) must not flag dirty.
    act(() => result.current.setBody('Line one\nLine two\n'));
    expect(result.current.dirtyFields.has('body')).toBe(false);
  });
});

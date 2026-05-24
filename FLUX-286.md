---
id: FLUX-286
title: 'Engine: normalizeInlineSubtasks skips objects without id field'
status: Todo
priority: High
effort: S
assignee: unassigned
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-24T14:00:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-24T14:00:00.000Z'
    comment: >-
      Created ticket. FLUX-281 subtasks were written as inline objects without
      id fields and silently skipped by the normalizer.
  - type: comment
    user: Agent
    date: '2026-05-25T13:42:18.331Z'
    comment: >-
      Groomed: clear root cause at two sites in normalizeInlineSubtasks.
      Implementation plan added. Moving to Todo.
    id: c-2026-05-25t13-42-18-331z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T13:42:18.331Z'
---

## Problem / Motivation

When an agent writes subtasks as inline objects without an `id` field (e.g. `{title, status, assignee}`), the `normalizeInlineSubtasks()` function in `engine/src/task-store.ts` silently skips them. This leaves broken inline objects in the YAML that the portal cannot render. The FLUX-277/278 fix only handles objects that already have an `id`.

## Implementation Plan

All changes are in `engine/src/task-store.ts`, function `normalizeInlineSubtasks` (line 135).

1. **Broaden the detection condition** (line 139):
   Change `entry.id` check to detect any non-null object entry — not just those with `id`:
   ```ts
   const hasInlineObjects = subtasks.some(
     (entry: any) => typeof entry === 'object' && entry !== null
   );
   ```

2. **Handle id-less objects in the loop** (line 147–194):
   When `entry` is an object without `id`:
   - Derive the project key from the parent's ID (e.g. `FLUX-286` → `FLUX`).
   - Scan `tasksCache` for the max numeric ID with that project key (same logic as `POST /api/tasks` in `routes/tasks.ts` lines 84–91).
   - Assign `nextId = <projectKey>-<max+1>`.
   - Create the `.flux/<nextId>.md` file using the existing child-creation logic already in the function.
   - Push `nextId` into `normalizedIds`.
   - Log a warning: `[subtasks] Auto-created <nextId> from id-less inline subtask of <parentId>`.

3. **Keep existing behavior intact**: Objects with `id` follow the current path unchanged. String entries pass through untouched.

4. **Edge case**: If multiple id-less objects exist in one parent's subtasks, increment the counter for each within the same loop iteration to avoid collisions.

## Acceptance Criteria

- [ ] Inline subtask objects without an `id` field are detected and normalized.
- [ ] A new ticket file is generated with the next sequential ID.
- [ ] The parent's `subtasks` array is rewritten to string IDs on disk.
- [ ] Existing FLUX-277 behavior (objects with `id`) remains unchanged.
- [ ] Log warning emitted when normalizing id-less subtasks.

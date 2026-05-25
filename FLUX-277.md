---
id: FLUX-277
title: 'Engine: auto-create ticket files from inline subtask objects'
status: Released
priority: High
effort: S
assignee: unassigned
tags:
  - engine
  - bug-fix
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-19T07:39:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-19T07:39:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-25T09:54:03.252Z'
version: v0.8.0
releasedAt: '2026-05-25T09:54:03.252Z'
releaseDocPath: release-notes/v0.8.0
---

## Problem

When an agent writes subtasks as inline objects in a ticket's YAML frontmatter (e.g. `{id, title, status}` instead of string IDs), the portal crashes because it expects `subtasks` to be `string[]`. Agents do this because nothing enforces the correct format.

## Solution

In the engine's `loadTask` function (task-store.ts), detect subtask entries that are objects. For each inline object:

1. If a `.flux/<id>.md` file already exists, skip creation.
2. Otherwise, create a new ticket file from the inline data (title, status, tags etc).
3. Rewrite the parent ticket's `subtasks` array to contain only string IDs.
4. Link the child back to the parent via a comment or metadata if useful.

This makes the system self-healing — even if an agent writes the wrong format, the engine normalizes it into proper ticket files.

## Acceptance Criteria

- [ ] Inline subtask objects are detected during `loadTask`.
- [ ] Corresponding `.flux/<id>.md` files are auto-created with correct frontmatter.
- [ ] Parent ticket's `subtasks` array is rewritten to `string[]` on disk.
- [ ] Existing tickets with matching IDs are not overwritten.
- [ ] No crash when opening tickets with inline subtasks in the portal.

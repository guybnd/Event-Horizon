---
id: FLUX-336
title: Add `branch` field to ticket schema and types
status: Done
priority: Medium
effort: XS
assignee: unassigned
tags:
  - feature
  - engine
  - portal
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.551Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.551Z'
    comment: Created as subtask of FLUX-292.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T02:55:12.962Z'
  - type: comment
    user: Agent
    comment: >-
      Added `branch?: string` to the `Task` interface in `portal/src/types.ts`
      (line 66). Engine task-store already preserves arbitrary frontmatter
      fields via the `extraFields` mechanism — no engine changes needed. Portal
      TypeScript check passes clean. Field will round-trip through read/write
      without migration on existing tickets.
    date: '2026-06-03T02:55:37.698Z'
    id: c-2026-06-03t02-55-37-698z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T02:55:37.698Z'
  - type: comment
    user: Agent
    comment: >-
      Shipped in commit 17b4430. `branch?: string` was on the Task type already
      from prior session work; this commit additionally adds `baselineCommit?`
      and `diffSummary?` to round out the schema needed by FLUX-292's full
      slice. Engine task-store preserves the new fields via existing extraFields
      machinery — no migration needed. Docs: updated
      `.docs/event-horizon/reference/ticket-schema.md` with all three new
      fields.
    date: '2026-06-03T05:30:29.573Z'
    id: c-2026-06-03t05-30-29-573z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-06-03T05:30:29.573Z'
implementationLink: 17b4430
---
## Problem / Motivation

The ticket model has no field to store a git branch association. This subtask adds the schema support that all other parts depend on.

## Implementation Plan

1. Add optional `branch?: string` field to the `Task` interface in `portal/src/types.ts`.
2. Ensure `engine/src/task-store.ts` preserves the field during read/write without requiring it.
3. No migration needed — existing tickets simply won't have the field set.

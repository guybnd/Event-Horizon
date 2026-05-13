---
priority: High
effort: S
tags:
  - bug
  - sync
title: >-
  Tickets written to .flux/ instead of .flux-store/ if worktree not yet attached
  on startup
status: Done
createdBy: Unknown
updatedBy: Guy
assignee: unassigned
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T02:33:28.174Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-13T02:38:33.372Z'
    comment: >-
      Groomed. Two-part fix: (1) recovery scan in activateWorkspace to copy
      stray .flux/*.md files into .flux-store/ when in orphan mode, (2)
      activating flag to reject/queue writes until workspace is fully ready.
      Part 1 addresses the confirmed FLUX-218 through FLUX-226 incident; part 2
      prevents recurrence.
    id: c-2026-05-13t02-35-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T02:38:33.372Z'
  - type: activity
    user: Unknown
    date: '2026-05-13T02:38:33.372Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Unknown
    date: '2026-05-13T02:42:56.418Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Guy
    date: '2026-05-13T04:50:07.621Z'
order: 3
---
## Problem

`isOrphanMode()` checks `existsSync(getFluxStoreDir())` at call time. If `attachWorktreeIfPresent` hasn't completed yet (or fails silently), `.flux-store/` does not exist on disk and `isOrphanMode()` returns `false`. Any ticket writes during that window go to `.flux/` instead of `.flux-store/`. The sync watcher only watches `.flux-store/`, so those files are silently written to the wrong directory, never committed to `flux-data`, and never pushed.

This is the confirmed root cause of FLUX-218 through FLUX-226 ending up stranded in `.flux/`.

## Fix

Two parts:

### 1. Recovery path — scan for stray `.flux/*.md` files when in orphan mode

In `engine/src/task-store.ts`, inside `activateWorkspace`, after `attachWorktreeIfPresent` resolves and `isOrphanMode()` is `true`: scan `.flux/*.md` for any ticket files that exist but are absent from `.flux-store/`. Copy them into `.flux-store/` so the sync watcher picks them up on the next cycle. Log each migrated file.

### 2. Prevent writes during activation

In `engine/src/task-store.ts`, set a boolean flag `workspaceActivating = true` at the start of `activateWorkspace` and `false` when it resolves. In the write path (`createTask`, `updateTask`), if `workspaceActivating` is true, reject with a 503 or queue the write until activation completes.

This is a belt-and-suspenders guard — part 1 handles the recovery case; part 2 prevents it from recurring.

## Touchpoints

- `engine/src/task-store.ts` — `activateWorkspace`, write path
- `engine/src/workspace.ts` — `isOrphanMode`
- `engine/src/storage-sync.ts` — `attachWorktreeIfPresent`

## Validation

- Start engine fresh with a repo in orphan mode.
- Immediately create a ticket before the worktree is confirmed attached.
- Confirm the ticket lands in `.flux-store/`, not `.flux/`.
- Seed a stray `.flux/FLUX-xxx.md` file, restart engine, confirm it is migrated to `.flux-store/` automatically.

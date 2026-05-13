---
priority: High
effort: XS
tags:
  - bug
  - sync
title: Workspace route does not restart sync watcher after activateWorkspace
status: Released
createdBy: Unknown
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T02:33:26.689Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-13T02:38:31.233Z'
    comment: >-
      Groomed. One-liner fix: import startSyncWatcher in workspace.ts and call
      it after activateWorkspace in the POST / handler, matching the pattern in
      storage.ts migrate route.
    id: c-2026-05-13t02-35-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-13T02:38:31.233Z'
  - type: activity
    user: Unknown
    date: '2026-05-13T02:38:31.233Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Unknown
    date: '2026-05-13T02:42:14.172Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-13T02:49:22.366Z'
  - type: comment
    user: Agent
    date: '2026-05-13T02:49:22.366Z'
    comment: >-
      Shipped. Commit 993ffbc: added startSyncWatcher import and call in POST
      /api/workspace handler, mirroring the storage.ts pattern. Only
      workspace.ts staged — tasks.ts and task-store.ts changes are unrelated and
      left unstaged.
    id: c-2026-05-13t02-49-22-366z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-13T14:16:35.528Z'
version: v0.5.0
releasedAt: '2026-05-13T14:16:35.528Z'
releaseDocPath: release-notes/v0.5.0
---
## Problem

`POST /api/workspace` calls `activateWorkspace()` but never calls `startSyncWatcher()` afterwards. `startSyncWatcher()` is only invoked in the engine startup path in `index.ts`. If the workspace is activated or switched via the portal UI (or the initial workspace load goes through the route rather than startup), the sync watcher is never started and `.flux-store/` changes are never auto-committed or pushed.

## Fix

In `engine/src/routes/workspace.ts`:
1. Add `startSyncWatcher` to the import from `../sync-watcher.js`.
2. Call `startSyncWatcher()` immediately after `activateWorkspace(newRoot)` in the `POST /` handler.

This mirrors the pattern already used correctly in `engine/src/routes/storage.ts` (the migrate route).

## Validation

- Restart the engine, activate a workspace via the portal UI folder picker.
- Create a ticket.
- Confirm a `flux: sync` commit appears on `flux-data` within 30s of the write.
- Confirm `git push origin flux-data` is executed automatically.

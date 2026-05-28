---
priority: High
effort: S
tags:
  - bug
  - backend
assignee: Agent
createdBy: Unknown
title: Auto-migrate stranded .flux tickets to .flux-store on startup in orphan mode
status: In Progress
updatedBy: Agent
history:
  - type: activity
    user: Unknown
    date: '2026-05-12T09:19:03.431Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T09:19:57.986Z'
    comment: Launched Claude Code session (2855a761).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T09:21:18.882Z'
  - type: activity
    user: Agent
    date: '2026-05-12T09:21:18.882Z'
    comment: Updated description. Changed assignee from unassigned to Agent.
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T09:21:24.587Z'
    comment: >-
      Grooming complete. Ticket is now `Todo` with the body rewritten as the
      implementation plan. The API response confirms the `Grooming → Todo`
      status change was recorded.


      **Summary:** FLUX-220 is groomed and moved to `Todo`. Plan: add
      `migrateStrandedFluxTickets()` to `storage-sync.ts` (copies stranded
      `.flux/*.md` → `.flux-store/` on startup when orphan mode is active, then
      deletes originals), and call it from `activateWorkspace` before `initDir`.
      Ready to implement when you say go.
  - type: activity
    user: Agent
    date: '2026-05-12T09:21:24.589Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-12T11:47:15.350Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-12T11:47:21.070Z'
  - type: agent_session
    sessionId: b58e7e7a-9e62-4aa3-998b-86c4b5fec23f
    startedAt: '2026-05-25T16:01:21.913Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T16:01:21.913Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T16:01:30.556Z'
  - type: agent_session
    sessionId: 2ed28e2b-8209-434f-8aad-080e7c1a219f
    startedAt: '2026-05-28T04:57:23.930Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-28T04:57:23.930Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-28T04:58:11.691Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-28T04:58:11.691Z'
  - type: comment
    user: Agent
    date: '2026-05-28T04:58:11.691Z'
    comment: >-
      Starting implementation. Will enhance the existing recoverStrayFluxFiles
      to also delete source files after copy and migrate config.json, matching
      the ticket spec.
    id: c-2026-05-28t04-58-11-691z
tokenMetadata:
  inputTokens: 208737
  outputTokens: 3797
  costUSD: 0.265353
  costIsEstimated: false
  cacheReadTokens: 166381
  cacheCreationTokens: 41237
order: 4
---
## Implementation Plan

### Problem
When orphan mode is active (`.flux-store/` exists), `activateWorkspace` calls `initDir()` which reads from `getActiveFluxDir()` — i.e. `.flux-store/`. Any `.flux/*.md` ticket files that were not migrated are invisible to the engine. Subsequent writes to those tickets fail silently because `_path` in the task cache would point to `.flux/` which is never loaded.

### Solution
Add a `migrateStrandedFluxTickets(workspaceRoot: string): Promise<void>` function in `engine/src/storage-sync.ts` that:
1. Early-returns if orphan mode is NOT active (`.flux-store/` doesn`t exist)
2. Reads all `.md` files from `.flux/`
3. For each one, copies it to `.flux-store/` (skip if destination already exists — don`t overwrite newer data)
4. Deletes the source from `.flux/` after successful copy
5. Also migrates `config.json` from `.flux/` → `.flux-store/` if `.flux-store/config.json` does not yet exist
6. Logs each migrated file with `[startup-migrate]` prefix

Call `migrateStrandedFluxTickets(newRoot)` from `activateWorkspace` in `engine/src/task-store.ts`, after `attachWorktreeIfPresent(newRoot)` and before `initDir()`.

### Touchpoints
- `engine/src/storage-sync.ts` — add exported function
- `engine/src/task-store.ts` — import and call in `activateWorkspace`

### Validation
- Manually: put a `.md` ticket in `.flux/` while `.flux-store/` exists, restart engine, verify the ticket appears in `/api/tasks` and the `.flux/` file is gone
- No automated test needed for this scope

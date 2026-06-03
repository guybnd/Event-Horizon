---
priority: Medium
effort: L
tags:
  - refactor
  - engine
  - architecture
assignee: unassigned
id: FLUX-343
title: 'Engine: introduce Workspace context to replace module-level globals'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:27.699Z'
    comment: Created ticket.
---
## Problem

`engine/src/task-store.ts` exports module-level mutable singletons (`tasksCache`, `docsCache`, `parseErrors`, `workspaceActivating`). Watchers, sync workers, and SSE clients all share this global state. This makes workspace switching fragile (mutating shared state mid-flight), blocks any future multi-workspace-in-parallel mode, and complicates testing.

## Plan

- Introduce a `Workspace` class/struct that owns its own `tasksCache`, watchers, config snapshot, parse errors, and sync worker.
- Add middleware that resolves the active workspace and passes it to route handlers via `req.workspace`.
- `activateWorkspace(path)` becomes "create/swap context" instead of "mutate globals".
- Migrate callers in routes, MCP server, and `index.ts` one subsystem at a time.
- Acceptance: no module-level mutable cache exports remain in `task-store.ts`; switching workspaces does not race with watchers.

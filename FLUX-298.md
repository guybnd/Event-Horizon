---
assignee: unassigned
tags:
  - feature
  - portal
  - engine
  - settings
priority: Medium
effort: L
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T05:33:48.231Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-26T00:01:31.110Z'
    comment: Updated description.
  - type: agent_session
    sessionId: 091f5d98-3150-4e29-86d1-6aa2eae2c2f9
    startedAt: '2026-05-26T00:01:32.541Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-26T00:01:32.541Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-26T00:01:42.197Z'
  - type: activity
    user: Agent
    date: '2026-05-26T00:03:34.505Z'
    comment: >-
      Updated description. Changed priority to Medium. Changed effort to L.
      Updated tags.
title: multi project workflow
status: Grooming
createdBy: Guy
updatedBy: Agent
id: FLUX-298
---
## Problem / Motivation

Currently, switching between workspaces (project folders with their own `.flux/` directory) requires navigating to the Settings page and manually entering a path. Users working across multiple repos/projects need fast context switching — selecting a workspace should reload its settings, tickets, and config instantly. This is a core usability feature for multi-project users.

## Implementation Plan

### 1. App-level workspace list (Engine)

- Extend `~/.event-horizon/settings.json` to store a `workspaces` array of `{ path, label? }` objects alongside the existing `lastWorkspace` field.
- Add engine endpoints:
  - `GET /api/workspaces` — return the stored workspaces list
  - `POST /api/workspaces` — add a workspace entry (with optional label)
  - `DELETE /api/workspaces/:index` — remove a workspace entry
  - `POST /api/workspaces/switch` — activate a workspace (calls existing `activateWorkspace` flow, updates `lastWorkspace`)

### 2. Settings UI — Manage workspaces

- In `WorkspaceSection.tsx`, add a list of configured workspaces with add/remove controls.
- "Add" button opens folder picker (reuse existing `/api/workspace/pick` endpoint) or accepts manual path entry.
- Optional label field per workspace for display in the switcher.

### 3. Top bar workspace switcher (Portal)

- In `Header.tsx` top-right area, replace or augment the current project key input with a dropdown/popover showing configured workspaces.
- Display the active workspace label (or folder basename if no label).
- Selecting a different workspace calls `POST /api/workspaces/switch`, then triggers a full app reload (config, tasks, board state).
- Show a brief loading indicator during switch.

### 4. State management

- Add workspace list to `AppContext` (fetched on mount from `GET /api/workspaces`).
- Active workspace tracked via existing `config` fetch (already refreshes on workspace activation via SSE/polling).
- After switch, invalidate task cache and re-fetch config + tasks.

### 5. Edge cases

- If a configured workspace path no longer exists on disk, show it as "unavailable" in the switcher (don't crash).
- First-time users with no extra workspaces see no switcher (or a minimal add-project prompt).
- Workspace switch while unsaved changes in settings — confirm or auto-save.

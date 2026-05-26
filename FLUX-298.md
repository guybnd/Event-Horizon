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
    status: completed
    progress:
      - timestamp: '2026-05-26T00:01:47.921Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket,get_board_config,list_tickets'
            max_results: 3
      - timestamp: '2026-05-26T00:01:48.187Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T00:01:54.636Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-298
      - timestamp: '2026-05-26T00:02:03.190Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T00:02:05.798Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore multi-project architecture
            subagent_type: Explore
            prompt: >-
              I'm grooming a ticket for adding multi-project support to a local
              ticket board app called Event Horizon. I need to understand:


              1. How the current config/settings work - look at
              `.flux/config.json` and any settings-related code in `engine/src/`
              and `portal/src/`

              2. How the top bar / header is implemented in the portal (React
              UI) - find the component

              3. How the engine currently loads its project root / `.flux/`
              directory - what's the startup flow

              4. How the portal connects to the engine (API base URL, any
              context providers for config)


              Search breadth: medium. Focus on:

              - `.flux/config.json` structure

              - Engine startup / config loading (look for server.ts, index.ts,
              or app.ts in engine/src/)

              - Portal top bar / header component

              - Portal settings page/modal if any exists

              - AppContext or similar state management that holds config


              Report the key file paths and relevant code snippets so I can plan
              multi-project switching.
      - timestamp: '2026-05-26T00:02:07.819Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\config.json'
      - timestamp: '2026-05-26T00:02:07.937Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/**/*.ts
      - timestamp: '2026-05-26T00:02:08.343Z'
        message: 'Running: find /c/GitHub/EventHorizon -type f -name "package...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: find /c/GitHub/EventHorizon -type f -name "package.json" | head -5
      - timestamp: '2026-05-26T00:02:11.758Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\index.ts'
      - timestamp: '2026-05-26T00:02:18.191Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T00:02:21.210Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/api.ts
      - timestamp: '2026-05-26T00:02:21.611Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            limit: 150
      - timestamp: '2026-05-26T00:02:21.872Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/components/Settings.tsx
      - timestamp: '2026-05-26T00:02:24.346Z'
        message: Reading Settings.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Settings.tsx'
            limit: 100
      - timestamp: '2026-05-26T00:02:32.030Z'
        message: 'Running: grep -r "currentProject" /c/GitHub/EventHorizon/po...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -r "currentProject" /c/GitHub/EventHorizon/portal/src
              --include="*.tsx" --include="*.ts" | head -20
      - timestamp: '2026-05-26T00:02:33.195Z'
        message: Running command
        type: info
      - timestamp: '2026-05-26T00:02:39.173Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\tasks.ts'
            limit: 200
      - timestamp: '2026-05-26T00:02:48.200Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T00:03:33.216Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T00:03:34.494Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-298
            priority: Medium
            effort: L
            tags:
              - feature
              - portal
              - engine
              - settings
            body: >-
              ## Problem / Motivation


              Currently, switching between workspaces (project folders with
              their own `.flux/` directory) requires navigating to the Settings
              page and manually entering a path. Users working across multiple
              repos/projects need fast context switching — selecting a workspace
              should reload its settings, tickets, and config instantly. This is
              a core usability feature for multi-project users.


              ## Implementation Plan


              ### 1. App-level workspace list (Engine)


              - Extend `~/.event-horizon/settings.json` to store a `workspaces`
              array of `{ path, label? }` objects alongside the existing
              `lastWorkspace` field.

              - Add engine endpoints:
                - `GET /api/workspaces` — return the stored workspaces list
                - `POST /api/workspaces` — add a workspace entry (with optional label)
                - `DELETE /api/workspaces/:index` — remove a workspace entry
                - `POST /api/workspaces/switch` — activate a workspace (calls existing `activateWorkspace` flow, updates `lastWorkspace`)

              ### 2. Settings UI — Manage workspaces


              - In `WorkspaceSection.tsx`, add a list of configured workspaces
              with add/remove controls.

              - "Add" button opens folder picker (reuse existing
              `/api/workspace/pick` endpoint) or accepts manual path entry.

              - Optional label field per workspace for display in the switcher.


              ### 3. Top bar workspace switcher (Portal)


              - In `Header.tsx` top-right area, replace or augment the current
              project key input with a dropdown/popover showing configured
              workspaces.

              - Display the active workspace label (or folder basename if no
              label).

              - Selecting a different workspace calls `POST
              /api/workspaces/switch`, then triggers a full app reload (config,
              tasks, board state).

              - Show a brief loading indicator during switch.


              ### 4. State management


              - Add workspace list to `AppContext` (fetched on mount from `GET
              /api/workspaces`).

              - Active workspace tracked via existing `config` fetch (already
              refreshes on workspace activation via SSE/polling).

              - After switch, invalidate task cache and re-fetch config + tasks.


              ### 5. Edge cases


              - If a configured workspace path no longer exists on disk, show it
              as "unavailable" in the switcher (don't crash).

              - First-time users with no extra workspaces see no switcher (or a
              minimal add-project prompt).

              - Workspace switch while unsaved changes in settings — confirm or
              auto-save.
      - timestamp: '2026-05-26T00:03:49.096Z'
        message: >-
          Grooming complete. FLUX-298 is now in **Require Input** with two
          questions:


          1. **Workspace labels** — auto-derive from folder basename with
          optional override, or always require a user-provided label?

          2. **Switcher placement** — new dropdown in the top-right button
          cluster, or replace the existing project key input?


          I proposed defaults for both (auto-derive + top-right dropdown). Once
          you answer, I'll finalize the plan and move to Todo.
    user: Claude Code
    date: '2026-05-26T00:01:32.541Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T00:03:50.268Z'
  - type: activity
    user: Agent
    date: '2026-05-26T00:03:34.505Z'
    comment: >-
      Updated description. Changed priority to Medium. Changed effort to L.
      Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Two questions before moving to Todo:


      1. **Workspace label vs. auto-detect**: Should each workspace entry have a
      user-provided label, or should we auto-derive a display name from the
      folder name (e.g. `C:\GitHub\EventHorizon` → "EventHorizon")? Default
      proposal: auto-derive from folder basename, with an optional override
      label.


      2. **Switcher placement**: The description says "top right of the top
      bar". Should this be a dropdown button next to the existing engine/sync
      indicators, or should it replace the current project key input at the
      bottom-right of the header? Default proposal: a new dropdown button in the
      top-right cluster (left of the notification bell), showing the active
      workspace name and a chevron.
    date: '2026-05-26T00:03:41.573Z'
    id: c-2026-05-26t00-03-41-573z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-26T00:03:41.573Z'
  - type: comment
    user: Guy
    date: '2026-05-26T00:04:30.209Z'
    comment: >-
      1. sure as you suggest


      2. yes as you suggest and it should replace the KEY field which kinda ugly
      anyway
    replyTo: c-2026-05-26t00-03-41-573z
    id: c-2026-05-26t00-04-30-207z
title: multi project workflow
status: Require Input
createdBy: Guy
updatedBy: Guy
tokenMetadata:
  inputTokens: 184484
  outputTokens: 2680
  costUSD: 0.494443
  costIsEstimated: false
  cacheReadTokens: 153705
  cacheCreationTokens: 30766
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

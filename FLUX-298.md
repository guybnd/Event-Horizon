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
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-26T00:04:43.961Z'
  - type: agent_session
    sessionId: c806409e-b75d-4216-b601-b5aeb5204282
    startedAt: '2026-05-26T00:04:55.065Z'
    status: completed
    progress:
      - timestamp: '2026-05-26T00:05:09.755Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:get_ticket,list_tickets,update_ticket,change_status,add_comment
            max_results: 5
      - timestamp: '2026-05-26T00:05:11.010Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T00:05:16.360Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore workspace implementation
            subagent_type: Explore
            prompt: >-
              I need to understand the current workspace implementation in this
              Event Horizon project. Find:


              1. The current settings.json structure for workspaces (check
              engine/src/ for how ~/.event-horizon/settings.json is
              read/written)

              2. The existing workspace activation flow (activateWorkspace
              function)

              3. The existing /api/workspace endpoints

              4. The Header.tsx component in portal/src/

              5. WorkspaceSection.tsx in portal/src/

              6. AppContext.tsx in portal/src/

              7. The .flux/config.json structure


              Search broadly - look in engine/src/ and portal/src/ directories.
              I need to understand what already exists so I can groom a ticket
              for adding multi-workspace support.
      - timestamp: '2026-05-26T00:05:17.757Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/**/*.ts
      - timestamp: '2026-05-26T00:05:18.416Z'
        message: 'Running: find /c/GitHub/EventHorizon -name ".flux" -type d ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon -name ".flux" -type d 2>/dev/null |
              head -20
      - timestamp: '2026-05-26T00:05:22.012Z'
        message: Reading workspace.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/workspace.ts
      - timestamp: '2026-05-26T00:05:26.011Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T00:05:29.776Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: activateWorkspace
            path: /c/GitHub/EventHorizon/engine/src
            output_mode: content
            context: 5
      - timestamp: '2026-05-26T00:05:29.976Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/.flux/config.json
      - timestamp: '2026-05-26T00:05:30.267Z'
        message: 'Running: grep -n "activateWorkspace" /c/GitHub/EventHorizon...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              grep -n "activateWorkspace"
              /c/GitHub/EventHorizon/engine/src/task-store.ts | head -20
      - timestamp: '2026-05-26T00:05:32.665Z'
        message: Reading task-store.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/engine/src/task-store.ts
            offset: 598
            limit: 60
      - timestamp: '2026-05-26T00:05:35.887Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: setWorkspace|fetchWorkspace|pickWorkspace
            path: /c/GitHub/EventHorizon/portal/src/api.ts
            output_mode: content
            context: 3
      - timestamp: '2026-05-26T00:05:38.835Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /c/GitHub/EventHorizon/portal/src/api.ts
            offset: 1
            limit: 140
      - timestamp: '2026-05-26T00:05:41.011Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T00:06:09.523Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status
            max_results: 3
      - timestamp: '2026-05-26T00:06:11.022Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T00:06:13.662Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-298
      - timestamp: '2026-05-26T00:06:26.025Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T00:06:38.911Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-298
            body: >-
              ## Problem / Motivation


              Switching between workspaces (project folders with their own
              `.flux/` directory) requires navigating to the Settings page and
              manually entering a path. Users working across multiple
              repos/projects need fast context switching — selecting a workspace
              should reload its settings, tickets, and config instantly. This is
              a core usability feature for multi-project users.


              ## Implementation Plan


              ### 1. App-level workspace list (Engine)


              **File:** `engine/src/workspace.ts`


              - Extend `~/.event-horizon/settings.json` schema: add a
              `workspaces` array of `{ path: string, label?: string }` objects
              alongside the existing `workspace` field (which tracks the active
              workspace).

              - Auto-register: when a workspace is activated, auto-add it to the
              `workspaces` array if not already present.


              **File:** new `engine/src/routes/workspaces.ts`


              - `GET /api/workspaces` — return the stored workspaces list, each
              enriched with:
                - `displayName`: the user-provided `label`, or the folder basename if no label
                - `active`: boolean (matches current workspace path)
                - `available`: boolean (path exists on disk)
              - `POST /api/workspaces` — add a workspace entry `{ path, label?
              }`. Validate path contains `.flux/` or `.flux-store/`.

              - `DELETE /api/workspaces/:index` — remove a workspace entry by
              index.

              - `PUT /api/workspaces/:index` — update label for an entry.

              - `POST /api/workspaces/switch` — body `{ path }`. Calls existing
              `activateWorkspace()` flow, updates `workspace` field in settings.


              ### 2. Settings UI — Manage workspaces


              **File:** `portal/src/components/settings/WorkspaceSection.tsx`


              - Add a "Configured Workspaces" list above the existing folder
              switch section.

              - Each entry shows: display name, path (smaller/muted), remove
              button, optional edit-label icon.

              - "Add Workspace" button: reuses existing `/api/workspace/pick`
              endpoint or manual path input.

              - Keep the existing "Switch workspace" path input as a
              secondary/advanced option below.


              ### 3. Top bar workspace switcher (Portal)


              **File:** `portal/src/components/Header.tsx`


              - **Replace** the project KEY text input (currently bottom-right
              of header) with a workspace switcher dropdown/popover.

              - Display the active workspace's display name (label or folder
              basename).

              - Dropdown shows all configured workspaces; unavailable ones shown
              greyed with "(unavailable)" suffix.

              - Selecting a different workspace calls `POST
              /api/workspaces/switch`, then triggers full app reload (config,
              tasks, board state via `notifyWorkspaceSet()`).

              - Show a brief loading spinner on the switcher button during
              switch.

              - Include a "Manage workspaces..." link at the bottom of the
              dropdown that navigates to Settings.


              ### 4. State management


              **File:** `portal/src/AppContext.tsx`


              - Add `workspaces` state (fetched on mount from `GET
              /api/workspaces`).

              - Expose `switchWorkspace(path)` helper that calls the API and
              then runs the existing `notifyWorkspaceSet()` flow (which
              re-fetches config + tasks).

              - Re-fetch workspaces list after switch completes (to update
              `active` flags).


              ### 5. Edge cases


              - If a configured workspace path no longer exists on disk, show it
              as "unavailable" in the switcher (greyed out, not selectable).

              - First-time users with only one workspace: show the switcher with
              just their current workspace + an "Add workspace" option.

              - Remove the old project KEY input field from the header entirely
              — project keys remain configurable in Settings.

              - Auto-register the current workspace on engine startup if not
              already in the list.


              ### Key files to touch


              | Area | Files |

              |------|-------|

              | Engine settings | `engine/src/workspace.ts` |

              | New routes | `engine/src/routes/workspaces.ts` (new) |

              | Route registration | `engine/src/index.ts` |

              | Portal header | `portal/src/components/Header.tsx` |

              | Portal settings |
              `portal/src/components/settings/WorkspaceSection.tsx` |

              | Portal state | `portal/src/AppContext.tsx` |
      - timestamp: '2026-05-26T00:06:41.027Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T00:06:46.416Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-298
            newStatus: Todo
            comment: >-
              Grooming complete. Both questions resolved: (1) workspace display
              names auto-derived from folder basename with optional label
              override, (2) workspace switcher replaces the project KEY input in
              the header. Plan is detailed with file targets and endpoint specs
              — ready for implementation.
      - timestamp: '2026-05-26T00:06:54.702Z'
        message: >-
          FLUX-298 is groomed and moved to **Todo**. Summary of what was
          finalized:


          - **Labels**: Auto-derived from folder basename, with optional user
          override

          - **Switcher placement**: Replaces the project KEY input in the header
          (per your feedback)

          - **Effort**: L (unchanged) — touches engine routes, workspace
          settings, header component, app context, and settings UI

          - **Plan**: 5 sections covering engine endpoints, settings UI, header
          switcher, state management, and edge cases — with specific file
          targets listed


          Ready for implementation whenever you want to pick it up.
    user: Claude Code
    date: '2026-05-26T00:04:55.065Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T00:06:55.848Z'
  - type: activity
    user: Agent
    date: '2026-05-26T00:06:38.920Z'
    comment: Updated description.
  - type: comment
    user: Agent
    comment: >-
      Grooming complete. Both questions resolved: (1) workspace display names
      auto-derived from folder basename with optional label override, (2)
      workspace switcher replaces the project KEY input in the header. Plan is
      detailed with file targets and endpoint specs — ready for implementation.
    date: '2026-05-26T00:06:46.434Z'
    id: c-2026-05-26t00-06-46-434z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T00:06:46.434Z'
title: multi project workflow
status: Todo
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 373041
  outputTokens: 5054
  costUSD: 0.846087
  costIsEstimated: false
  cacheReadTokens: 326576
  cacheCreationTokens: 46437
order: 14
id: FLUX-298
---
## Problem / Motivation

Switching between workspaces (project folders with their own `.flux/` directory) requires navigating to the Settings page and manually entering a path. Users working across multiple repos/projects need fast context switching — selecting a workspace should reload its settings, tickets, and config instantly. This is a core usability feature for multi-project users.

## Implementation Plan

### 1. App-level workspace list (Engine)

**File:** `engine/src/workspace.ts`

- Extend `~/.event-horizon/settings.json` schema: add a `workspaces` array of `{ path: string, label?: string }` objects alongside the existing `workspace` field (which tracks the active workspace).
- Auto-register: when a workspace is activated, auto-add it to the `workspaces` array if not already present.

**File:** new `engine/src/routes/workspaces.ts`

- `GET /api/workspaces` — return the stored workspaces list, each enriched with:
  - `displayName`: the user-provided `label`, or the folder basename if no label
  - `active`: boolean (matches current workspace path)
  - `available`: boolean (path exists on disk)
- `POST /api/workspaces` — add a workspace entry `{ path, label? }`. Validate path contains `.flux/` or `.flux-store/`.
- `DELETE /api/workspaces/:index` — remove a workspace entry by index.
- `PUT /api/workspaces/:index` — update label for an entry.
- `POST /api/workspaces/switch` — body `{ path }`. Calls existing `activateWorkspace()` flow, updates `workspace` field in settings.

### 2. Settings UI — Manage workspaces

**File:** `portal/src/components/settings/WorkspaceSection.tsx`

- Add a "Configured Workspaces" list above the existing folder switch section.
- Each entry shows: display name, path (smaller/muted), remove button, optional edit-label icon.
- "Add Workspace" button: reuses existing `/api/workspace/pick` endpoint or manual path input.
- Keep the existing "Switch workspace" path input as a secondary/advanced option below.

### 3. Top bar workspace switcher (Portal)

**File:** `portal/src/components/Header.tsx`

- **Replace** the project KEY text input (currently bottom-right of header) with a workspace switcher dropdown/popover.
- Display the active workspace's display name (label or folder basename).
- Dropdown shows all configured workspaces; unavailable ones shown greyed with "(unavailable)" suffix.
- Selecting a different workspace calls `POST /api/workspaces/switch`, then triggers full app reload (config, tasks, board state via `notifyWorkspaceSet()`).
- Show a brief loading spinner on the switcher button during switch.
- Include a "Manage workspaces..." link at the bottom of the dropdown that navigates to Settings.

### 4. State management

**File:** `portal/src/AppContext.tsx`

- Add `workspaces` state (fetched on mount from `GET /api/workspaces`).
- Expose `switchWorkspace(path)` helper that calls the API and then runs the existing `notifyWorkspaceSet()` flow (which re-fetches config + tasks).
- Re-fetch workspaces list after switch completes (to update `active` flags).

### 5. Edge cases

- If a configured workspace path no longer exists on disk, show it as "unavailable" in the switcher (greyed out, not selectable).
- First-time users with only one workspace: show the switcher with just their current workspace + an "Add workspace" option.
- Remove the old project KEY input field from the header entirely — project keys remain configurable in Settings.
- Auto-register the current workspace on engine startup if not already in the list.

### Key files to touch

| Area | Files |
|------|-------|
| Engine settings | `engine/src/workspace.ts` |
| New routes | `engine/src/routes/workspaces.ts` (new) |
| Route registration | `engine/src/index.ts` |
| Portal header | `portal/src/components/Header.tsx` |
| Portal settings | `portal/src/components/settings/WorkspaceSection.tsx` |
| Portal state | `portal/src/AppContext.tsx` |

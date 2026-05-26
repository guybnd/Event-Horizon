---
title: 'Global app settings: dedicated install location with first-boot config'
status: In Progress
priority: High
effort: L
assignee: unassigned
tags:
  - feature
  - engine
  - portal
  - settings
  - infrastructure
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-26T00:43:01.140Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-26T00:43:59.426Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-26T00:48:42.146Z'
    comment: Updated description.
  - type: agent_session
    sessionId: b748815f-89e8-4062-96ef-c6e24d015b9c
    startedAt: '2026-05-26T00:48:43.319Z'
    status: completed
    progress:
      - timestamp: '2026-05-26T00:49:03.930Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:get_ticket,update_ticket,change_status,add_comment,create_subtask
            max_results: 5
      - timestamp: '2026-05-26T00:49:10.431Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-324
      - timestamp: '2026-05-26T00:49:11.172Z'
        message: Reading INDEX.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.docs\INDEX.md'
      - timestamp: '2026-05-26T00:49:14.329Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T00:49:26.710Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: event-horizon.*settings|settings\.json|APPDATA|Application Support
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: files_with_matches
      - timestamp: '2026-05-26T00:49:29.333Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T00:49:30.534Z'
        message: Reading workspace.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\workspace.ts'
      - timestamp: '2026-05-26T00:49:44.334Z'
        message: Reading
        type: info
      - timestamp: '2026-05-26T00:49:59.338Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T00:50:16.634Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-324
            priority: High
            effort: L
            tags:
              - feature
              - engine
              - portal
              - settings
              - infrastructure
            body: >-
              ## Problem / Motivation


              The app's global state lives at a hardcoded
              `~/.event-horizon/settings.json` with a minimal schema
              (`workspace`, `workspaces[]`). User preferences are scattered
              across localStorage, hardcoded defaults, and per-project config.
              There's no formal install concept — the directory silently appears
              on first use. For a multi-project tool that lives permanently on a
              user's machine, we need a proper global data directory,
              centralized user preferences, a first-boot experience, and a
              repeatable project bootstrapping strategy.


              ## Decisions (from user input)


              - **Storage location**: Use platform conventions —
              `%APPDATA%/EventHorizon` (Windows), `~/Library/Application
              Support/EventHorizon` (macOS), `~/.config/event-horizon` (Linux).

              - **First-boot flow**: Show a one-time dialog. If existing data is
              detected at the legacy `~/.event-horizon` path, notify the user
              before any migration so they don't accidentally lose data.

              - **Discovery on upgrade**: Always check the platform-conventional
              path. No sentinel pointer file needed — the canonical path *is*
              the discovery mechanism.

              - **Global settings scope**: `workspaces[]`, `lastWorkspace`,
              `theme`, `defaultUser`, `preferredFramework`, `defaultAgent`,
              `port`, `dataDir`, `boardClickBehavior`, `animations`, `timeouts`.
              Workspace-level settings (not global): `requireComments`,
              `enableBacklog`.

              - **Migration**: Seamless first-boot migration from
              `~/.event-horizon` → new platform path.

              - **Project bootstrapping**: Opinionated defaults (config.json,
              agent skills, .docs/ structure) scaffolded automatically on new
              project creation. Allow post-setup editing. Project templates as a
              future subtask.


              ## Implementation Plan


              ### 1. Platform data directory resolver
              (`engine/src/global-settings.ts`)

              - New module that resolves the global data directory per platform
              using `process.platform` and environment variables (`APPDATA`,
              `XDG_CONFIG_HOME`, etc.).

              - Export `getGlobalDataDir()` returning the platform path.

              - Export `getLegacyDataDir()` returning `~/.event-horizon` for
              migration detection.

              - Export typed `GlobalSettings` interface with all fields above.

              - Read/write functions: `loadGlobalSettings()`,
              `saveGlobalSettings()`.


              ### 2. Migration logic (`engine/src/global-settings.ts` or
              separate `migrate.ts`)

              - On load: if platform path doesn't exist but legacy
              `~/.event-horizon` does, copy contents to the new location.

              - Set a `migratedFrom` field in the new settings to record
              provenance.

              - Do NOT delete the legacy directory automatically — leave that to
              user action.


              ### 3. First-boot flow (engine + portal)

              - Engine: `GET /api/settings/boot-status` endpoint returning `{
              firstBoot: boolean, legacyFound: boolean, dataDir: string }`.

              - Portal: A first-boot dialog component shown when `firstBoot` is
              true. Displays the chosen data directory. If legacy data is
              detected, shows a notice: "Existing data found at [path] — it will
              be migrated to [new path]." User confirms or picks an alternate
              path.

              - Engine: `POST /api/settings/confirm-boot` to finalize (trigger
              migration if needed, write `firstBootCompleted: true`).


              ### 4. Refactor `workspace.ts` to use new global settings

              - Replace hardcoded `APP_SETTINGS_DIR` / `APP_SETTINGS_FILE` with
              calls to `getGlobalDataDir()`.

              - `AppSettings` interface merges into or delegates to
              `GlobalSettings`.

              - All existing workspace CRUD functions continue to work
              unchanged.


              ### 5. Expose global settings in portal

              - Engine: `GET/PUT /api/settings/global` for reading/writing user
              preferences.

              - Portal: Settings page section for global preferences (theme,
              defaultUser, defaultAgent, port, etc.).

              - Separate from workspace-level config (requireComments,
              enableBacklog stay in `.flux/config.json`).


              ### 6. Project bootstrapping on new workspace creation

              - When `POST /api/workspace` points to a folder without `.flux/`:
                - Scaffold `config.json` with statuses, columns, project key derived from folder name.
                - Run skill installer (agent config files for detected/default framework).
                - Create `.docs/` with starter INDEX.md and project overview stub.
              - Opinionated defaults, editable after creation.


              ### 7. Future subtask: project templates

              - Global settings stores a customizable project template applied
              to all new projects.

              - Defer to a separate ticket.


              ## Key Files Affected

              - `engine/src/workspace.ts` — refactor away hardcoded paths

              - `engine/src/global-settings.ts` — new module (core of this
              ticket)

              - `engine/src/index.ts` — wire new routes

              - `engine/src/routes/workspace.ts` — update boot/init logic

              - `portal/src/components/` — first-boot dialog, settings UI
              additions

              - `engine/src/workflow-installer.ts` — bootstrap integration
      - timestamp: '2026-05-26T00:50:21.992Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:mcp__event-horizon__create_subtask'
            max_results: 1
      - timestamp: '2026-05-26T00:50:29.338Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-26T00:50:29.779Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__create_subtask
          parameters:
            parentId: FLUX-324
            title: Customizable project templates in global settings
            status: Grooming
            priority: Low
            effort: M
            tags:
              - feature
              - engine
              - settings
            body: >-
              ## Problem / Motivation


              When bootstrapping new projects, users may want to customize what
              gets scaffolded (statuses, columns, agent configs, doc structure)
              rather than always getting the same opinionated defaults. A
              "project template" stored in global settings would let users
              configure their preferred defaults once and have them applied to
              all new projects.


              ## Scope


              - Add a `projectTemplate` field to global settings schema.

              - UI in settings to edit the template (statuses, columns, default
              tags, agent framework preference).

              - Bootstrap logic reads from template instead of hardcoded
              defaults when available.

              - Ship after FLUX-324 (global settings infrastructure) is
              complete.
      - timestamp: '2026-05-26T00:50:35.251Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-324
            newStatus: Todo
      - timestamp: '2026-05-26T00:50:44.344Z'
        message: Working
        type: info
      - timestamp: '2026-05-26T00:50:47.926Z'
        message: >-
          Grooming complete for FLUX-324. Here's what was done:


          - **Priority**: High (infrastructure that unblocks proper
          multi-workspace UX)

          - **Effort**: L (touches engine, portal, migration logic, and new
          first-boot flow)

          - **Tags**: feature, engine, portal, settings, infrastructure

          - **Body**: Rewrote with a clear Problem/Motivation and a 7-step
          implementation plan covering the platform directory resolver,
          migration, first-boot dialog, workspace.ts refactor, settings UI, and
          project bootstrapping.

          - **Subtask**: Created FLUX-325 for the deferred "customizable project
          templates" feature.


          All open questions are resolved from the user's inline answers —
          ticket is now in **Todo** and ready for implementation.
    user: Claude Code
    date: '2026-05-26T00:48:43.319Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-26T00:50:49.062Z'
  - type: activity
    user: Agent
    date: '2026-05-26T00:50:16.653Z'
    comment: >-
      Updated description. Changed priority to High. Changed effort to L.
      Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-26T00:50:35.390Z'
  - type: comment
    user: Agent
    comment: >-
      Implementation plan: Starting with the core global-settings module (step
      1-2), then refactoring workspace.ts to use it (step 4), adding boot-status
      API endpoints (step 3 engine side), then the portal first-boot dialog and
      settings UI (steps 3+5), and finally project bootstrapping (step 6). Will
      tackle in that order to keep each change buildable.
    date: '2026-05-26T00:53:13.945Z'
    id: c-2026-05-26t00-53-13-945z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-26T00:53:14.367Z'
implementationLink: ''
subtasks:
  - FLUX-325
id: FLUX-324
tokenMetadata:
  inputTokens: 304171
  outputTokens: 4189
  costUSD: 0.462449
  costIsEstimated: false
  cacheReadTokens: 269605
  cacheCreationTokens: 32503
---
## Problem / Motivation

The app's global state lives at a hardcoded `~/.event-horizon/settings.json` with a minimal schema (`workspace`, `workspaces[]`). User preferences are scattered across localStorage, hardcoded defaults, and per-project config. There's no formal install concept — the directory silently appears on first use. For a multi-project tool that lives permanently on a user's machine, we need a proper global data directory, centralized user preferences, a first-boot experience, and a repeatable project bootstrapping strategy.

## Decisions (from user input)

- **Storage location**: Use platform conventions — `%APPDATA%/EventHorizon` (Windows), `~/Library/Application Support/EventHorizon` (macOS), `~/.config/event-horizon` (Linux).
- **First-boot flow**: Show a one-time dialog. If existing data is detected at the legacy `~/.event-horizon` path, notify the user before any migration so they don't accidentally lose data.
- **Discovery on upgrade**: Always check the platform-conventional path. No sentinel pointer file needed — the canonical path *is* the discovery mechanism.
- **Global settings scope**: `workspaces[]`, `lastWorkspace`, `theme`, `defaultUser`, `preferredFramework`, `defaultAgent`, `port`, `dataDir`, `boardClickBehavior`, `animations`, `timeouts`. Workspace-level settings (not global): `requireComments`, `enableBacklog`.
- **Migration**: Seamless first-boot migration from `~/.event-horizon` → new platform path.
- **Project bootstrapping**: Opinionated defaults (config.json, agent skills, .docs/ structure) scaffolded automatically on new project creation. Allow post-setup editing. Project templates as a future subtask.

## Implementation Plan

### 1. Platform data directory resolver (`engine/src/global-settings.ts`)
- New module that resolves the global data directory per platform using `process.platform` and environment variables (`APPDATA`, `XDG_CONFIG_HOME`, etc.).
- Export `getGlobalDataDir()` returning the platform path.
- Export `getLegacyDataDir()` returning `~/.event-horizon` for migration detection.
- Export typed `GlobalSettings` interface with all fields above.
- Read/write functions: `loadGlobalSettings()`, `saveGlobalSettings()`.

### 2. Migration logic (`engine/src/global-settings.ts` or separate `migrate.ts`)
- On load: if platform path doesn't exist but legacy `~/.event-horizon` does, copy contents to the new location.
- Set a `migratedFrom` field in the new settings to record provenance.
- Do NOT delete the legacy directory automatically — leave that to user action.

### 3. First-boot flow (engine + portal)
- Engine: `GET /api/settings/boot-status` endpoint returning `{ firstBoot: boolean, legacyFound: boolean, dataDir: string }`.
- Portal: A first-boot dialog component shown when `firstBoot` is true. Displays the chosen data directory. If legacy data is detected, shows a notice: "Existing data found at [path] — it will be migrated to [new path]." User confirms or picks an alternate path.
- Engine: `POST /api/settings/confirm-boot` to finalize (trigger migration if needed, write `firstBootCompleted: true`).

### 4. Refactor `workspace.ts` to use new global settings
- Replace hardcoded `APP_SETTINGS_DIR` / `APP_SETTINGS_FILE` with calls to `getGlobalDataDir()`.
- `AppSettings` interface merges into or delegates to `GlobalSettings`.
- All existing workspace CRUD functions continue to work unchanged.

### 5. Expose global settings in portal
- Engine: `GET/PUT /api/settings/global` for reading/writing user preferences.
- Portal: Settings page section for global preferences (theme, defaultUser, defaultAgent, port, etc.).
- Separate from workspace-level config (requireComments, enableBacklog stay in `.flux/config.json`).

### 6. Project bootstrapping on new workspace creation
- When `POST /api/workspace` points to a folder without `.flux/`:
  - Scaffold `config.json` with statuses, columns, project key derived from folder name.
  - Run skill installer (agent config files for detected/default framework).
  - Create `.docs/` with starter INDEX.md and project overview stub.
- Opinionated defaults, editable after creation.

### 7. Future subtask: project templates
- Global settings stores a customizable project template applied to all new projects.
- Defer to a separate ticket.

## Key Files Affected
- `engine/src/workspace.ts` — refactor away hardcoded paths
- `engine/src/global-settings.ts` — new module (core of this ticket)
- `engine/src/index.ts` — wire new routes
- `engine/src/routes/workspace.ts` — update boot/init logic
- `portal/src/components/` — first-boot dialog, settings UI additions
- `engine/src/workflow-installer.ts` — bootstrap integration

---
title: 'Global app settings: dedicated install location with first-boot config'
status: Grooming
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
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-26T00:48:43.319Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-26T00:48:56.408Z'
  - type: activity
    user: Agent
    date: '2026-05-26T00:50:16.653Z'
    comment: >-
      Updated description. Changed priority to High. Changed effort to L.
      Updated tags.
implementationLink: ''
subtasks:
  - FLUX-325
id: FLUX-324
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

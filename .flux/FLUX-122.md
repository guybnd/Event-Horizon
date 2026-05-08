---
title: IDE-model workspace selection — pick project folder from the portal
status: Done
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - distribution
priority: High
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:00.000Z'
    comment: Created ticket. User wants the binary to run standalone like an IDE — user picks the project folder from the portal rather than running from within a project.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Plan: refactor engine so workspaceRoot is null at startup (not a hardcoded CWD-based constant).
      The engine starts and serves the portal regardless. Workspace-dependent routes return 503 with
      code NO_WORKSPACE until a folder is selected. Workspace is persisted to ~/.event-horizon/settings.json
      and restored on the next launch. POST /api/workspace validates and hot-activates a new folder.
      Portal shows a WorkspaceSelector screen when no workspace is configured.
    id: c-2026-05-08-plan
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Implementation complete. Summary of changes:

      Engine (engine/src/index.ts):
      - workspaceRoot is now a mutable `let` variable starting as null.
      - All path constants (FLUX_DIR, CONFIG_FILE, TASK_ASSETS_DIR, READ_STATE_FILE) replaced with getter functions that derive from workspaceRoot.
      - requireWorkspace() middleware returns 503 {error, code: NO_WORKSPACE} on all workspace-dependent routes.
      - loadAppSettings() / saveAppSettings() read/write ~/.event-horizon/settings.json.
      - getCliWorkspace() checks --workspace arg without crashing if absent.
      - activateWorkspace(path) resets caches, calls initDir(), starts/restarts chokidar watchers.
      - startWatchers() is now a function that closes existing watchers before creating new ones.
      - GET /api/workspace → {configured, path}; POST /api/workspace → validates .flux/ exists, activates, persists.
      - GET /api/health now returns {status, workspace} so the portal can sync state.
      - Startup: engine listens first, then tries --workspace arg → persisted settings → logs guidance.
      - Dev script still passes --workspace .. so EH development workflow is unchanged.

      Portal:
      - api.ts: fetchWorkspace(), setWorkspace() added. fetchHealth() typed to include workspace field.
      - AppContext.tsx: workspaceConfigured/workspacePath state added. notifyWorkspaceSet() triggers config+tasks reload. Health check syncs workspace state from server.
      - App.tsx: shows WorkspaceSelector instead of AppContent when !workspaceConfigured && isConnected.
      - WorkspaceSelector.tsx: full-screen folder path input + Open Project button with error display.
      - Settings.tsx (workspace tab): "Project Folder" section added at top with current path display and switch input.
    id: c-2026-05-08-done
  - type: comment
    user: Agent
    date: '2026-05-08T17:30:00.000Z'
    comment: >-
      Completed. IDE workspace model shipped. Scope extended to include native
      OS folder picker dialog (POST /api/workspace/pick with PowerShell
      FolderBrowserDialog on Windows, osascript on macOS, zenity/kdialog on
      Linux). Browse button in WorkspaceSelector and Settings. User confirmed.
    id: c-flux122-done
order: 122
---

## Problem / Motivation

The previous model required running the engine binary from within a project directory, which is not how standalone apps work. Users should be able to download the binary, run it from anywhere, and select their project folder from the portal UI — the same way VS Code, Obsidian, or any IDE works.

This also enables switching between projects from the same running instance.

## Implementation

### Engine
- `workspaceRoot` is a mutable variable starting as `null` — no crash on empty startup.
- All `FLUX_DIR`, `CONFIG_FILE`, `TASK_ASSETS_DIR`, `READ_STATE_FILE` constants replaced with `getFluxDir()` / `getConfigFile()` / `getTaskAssetsDir()` / `getReadStateFile()` getter functions.
- `requireWorkspace` Express middleware guards all workspace-dependent routes with a 503.
- `~/.event-horizon/settings.json` persists the last workspace across restarts.
- `POST /api/workspace` validates the folder (must have `.flux/`), activates it live, and saves it.
- `GET /api/workspace` returns `{ configured, path }`.
- `activateWorkspace()` resets caches and restarts chokidar watchers on workspace switch.
- Startup: engine binds port first, then tries `--workspace` arg → persisted settings → logs guidance. Dev script continues to pass `--workspace ..` for EH development.

### Portal
- `WorkspaceSelector.tsx` — full-screen folder picker shown on first launch.
- `AppContext.tsx` — `workspaceConfigured`, `workspacePath`, `notifyWorkspaceSet` exposed.
- `App.tsx` — shows `WorkspaceSelector` when not configured and engine is connected.
- `Settings.tsx` — "Project Folder" section in the Workspace tab shows current path and a switch input.

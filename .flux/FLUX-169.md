---
assignee: Agent
tags:
  - bug
  - backend
  - reliability
priority: Medium
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-10T05:26:32.000Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: Done
    user: Agent
    date: '2026-05-10T05:26:50.000Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:26:50.000Z'
    comment: >-
      Fix shipped. Engine startup now falls back to cwd when no workspace is
      configured and the current working directory contains a .flux/ directory.
      This eliminates the silent 503 failure mode where agent API calls would
      appear to succeed but be silently dropped because no workspace was loaded.
      Workspace resolution order: --workspace CLI arg → persisted
      ~/.event-horizon/settings.json → cwd fallback → prompt user. Change in
      engine/src/index.ts startup block (~line 2413).
    id: c-2026-05-10t05-26-50-000z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.935Z'
title: Engine startup should fall back to cwd when no workspace is configured
status: Released
createdBy: Agent
updatedBy: Agent
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.935Z'
releaseDocPath: release-notes/v0.3.0
---
## Problem

When the engine starts with no saved workspace and no `--workspace` CLI arg, all
workspace-dependent API routes return `503 NO_WORKSPACE`. Agent API calls made
from within a project directory (e.g. `patch-ticket`, direct curl calls) would
fail silently — the error response was misread as success by the caller.

## Fix

Added a cwd fallback to the startup workspace resolution in `engine/src/index.ts`.
If no workspace is configured via CLI arg or persisted settings, and the current
working directory contains a `.flux/` directory, that directory is automatically
activated as the workspace.

**Resolution order:**
1. `--workspace` CLI arg
2. Persisted `~/.event-horizon/settings.json`
3. cwd (if it contains `.flux/`)
4. Prompt user via portal

## Files Changed

- `engine/src/index.ts`: startup block (~line 2413)

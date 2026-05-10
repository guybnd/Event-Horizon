---
assignee: unassigned
tags:
  - bug
  - onboarding
  - ux
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-10T05:06:12.299Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-10T05:06:14.135Z'
    comment: Launched Claude Code session (82975a4c).
  - type: comment
    user: Agent
    date: '2026-05-10T05:09:22.206Z'
    comment: >-
      Groomed. Root cause: POST /api/workspace hard-rejects folders without
      .flux/ before calling initDir(). Fix: remove the NO_FLUX_DIR rejection and
      let activateWorkspace/initDir auto-create the directory. Two-file change:
      engine/src/index.ts (remove ~8 lines) + OnboardingWizard.tsx (update
      description text). Also update onboarding UI text to tell users the wizard
      creates .flux/ automatically.
    id: c-2026-05-10t05-10-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T05:09:22.206Z'
  - type: activity
    user: Agent
    date: '2026-05-10T05:09:22.206Z'
    comment: 'Updated description. Updated tags to bug, onboarding, ux.'
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T05:09:26.434Z'
    comment: >-
      Ticket groomed and moved to Todo. Here's the plan:


      **Root cause:** `POST /api/workspace` in `engine/src/index.ts`
      hard-rejects any folder missing `.flux/` before `initDir()` ever runs. The
      fix removes that guard and lets `activateWorkspace` (which calls
      `initDir`) create `.flux/`, `.flux/assets/`, and a default `config.json`
      automatically.


      **Two-file change:**

      1. `engine/src/index.ts` — remove the `NO_FLUX_DIR` rejection block (~8
      lines)

      2. `portal/src/components/OnboardingWizard.tsx` — update Step 1
      description to say the wizard auto-creates `.flux/` instead of requiring
      `init` first


      Edge cases preserved: missing project root still errors; existing config
      isn't overwritten; watchers start correctly on the new dir.
  - type: activity
    user: Agent
    date: '2026-05-10T05:11:08.215Z'
    comment: Launched Claude Code session (37e57467).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-10T05:11:24.384Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:11:24.385Z'
    comment: >-
      Starting implementation: removing NO_FLUX_DIR rejection from engine,
      updating OnboardingWizard description text.
    id: c-2026-05-10t05-11-24-385z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-10T05:11:48.205Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:11:48.206Z'
    comment: >-
      Implementation complete. Removed the NO_FLUX_DIR rejection block from POST
      /api/workspace in engine/src/index.ts (~8 lines). Updated
      OnboardingWizard.tsx Step 1 description to say the wizard auto-creates
      .flux/ rather than requiring the user to run init first. Validated:
      existsSync import retained (still used on lines 2176, 2254, 2265, 2342).
      Folder-not-found guard preserved. activateWorkspace/initDir already
      handles recursive mkdir and default config creation.
    id: c-2026-05-10t05-11-48-206z
  - type: activity
    user: Agent
    date: '2026-05-10T05:13:09.038Z'
    comment: Launched Claude Code session (61085ee4).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-10T05:13:29.338Z'
  - type: comment
    user: Agent
    date: '2026-05-10T05:13:29.339Z'
    comment: >-
      Implementation complete. Removed the NO_FLUX_DIR rejection block from POST
      /api/workspace in engine/src/index.ts and updated OnboardingWizard.tsx
      Step 1 description to say the wizard auto-creates .flux/ rather than
      requiring init first. Commit: 5084cd944651347e21fee9024f7a90f12c411fff
    id: c-2026-05-10t05-13-29-339z
  - type: agent_message
    user: Claude Code
    date: '2026-05-10T05:13:32.085Z'
    comment: >-
      FLUX-165 is done. Commit `5084cd9` — removed the `NO_FLUX_DIR` rejection
      block from `POST /api/workspace` and updated the onboarding wizard
      description. Users with a valid project folder but no `.flux/` dir can now
      complete onboarding without running `init` first.
  - type: activity
    user: Agent
    date: '2026-05-10T06:08:07.555Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-10T11:10:25.932Z'
title: Fix onboarding flow failures for new users
status: Released
createdBy: Guy
updatedBy: Agent
version: v0.3.0
releasedAt: '2026-05-10T11:10:25.932Z'
releaseDocPath: release-notes/v0.3.0
---
## Problem

The onboarding wizard Step 1 calls `POST /api/workspace` which hard-rejects any folder that lacks a `.flux/` directory (returns 400 with `NO_FLUX_DIR`). This blocks users who have a valid project folder but have not yet run `event-horizon init` — even if they followed the init steps in a different terminal session and the folder exists. The error message is generic and the UI offers no recovery path.

## Root Cause

`POST /api/workspace` in `engine/src/index.ts` (lines 2131-2138) checks `existsSync(fluxPath)` and bails immediately. It never creates the missing folder. The `initDir()` function (line 1049) already knows how to create `.flux/`, `.docs/`, and `.flux/assets/` — it is only called *after* the check passes.

## Fix

Instead of hard-rejecting when `.flux/` is missing, automatically scaffold the workspace:

**`engine/src/index.ts` — `POST /api/workspace` handler (lines 2131-2138):**
- Remove the hard rejection block for `NO_FLUX_DIR`.
- After validating the folder exists, call `activateWorkspace(newRoot)` directly (which calls `initDir()` internally, creating `.flux/`, `.docs/`, `.flux/assets/` via `mkdir({ recursive: true })` and writing a default `config.json` if missing).
- `loadConfig()` inside `initDir()` already falls back to defaults when `config.json` is absent, so no extra scaffolding code is needed.

**`portal/src/components/OnboardingWizard.tsx` — Step 1 description text (line 142-153):**
- Update the helper text to say the wizard will create `.flux/` automatically if it does not exist, rather than requiring the user to run `event-horizon init` first.
- Keep the `event-horizon init` mention as an optional alternative for users who prefer CLI setup.

## Edge Cases Considered

- **Folder does not exist at all**: keep the existing 400 for `Folder not found` — we only auto-create subdirectories, not the project root itself.
- **config.json already present**: `loadConfig()` reads it normally; no overwrite occurs.
- **File watcher**: `startWatchers()` is called inside `activateWorkspace()` so watchers start on the newly created `.flux/` dir without extra changes.
- **WorkspaceSelector (post-onboarding)**: same `POST /api/workspace` path, so the fix applies there too.

## Files to Change

1. `engine/src/index.ts` — remove `NO_FLUX_DIR` rejection block (~8 lines).
2. `portal/src/components/OnboardingWizard.tsx` — update Step 1 description text (~3 lines).

## Validation

- Onboarding wizard: enter a valid folder path with no `.flux/` → wizard advances to Step 2, `.flux/` is created on disk.
- Onboarding wizard: enter a non-existent folder path → still shows "Folder not found" error.
- Existing workspace with `.flux/` already present → still works normally.
- WorkspaceSelector (outside onboarding) with missing `.flux/` → same behaviour, auto-creates.

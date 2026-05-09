---
assignee: unassigned
tags:
  - integration
  - settings
  - installer
priority: Medium
effort: S
implementationLink: 1e29bb9
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T06:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T06:00:00.000Z'
    comment: >-
      Closed. Three integration bugs fixed in commit 1e29bb9:


      1. `portal/src/api.ts` — Added `skillSourcePaths: string[]` to
      `SkillStatus` interface; all 4 phase skill paths now cross the TypeScript
      boundary instead of being dropped.


      2. `portal/src/components/Settings.tsx:494` — Fixed `fetchSkillStatus`
      consumer to read `status.skillSourcePaths` so the Integration panel shows
      all 4 skill source files (orchestrator, grooming, implementation, release)
      not just the orchestrator.


      3. `portal/src/components/Settings.tsx:621` — Replaced hardcoded Windows
      path `npm.cmd run install-skill -- --target c:\\GitHub\\EventHorizon` with
      cross-platform `npm run install-skill -- --target "<workspacePath>"` using
      real path from `useApp()` context.


      4. `engine/src/workflow-installer.ts` — Added `.claude` directory check to
      `resolveFramework` so Claude Code projects auto-detect as `claude`
      framework instead of falling through to `generic`.
    id: c-2026-05-09t06-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T06:00:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:59:30.894Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:59:30.894Z'
    comment: Updated implementation link.
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:59:35.915Z'
    comment: >-
      ```text

      FLUX-145 is closed. Commit `1e29bb9` captures all four fixes:


      - **`api.ts`** — `skillSourcePaths: string[]` added to `SkillStatus` so
      all 4 skill paths cross the TypeScript boundary

      - **`Settings.tsx:494`** — Integration panel now reads
      `status.skillSourcePaths` and shows all 4 phase skill files (not just the
      orchestrator)

      - **`Settings.tsx:621`** — Copy install command now uses the real
      workspace path and cross-platform `npm run` instead of the hardcoded
      Windows path

      - **`workflow-installer.ts`** — `.claude` directory check added to
      `resolveFramework` so this repo correctly auto-detects as `claude` instead
      of `generic`

      ```
    id: c-2026-05-08t14-59-35-915z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.350Z'
title: validate claude code skills integration
status: Released
createdBy: Guy
updatedBy: Agent
description: >-
  ## Overview


  Three bugs found in the Claude Code skills integration:


  1. **`SkillStatus` interface missing `skillSourcePaths`** —
  `portal/src/api.ts` `SkillStatus` interface (lines 141-152) has only
  `skillSourcePath: string` (singular). The engine already returns
  `skillSourcePaths: string[]` (all 4 phase skill files) in
  `WorkflowInstallStatus`, but the field is dropped at the TypeScript boundary.


  2. **Settings UI reads only the orchestrator path** —
  `portal/src/components/Settings.tsx:494` does
  `setSkillSourcePaths(status.skillSourcePath ? [status.skillSourcePath] : [])`,
  wrapping only the orchestrator path. It should read `status.skillSourcePaths`
  to display all 4 skill source files in the "Source Skills" section.


  3. **`handleCopyInstallCommand` has a hardcoded Windows path** —
  `Settings.tsx:621` always generates `npm.cmd run install-skill -- --target
  c:\\GitHub\\EventHorizon --framework ${targetFramework}` regardless of OS or
  actual workspace. It should use the real workspace path from `/api/workspace`.


  4. **`claude` framework missing from auto-detection** —
  `engine/src/workflow-installer.ts` `resolveFramework` checks `.github`,
  `.gemini`, `.cursor`, `.windsurf`, `.cline` but not `.claude`, so Claude Code
  projects always fall through to `generic`. Add a check for `.claude`
  directory.


  ## Implementation Steps


  ### 1. `portal/src/api.ts`

  - Add `skillSourcePaths: string[]` to the `SkillStatus` interface alongside
  the existing `skillSourcePath: string`.


  ### 2. `portal/src/components/Settings.tsx`

  - At line 494, replace `setSkillSourcePaths(status.skillSourcePath ?
  [status.skillSourcePath] : [])` with
  `setSkillSourcePaths(status.skillSourcePaths ?? [])`.

  - In `handleCopyInstallCommand` (around line 621), fetch workspace path from
  `/api/workspace` (already exists in the engine) and use it in the generated
  command. Use `npm run install-skill` (cross-platform) instead of `npm.cmd`.


  ### 3. `engine/src/workflow-installer.ts`

  - In `resolveFramework`, add a check for `.claude` directory after the
  existing framework checks, returning `claude` (or the appropriate constant
  already used by the installer).


  ## Validation

  - Load the Settings > Integration panel and verify all 4 skill source paths
  appear under "Source Skills".

  - Verify the "Copy install command" generates a correct cross-platform command
  with the real workspace path.

  - Verify auto-detection resolves to `claude` when the workspace has a
  `.claude/` directory.


  ## Key Files

  - `portal/src/api.ts` — `SkillStatus` interface

  - `portal/src/components/Settings.tsx` — `fetchSkillStatus` consumer,
  `handleCopyInstallCommand`

  - `engine/src/workflow-installer.ts` — `resolveFramework`
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.350Z'
releaseDocPath: release-notes/0.2.0
---
doo we only supply orchestrator? why not all the individual skills? is the integration buttons setup working correctly?
  Here's my grooming analysis:


      ---


      **Two concrete issues found:**


      **Issue 1 — Settings UI uses `skillSourcePath` (singular) instead of
      `skillSourcePaths` (plural)**


      In `Settings.tsx:494`, the `fetchSkillStatus` result is mapped like this:

      ```ts

      setSkillSourcePaths(status.skillSourcePath ? [status.skillSourcePath] :
      []);

      ```

      But the API (`WorkflowInstallStatus`) already returns `skillSourcePaths:
      string[]` with all 4 skill file paths. The UI wraps only the single
      `skillSourcePath` (orchestrator only) in an array and never reads
      `skillSourcePaths`. So the "Source Skills" section either shows only the
      orchestrator path (after status load), or falls back to the hardcoded
      4-path list (before load). The fallback is fine, but the live data path is
      wrong — it should pass all 4 paths.


      The `SkillStatus` interface in `api.ts:141-152` also lacks
      `skillSourcePaths: string[]`, so the field is lost at the API boundary.


      **Issue 2 — `handleCopyInstallCommand` has a hardcoded Windows path**


      `Settings.tsx:621`:

      ```ts

      const command = `npm.cmd run install-skill -- --target
      c:\\GitHub\\EventHorizon --framework ${targetFramework}`;

      ```

      This always copies a Windows-specific path regardless of the OS or the
      actual workspace path. It should use the real workspace path from context
      or the engine API.


      **Issue 3 (minor) — `claude` framework auto-detection is missing**


      `workflow-installer.ts` checks `.github`, `.gemini`, `.cursor`,
      `.windsurf`, `.cline` for auto-detect but has no check for `.claude`. The
      Claude Code framework always falls through to `generic` on auto-detect.
      This repo itself has `.claude/` and would be mis-categorized.


      ---


      **Proposed plan for `Todo`:**


      1. Add `skillSourcePaths: string[]` to `SkillStatus` interface in `api.ts`

      2. Fix `Settings.tsx:494` to read `status.skillSourcePaths` instead of
      wrapping `status.skillSourcePath`

      3. Fix `handleCopyInstallCommand` to use the actual workspace path (can
      pull it from `AppContext` or engine's `/api/workspace` endpoint)

      4. Add `.claude` auto-detection to `resolveFramework` in
      `workflow-installer.ts`


      Effort: **S** | Priority: **Medium** | Tags: `integration`, `settings`,
      `installer`


      Shall I move this to `Todo` with this plan, or do you want to adjust scope
      before coding starts?

      ```
    id: c-2026-05-08t14-51-52-422z
title: validate claude code skills integration
status: Grooming
createdBy: Guy
updatedBy: Agent
---
doo we only supply orchestrator? why not all the individual skills? is the integration buttons setup working correctly?

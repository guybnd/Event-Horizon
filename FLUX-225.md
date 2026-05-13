---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: de3f8cd
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-12T11:21:59.562Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T11:22:24.250Z'
    comment: Launched Claude Code session (be19b82b).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-12T11:29:39.629Z'
  - type: activity
    user: Agent
    date: '2026-05-12T11:29:39.629Z'
    comment: Updated description.
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T11:31:28.378Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T11:31:36.151Z'
    comment: >-
      Implementation complete. Here's a summary of the fix:


      **Root cause:** When a user sets up a new project via the portal UI, the
      engine calls `activateWorkspace()` → `initDir()`, which creates the
      `.docs/` directory but never seeds it with starter content. The
      `event-horizon init` CLI was the only path that seeded docs — leaving
      portal-created workspaces with an empty docs menu.


      **Fix:** Added `seedStarterDocs()` to `engine/src/task-store.ts`, called
      from `initDir()`. It:

      1. Detects a fresh (empty) `.docs/` dir — existing projects are untouched

      2. Writes `project-overview.md` with the same starter content as `init.ts`

      3. Copies bundled `.docs/event-horizon/` usage guides using the same
      embedded-path resolution as `init.ts` (works in both pkg binary and dev
      mode)


      Ticket is at `Ready` for your review.
  - type: activity
    user: Agent
    date: '2026-05-12T11:31:36.153Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T11:38:56.722Z'
  - type: activity
    user: Agent
    date: '2026-05-12T11:38:56.755Z'
    comment: Launched Claude Code session (b66b5a7e).
  - type: comment
    user: Agent
    comment: >-
      CODE REVIEW — Linus Torvalds, not impressed


      The fix works. The logic is correct. The guard against re-seeding existing
      dirs is fine. But you copy-pasted three functions verbatim from init.ts
      and called it a day:


      1. `resolveEmbeddedDocsRoot()` — IDENTICAL to init.ts line 112. Word for
      word.

      2. `buildStarterProjectOverview()` — IDENTICAL to init.ts line 136. Word
      for word.

      3. `copyDirRecursive()` — IDENTICAL to init.ts `copyDir()`, just renamed.
      Not even a meaningful rename — you picked a longer name for a function
      that was already obviously recursive.


      Do you understand what code duplication MEANS? It means in six months when
      someone fixes the pkg binary path resolution in init.ts, they will NOT fix
      it in task-store.ts. These should be in a shared module — `docs-seeder.ts`
      or similar — imported by both files. This is not optional. This is the
      entire point of having a module system.


      4. `existsSync` from `node:fs` mixed in with async fs everywhere else.
      Pick one. The rest of this file uses async/await with try/catch. Use
      `fs.access()` consistently instead of reaching for the sync version.


      5. `.catch(() => undefined)` on copyDirRecursive swallows errors
      completely silently. If the EH guides fail to copy, the user gets a
      half-seeded docs dir with no indication of what went wrong. At minimum log
      it.


      6. The plan said derive projectKey from config. You derive it from the
      basename of workspaceRoot. Those are different things. If someone
      configured a project name that differs from their directory name, they get
      the wrong value. Read from config like the plan said.


      Extract the shared functions, fix the silent failure, read projectKey from
      config. Then it can ship.
    date: '2026-05-12T11:39:57.587Z'
    id: c-2026-05-12t11-39-57-587z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T11:40:03.558Z'
    comment: >-
      Review posted. Here's the verdict:


      **FLUX-225 — sent back to In Progress with the following issues:**


      1. **Rampant code duplication.** `resolveEmbeddedDocsRoot()`,
      `buildStarterProjectOverview()`, and `copyDirRecursive()` are copy-pasted
      verbatim from `init.ts`. These need to live in a shared module.


      2. **Unnecessary sync import.** `existsSync` from `node:fs` is used in an
      otherwise fully async file. Use `fs.access()`.


      3. **Silent failure swallowed.** `.catch(() => undefined)` on the
      directory copy means a failed EH guides copy goes unnoticed — user gets a
      partial docs dir with no log output.


      4. **projectKey ignores config.** The plan said derive from config; the
      code uses `path.basename(workspaceRoot)`. If the configured project name
      differs from the directory name, wrong value.
  - type: activity
    user: Agent
    date: '2026-05-12T11:40:03.560Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T11:40:31.518Z'
    comment: Launched Claude Code session (3d8db43b).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T11:44:11.146Z'
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T11:44:27.069Z'
    comment: >-
      FLUX-225 is now `Ready`. Here's what was done to address the code review:


      **Changes made:**


      1. **Created `engine/src/docs-seeder.ts`** — new shared module containing
      `resolveEmbeddedDocsRoot`, `copyDir`, and `buildStarterProjectOverview`.
      Both `task-store.ts` and `init.ts` now import from here instead of
      carrying their own copies.


      2. **Removed `existsSync`** from `task-store.ts` — replaced with
      `fs.access()` calls to stay consistent with the async/await style used
      everywhere else in the file.


      3. **Fixed silent error swallowing** — instead of `.catch(() =>
      undefined)`, failures during EH guide copying now log a `console.warn`
      with the destination path and error so problems are visible.


      4. **Fixed projectKey derivation** — `seedStarterDocs` now reads
      `configCache.projects[0]` first and only falls back to the workspace
      basename when the config has no projects array, matching the plan's
      intent.
  - type: activity
    user: Agent
    date: '2026-05-12T11:44:27.074Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T11:44:56.803Z'
    comment: Launched Claude Code session (d8cc1c48).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-12T11:46:20.339Z'
  - type: activity
    user: Agent
    date: '2026-05-12T11:46:20.339Z'
    comment: Updated implementation link.
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T11:46:25.002Z'
    comment: >-
      FLUX-225 is closed. Commit `de3f8cd` — new projects set up via the portal
      UI will now have `project-overview.md` and the bundled EH guides seeded
      into `.docs/` on first activation, matching the CLI `init` flow.
  - type: activity
    user: Agent
    date: '2026-05-12T11:46:25.006Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-13T14:16:35.524Z'
title: 'bug: new project setup starts without docs'
status: Released
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 4524961
  outputTokens: 38496
  costUSD: 2.46104
  costIsEstimated: false
  cacheReadTokens: 4373290
  cacheCreationTokens: 148226
version: v0.5.0
releasedAt: '2026-05-13T14:16:35.524Z'
releaseDocPath: release-notes/v0.5.0
---
## Root Cause

When a user sets up a new project via the portal UI (WorkspaceSelector or OnboardingWizard), the engine calls `activateWorkspace()` → `initDir()`. `initDir()` creates the `.docs/` directory but never seeds it with starter content.

The `event-horizon init` CLI (init.ts) does seed docs: it creates `project-overview.md` and copies bundled `.docs/event-horizon/` guides. But `activateWorkspace()` never calls this logic.

Result: new projects have an empty `.docs/` and the Docs menu shows nothing.

## Fix Plan

1. Add `seedStarterDocs(docsDir: string, projectKey: string)` function to `engine/src/task-store.ts`
   - Creates `project-overview.md` with inline starter content (same as init.ts)
   - Copies embedded `.docs/event-horizon/` guides using same `resolveEmbeddedDocsRoot()` path resolution as init.ts
   - Only runs when the `.docs/` directory is newly created (empty)

2. Call `seedStarterDocs()` from `initDir()` after the `fs.mkdir(getDocsDir())` call, when the directory was just created or is empty

3. Derive the projectKey from the config (falls back to basename of workspaceRoot)

## Touchpoints

- `engine/src/task-store.ts`: add seedStarterDocs, call from initDir
- No portal changes needed

## Validation

- Set workspace to a fresh (empty) directory in portal → docs menu should populate with project-overview and EH guides
- Set workspace to an existing project with existing .docs/ → no change to existing docs

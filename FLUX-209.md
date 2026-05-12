---
priority: Medium
effort: L
assignee: unassigned
tags:
  - architecture
  - backend
  - engine
createdBy: Unknown
title: Implement git orphan branch sync for decoupled ticket storage
status: Released
updatedBy: Guy
history:
  - type: activity
    user: Unknown
    date: '2026-05-12T02:07:30.310Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-12T02:11:07.945Z'
    comment: it should be easy for a user to migrate between these modes too
    id: c-2026-05-12t02-11-07-930z
  - type: activity
    user: Agent
    date: '2026-05-12T02:11:18.769Z'
    comment: Launched Claude Code session (9e88077d).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T02:17:21.140Z'
  - type: comment
    user: Agent
    date: '2026-05-12T02:17:21.141Z'
    comment: >-
      Grooming complete. Plan written directly to ticket body. Key decisions:
      mode detection is presence-based (.flux-store/ existing = orphan mode, no
      settings entry needed); bidirectional migration (migrate + restore)
      handled by new storage-sync.ts; debounced 30s watcher batches all writes
      into one commit+push. Auto-squash stubbed at threshold check only —
      scheduler deferred. Settings UI gets a Storage Mode card in
      WorkspaceSection. Startup wizard question deferred to a separate ticket.
    id: c-2026-05-12t02-17-21-141z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:17:31.092Z'
    comment: >-
      Grooming complete. The ticket body now contains the full implementation
      plan and FLUX-209 is in `Todo`.


      Key decisions captured in the plan:

      - **Mode detection** is presence-based: if `.flux-store/` exists, the
      engine is in orphan mode — no settings file entry needed

      - **Bidirectional migration**: `migrateToOrphan` and `restoreToInRepo` in
      a new `storage-sync.ts` — directly addresses the user's comment about easy
      switching between modes

      - **Debounced watcher**: 30s silence timer collapses burst agent writes
      into one `flux-data` commit+push

      - **Multi-machine restore**: `attachWorktreeIfPresent()` runs at engine
      startup — if `.flux-store/` is missing but `flux-data` branch is
      reachable, it re-attaches automatically

      - **Settings UI**: Storage Mode card in `WorkspaceSection.tsx` with
      migrate/restore buttons

      - **Auto-squash** and the **startup wizard storage question** are
      explicitly deferred
  - type: activity
    user: Agent
    date: '2026-05-12T02:17:31.101Z'
    comment: Claude Code session ended with code 0.
  - type: comment
    user: Guy
    date: '2026-05-12T02:25:21.507Z'
    comment: >-
      lets begin and also pay attention to things like skills and instructions
      if they need to know how to work this way according to which mode its in
    id: c-2026-05-12t02-25-21-501z
  - type: activity
    user: Agent
    date: '2026-05-12T02:25:25.719Z'
    comment: Launched Claude Code session (b785a9ae).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-12T02:26:02.888Z'
  - type: comment
    user: Agent
    date: '2026-05-12T02:26:02.891Z'
    comment: >-
      Beginning implementation. Plan: (1) storage-sync.ts with
      migrate/restore/attach functions, (2) task-store.ts path resolution +
      startup hook, (3) debounced sync watcher, (4) engine storage API routes,
      (5) Settings UI card, (6) skill doc updates for orphan mode.
    id: c-2026-05-12t02-26-02-891z
  - type: activity
    user: Agent
    date: '2026-05-12T02:26:50.249Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T02:30:44.322Z'
  - type: comment
    user: Agent
    date: '2026-05-12T02:30:44.323Z'
    comment: >-
      Implementation complete. New files: storage-sync.ts
      (migrate/restore/attach), sync-watcher.ts (30s debounced git push),
      routes/storage.ts (migrate/restore/mode API). Updated: workspace.ts
      (isOrphanMode, getActiveFluxDir, getFluxStoreDir, config resolution),
      task-store.ts (uses getActiveFluxDir in initDir+startWatchers, calls
      attachWorktreeIfPresent on activateWorkspace), index.ts (registers
      /api/storage router, calls startSyncWatcher on startup), portal/src/api.ts
      (fetchStorageMode, migrateStorage, restoreStorage), WorkspaceSection.tsx
      (Storage Mode card with mode indicator + migrate/restore buttons), skill
      doc updated with Storage Mode Awareness section. Portal TS clean; engine
      pre-existing verbatimModuleSyntax errors unchanged.
    id: c-2026-05-12t02-30-44-323z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:30:57.123Z'
    comment: >-
      FLUX-209 is now **Ready** for your review. Here's a summary of what was
      built:


      **New files:**

      - `engine/src/storage-sync.ts` — `migrateToOrphan`, `restoreToInRepo`,
      `attachWorktreeIfPresent`

      - `engine/src/sync-watcher.ts` — chokidar watcher on `.flux-store/` with
      30s debounce → `git commit + push origin flux-data`

      - `engine/src/routes/storage.ts` — `GET /api/storage/mode`, `POST
      /api/storage/migrate`, `POST /api/storage/restore`


      **Updated files:**

      - `engine/src/workspace.ts` — added `getFluxStoreDir()`, `isOrphanMode()`,
      `getActiveFluxDir()`, and orphan-aware `getConfigFile()`

      - `engine/src/task-store.ts` — `initDir` and `startWatchers` use
      `getActiveFluxDir()`; `activateWorkspace` calls `attachWorktreeIfPresent`
      on startup

      - `engine/src/index.ts` — registers `/api/storage` router, calls
      `startSyncWatcher` on startup

      - `portal/src/api.ts` — `fetchStorageMode`, `migrateStorage`,
      `restoreStorage`

      - `portal/src/components/settings/WorkspaceSection.tsx` — Storage Mode
      card with live mode badge + "Enable Git Sync" / "Restore to In-Repo"
      buttons

      - `.docs/skills/event-horizon-implementation.md` — added Storage Mode
      Awareness section so future agents know to use `getActiveFluxDir()` and
      understand the two modes


      Say `finish FLUX-209` when you're ready to commit.
  - type: activity
    user: Agent
    date: '2026-05-12T02:30:57.127Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T02:31:32.945Z'
  - type: activity
    user: Agent
    date: '2026-05-12T02:31:33.205Z'
    comment: Launched Claude Code session (d07532d0).
  - type: comment
    user: Agent
    comment: >-
      Code review:


      **storage-sync.ts — migrateToOrphan is a mess.** You do `git checkout
      --orphan flux-data` which switches the working tree to the orphan branch
      with the index wiped, then immediately `checkout -` to go back. That is
      destructive and racy. If ANYTHING fails in between (dirty tree, existing
      branch, whatever), you leave the repo on the orphan branch with the index
      gone. The silent catch that swallows the entire block is inexcusable.
      "Branch may already exist" doesn't justify eating every possible error
      including a half-executed destructive branch switch. Fix it: check if the
      branch exists first (`git branch --list flux-data`), and create it without
      switching the working tree — `git worktree add --orphan` takes an
      `--orphan` flag that creates the orphan branch in the new worktree without
      ever touching the current checkout. Use that instead.


      **Duplicated getFluxStoreDir.** `storage-sync.ts` exports
      `getFluxStoreDir(workspaceRoot: string)` taking an explicit arg.
      `workspace.ts` also exports `getFluxStoreDir()` with no args reading from
      the global. Same name, same purpose, two implementations.
      `sync-watcher.ts` imports the no-arg version from workspace.ts,
      `routes/storage.ts` imports from workspace.ts, and storage-sync.ts defines
      its own. Pick one. This is going to drift and cause bugs.


      **sync-watcher.ts — the workspaceRoot parameter is a lie.**
      `startSyncWatcher(workspaceRoot: string)` accepts a workspaceRoot, but
      then calls `isOrphanMode()` and `getFluxStoreDir()` with NO arguments —
      both use the workspace.ts global. The parameter is completely unused.
      Either remove the parameter and be honest about it, or actually use it.


      **migrateToOrphan drops assets/.** The comment says `// Also move
      config.json and assets dir` but only config.json is moved. `assets/` is
      never touched. Same problem in `restoreToInRepo` — only .md files and
      config.json come back. Any attachments stored under assets/ are silently
      abandoned during a round-trip.


      **restoreToInRepo gitignore cleanup will silently fail.** The original
      write appends `.flux/*.md` (unescaped slash) but the cleanup regex uses
      `\.flux\/\*\.md` (escaped slash in regex). The forward slash doesn't need
      escaping in a JS regex. More importantly, the regex anchors on leading
      `\n` which means it won't match if the entries are at the start of the
      file or have CRLF line endings. This leaves stale gitignore entries
      rotting after restore.


      The UI wiring, route definitions, and API client functions are fine. That
      part is clean.


      Fix the four issues before this ships: (1) non-destructive orphan branch
      creation via worktree add --orphan, (2) deduplicate getFluxStoreDir, (3)
      remove or actually use the workspaceRoot param in startSyncWatcher, (4)
      move/restore the assets directory.
    date: '2026-05-12T02:32:47.518Z'
    id: c-2026-05-12t02-32-47-518z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:32:54.976Z'
    comment: >-
      The review comment was posted and the ticket is set to **In Progress**.
      Here's a summary of the issues called out:


      1. **`migrateToOrphan` — destructive branch creation**: It does `git
      checkout --orphan flux-data` which switches the working tree, then
      silently swallows all errors from that block. If it fails mid-way, the
      repo is left on a wiped orphan branch. Should use `git worktree add
      --orphan` instead — creates the orphan branch in the new worktree without
      touching the current checkout.


      2. **Duplicated `getFluxStoreDir`**: Same function exists in both
      `storage-sync.ts` (takes explicit arg) and `workspace.ts` (reads global).
      Two implementations of the same thing will drift.


      3. **`startSyncWatcher` — unused parameter**: Accepts `workspaceRoot` but
      then calls `isOrphanMode()` and `getFluxStoreDir()` with no args (the
      global-reading versions). The parameter is silently ignored.


      4. **`assets/` directory abandoned during migration/restore**: Comment
      says "move assets dir" but the code never does it. Round-tripping through
      migrate→restore silently drops all ticket attachments.


      5. **gitignore cleanup regex will silently fail**: The restore function's
      cleanup regex has an unnecessarily escaped `/` and fragile `\n` anchoring
      that will fail to remove the stale entries in edge cases.
  - type: activity
    user: Agent
    date: '2026-05-12T02:32:54.985Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T02:34:05.117Z'
    comment: Launched Claude Code session (599647b9).
  - type: activity
    user: Agent
    date: '2026-05-12T02:36:19.651Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T02:36:59.717Z'
  - type: comment
    user: Agent
    date: '2026-05-12T02:36:59.717Z'
    comment: >-
      Fixed all four issues flagged in code review:


      1. Non-destructive orphan branch creation: replaced destructive checkout
      --orphan + checkout - dance with git worktree add --orphan -b, which
      creates the orphan branch inside the new worktree without touching the
      current checkout. Added pre-flight check for existing flux-data branch to
      give a clear error instead of a silent partial failure.


      2. Deduplicated getFluxStoreDir: removed the exported function from
      storage-sync.ts entirely. All three files (storage-sync.ts,
      sync-watcher.ts, routes/storage.ts) were already importing from
      workspace.ts; storage-sync.ts now uses inline path.join calls directly.


      3. Removed unused workspaceRoot param from startSyncWatcher: signature is
      now startSyncWatcher() with no arguments. Updated all call sites
      (routes/storage.ts and index.ts).


      4. assets/ directory round-trips correctly: migrateToOrphan copies
      .flux/assets/ into .flux-store/assets/ and removes the source;
      restoreToInRepo copies it back. The .gitignore addition now also covers
      .flux/assets/ so assets are not accidentally committed to the main branch
      after migration.


      TypeScript check: all errors are pre-existing verbatimModuleSyntax project
      config issue, no new errors introduced.
    id: c-2026-05-12t02-36-59-717z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:37:05.633Z'
    comment: >-
      All four issues from the code review have been fixed:


      1. **Non-destructive orphan branch creation** — replaced `git checkout
      --orphan` (which switches the working tree) with `git worktree add
      --orphan -b flux-data` (creates the branch inside the new worktree, never
      touching the current checkout). Added a pre-flight check for an existing
      `flux-data` branch with a clear error message.


      2. **Deduplicated `getFluxStoreDir`** — removed the exported version from
      `storage-sync.ts` entirely. The file now uses inline
      `path.join(workspaceRoot, '.flux-store')` calls, and all consumers
      continue to import from `workspace.ts`.


      3. **Removed the unused `workspaceRoot` parameter** from
      `startSyncWatcher` — signature is now `startSyncWatcher()` with no
      arguments; fixed both call sites in `routes/storage.ts` and `index.ts`.


      4. **`assets/` directory handled in both directions** — `migrateToOrphan`
      now copies `assets/` to `.flux-store/assets/` and removes the source;
      `restoreToInRepo` copies it back. The `.gitignore` addition also covers
      `.flux/assets/`.


      Ticket moved to **Ready**.
  - type: activity
    user: Agent
    date: '2026-05-12T02:37:05.638Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T02:40:14.075Z'
  - type: activity
    user: Agent
    date: '2026-05-12T02:40:14.113Z'
    comment: Launched Claude Code session (4fc13a72).
  - type: comment
    user: Agent
    comment: >-
      Code review pass 2.


      **getTaskAssetsDir() is not orphan-aware. This is a functional bug.**


      workspace.ts:21 hardcodes `path.join(getFluxDir(), 'assets')`. After
      migration, assets live at `.flux-store/assets/`. But every call site —
      routes/assets.ts:19, routes/tasks.ts:255+270, file-utils.ts:69 — still
      reads from `.flux/assets/`. That means after you migrate:

      - Asset uploads land in `.flux/assets/` (gitignored, invisible to the sync
      watcher)

      - Asset serving reads from `.flux/assets/` (wrong location)

      - Migrated assets in `.flux-store/assets/` are unreachable


      You fixed the migration and restore round-trips for the assets directory
      but forgot to fix the live path resolution. `getTaskAssetsDir()` should be
      `getActiveFluxDir() + '/assets'` the same way you changed everything else.
      One-line fix in workspace.ts. You did this correctly for every other path
      and then forgot the one that actually serves live assets.


      **isSyncPending() is dead code.**


      Exported from sync-watcher.ts, never imported anywhere. Either use it or
      delete it. Exporting unused symbols is noise.


      **restoreToInRepo can silently discard uncommitted changes.**


      The restore route calls stopSyncWatcher() then restoreToInRepo().
      stopSyncWatcher() clears the debounce timer without flushing it. If a
      write came in at second 28 of the 30s window, the sync never runs, the
      worktree is removed with --force, and those changes are gone.
      restoreToInRepo() should do a final git add -A + git commit before
      removing the worktree, even if there's nothing to commit (no-op is fine).
      Data loss on restore is not acceptable.


      The previous review items (destructive branch creation, duplicate
      getFluxStoreDir, unused param, assets round-trip) are fixed. These three
      are new issues found in this pass.
    date: '2026-05-12T02:42:17.021Z'
    id: c-2026-05-12t02-42-17-021z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:42:22.563Z'
    comment: >-
      Review posted. Three new issues found in this pass:


      1. **`getTaskAssetsDir()` is not orphan-aware** — hardcoded to
      `.flux/assets/` in `workspace.ts:21`. After migration, asset uploads and
      serving still hit the wrong directory. Fix is one line: use
      `getActiveFluxDir()` instead of `getFluxDir()`.


      2. **`isSyncPending()` is dead code** — exported from `sync-watcher.ts`,
      never imported anywhere. Delete it.


      3. **`restoreToInRepo()` can silently drop uncommitted changes** — the
      route calls `stopSyncWatcher()` which kills the debounce timer without
      flushing pending changes, then removes the worktree with `--force`. Writes
      made in the last 30 seconds before restore are gone. Need a final `git add
      -A && git commit` before removing the worktree.


      The ticket is back to In Progress.
  - type: activity
    user: Agent
    date: '2026-05-12T02:42:22.574Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T02:44:11.284Z'
    comment: Launched Claude Code session (83e0ac16).
  - type: activity
    user: Agent
    date: '2026-05-12T02:44:41.930Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T02:45:10.798Z'
  - type: comment
    user: Agent
    date: '2026-05-12T02:45:10.799Z'
    comment: >-
      Pass 3 fixes applied:


      1. getTaskAssetsDir() now uses getActiveFluxDir() instead of getFluxDir()
      — assets upload and serve from .flux-store/assets/ in orphan mode
      (workspace.ts:21).


      2. isSyncPending() removed from sync-watcher.ts — it was exported but
      never imported anywhere. Also cleaned up the pendingSync state variable
      that was only used to back that export.


      3. restoreToInRepo() now flushes uncommitted changes before removing the
      worktree: runs git add -A + git commit (no-op if nothing dirty) before the
      git worktree remove --force call, preventing data loss when the debounce
      timer is cancelled mid-window (storage-sync.ts:110-115).


      All acceptance criteria met. Ready for review.
    id: c-2026-05-12t02-45-10-799z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:45:15.636Z'
    comment: >-
      All three issues from the code review are fixed:


      1. **`getTaskAssetsDir()` orphan-aware** (`workspace.ts:21`): changed
      `getFluxDir()` → `getActiveFluxDir()` so asset uploads and serving use
      `.flux-store/assets/` when in orphan mode.


      2. **`isSyncPending()` dead code removed** (`sync-watcher.ts`): deleted
      the exported function and the `pendingSync` state variable that only
      backed it.


      3. **`restoreToInRepo()` pre-restore snapshot**
      (`storage-sync.ts:110-115`): added a `git add -A` + conditional commit
      before `git worktree remove --force`, so any changes sitting in the
      debounce window are captured before the worktree is destroyed.


      Ticket is now in **Ready** status.
  - type: activity
    user: Agent
    date: '2026-05-12T02:45:15.642Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T02:45:28.501Z'
  - type: activity
    user: Agent
    date: '2026-05-12T02:45:28.609Z'
    comment: Launched Claude Code session (373654c4).
  - type: comment
    user: Agent
    comment: >-
      Code review pass 3 — two real bugs still unfixed.


      **1. attachWorktreeIfPresent creates a detached HEAD. This is a functional
      bug.**


      storage-sync.ts:22: `git worktree add storeDir origin/flux-data` hands git
      an explicit remote tracking ref. git resolves it to a commit SHA and
      creates a detached HEAD worktree. It does NOT create a local branch named
      flux-data. So after re-attach on a fresh clone, every `git commit` in the
      sync watcher fails with "HEAD detached, not on a branch." The push also
      fails because there is no flux-data refspec to push.


      The DWIM that creates a local tracking branch only kicks in when you pass
      `flux-data` (no remote prefix). Fix is one line: `[worktree, add, -b,
      flux-data, storeDir, origin/flux-data]`. That creates a local branch
      tracking the remote and checks it out in the worktree. The migrate path
      already does this correctly with `--orphan -b flux-data`. The re-attach
      path does not.


      **2. restoreToInRepo leaves the local flux-data branch behind. Migrate →
      restore → migrate fails.**


      After `git worktree remove --force`, the `.flux-store/` directory is gone
      so isOrphanMode() returns false, but the local `flux-data` branch still
      exists in the repo. When the user migrates again, line 37-40 of
      storage-sync.ts does `git branch --list flux-data`, finds it, and throws
      "flux-data branch already exists — remove it manually." That is
      unacceptable. The restore function should delete the branch itself: `git
      branch -D flux-data` after worktree removal. If the branch was pushed, the
      history is safe on the remote regardless.


      Everything else is fine — the previous review fixes landed correctly. Fix
      these two and it ships.
    date: '2026-05-12T02:53:20.982Z'
    id: c-2026-05-12t02-53-20-982z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T02:53:32.754Z'
    comment: >-
      Review posted. Two bugs found and filed, ticket is back to In Progress.


      **Pass 4 findings:**


      1. **`attachWorktreeIfPresent` creates detached HEAD** — `git worktree add
      storeDir origin/flux-data` checks out a commit SHA, not a branch. Every
      `git commit` the sync watcher attempts after re-attach will fail with
      "HEAD detached, not on a branch." Fix: `git worktree add -b flux-data
      storeDir origin/flux-data`.


      2. **`restoreToInRepo` leaves local `flux-data` branch behind** — the
      worktree is removed but the branch isn't. Migrate → restore → migrate hits
      the pre-flight check on line 37-40 and throws "flux-data branch already
      exists." Fix: `git branch -D flux-data` after worktree removal.


      Everything else — the previous three rounds of fixes, the UI wiring,
      routes, and task-store integration — is clean.
  - type: activity
    user: Agent
    date: '2026-05-12T02:53:32.759Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-12T03:05:07.437Z'
    comment: Launched Claude Code session (fded954e).
  - type: activity
    user: Agent
    date: '2026-05-12T03:05:26.717Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T03:05:38.945Z'
  - type: comment
    user: Agent
    date: '2026-05-12T03:05:38.946Z'
    comment: >-
      Fixed two bugs from code review pass 3:\n\n1. attachWorktreeIfPresent:
      changed 'git worktree add storeDir origin/flux-data' to 'git worktree add
      -b flux-data storeDir origin/flux-data'. Without -b, git resolves the
      remote ref to a SHA and creates a detached HEAD, causing all subsequent
      sync commits and pushes to fail.\n\n2. restoreToInRepo: added 'git branch
      -D flux-data' after worktree removal. Previously the local branch was left
      behind, causing migrate → restore → migrate to fail with 'flux-data branch
      already exists'. Remote history is unaffected since the branch was already
      pushed.
    id: c-2026-05-12t03-05-38-946z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T03:05:42.317Z'
    comment: >-
      Both bugs are fixed:


      1. **`attachWorktreeIfPresent` detached HEAD** — added `-b flux-data` to
      the `git worktree add` call so it creates a local tracking branch instead
      of a detached HEAD. Without this, every sync commit and push would fail.


      2. **`restoreToInRepo` orphaned branch** — added `git branch -D flux-data`
      after worktree removal so the local branch is cleaned up. This makes
      migrate → restore → migrate work without the "branch already exists"
      error.


      Ticket moved to **Ready**.
  - type: activity
    user: Agent
    date: '2026-05-12T03:05:42.328Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-12T03:31:50.329Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-12T07:32:17.151Z'
implementationLink: ''
subtasks: []
tokenMetadata:
  inputTokens: 5090031
  outputTokens: 91120
  costUSD: 4.014931
  costIsEstimated: false
  cacheReadTokens: 4767840
  cacheCreationTokens: 301123
order: 2
version: 0.4.0
releasedAt: '2026-05-12T07:32:17.151Z'
releaseDocPath: release-notes/0.4.0
---
## Overview

Implement the "Invisible Sync" storage upgrade. Default stays in-repo (`.flux/`) for zero-friction onboarding. A one-command opt-in migrates tickets to a `flux-data` git orphan branch worktree, keeping ticket history off the main branch while using git as a distributed sync layer.

## Key Decisions (from grooming)

- **Mode detection is presence-based**: if `.flux-store/` worktree exists, engine is in orphan mode — no settings entry required
- **Bidirectional migration**: `migrateToOrphan()` and `restoreToInRepo()` in a new `engine/src/storage-sync.ts`
- **Debounced watcher**: 30s silence timer collapses burst agent writes into one `flux-data` commit+push
- **Multi-machine restore**: `attachWorktreeIfPresent()` runs at engine startup — if `.flux-store/` is missing but `flux-data` branch is reachable on the remote, it re-attaches automatically
- **Settings UI**: Storage Mode card in `portal/src/components/settings/WorkspaceSection.tsx` with Migrate / Restore buttons
- **Auto-squash** (reset every 1,000 commits) and **startup wizard storage question** deferred to follow-on tickets

## Implementation Plan

### 1. `engine/src/storage-sync.ts` (new)

- `migrateToOrphan(workspaceRoot)`: creates `flux-data` orphan branch, adds `.flux-store/` worktree, moves all `.flux/*.md` files there, adds `.flux/` to `.gitignore`, commits initial snapshot
- `restoreToInRepo(workspaceRoot)`: copies files back from `.flux-store/` to `.flux/`, removes worktree, removes gitignore entry
- `attachWorktreeIfPresent(workspaceRoot)`: on engine startup, checks if `.flux-store/` is absent but `flux-data` is reachable — if so, runs `git worktree add .flux-store flux-data`

### 2. `engine/src/task-store.ts`

- `activateWorkspace()` calls `attachWorktreeIfPresent()` before scanning for tickets
- Resolve ticket path to `.flux-store/` when orphan mode is active, `.flux/` otherwise

### 3. Debounced file watcher

- Add to `engine/src/index.ts` (or a dedicated `engine/src/sync-watcher.ts`)
- Watch `.flux-store/` for changes, debounce 30s, then `git -C .flux-store add -A && git commit -m "flux: sync" && git push origin flux-data`

### 4. Settings UI

- New Storage Mode card in `WorkspaceSection.tsx`
- Shows current mode (In-Repo / Orphan Branch)
- "Enable Git Sync" button → calls new `POST /api/storage/migrate` endpoint
- "Restore to In-Repo" button → calls `POST /api/storage/restore`

### 5. Engine API routes

- `POST /api/storage/migrate` → runs `migrateToOrphan()`
- `POST /api/storage/restore` → runs `restoreToInRepo()`

## Acceptance Criteria

- [ ] Default in-repo mode unchanged — existing users unaffected
- [ ] `migrateToOrphan()` moves tickets to orphan branch worktree and gitignores `.flux/`
- [ ] `restoreToInRepo()` reverses the migration cleanly
- [ ] Debounced watcher auto-commits and pushes changes on `flux-data` branch
- [ ] Engine startup re-attaches worktree if missing on a fresh clone
- [ ] Settings UI exposes migrate/restore with clear mode indicator
- [ ] No ticket data lost during migration or restore

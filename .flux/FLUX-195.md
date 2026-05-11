---
priority: High
effort: S
tags:
  - bug
  - engine
assignee: unassigned
createdBy: Agent
title: >-
  Ticket silently disappears from board after engine restart when file exists on
  disk
status: Released
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-11T03:39:18.254Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T05:19:50.421Z'
    comment: Launched Claude Code session (bd761b47).
  - type: activity
    user: Agent
    date: '2026-05-11T05:20:31.512Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T05:20:37.477Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:20:37.478Z'
    comment: >-
      Grooming complete. Fix: added eager scan at end of initDir() in
      engine/src/task-store.ts — reads all .flux/*.md files via fs.readdir and
      calls loadTask for each before the chokidar watcher starts. Watcher add
      events for the same files are idempotent. No new tests needed; existing
      engine startup covers this path. Ready to implement (change is already
      applied).
    id: c-2026-05-11t05-20-37-478z
  - type: activity
    user: Agent
    date: '2026-05-11T05:20:56.378Z'
    comment: Updated description.
  - type: activity
    user: Agent
    date: '2026-05-11T05:21:00.253Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T05:24:03.206Z'
    comment: Launched Claude Code session (8ea9cc2a).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-11T05:24:25.177Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:24:25.178Z'
    comment: >-
      Starting implementation verification — fix already applied at
      task-store.ts:265-270.
    id: c-2026-05-11t05-24-25-178z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-11T05:24:58.805Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:24:58.807Z'
    comment: >-
      Implementation verified. Eager scan correctly placed at end of initDir()
      (task-store.ts:265-270), runs before chokidar watcher starts, uses
      isTopLevelTaskFile to filter .flux/*.md only. Watcher add events are
      idempotent — no duplicate-load risk. Pre-existing TS errors in
      claude-code.ts are unrelated. No docs changes needed.
    id: c-2026-05-11t05-24-58-807z
  - type: activity
    user: Agent
    date: '2026-05-11T05:25:01.985Z'
    comment: Claude Code session ended with code 0.
  - type: activity
    user: Agent
    date: '2026-05-11T05:25:07.220Z'
    comment: Launched Claude Code session (77967ce1).
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-11T05:25:29.212Z'
  - type: comment
    user: Agent
    date: '2026-05-11T05:25:29.213Z'
    comment: >-
      Committed c5addac. Eager scan in initDir() pre-populates the task cache
      from .flux/*.md before the chokidar watcher starts, so all tickets appear
      in GET /api/tasks immediately after engine restart. Watcher add events
      remain idempotent — no duplicate-load risk.
    id: c-2026-05-11t05-25-29-213z
  - type: activity
    user: Agent
    date: '2026-05-11T05:25:34.409Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-11T05:55:57.047Z'
tokenMetadata:
  inputTokens: 640137
  outputTokens: 4938
  costUSD: 0.447621
  costIsEstimated: false
version: v0.3.1
releasedAt: '2026-05-11T05:55:57.047Z'
releaseDocPath: release-notes/v0.3.1
---
## Implementation Plan

### Problem

After engine restart, tickets already on disk are absent from `GET /api/tasks` until a file-touch triggers the chokidar watcher. `initDir()` does not pre-populate the cache before the watcher starts, so any chokidar `add` race or missed event leaves tickets silently missing.

### Fix — `engine/src/task-store.ts`

Add an eager scan at the end of `initDir()` that reads all `*.md` files from `.flux/` and calls `loadTask` for each one. Chokidar `add` events for those same files are idempotent (`loadTask` overwrites with the same data), so there is no double-load risk.

```ts
const fluxFiles = await fs.readdir(getFluxDir()).catch(() => [] as string[]);
for (const name of fluxFiles) {
  if (isTopLevelTaskFile(path.join(getFluxDir(), name))) {
    await loadTask(path.join(getFluxDir(), name));
  }
}
```

This code is already applied in `initDir()` (~line 265).

### Validation

- Restart the engine and immediately call `GET /api/tasks` — all tickets on disk should appear.
- Confirm no duplicate entries after the watcher fires its own `add` events.

### Files Changed

- `engine/src/task-store.ts` — `initDir()` function only
(isTopLevelTaskFile(path.join(getFluxDir(), name))) {
    await loadTask(path.join(getFluxDir(), name));
  }
}
```

This code is already applied in `initDir()` (~line 265).

### Validation

- Restart the engine and immediately call `GET /api/tasks` — all tickets on disk should appear.
- Confirm no duplicate entries after the watcher fires its own `add` events.

### Files Changed

- `engine/src/task-store.ts` — `initDir()` function only
 no duplicate entries after the watcher fires its own `add` events.

### Files Changed

- `engine/src/task-store.ts` — `initDir()` function only

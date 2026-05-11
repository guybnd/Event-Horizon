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
status: Grooming
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-11T03:39:18.254Z'
    comment: Created ticket.
---
## Bug

After an engine restart, a ticket file that exists on disk is not served by `GET /api/tasks` and appears missing from the board. Touching the file (or any other watcher-triggering event) causes it to reappear immediately.

## Root Cause

`initDir()` creates directories, loads docs, config, and pricing but does not perform an initial scan of `.flux/*.md` files. Task loading is handled exclusively by the chokidar watcher `on("add")` event, which fires during the watcher initial scan.

When the engine restarts, `activateWorkspace` resets `tasksCache = {}` and calls `startWatchers()`. Chokidar starts a fresh watch on `.flux/` and fires `add` for each file it discovers. The failure mode is a chokidar race or missed event: if chokidar does not emit `add` for a file (e.g. due to OS-level inode caching, rapid restart under `tsx watch`, or watcher timing), `loadTask` is never called and the ticket stays absent from `tasksCache` with no error logged.

The engine has no fallback — `initDir` does not explicitly read `.flux/` and pre-populate the cache before the watcher starts.

## Affected Code

- `initDir()` (~line 1074): does not scan `.flux/*.md`
- `activateWorkspace()` (~line 1169): relies entirely on the watcher for initial load
- `startWatchers()` (~line 1091): no explicit eager-load before delegating to chokidar events

## Fix

Add an explicit eager scan in `initDir()` (or after `startWatchers()` in `activateWorkspace`) that reads all `*.md` files in `.flux/` and calls `loadTask` for each. The watcher `add` events that follow for the same files are idempotent, so there is no double-load risk.

```ts
const fluxFiles = await fs.readdir(getFluxDir());
for (const name of fluxFiles) {
  if (name.endsWith('.md')) {
    await loadTask(path.join(getFluxDir(), name));
  }
}
```

## Reproduction

1. Have a ticket file on disk.
2. Restart the engine (source-change restart under `tsx watch` is the most reliable trigger).
3. Check `GET /api/tasks` — the ticket is absent.
4. Touch the file — it reappears immediately.

## Workaround

Touch the missing file to trigger a watcher `change` event.

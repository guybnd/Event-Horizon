---
title: Fix Gemini CLI session abandonment bugs
status: Backlog
priority: High
effort: Medium
tags:
  - bug
  - engine
  - agents
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-14T07:12:06.914Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-14T08:46:19.105Z'
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T05:36:48.785Z'
order: 164
---

## Problem / Motivation

Gemini CLI agent sessions are incorrectly reported as "abandoned (engine restarted)" on certain tickets. Investigation confirmed three distinct bugs:

1. **Exit handler race condition** — `proc.on('exit', …)` is registered *after* `await updateTaskWithHistory()` in `startCliSession`. If Gemini exits during that await (e.g. fast auth/quota error), the exit event fires before the handler is registered. The session is never closed in the ticket file and stays `active` permanently, only cleaned up as "cancelled" on the next engine restart.

2. **SIGTERM ignored by Gemini on Windows** — The `gemini.js` relaunch wrapper has empty SIGTERM/SIGINT/SIGHUP signal handlers. `GeminiAdapter.stop()` calls `proc.kill('SIGTERM')`, which does nothing. The Gemini process keeps running after `stopAllCliSessions` is called (e.g. during graceful shutdown or `tsx watch` restart), leaving sessions orphaned.

3. **No session cleanup on unexpected engine exit** — When the engine exits unexpectedly (e.g. `tsx watch` source-file restart, tray crash), active sessions are only marked abandoned on the *next* startup via `reconcileOrphanedSessions`. There is no synchronous cleanup at the point of exit, so sessions appear abandoned rather than completing or failing cleanly.

**Root cause of "some tickets"**: Tickets requiring engine source-file edits (e.g. FLUX-254) cause `tsx watch` to restart the engine mid-session. This kills all active sessions (including unrelated ones like FLUX-255) simultaneously — confirmed by both sessions terminating at the exact same millisecond (`06:36:35.875Z`).

## Implementation Plan

### 1. Fix exit handler race (engine/src/agents/gemini.ts)

Move the `proc.on('exit', …)` registration to **before** the `await updateTaskWithHistory()` call. To handle the case where the exit fires before the initial write completes, enqueue the initial history write through `enqueueSessionWrite` instead of a bare `await`, so `await session.writeQueue` inside the exit handler will naturally wait for it.

### 2. Fix Windows SIGTERM / process-tree kill (engine/src/agents/gemini.ts + session-store.ts)

In `GeminiAdapter.stop()`, replace `proc.kill('SIGTERM')` with:
- **Windows**: `execSync('taskkill /F /T /PID <pid>')` to kill the entire process tree (wrapper + working child).
- **Other platforms**: keep SIGTERM.

Also update `stopAllCliSessions` to set `session.requestedStop = true` for Gemini sessions so the exit handler marks them `cancelled` (not `failed`) after the kill.

### 3. Synchronous session cleanup on engine exit (engine/src/task-store.ts + engine/src/index.ts)

Add a `reconcileOrphanedSessionsSync()` function using `fs.readFileSync` / `fs.writeFileSync` (from the `node:fs` sync API) that mirrors the existing async `reconcileOrphanedSessions` but runs synchronously.

Hook it in `index.ts` via `process.on('exit', …)` so it runs regardless of how the engine exits (graceful shutdown, uncaught exception, tsx watch restart, tray crash).

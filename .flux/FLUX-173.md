---
assignee: Agent
tags:
  - bug
  - reliability
  - engine
  - agent-workflow
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-10T06:00:00.000Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-10T06:00:00.000Z'
id: FLUX-173
title: engine orphans agent sessions on restart — no SIGTERM handler
status: Todo
createdBy: Agent
updatedBy: Agent
---
## Problem

When the engine restarts (e.g. via `tsx watch` on file save), it sends `SIGTERM` to the old engine process. The engine has no `SIGTERM`/`SIGINT` handler, so it exits immediately:

- Spawned `claude` child processes are orphaned (not killed), continue running against stale ticket context, and burn tokens indefinitely
- `proc.on('exit')` never fires because the engine is already dead before the child exits
- No "session ended" activity entry is ever written to the ticket
- The ticket shows "Launched X session" with no termination — appears active in the UI forever

Two orphaned sessions were observed burning tokens for 2+ hours (PIDs 2305, 3719) before being manually killed.

Additionally, after a restart the engine's in-memory session maps (`cliSessionsById`, `cliSessionIdByTaskId`) are empty, so it has no record of sessions that were active before the restart. Tickets with a dangling "Launched" activity and no "ended" entry remain visually stuck as active.

## Root Causes

1. **No signal handler** — `SIGTERM`/`SIGINT` arrive but the engine has no handler to kill children or flush writes before exit.
2. **No startup reconciliation** — on boot, the engine doesn't scan tickets for open sessions and write cleanup activity for any that were orphaned.

## Fix

### 1. Signal handlers (`engine/src/index.ts`)

Register `SIGTERM` and `SIGINT` handlers before the server starts listening:

```typescript
async function gracefulShutdown(signal: string) {
  stopAllCliSessions(signal);
  // Give in-flight write queues a moment to flush
  await new Promise(r => setTimeout(r, 300));
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
```

`stopAllCliSessions` already sends `SIGTERM` to all child procs and sets `requestedStop = true`. The `proc.on('exit')` handlers will fire (since the engine is still alive during the shutdown window), writing "session stopped" activity to each ticket before the engine exits.

### 2. Startup orphan reconciliation (`engine/src/index.ts`)

After workspace loads and `tasksCache` is populated, scan all tickets. For each ticket where the last `activity` entry contains "Launched … session" with no subsequent "session ended"/"session stopped" entry, append a cleanup activity:

```
"[label] session lost (engine restarted)."
```

This keeps the ticket history honest and clears the visual "active session" indicator (which is driven by the `cliSession` field, not history — but the history cleanup is important for agent context).

Note: the `cliSession` field is derived from the in-memory map, not stored. After restart the map is empty, so `getCliSessionSummaryForTask` already returns `undefined` — the UI will already show no active session. The history cleanup is the remaining gap.

## Files to Change

- `engine/src/index.ts`
  - Add `gracefulShutdown` async function + `SIGTERM`/`SIGINT` registrations (near server startup, after `app.listen`)
  - Add `reconcileOrphanedSessions()` call after workspace is loaded and `tasksCache` is populated

## Validation

1. Start the engine, launch a session on a ticket, edit `engine/src/index.ts` to trigger `tsx watch` restart — confirm the ticket gets a "session stopped" activity and the child `claude` process is no longer running after restart
2. Kill the engine with `Ctrl-C` — same result
3. Manually kill the engine with `kill <pid>` (SIGTERM) — same result
4. Start engine cold with a ticket that has a dangling "Launched" entry — confirm reconciliation writes a "session lost (engine restarted)" cleanup activity

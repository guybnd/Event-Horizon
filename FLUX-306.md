---
title: Fix agent sessions being dropped from ticket history
status: In Progress
priority: High
effort: S
assignee: Agent
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Guy
history:
  - type: activity
    user: Guy
    date: '2026-05-25T06:34:49.004Z'
    comment: Created ticket.
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-25T06:35:03.930Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T06:35:08.891Z'
order: 1
---
## Problem / Motivation

When an agent session is launched from the portal, the engine writes an `agent_session` history entry to the ticket file (`.flux/<id>.md`). The spawned agent (Claude/Copilot/Gemini) then reads and rewrites that file to update status, body, and comments — but it doesn't understand `agent_session` type entries and **silently drops them**. It can also drop comments.

When the session finishes, `updateAgentSession` re-reads the file, can't find the session entry, logs a warning, returns null, and falls through to writing a plain `activity` entry. The UI never sees the rich session with progress data.

This affects all agent sessions launched from the portal — none of them persist their session history.

## Implementation Plan

Two layers of protection in `engine/src/task-store.ts`:

1. **`loadTask` (file watcher protection)** — When chokidar detects the agent rewrote the file, compare the incoming history against the in-memory cache. If `agent_session` or `comment` entries were dropped, re-inject them and write the corrected file back to disk.

2. **`updateAgentSession` (session close fallback)** — If the entry is missing from the file at session end, re-inject it from the live session's in-memory `sessionHistoryEntry` or from the task cache before applying the final update.

## Affected Files

- `engine/src/task-store.ts` — `loadTask()` and `updateAgentSession()`

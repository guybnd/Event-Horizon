---
title: Fix agent sessions being dropped from ticket history
status: Ready
priority: High
effort: S
assignee: Agent
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Agent
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
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-25T06:45:50.906Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T06:45:54.447Z'
  - type: agent_session
    sessionId: eb103e42-67bc-4284-8bd5-0beb8209849b
    startedAt: '2026-05-25T06:45:54.608Z'
    status: cancelled
    progress: []
    user: Copilot CLI
    date: '2026-05-25T06:45:54.608Z'
    outcome: Copilot CLI session stopped by user.
    endedAt: '2026-05-25T06:46:05.186Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-25T06:46:07.814Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T06:46:13.859Z'
  - type: comment
    user: Agent
    date: '2026-05-25T06:47:50.149Z'
    comment: >-
      Code review: PASS. Two-layer defense is correct. loadTask catches
      chokidar-triggered drops by comparing against cache; updateAgentSession
      recovers from live session store or cache at close time. readTaskFromDisk
      extraction is clean DRY. extraFields hardening is a bonus. Only note:
      comment re-injection relies on cached entries having id (set by
      normalizeHistoryEntries running before the protection block). Do not break
      that ordering or comments silently fall through. No changes required.
    id: c-2026-05-25t06-47-50-149z
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-25T06:47:56.674Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T06:47:56.674Z'
  - type: comment
    user: Agent
    date: '2026-05-25T06:47:56.674Z'
    comment: >-
      Implementation complete. Both protection layers are solid: loadTask
      rehydrates dropped entries on file-watch, updateAgentSession recovers from
      live session or cache. Ready for final review.
    id: c-2026-05-25t06-47-56-674z
  - type: agent_session
    sessionId: cec9666d-3e47-4426-bfc4-9f0ebaa6f695
    startedAt: '2026-05-25T06:46:14.057Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-25T06:46:28.464Z'
        message: Reading FLUX-306.md
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\FLUX-306.md'
      - timestamp: '2026-05-25T06:46:28.992Z'
        message: 'Running: git log --oneline -10'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git log --oneline -10
            description: Show recent commits
      - timestamp: '2026-05-25T06:46:29.846Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T06:46:36.921Z'
        message: 'Running: git diff HEAD -- engine/src/history.ts'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git diff HEAD -- engine/src/history.ts
            description: Show uncommitted changes to history.ts
      - timestamp: '2026-05-25T06:46:38.430Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: export.*(cliSessionsById|cliSessionIdByTaskId)
            path: 'C:\GitHub\EventHorizon\engine\src\session-store.ts'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T06:46:43.408Z'
        message: Reading history.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\history.ts'
            offset: 80
            limit: 30
      - timestamp: '2026-05-25T06:46:44.848Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T06:46:47.592Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: type.*comment|comment.*id
            path: 'C:\GitHub\EventHorizon\engine\src\history.ts'
            output_mode: content
            '-n': true
            context: 3
            '-i': true
      - timestamp: '2026-05-25T06:46:50.379Z'
        message: Reading history.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\history.ts'
            offset: 200
            limit: 30
      - timestamp: '2026-05-25T06:46:54.438Z'
        message: Reading task-store.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
            offset: 235
            limit: 80
      - timestamp: '2026-05-25T06:46:57.980Z'
        message: Reading task-store.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
            offset: 96
            limit: 40
      - timestamp: '2026-05-25T06:46:59.851Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T06:47:01.421Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__add_comment,mcp__event-horizon__change_status
            max_results: 2
      - timestamp: '2026-05-25T06:47:14.850Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T06:47:40.131Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__add_comment
          parameters:
            ticketId: FLUX-306
            comment: >-
              Code review: PASS.


              Two-layer defense is correct. loadTask catches chokidar-triggered
              drops by comparing against cache; updateAgentSession recovers from
              live session store or cache at close time. readTaskFromDisk
              extraction is clean DRY. extraFields hardening is a bonus.


              Only note: comment re-injection relies on cached entries having
              `id` (set by normalizeHistoryEntries running before the protection
              block). Don't break that ordering or comments silently fall
              through.


              No changes required.
      - timestamp: '2026-05-25T06:47:44.853Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T06:47:45.079Z'
        message: 'Running: curl -s -X PUT http://localhost:3067/api/tasks/FLU...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              curl -s -X PUT http://localhost:3067/api/tasks/FLUX-306 -H
              "Content-Type: application/json" -d '{"appendHistory": [{"type":
              "comment", "user": "Agent", "date": "'"$(date -u
              +%Y-%m-%dT%H:%M:%S.%3NZ)"'", "comment": "Code review:
              PASS.\n\nTwo-layer defense is correct. loadTask catches
              chokidar-triggered drops by comparing against cache;
              updateAgentSession recovers from live session store or cache at
              close time. readTaskFromDisk extraction is clean DRY. extraFields
              hardening is a bonus.\n\nOnly note: comment re-injection relies on
              cached entries having `id` (set by normalizeHistoryEntries running
              before the protection block). Don't break that ordering or
              comments silently fall through.\n\nNo changes required."}]}'
            description: Post review comment via REST API
      - timestamp: '2026-05-25T06:47:56.431Z'
        message: 'Running: TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) && cu...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) && curl -s -X PUT
              http://localhost:3067/api/tasks/FLUX-306 -H "Content-Type:
              application/json" -d "{\"status\": \"Ready\", \"appendHistory\":
              [{\"type\": \"status_change\", \"from\": \"In Progress\", \"to\":
              \"Ready\", \"user\": \"Agent\", \"date\": \"$TIMESTAMP\"},
              {\"type\": \"comment\", \"user\": \"Agent\", \"date\":
              \"$TIMESTAMP\", \"comment\": \"Implementation complete. Both
              protection layers are solid: loadTask rehydrates dropped entries
              on file-watch, updateAgentSession recovers from live session or
              cache. Ready for final review.\"}]}" | python -c "import sys,json;
              d=json.load(sys.stdin); print(d.get('status','ERROR'))"
            description: Move ticket to Ready status
    user: Claude Code
    date: '2026-05-25T06:46:14.057Z'
    outcome: Claude Code session stopped by user.
    endedAt: '2026-05-25T06:47:56.792Z'
order: 0
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

---
priority: Medium
tags:
  - ui
  - ux
effort: S
title: Add sync status indicator to portal UI
status: In Progress
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-05-13T04:21:41.539Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T04:23:25.213Z'
    comment: Launched Claude Code session (5abd3190).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T04:24:10.066Z'
  - type: comment
    user: Agent
    date: '2026-05-13T04:24:10.067Z'
    comment: >-
      Starting implementation: adding sync status indicator to portal header
      with SSE real-time updates
    id: c-2026-05-13t04-24-10-067z
  - type: comment
    user: Agent
    date: '2026-05-13T04:25:34.591Z'
    comment: >-
      Implementation complete: Created SyncStatusIndicator component with SSE
      real-time updates, integrated into Header between agent sessions and
      engine status. Shows visual states for idle/syncing/synced/error/offline
      with color coding matching existing header design patterns.
    id: c-2026-05-13t04-25-34-591z
  - type: activity
    user: Agent
    date: '2026-05-13T04:27:43.809Z'
    comment: Claude Code session lost (engine restarted).
---
## Context

Parent ticket: FLUX-235

The sync-watcher now exposes status through `/api/sync-status` and `/api/sync-status/stream` endpoints. This subtask adds UI to display sync state to users.

## Requirements

Show sync state with visual indicators:
- ?? **Synced** - last sync time
- ?? **Syncing...** - sync in progress
- ?? **Error** - sync failed (show error type)
- ?? **Offline** - no remote configured
- ?? **Network** - network failure (working offline)
- ?? **Auth** - authentication failure

## Implementation

**Location options:**
1. Portal header (persistent indicator)
2. Toast notification (on state change)
3. Settings > Storage Mode card (detailed status)

**Technical:**
- Connect to `/api/sync-status/stream` SSE endpoint
- Subscribe to status changes
- Display appropriate icon/message based on state
- Show last sync timestamp when synced
- Show error details when failed

## Acceptance Criteria

- User can see current sync status at a glance
- Status updates in real-time (via SSE)
- Error states show actionable information
- Offline mode clearly distinguished from broken sync

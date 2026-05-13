---
priority: Medium
tags:
  - ui
  - ux
effort: S
id: FLUX-237
title: Add sync status indicator to portal UI
status: Todo
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-05-13T04:21:41.539Z'
    comment: Created ticket.
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

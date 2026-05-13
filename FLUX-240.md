---
id: FLUX-240
priority: Low
assignee: Agent
tags:
  - ui
  - sync
effort: XS
createdBy: Unknown
updatedBy: Unknown
implementationLink: ''
title: Manual sync trigger on sync status button click
status: Done
history:
  - type: activity
    user: Unknown
    date: '2026-05-13T07:44:47.192Z'
    comment: Created ticket.
---
## What was done

Added a click handler to the sync status indicator button in the portal header that triggers an immediate sync when clicked.

## Changes

- `engine/src/sync-watcher.ts`: exported `triggerSync()` — calls `runSync` immediately
- `engine/src/routes/sync-status.ts`: added `POST /api/sync-status/sync` endpoint
- `portal/src/api.ts`: added `triggerSync()` fetch call
- `portal/src/components/SyncStatusIndicator.tsx`: button is now always clickable (except during active sync); idle/synced/error states trigger a sync, conflict state still opens the resolution modal. Tooltip appends "— click to sync now" when actionable.

## Validation

Engine builds clean. tsx watch hot-reloaded changes.

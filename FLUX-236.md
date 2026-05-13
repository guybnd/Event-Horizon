---
priority: Medium
tags:
  - ui
  - git
  - reliability
effort: M
title: Add conflict resolution UI for orphan branch sync
status: In Progress
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-05-13T04:21:40.564Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-13T04:23:27.422Z'
    comment: Launched Claude Code session (dc9ccc4b).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T04:24:02.441Z'
  - type: comment
    user: Agent
    date: '2026-05-13T04:24:02.442Z'
    comment: >-
      Reading current sync implementation to understand conflict detection
      points.
    id: c-2026-05-13t04-24-02-442z
  - type: activity
    user: Agent
    date: '2026-05-13T04:27:43.809Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T04:33:25.200Z'
  - type: comment
    user: Agent
    date: '2026-05-13T04:33:25.201Z'
    comment: >-
      Implementation complete. Fixed API endpoint URL mismatch in
      SyncStatusIndicator.tsx (changed /api/sync/resolve-conflicts to
      /api/storage/resolve-conflicts). All backend and frontend components
      validated and building successfully. Ready for testing with real sync
      conflicts.
    id: c-2026-05-13t04-33-25-201z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T04:33:39.290Z'
    comment: >-
      Perfect! The ticket has been successfully updated to "Ready" status with a
      completion comment. Let me create a summary of what was done:


      ## Summary


      I've successfully completed the implementation review and bug fix for
      FLUX-236 (Add conflict resolution UI for orphan branch sync).


      **Issue Found & Fixed:**

      - **Bug**: `SyncStatusIndicator.tsx` was calling
      `/api/sync/resolve-conflicts` instead of the correct backend endpoint
      `/api/storage/resolve-conflicts`

      - **Fix**: Updated line 227 in `SyncStatusIndicator.tsx` to use the
      correct endpoint path


      **Implementation Status:**


      All required components are implemented and validated:


      **Backend** (engine/src/):

      - `sync-watcher.ts`: Conflict detection logic, `resolveConflicts()`
      function, and conflict state tracking

      - `routes/storage.ts`: `POST /api/storage/resolve-conflicts` endpoint

      - `routes/sync-status.ts`: `GET /api/sync-status` and SSE stream for
      real-time updates


      **Frontend** (portal/src/):

      - `ConflictResolutionModal.tsx`: Full-featured modal with side-by-side
      conflict preview

      - `SyncStatusIndicator.tsx`: Live sync status indicator in header (now
      with correct API endpoint)

      - `App.tsx`: SSE subscription and conflict modal orchestration

      - `api.ts`: Type-safe API functions for sync operations


      **Validation:**

      - ✅ Portal builds successfully

      - ✅ Engine routes are properly wired

      - ✅ All API endpoints correctly mapped


      **Ticket Status:** Moved to **Ready** - awaiting user review and testing
      with real sync conflicts.
  - type: activity
    user: Agent
    date: '2026-05-13T04:33:39.506Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-13T04:34:09.942Z'
  - type: activity
    user: Agent
    date: '2026-05-13T04:34:10.234Z'
    comment: Launched Claude Code session (140d7e1c).
tokenMetadata:
  inputTokens: 927967
  outputTokens: 4109
  costUSD: 0.537461
  costIsEstimated: false
  cacheReadTokens: 868458
  cacheCreationTokens: 47950
---
## Context

Parent ticket: FLUX-235

When sync detects that local and remote have diverged with conflicting ticket changes, we currently reset to remote (with backup). This subtask adds a UI flow for user-driven conflict resolution.

## Requirements

1. **Detect conflicts** - Identify when local changes would be lost (ticket exists both locally and remotely with different content)
2. **Pause sync** - Don't auto-reset when conflicts detected
3. **Show modal** with options:
   - "Use remote version (discard local)"
   - "Rename local to FLUX-XXX" (allocate new ID)
   - "Show diff and let me merge"
4. **Apply user choice** and continue sync

## Implementation

**Backend:**
- Add conflict detection to `sync-watcher.ts:runSync()`
- Add `POST /api/storage/resolve-conflicts` endpoint
- Emit conflict status through sync status observable

**Frontend:**
- Add conflict resolution modal in portal
- Show diff viewer for "Show diff" option
- Handle resolution and trigger sync continuation

## Acceptance Criteria

- When divergence detected, sync pauses and modal appears
- User can choose resolution strategy
- Sync completes after user resolves conflicts
- No silent data loss

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

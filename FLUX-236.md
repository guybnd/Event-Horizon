---
priority: Medium
tags:
  - ui
  - git
  - reliability
effort: M
id: FLUX-236
title: Add conflict resolution UI for orphan branch sync
status: Todo
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-05-13T04:21:40.564Z'
    comment: Created ticket.
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

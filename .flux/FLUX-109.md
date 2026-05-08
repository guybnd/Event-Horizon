---
assignee: unassigned
tags:
  - feature
  - ux
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:00:43.704Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T12:30:00.000Z'
    comment: >-
      Groomed. Add `archiveStatus` config field (default `'Archived'`) following
      the same pattern as `requireInputStatus` and `readyForMergeStatus`.
      Implementation: (1) Add `archiveStatus?: string` to `Config` in types.ts.
      (2) Add `DEFAULT_ARCHIVE_STATUS` and `getArchiveStatus()` to workflow.ts.
      (3) Filter archived tasks from the board in Board.tsx alongside the
      Released filter. (4) Add archiveStatus input to Settings.tsx. Search is
      already unaffected — it reads all tasks from context.
    id: c-flux109-groom
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T12:30:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:35:00.000Z'
    comment: >-
      Implemented. Added `archiveStatus?: string` to Config in types.ts,
      `DEFAULT_ARCHIVE_STATUS = 'Archived'` and `getArchiveStatus()` to
      workflow.ts, archive filter in Board.tsx alongside the Released exclusion,
      and Archive Status select field in Settings.tsx (with Restore button, same
      pattern as requireInputStatus/readyForMergeStatus). No errors.
    id: c-flux109-done
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T12:35:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:40:00.000Z'
    comment: >-
      Bug fix: task filter alone was insufficient — the Archived column itself
      still rendered when it was in config.columns. Added a `.filter(c => c !==
      archiveStatus)` to `allColumns` in Board.tsx so the column is also
      excluded from rendering.
    id: c-flux109-fix
  - type: comment
    user: Agent
    date: '2026-05-08T13:45:00.000Z'
    comment: >-
      Done. Committed c41a465. Archive status feature is complete — tickets in
      the configured archive status are hidden from board tasks and column list,
      but remain searchable. Settings UI includes the Archive Status field with
      Restore button.
    id: c-flux109-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T13:45:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-08T00:38:08.254Z'
title: add archive status that hides tickets from all surfaces except search
status: Done
createdBy: Guy
updatedBy: Guy
order: 75
---

# Goal

Add a configurable `archiveStatus` (default `'Archived'`) that hides tickets from all board and backlog surfaces while keeping them discoverable via search.

# Implementation Plan

1. **`portal/src/types.ts`** — Add `archiveStatus?: string` to `Config`.
2. **`portal/src/workflow.ts`** — Add `DEFAULT_ARCHIVE_STATUS = 'Archived'` and `getArchiveStatus(config)` helper.
3. **`portal/src/components/Board.tsx`** — Import `getArchiveStatus`, add `task.status !== archiveStatus` filter alongside the `Released` exclusion.
4. **`portal/src/components/Settings.tsx`** — Add `archiveStatus` text field (same pattern as `requireInputStatus`), include in `originalPayload`, `currentSavedPayload`, `handleDiscard`, and save payload.

# Validation

- Create a ticket, move it to "Archived" — it disappears from the board.
- Search for it by title — it appears in search results.
- The archived status is configurable via Settings.

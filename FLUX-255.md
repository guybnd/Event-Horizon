---
title: Fix drag-and-drop race condition in board
status: Ready
priority: Medium
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - bug
  - ui-ux
history:
  - type: activity
    user: Guy
    date: '2026-05-14T03:05:00.000Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-14T03:05:00.000Z'
    comment: Created ticket to track drag-and-drop instability fix.
  - type: comment
    user: Guy
    date: '2026-05-14T06:32:51.122Z'
    comment: Note
    id: c-2026-05-14t06-32-51-046z
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-14T06:32:51.122Z'
    comment: Included with comment
order: 0
---

## Problem / Motivation

Users reported that dragging and dropping tickets between columns would occasionally "flip back" to the original status. This was diagnosed as a race condition in `Board.tsx` where the optimistic UI update is overwritten by the background task polling (every 3 seconds) before the server's update has been fully processed or returned in a fresh fetch.

## Implementation Plan

1.  **Add a `movingTaskIds` ref or state** to `Board.tsx` to track tickets currently undergoing a status change.
2.  **Filter incoming poll results**: Prevent `useEffect` from updating the local task state for any ticket ID currently in the "moving" set.
3.  **Cleanup**: Remove the ticket ID from the set only after the API call completes and a fresh refresh is triggered.

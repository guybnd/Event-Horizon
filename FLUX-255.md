---
title: Fix drag-and-drop race condition in board
status: In Progress
priority: Medium
createdBy: Guy
updatedBy: Agent
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
  - type: comment
    user: Guy
    date: '2026-05-14T06:34:38.253Z'
    comment: >-
      the problem seemed to have stemmed from the requirement to update comment
      while changing status. this was fixed, however. now dragging and dropping
      always requires putting in a comment while changing status, ignoring the
      actual setting from the settings page which could allow without it
    replyTo: c-2026-05-14t06-32-51-046z
    id: c-2026-05-14t06-34-38-221z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-14T06:34:38.253Z'
    comment: Returned to work
  - type: agent_session
    sessionId: 3fb23965-f840-406b-89a6-ea0e7d2eeacd
    startedAt: '2026-05-14T06:34:38.316Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-14T06:34:53.157Z'
        message: Working
      - timestamp: '2026-05-14T06:34:53.916Z'
        message: Working
    user: Gemini CLI
    date: '2026-05-14T06:34:38.316Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-14T06:36:35.875Z'
  - type: agent_session
    sessionId: f5b4720e-fb97-4b25-bcc2-55d804747785
    startedAt: '2026-05-14T08:02:32.242Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-14T08:02:46.745Z'
        message: Working
      - timestamp: '2026-05-14T08:02:47.944Z'
        message: Working
    user: Gemini CLI
    date: '2026-05-14T08:02:32.242Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-14T08:05:37.587Z'
order: 0
effort: None
implementationLink: ''
---

## Problem / Motivation

Users reported that dragging and dropping tickets between columns would occasionally "flip back" to the original status. This was diagnosed as a race condition in `Board.tsx` where the optimistic UI update is overwritten by the background task polling (every 3 seconds) before the server's update has been fully processed or returned in a fresh fetch.

## Implementation Plan

1.  **Add a `movingTaskIds` ref or state** to `Board.tsx` to track tickets currently undergoing a status change.
2.  **Filter incoming poll results**: Prevent `useEffect` from updating the local task state for any ticket ID currently in the "moving" set.
3.  **Cleanup**: Remove the ticket ID from the set only after the API call completes and a fresh refresh is triggered.

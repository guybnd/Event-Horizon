---
title: Fix drag-and-drop race condition in board
status: Released
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
    outcome: Gemini CLI session stopped by user.
    endedAt: '2026-05-14T08:06:52.693Z'
  - type: activity
    user: Agent
    date: '2026-05-14T08:06:52.631Z'
    comment: Gemini CLI session stopped.
  - type: agent_session
    sessionId: 9d47a208-888e-4f8e-a65e-e1e33bfbcc76
    startedAt: '2026-05-14T08:14:54.960Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-14T08:15:07.994Z'
        message: Researching Board Component
        type: topic
        data:
          title: Researching Board Component
          summary: >-
            I am starting the investigation into the drag-and-drop race
            condition in `Board.tsx`. My goal is to understand how the board
            currently manages task state, optimistic updates, and background
            polling to identify the exact points where the race condition occurs
            and where the proposed fix should be integrated.
          strategicIntent: Researching the Board component and its task handling/polling logic.
      - timestamp: '2026-05-14T08:15:08.333Z'
        message: Working
        type: tool
        data:
          toolName: glob
          parameters:
            pattern: '**/Board.tsx'
      - timestamp: '2026-05-14T08:15:10.364Z'
        message: Working
        type: info
      - timestamp: '2026-05-14T08:15:10.927Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal\src\components\Board.tsx
      - timestamp: '2026-05-14T08:15:16.345Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal\src\AppContext.tsx
      - timestamp: '2026-05-14T08:15:41.627Z'
        message: Reading types.ts
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal\src\types.ts
      - timestamp: '2026-05-14T08:16:39.011Z'
        message: Reading Column.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal\src\components\Column.tsx
      - timestamp: '2026-05-14T08:16:42.596Z'
        message: Reading TaskCard.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal\src\components\TaskCard.tsx
    user: Gemini CLI
    date: '2026-05-14T08:14:54.960Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-14T08:24:19.904Z'
  - type: agent_session
    sessionId: 0d15242e-5979-4389-9288-580eee67a690
    startedAt: '2026-05-14T08:24:36.633Z'
    status: failed
    progress:
      - timestamp: '2026-05-14T08:25:00.132Z'
        message: Researching Board.tsx and Polling Logic
        type: topic
        data:
          title: Researching Board.tsx and Polling Logic
          summary: >-
            I am starting the investigation into the drag-and-drop race
            condition in Board.tsx. My goal is to understand how the component
            manages task state, handles drag-and-drop events, and performs
            background polling. This will allow me to implement a mechanism to
            track "moving" tasks and prevent them from being prematurely
            overwritten by stale polling data.
          strategicIntent: >-
            Researching Board.tsx and task polling logic to address the
            drag-and-drop race condition.
      - timestamp: '2026-05-14T08:25:00.455Z'
        message: Working
        type: tool
        data:
          toolName: glob
          parameters:
            pattern: portal/src/components/Board.tsx
      - timestamp: '2026-05-14T08:25:02.660Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal/src/components/Board.tsx
      - timestamp: '2026-05-14T08:25:06.982Z'
        message: Working
        type: info
      - timestamp: '2026-05-14T08:25:09.275Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal/src/AppContext.tsx
    user: Gemini CLI
    date: '2026-05-14T08:24:36.633Z'
    outcome: Gemini CLI session ended with code 1.
    endedAt: '2026-05-14T08:25:10.461Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-14T09:02:35.920Z'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-14T09:02:44.067Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-14T10:59:32.386Z'
order: 4
effort: None
implementationLink: ''
tokenMetadata:
  inputTokens: 52697
  outputTokens: 274
  costUSD: 0.162201
  costIsEstimated: true
  cacheReadTokens: 23383
  cacheCreationTokens: 0
version: v0.6.0
releasedAt: '2026-05-14T10:59:32.386Z'
releaseDocPath: release-notes/v0.6.0
---

## Problem / Motivation

Users reported that dragging and dropping tickets between columns would occasionally "flip back" to the original status. This was diagnosed as a race condition in `Board.tsx` where the optimistic UI update is overwritten by the background task polling (every 3 seconds) before the server's update has been fully processed or returned in a fresh fetch.

## Implementation Plan

1.  **Add a `movingTaskIds` ref or state** to `Board.tsx` to track tickets currently undergoing a status change.
2.  **Filter incoming poll results**: Prevent `useEffect` from updating the local task state for any ticket ID currently in the "moving" set.
3.  **Cleanup**: Remove the ticket ID from the set only after the API call completes and a fresh refresh is triggered.

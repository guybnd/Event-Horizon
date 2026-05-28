---
assignee: unassigned
tags:
  - bug
  - portal
  - engine
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T15:50:53.984Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 64a27a01-251b-4f59-871f-acdd93311628
    startedAt: '2026-05-25T15:51:43.215Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:52:00.460Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:52:03.315Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Find read all button code
            subagent_type: Explore
            prompt: >-
              I'm looking for code related to "read all" or "mark all as read"
              buttons in this project. The user reports that these buttons
              "don't seem to be sticking" - meaning the state unsyncs after a
              while. 


              Search for:

              1. Any "read all" or "mark all as read" button components or
              handlers

              2. The notification system and how read/unread state is managed

              3. Any state persistence for notifications (localStorage, context,
              etc.)


              The project has a React frontend in `portal/src/` and an Express
              backend in `engine/src/`. Look in both places. Search broadly -
              try "readAll", "markAllRead", "mark.*read", "notification",
              "unread" patterns.
      - timestamp: '2026-05-25T15:52:05.849Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/*.{ts,tsx,js,jsx}'
            path: 'C:\GitHub\EventHorizon\portal\src'
      - timestamp: '2026-05-25T15:52:09.710Z'
        message: Reading NotificationPanel.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\NotificationPanel.tsx'
      - timestamp: '2026-05-25T15:52:13.148Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: markNotificationRead|markAllNotificationsRead|/notifications
            path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            output_mode: content
      - timestamp: '2026-05-25T15:52:13.456Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
      - timestamp: '2026-05-25T15:52:15.467Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:52:20.419Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: broadcastEvent.*notification|markAllRead
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: content
            context: 3
      - timestamp: '2026-05-25T15:52:30.473Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:52:34.257Z'
        message: Reading notifications.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\notifications.ts'
      - timestamp: '2026-05-25T15:52:38.948Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: markAllNotificationsRead|readAll|read-all|Mark all
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:52:43.478Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 670
            limit: 60
      - timestamp: '2026-05-25T15:52:45.484Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:52:48.232Z'
        message: Reading TaskCard.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TaskCard.tsx'
            offset: 1015
            limit: 40
      - timestamp: '2026-05-25T15:52:54.057Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: ctxMarkAllCommentsRead|markAllCommentsRead
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:52:56.302Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 520
            limit: 30
      - timestamp: '2026-05-25T15:53:00.309Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: saveReadState
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:53:00.549Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:53:02.384Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            offset: 210
            limit: 25
      - timestamp: '2026-05-25T15:53:05.694Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: read-state
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T15:53:15.634Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:53:16.536Z'
        message: Reading read-state.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\read-state.ts'
      - timestamp: '2026-05-25T15:53:19.738Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: readComments|setReadComments|fetchReadState|ensureReadStateLoaded
            path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:53:22.994Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 496
            limit: 30
      - timestamp: '2026-05-25T15:53:27.129Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: loadTasks|refreshNotifications|triggerRefresh
            path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:53:30.649Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:53:30.692Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 276
            limit: 50
      - timestamp: '2026-05-25T15:53:34.696Z'
        message: Reading Column.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Column.tsx'
            offset: 38
            limit: 30
      - timestamp: '2026-05-25T15:53:40.602Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 418
            limit: 20
      - timestamp: '2026-05-25T15:53:45.375Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: LIVE_TASK_POLL_INTERVAL
            path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:53:45.652Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:53:50.310Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 790
            limit: 25
      - timestamp: '2026-05-25T15:53:58.211Z'
        message: Reading AppContext.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\AppContext.tsx'
            offset: 527
            limit: 10
      - timestamp: '2026-05-25T15:54:00.655Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:54:26.024Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: const comments|unreadComments|readCommentIds
            path: 'C:\GitHub\EventHorizon\portal\src\components\TaskCard.tsx'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:54:30.790Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:54:32.608Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: comment.*id|id.*comment|history.*id
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: content
            '-n': true
            glob: '*.ts'
      - timestamp: '2026-05-25T15:54:37.155Z'
        message: Reading task-store.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
            offset: 265
            limit: 30
      - timestamp: '2026-05-25T15:54:41.790Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: 'type: ''comment''|type: comment'
            path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:54:46.141Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:54:49.393Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\tasks.ts'
            offset: 318
            limit: 25
      - timestamp: '2026-05-25T15:54:52.781Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: normalizeHistoryEntries
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T15:54:56.806Z'
        message: Reading history.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\history.ts'
      - timestamp: '2026-05-25T15:55:01.145Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:56:17.874Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__update_ticket,mcp__event-horizon__change_status
            max_results: 2
      - timestamp: '2026-05-25T15:56:31.177Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:57:31.236Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:57:39.151Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-322
            title: >-
              Fix "Mark all read" buttons losing state due to race condition and
              missing broadcast
            priority: High
            effort: S
            tags:
              - bug
              - portal
              - engine
            body: >-
              ## Problem / Motivation


              "Mark all read" buttons across the portal (Column header, TaskCard
              popover, TaskModal, NotificationPanel) don't reliably persist.
              After marking comments/notifications as read, they reappear as
              unread after a short time or on page reload. This degrades the
              user experience for anyone tracking unread activity across
              tickets.


              ## Root Causes


              **1. Race condition in `PUT /api/read-state` (primary bug)**

              The Column-level "Mark all read" button calls
              `markAllCommentsRead(taskId, ids)` for each task in the column via
              `.forEach()`. Each call fires a separate `PUT /api/read-state`
              request. The route handler does a non-atomic read-modify-write on
              `read-state.json`:

              - Request A reads file → gets state S0

              - Request B reads file → gets state S0 (A hasn't written yet)

              - Request A merges + writes S0+A

              - Request B merges + writes S0+B → **overwrites A's changes**


              On next page load, `fetchReadState` returns the incomplete state
              and previously-read comments appear unread again.


              **2. Missing SSE broadcast on `POST /notifications/read-all`**

              `markAllRead()` in `engine/src/notifications.ts` doesn't call
              `broadcastEvent()`. Other tabs and the notification badge show
              stale unread counts until the next manual refresh.


              **3. Fire-and-forget `saveReadState` calls (minor)**

              Frontend uses `void saveReadState(...)` with no error handling. If
              the engine is briefly unresponsive, the persist silently fails.


              ## Implementation Plan


              1. **Fix the race condition** in
              `engine/src/routes/read-state.ts`:
                 - Add a serialization lock (simple async mutex / queue) so concurrent PUT requests are processed sequentially, each reading the result of the previous write.

              2. **Batch the frontend calls** in `portal/src/AppContext.tsx`:
                 - Change `markAllCommentsRead` to accept multiple tickets at once, or debounce/batch `saveReadState` calls so a single PUT is sent with all ticket read-states combined.

              3. **Add SSE broadcast** in `engine/src/routes/notifications.ts`:
                 - After `markAllRead()`, call `broadcastEvent('notification', { unreadCount: 0 })` so all connected clients update their badge.

              4. **Add minimal error handling** to `saveReadState` calls:
                 - On failure, retry once or log a warning. Ensure local state isn't lost.
      - timestamp: '2026-05-25T15:57:46.473Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:57:56.991Z'
        message: >-
          Grooming complete. FLUX-322 is now in **Todo** with a concrete
          implementation plan. 


          The core issue is a race condition: when the Column-level "Mark all
          read" fires multiple concurrent `PUT /read-state` requests, they each
          read-modify-write the same JSON file non-atomically, so later writes
          overwrite earlier ones. Secondary issues are a missing SSE broadcast
          for the notification panel's "mark all read" and fire-and-forget save
          calls on the frontend.
    user: Claude Code
    date: '2026-05-25T15:51:43.215Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T15:57:58.194Z'
  - type: activity
    user: Agent
    date: '2026-05-25T15:57:39.230Z'
    comment: >-
      Updated title. Updated description. Changed priority to High. Changed
      effort to S. Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T15:57:47.768Z'
  - type: agent_session
    sessionId: 018ac9e8-e400-4632-bb47-c22828466a79
    startedAt: '2026-05-25T16:00:37.105Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T16:00:37.105Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T16:00:44.538Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T16:01:33.474Z'
  - type: agent_session
    sessionId: e1676a54-9bee-414a-ad3e-b15fab026770
    startedAt: '2026-05-28T07:51:03.348Z'
    status: active
    progress: []
    user: Claude Code
    date: '2026-05-28T07:51:03.348Z'
id: FLUX-322
title: >-
  Fix "Mark all read" buttons losing state due to race condition and missing
  broadcast
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 1198787
  outputTokens: 14428
  costUSD: 1.305428
  costIsEstimated: false
  cacheReadTokens: 1151646
  cacheCreationTokens: 46157
---
## Problem / Motivation

"Mark all read" buttons across the portal (Column header, TaskCard popover, TaskModal, NotificationPanel) don't reliably persist. After marking comments/notifications as read, they reappear as unread after a short time or on page reload. This degrades the user experience for anyone tracking unread activity across tickets.

## Root Causes

**1. Race condition in `PUT /api/read-state` (primary bug)**
The Column-level "Mark all read" button calls `markAllCommentsRead(taskId, ids)` for each task in the column via `.forEach()`. Each call fires a separate `PUT /api/read-state` request. The route handler does a non-atomic read-modify-write on `read-state.json`:
- Request A reads file → gets state S0
- Request B reads file → gets state S0 (A hasn't written yet)
- Request A merges + writes S0+A
- Request B merges + writes S0+B → **overwrites A's changes**

On next page load, `fetchReadState` returns the incomplete state and previously-read comments appear unread again.

**2. Missing SSE broadcast on `POST /notifications/read-all`**
`markAllRead()` in `engine/src/notifications.ts` doesn't call `broadcastEvent()`. Other tabs and the notification badge show stale unread counts until the next manual refresh.

**3. Fire-and-forget `saveReadState` calls (minor)**
Frontend uses `void saveReadState(...)` with no error handling. If the engine is briefly unresponsive, the persist silently fails.

## Implementation Plan

1. **Fix the race condition** in `engine/src/routes/read-state.ts`:
   - Add a serialization lock (simple async mutex / queue) so concurrent PUT requests are processed sequentially, each reading the result of the previous write.

2. **Batch the frontend calls** in `portal/src/AppContext.tsx`:
   - Change `markAllCommentsRead` to accept multiple tickets at once, or debounce/batch `saveReadState` calls so a single PUT is sent with all ticket read-states combined.

3. **Add SSE broadcast** in `engine/src/routes/notifications.ts`:
   - After `markAllRead()`, call `broadcastEvent('notification', { unreadCount: 0 })` so all connected clients update their badge.

4. **Add minimal error handling** to `saveReadState` calls:
   - On failure, retry once or log a warning. Ensure local state isn't lost.

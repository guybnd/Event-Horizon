---
assignee: unassigned
tags:
  - bug
  - portal
  - engine
priority: Medium
effort: S
implementationLink: a36542a
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T15:22:32.613Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: dd444440-768f-4486-9015-c4f3a9011141
    startedAt: '2026-05-25T15:22:34.976Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:22:49.071Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket'
            max_results: 1
      - timestamp: '2026-05-25T15:22:52.033Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:22:54.820Z'
        message: Reading TaskCard.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TaskCard.tsx'
      - timestamp: '2026-05-25T15:23:05.689Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: isPromptableStatus
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:23:06.313Z'
        message: Reading workflow.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\workflow.ts'
      - timestamp: '2026-05-25T15:23:07.039Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:23:10.291Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: requireInputStatus|readyForMergeStatus|promptable
            path: 'C:\GitHub\EventHorizon'
            glob: '*.{ts,tsx,json}'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T15:23:10.795Z'
        message: Reading config.json
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\.flux\config.json'
      - timestamp: '2026-05-25T15:23:22.039Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:23:27.322Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Board.tsx'
            limit: 100
      - timestamp: '2026-05-25T15:23:28.676Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: Require Input|Ready|promptable|column|status
            path: 'C:\GitHub\EventHorizon\portal\src\components\Board.tsx'
            output_mode: content
            '-n': true
            head_limit: 60
      - timestamp: '2026-05-25T15:23:31.875Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Board.tsx'
            offset: 100
            limit: 120
      - timestamp: '2026-05-25T15:23:35.405Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: Require Input|Grooming
            path: 'C:\GitHub\EventHorizon\.flux\config.json'
            output_mode: content
      - timestamp: '2026-05-25T15:23:37.041Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:23:54.484Z'
        message: Reading NotificationPanel.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\NotificationPanel.tsx'
      - timestamp: '2026-05-25T15:24:00.766Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: notification|bell|NotificationPanel
            path: 'C:\GitHub\EventHorizon\portal\src\components\Header.tsx'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:24:07.053Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:24:09.669Z'
        message: Reading Header.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Header.tsx'
            offset: 60
            limit: 120
      - timestamp: '2026-05-25T15:24:17.568Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: notification|prompt
            path: 'C:\GitHub\EventHorizon\engine\src'
            glob: '*.ts'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T15:24:22.057Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:24:24.314Z'
        message: Reading notifications.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\notifications.ts'
      - timestamp: '2026-05-25T15:24:32.917Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: generatePromptNotification
            path: 'C:\GitHub\EventHorizon\engine\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:24:37.060Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:24:41.341Z'
        message: Reading task-store.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
            offset: 130
            limit: 40
      - timestamp: '2026-05-25T15:24:52.060Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:24:53.842Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: Require Input|Ready
            path: 'C:\GitHub\EventHorizon\.flux'
            glob: '*.md'
            output_mode: content
            head_limit: 20
      - timestamp: '2026-05-25T15:25:05.840Z'
        message: Reading ReadyForMergePrompt.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: >-
              C:\GitHub\EventHorizon\portal\src\components\task-modal\ReadyForMergePrompt.tsx
      - timestamp: '2026-05-25T15:25:06.933Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: isPromptableStatus|alertIndicator|alert.*indicator|prompt.*status
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:25:07.071Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:25:26.981Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__change_status,mcp__event-horizon__update_ticket,mcp__event-horizon__add_comment
            max_results: 3
      - timestamp: '2026-05-25T15:25:37.076Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:25:40.152Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-318
            priority: Medium
            effort: S
            tags:
              - bug
      - timestamp: '2026-05-25T15:25:52.256Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:25:59.143Z'
        message: >-
          Moved FLUX-318 to **Require Input**. I need clarification on which
          "alert indicators" aren't working — the card-level ping icon, the
          header notification bell, or if you're expecting browser-level OS
          notifications (which don't exist yet). The question is posted on the
          ticket.
    user: Claude Code
    date: '2026-05-25T15:22:34.976Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T15:26:00.308Z'
  - type: activity
    user: Agent
    date: '2026-05-25T15:25:40.169Z'
    comment: Changed priority to Medium. Changed effort to S. Updated tags.
  - type: comment
    user: Agent
    comment: >-
      I found several "alert indicator" systems in the codebase. Which one isn't
      working for you?


      1. **Card-level AlertCircle ping** — the amber circle icon with ping
      animation on cards in "Require Input" or "Ready" status
      (TaskCard.tsx:628-636)

      2. **Header notification bell** — the bell icon showing unread count +
      pulse when a ticket moves to Require Input/Ready (Header.tsx:150-171,
      notifications.ts:79-98)

      3. **Browser-level notifications** — OS-level popup alerts (these don't
      exist yet — is this what you expect?)

      4. **Something else** — please describe what you expected to see and when


      Also: do you have any tickets currently in "Require Input" or "Ready"
      status? The indicators only appear for those statuses. If no tickets are
      in those statuses, the system is working but has nothing to display.


      Default assumption: if no answer, I'll investigate whether the
      notification bell fails to show alerts when a ticket transitions to
      Require Input via drag-and-drop.
    date: '2026-05-25T15:25:51.201Z'
    id: c-2026-05-25t15-25-51-201z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-25T15:25:51.201Z'
  - type: comment
    user: Guy
    date: '2026-05-25T15:27:51.355Z'
    comment: >-
      i meant 2.

      it seems to work only on require input, but tickets moving to ready dont
      trigger a notification event. neither do tickets moved into done
    replyTo: c-2026-05-25t15-25-51-201z
    id: c-2026-05-25t15-27-51-347z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-25T15:27:51.355Z'
    comment: Response submitted
  - type: agent_session
    sessionId: a72cea71-5ae8-41c5-b9d1-80f9b9049301
    startedAt: '2026-05-25T15:27:59.000Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:28:13.824Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket'
            max_results: 1
      - timestamp: '2026-05-25T15:28:15.784Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:28:19.703Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-318
      - timestamp: '2026-05-25T15:28:25.238Z'
        message: Reading notifications.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\notifications.ts'
      - timestamp: '2026-05-25T15:28:26.259Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: notification|notify|emit.*status
            path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:28:29.163Z'
        message: Reading task-store.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\task-store.ts'
      - timestamp: '2026-05-25T15:28:30.786Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:28:44.596Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: status|PUT.*tasks
            path: 'C:\GitHub\EventHorizon\engine\src'
            glob: '*route*'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T15:28:45.789Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:28:53.429Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\tasks.ts'
            offset: 234
            limit: 200
      - timestamp: '2026-05-25T15:29:00.794Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:29:14.316Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: change_status|changeStatus|change.status
            path: 'C:\GitHub\EventHorizon\engine\src\mcp-server.ts'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:29:15.802Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:29:18.357Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\mcp-server.ts'
            offset: 219
            limit: 60
      - timestamp: '2026-05-25T15:29:30.810Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:29:40.302Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-318
            priority: Medium
            effort: S
            tags:
              - bug
              - portal
              - engine
            body: >-
              ## Problem / Motivation


              The notification bell (header alert indicator) only fires for
              "Require Input" transitions but not for "Ready" or "Done"
              transitions. This means the user never gets notified when an agent
              finishes work on a ticket.


              **Root cause:** The PUT `/api/tasks/:id` route in
              `engine/src/routes/tasks.ts` handles status changes inline (lines
              307-315, writes at 351-352) but never calls
              `generatePromptNotification` or `generateCompletionNotification`.
              Only `updateTaskWithHistory` (used by MCP tools/`change_status`)
              fires notifications (lines 146-153 of `task-store.ts`). So
              portal-initiated status changes (drag-drop, modal edits) and
              MCP-tool-initiated changes both go through `updateTaskWithHistory`
              for MCP, but the REST PUT route bypasses it entirely.


              Additionally, the `updateTaskWithHistory` logic at line 149-151
              correctly checks for both `requireInputStatus` and `readyStatus`,
              and line 151-153 handles "Done" — so MCP-driven changes should
              work. The user reports even MCP-driven "Ready" and "Done" don't
              trigger notifications, suggesting either:

              1. The portal WebSocket isn't receiving/displaying the
              `notification` event for these types, or

              2. The portal's NotificationPanel filters out `completion` type
              notifications.


              ## Implementation Plan


              1. **Add notification generation to the PUT route**
              (`engine/src/routes/tasks.ts`): After the file write succeeds
              (around line 352), check if the new status differs from the old
              status and fire the appropriate notification — same logic as
              `updateTaskWithHistory` lines 146-153.


              2. **Verify portal handles all notification types**: Check
              `NotificationPanel.tsx` and the SSE/WebSocket listener to ensure
              `completion` type notifications are rendered (not just `prompt`
              type). Fix any filtering that excludes them.


              3. **Test**: Move a ticket to Ready via drag-drop → bell should
              show notification. Move a ticket to Done → bell should show
              completion notification. Verify Require Input still works.
      - timestamp: '2026-05-25T15:29:45.854Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:29:51.486Z'
        message: >-
          Grooming complete. FLUX-318 is now in **Todo** with a concrete plan:


          - **Root cause**: The REST PUT route (`engine/src/routes/tasks.ts`)
          writes status changes directly to disk without calling
          `generatePromptNotification`/`generateCompletionNotification`. Only
          MCP tool-driven changes (via `updateTaskWithHistory`) fire
          notifications.

          - **Fix**: Add notification generation after the PUT route's file
          write, and verify the portal's NotificationPanel renders
          `completion`-type notifications (not just `prompt`-type).
    user: Claude Code
    date: '2026-05-25T15:27:59.000Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T15:29:52.634Z'
  - type: activity
    user: Agent
    date: '2026-05-25T15:29:40.318Z'
    comment: Updated description. Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T15:29:44.746Z'
  - type: agent_session
    sessionId: a69c2c82-9123-4b6c-ab5d-09c1ef443c96
    startedAt: '2026-05-25T15:30:35.969Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T15:30:35.969Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T15:30:43.455Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T15:30:54.450Z'
  - type: comment
    user: Agent
    comment: >-
      Fixed: the PUT /api/tasks/:id route now fires generatePromptNotification
      for Require Input and Ready transitions, and
      generateCompletionNotification for Done transitions. The import was
      already present (from the interrupted session); added the actual call site
      after the file write succeeds (line 355-361 in tasks.ts). Portal
      NotificationPanel already renders all notification types correctly — the
      bug was engine-only.
    date: '2026-05-25T15:40:42.417Z'
    id: c-2026-05-25t15-40-42-417z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-25T15:40:42.418Z'
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-05-25T15:41:02.598Z'
title: alert indicators not really working
status: Ready
createdBy: Guy
updatedBy: Guy
tokenMetadata:
  inputTokens: 1569335
  outputTokens: 10367
  costUSD: 1.552584
  costIsEstimated: false
  cacheReadTokens: 1481338
  cacheCreationTokens: 86007
order: 0
---
## Problem / Motivation

The notification bell (header alert indicator) only fires for "Require Input" transitions but not for "Ready" or "Done" transitions. This means the user never gets notified when an agent finishes work on a ticket.

**Root cause:** The PUT `/api/tasks/:id` route in `engine/src/routes/tasks.ts` handles status changes inline (lines 307-315, writes at 351-352) but never calls `generatePromptNotification` or `generateCompletionNotification`. Only `updateTaskWithHistory` (used by MCP tools/`change_status`) fires notifications (lines 146-153 of `task-store.ts`). So portal-initiated status changes (drag-drop, modal edits) and MCP-tool-initiated changes both go through `updateTaskWithHistory` for MCP, but the REST PUT route bypasses it entirely.

Additionally, the `updateTaskWithHistory` logic at line 149-151 correctly checks for both `requireInputStatus` and `readyStatus`, and line 151-153 handles "Done" — so MCP-driven changes should work. The user reports even MCP-driven "Ready" and "Done" don't trigger notifications, suggesting either:
1. The portal WebSocket isn't receiving/displaying the `notification` event for these types, or
2. The portal's NotificationPanel filters out `completion` type notifications.

## Implementation Plan

1. **Add notification generation to the PUT route** (`engine/src/routes/tasks.ts`): After the file write succeeds (around line 352), check if the new status differs from the old status and fire the appropriate notification — same logic as `updateTaskWithHistory` lines 146-153.

2. **Verify portal handles all notification types**: Check `NotificationPanel.tsx` and the SSE/WebSocket listener to ensure `completion` type notifications are rendered (not just `prompt` type). Fix any filtering that excludes them.

3. **Test**: Move a ticket to Ready via drag-drop → bell should show notification. Move a ticket to Done → bell should show completion notification. Verify Require Input still works.

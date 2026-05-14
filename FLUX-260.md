---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-14T08:54:21.012Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-14T08:54:23.836Z'
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-14T08:54:25.377Z'
  - type: activity
    user: Guy
    date: '2026-05-14T08:54:57.623Z'
    comment: Updated description.
  - type: agent_session
    sessionId: 47633370-0627-4a57-8180-b7b74e74eaf2
    startedAt: '2026-05-14T08:54:58.210Z'
    status: completed
    progress:
      - timestamp: '2026-05-14T08:55:13.237Z'
        message: 'Grooming FLUX-260: Conditional Comment Requirement for Status Change'
        type: topic
        data:
          title: 'Grooming FLUX-260: Conditional Comment Requirement for Status Change'
          summary: >-
            Starting the grooming process for FLUX-260. I will search for the
            error message "Transitioning to Ready requires a completion comment"
            and investigate how task status updates are handled on the frontend
            and backend, as well as where the setting for requiring a comment is
            stored.
          strategicIntent: >-
            Investigate the ticket requirements and codebase to determine how to
            support conditional comment requirements for status changes.
      - timestamp: '2026-05-14T08:55:13.265Z'
        message: Working
        type: tool
        data:
          toolName: grep_search
          parameters:
            pattern: Transitioning to Ready requires a completion comment
      - timestamp: '2026-05-14T08:55:13.346Z'
        message: Working
        type: tool
        data:
          toolName: grep_search
          parameters:
            pattern: require.*comment
      - timestamp: '2026-05-14T08:55:13.618Z'
        message: Working
        type: info
      - timestamp: '2026-05-14T08:55:23.400Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: EventHorizon\engine\src\routes\tasks.ts
            start_line: 140
            end_line: 190
      - timestamp: '2026-05-14T08:55:23.481Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            start_line: 160
            file_path: EventHorizon\portal\src\components\Board.tsx
            end_line: 290
      - timestamp: '2026-05-14T08:55:28.794Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: read_file
          parameters:
            end_line: 190
            start_line: 140
            file_path: engine\src\routes\tasks.ts
      - timestamp: '2026-05-14T08:55:28.845Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: portal\src\components\Board.tsx
            start_line: 160
            end_line: 290
      - timestamp: '2026-05-14T08:55:40.780Z'
        message: Reading tasks.ts
        type: tool
        data:
          toolName: read_file
          parameters:
            end_line: 139
            start_line: 100
            file_path: engine\src\routes\tasks.ts
      - timestamp: '2026-05-14T08:55:40.825Z'
        message: Reading config.ts
        type: tool
        data:
          toolName: read_file
          parameters:
            file_path: engine\src\config.ts
            end_line: 50
            start_line: 1
      - timestamp: '2026-05-14T08:55:55.783Z'
        message: 'Implementing FLUX-260: Conditional Comments for Ready Status'
        type: topic
        data:
          title: 'Implementing FLUX-260: Conditional Comments for Ready Status'
          summary: >-
            I have investigated the issue. The backend `tasks.ts` route
            hardcodes the requirement for a completion comment when
            transitioning to 'Ready', completely ignoring the
            `configCache.requireCommentOnStatusChange` setting. The frontend
            already handles the setting correctly and responds to backend
            errors. I will modify `tasks.ts` to conditionally enforce the
            comment requirement based on this configuration.
          strategicIntent: >-
            Modify the backend to respect the `requireCommentOnStatusChange`
            configuration setting when transitioning tasks to the Ready status.
      - timestamp: '2026-05-14T08:55:56.721Z'
        message: Editing tasks.ts
        type: tool
        data:
          toolName: replace
          parameters:
            instruction: >-
              Make transitioning to Ready conditionally require a comment based
              on `configCache.requireCommentOnStatusChange`.
            old_string: |2-
                  const hasNewComment =
                    submittedHistory.slice(existingLen).some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment))) ||
                    appendHistoryEntries.some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment)));
                  if (!hasNewComment) {
                    return res.status(400).json({
            new_string: |2-
                  const hasNewComment =
                    submittedHistory.slice(existingLen).some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment))) ||
                    appendHistoryEntries.some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment)));
                  if (!hasNewComment && configCache.requireCommentOnStatusChange !== false) {
                    return res.status(400).json({
            allow_multiple: false
            file_path: engine\src\routes\tasks.ts
      - timestamp: '2026-05-14T08:56:03.645Z'
        message: 'Running: cd engine && npm install --silent && npm run test ...'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: cd engine && npm install --silent && npm run test --if-present
      - timestamp: '2026-05-14T08:56:16.219Z'
        message: 'Running: cd engine; npm install --silent; npm run build'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: cd engine; npm install --silent; npm run build
      - timestamp: '2026-05-14T08:56:34.727Z'
        message: 'Completed FLUX-260: Conditional Comments for Ready Status'
        type: topic
        data:
          title: 'Completed FLUX-260: Conditional Comments for Ready Status'
          summary: >-
            The requirement to include a completion comment when transitioning a
            task to "Ready" is now conditional. It respects the
            `configCache.requireCommentOnStatusChange` setting on the backend,
            resolving the hardcoded enforcement. The engine build completes
            successfully.
          strategicIntent: Conclude the ticket FLUX-260 implementation.
      - timestamp: '2026-05-14T08:56:39.797Z'
        message: >-
          I have completed the implementation for FLUX-260. 


          **Progress:**

          - Investigated the status transition logic in both the frontend
          (`portal/src/components/Board.tsx`) and the backend
          (`engine/src/routes/tasks.ts`).

          - Found that while the frontend conditionally enforced the prompt
          based on `requireCommentOnStatusChange` and reactive backend error
          handling, the backend hardcoded the `READY_MISSING_COMMENT`
          enforcement.

          - Updated `engine/src/routes/tasks.ts` so that moving a ticket to the
          `Ready` status now correctly checks
          `configCache.requireCommentOnStatusChange !== false` before enforcing
          the comment requirement.

          - Verified the build for the `engine` package succeeds with these
          changes.


          **Blockers:**

          - None. The fix is ready for review.
        type: text
    user: Gemini CLI
    date: '2026-05-14T08:54:58.210Z'
    outcome: Gemini CLI session ended with code 0.
    endedAt: '2026-05-14T08:56:39.809Z'
title: fix not being able to drag change status
status: Grooming
createdBy: Guy
updatedBy: Agent
order: 7
tokenMetadata:
  inputTokens: 191827
  outputTokens: 1026
  costUSD: 0.590871
  costIsEstimated: true
  cacheReadTokens: 121178
  cacheCreationTokens: 0
---
Failed to update task: Transitioning to Ready requires a completion comment in the same request.

changing status to ready is hardcoded enforced, this shouldnt be.  
if the setings option to require comment is DISABLED, then allow me to drag and drop status change  
if its ENABELD, then give me the comment box!!

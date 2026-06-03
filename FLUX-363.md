---
assignee: unassigned
tags:
  - portal
  - ux
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-06-03T04:52:33.005Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 2e4ab2a0-3a1f-4d13-bd64-302084b1a201
    startedAt: '2026-06-03T04:52:34.647Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T04:52:44.084Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status
            max_results: 5
      - timestamp: '2026-06-03T04:52:47.518Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-363
      - timestamp: '2026-06-03T04:52:49.685Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:52:53.851Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Find board column/task list structure in portal
            subagent_type: Explore
            prompt: >-
              In /Users/guy/Event-Horizon/portal/src, find how the kanban board
              columns and task lists are rendered. I need to understand: (1)
              what component renders the board columns, (2) how tasks are listed
              within a column, (3) whether there's any notion of "running" or
              "in progress" tasks being visually distinguished. Look at
              TaskBoard, Column, or similar components. Report the key file
              paths and the relevant logic. Quick search.
      - timestamp: '2026-06-03T04:52:55.777Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: '**/portal/src/**/*.tsx'
      - timestamp: '2026-06-03T04:52:58.556Z'
        message: Reading Board.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/components/Board.tsx
      - timestamp: '2026-06-03T04:53:03.763Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: cliSession|hasActiveCliSession|currentActivity
            path: /Users/guy/Event-Horizon/portal/src
            type: ts
            output_mode: files_with_matches
      - timestamp: '2026-06-03T04:53:04.686Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:53:05.967Z'
        message: Reading types.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/types.ts
      - timestamp: '2026-06-03T04:53:19.687Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T04:53:32.845Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-363
            priority: Medium
            effort: S
            tags:
              - portal
              - ux
            body: >
              ## Problem / Motivation


              Tasks with active agent sessions (status `pending`, `running`, or
              `waiting-input`) get buried in long columns as other cards pile
              up. There's no positional guarantee they stay visible, so users
              lose track of what's actually running.


              ## Implementation Plan


              All changes in `portal/src/components/Column.tsx`.


              1. **Sort tasks within each column** — before rendering the
              `SortableContext` items array, partition tasks into two buckets:
                 - `running`: `task.cliSession && ['pending', 'running', 'waiting-input'].includes(task.cliSession.status)` is true
                 - `rest`: everything else
                 - Render `[...running, ...rest]` so active tasks always appear first.

              2. **Visual section divider** — if both buckets are non-empty,
              render a subtle separator between them (e.g. a labeled `<hr>` or
              small heading like "Running" / "Queued") so the boundary is clear
              at a glance.


              3. **DnD compatibility** — the sorted order is display-only; the
              `SortableContext` items array must reflect the same order so
              drag-and-drop indices stay consistent. Do not persist this order
              back to the engine — it's a pure render-time sort.


              Key files:

              - `portal/src/components/Column.tsx` — task list rendering and
              sort logic

              - `portal/src/components/TaskCard.tsx` — `hasActiveCliSession`
              helper (read-only reference, no changes needed)

              - `portal/src/types.ts` — `CliSessionSummary` type (read-only
              reference)
      - timestamp: '2026-06-03T04:53:34.688Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T04:53:38.826Z'
        message: >-
          FLUX-363 is groomed and moved to **Todo**.


          **Plan summary:** Sort tasks in each column so running ones (active
          `cliSession`) float to the top, with a subtle divider separating them
          from queued/idle tasks. All changes are confined to `Column.tsx` —
          pure render-time sort, no engine writes.
    user: Claude Code
    date: '2026-06-03T04:52:34.647Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T04:53:38.826Z'
  - type: activity
    user: Agent
    date: '2026-06-03T04:53:32.861Z'
    comment: >-
      Updated description. Changed priority to Medium. Changed effort to S.
      Updated tags.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-06-03T04:53:35.208Z'
  - type: agent_session
    sessionId: b52a3d13-a5dd-4bb8-984b-79df699fe348
    startedAt: '2026-06-03T05:18:41.953Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-06-03T05:18:41.953Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-06-03T05:18:48.531Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T05:18:56.219Z'
id: FLUX-363
title: separate columns into 'currently running' and not
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 174967
  outputTokens: 1501
  costUSD: 0.193133
  costIsEstimated: false
  cacheReadTokens: 165769
  cacheCreationTokens: 9186
---
## Problem / Motivation

Tasks with active agent sessions (status `pending`, `running`, or `waiting-input`) get buried in long columns as other cards pile up. There's no positional guarantee they stay visible, so users lose track of what's actually running.

## Implementation Plan

All changes in `portal/src/components/Column.tsx`.

1. **Sort tasks within each column** — before rendering the `SortableContext` items array, partition tasks into two buckets:
   - `running`: `task.cliSession && ['pending', 'running', 'waiting-input'].includes(task.cliSession.status)` is true
   - `rest`: everything else
   - Render `[...running, ...rest]` so active tasks always appear first.

2. **Visual section divider** — if both buckets are non-empty, render a subtle separator between them (e.g. a labeled `<hr>` or small heading like "Running" / "Queued") so the boundary is clear at a glance.

3. **DnD compatibility** — the sorted order is display-only; the `SortableContext` items array must reflect the same order so drag-and-drop indices stay consistent. Do not persist this order back to the engine — it's a pure render-time sort.

Key files:
- `portal/src/components/Column.tsx` — task list rendering and sort logic
- `portal/src/components/TaskCard.tsx` — `hasActiveCliSession` helper (read-only reference, no changes needed)
- `portal/src/types.ts` — `CliSessionSummary` type (read-only reference)

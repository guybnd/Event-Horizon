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
    status: completed
    progress:
      - timestamp: '2026-06-03T05:18:51.605Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__change_status,mcp__event-horizon__get_ticket,mcp__event-horizon__add_comment
            max_results: 5
      - timestamp: '2026-06-03T05:18:52.134Z'
        message: Reading Column.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/components/Column.tsx
      - timestamp: '2026-06-03T05:18:56.192Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-363
            newStatus: In Progress
      - timestamp: '2026-06-03T05:18:56.995Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T05:19:11.995Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T05:19:16.861Z'
        message: Editing Column.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: /Users/guy/Event-Horizon/portal/src/components/Column.tsx
            old_string: |2-
                      {tasks.length > 0 && (
                        <SortableContext items={tasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
                          {tasks
                            .map(task => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                parentTask={parentByChildId.get(task.id)}
                                liveEvent={taskLiveEvents[task.id]}
                                travelDirection={getTaskTravelDirection(task.id)}
                              />
                            ))}
                        </SortableContext>
                      )}
            new_string: |2-
                      {tasks.length > 0 && (() => {
                        const runningTasks = tasks.filter(
                          t => t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status)
                        );
                        const restTasks = tasks.filter(
                          t => !(t.cliSession && ['pending', 'running', 'waiting-input'].includes(t.cliSession.status))
                        );
                        const sortedTasks = [...runningTasks, ...restTasks];
                        return (
                          <SortableContext items={sortedTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
                            {runningTasks.map(task => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                parentTask={parentByChildId.get(task.id)}
                                liveEvent={taskLiveEvents[task.id]}
                                travelDirection={getTaskTravelDirection(task.id)}
                              />
                            ))}
                            {runningTasks.length > 0 && restTasks.length > 0 && (
                              <div className="flex items-center gap-2 my-1 px-1 shrink-0">
                                <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-500">Queued</span>
                                <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
                              </div>
                            )}
                            {restTasks.map(task => (
                              <TaskCard
                                key={task.id}
                                task={task}
                                parentTask={parentByChildId.get(task.id)}
                                liveEvent={taskLiveEvents[task.id]}
                                travelDirection={getTaskTravelDirection(task.id)}
                              />
                            ))}
                          </SortableContext>
                        );
                      })()}
      - timestamp: '2026-06-03T05:19:19.186Z'
        message: Reading Column.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/portal/src/components/Column.tsx
            offset: 80
      - timestamp: '2026-06-03T05:19:22.191Z'
        message: 'Running: cd /Users/guy/Event-Horizon/portal && npx tsc --no...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              cd /Users/guy/Event-Horizon/portal && npx tsc --noEmit 2>&1 | head
              -30
            description: Type-check portal
      - timestamp: '2026-06-03T05:19:26.996Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T05:19:28.445Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-363
            newStatus: Ready
            comment: >-
              Implemented in `portal/src/components/Column.tsx`. Tasks with
              active cliSession (pending/running/waiting-input) are partitioned
              into a `runningTasks` bucket and floated to the top of their
              column. When both buckets are non-empty, a labeled "Queued"
              divider separates them. The `SortableContext` items array uses the
              same sorted order so DnD indices stay consistent. No engine
              changes needed. TypeScript clean. No docs changes needed — this is
              a pure UI sort with no API/schema impact.
      - timestamp: '2026-06-03T05:19:32.727Z'
        message: >-
          Done. The changes are all in
          `portal/src/components/Column.tsx:81-118`:


          - **Running tasks bubble up** — tasks with `cliSession.status` in
          `['pending', 'running', 'waiting-input']` are partitioned out and
          rendered first

          - **"Queued" divider** — a subtle labeled `<hr>`-style separator
          appears between the running and queued sections only when both are
          non-empty

          - **DnD-safe** — `SortableContext` receives `sortedTasks` (same order
          as rendered), so drag indices stay consistent with the visual order
    user: Claude Code
    date: '2026-06-03T05:18:41.953Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T05:19:32.727Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T05:18:56.219Z'
  - type: comment
    user: Agent
    comment: >-
      Implemented in `portal/src/components/Column.tsx`. Tasks with active
      cliSession (pending/running/waiting-input) are partitioned into a
      `runningTasks` bucket and floated to the top of their column. When both
      buckets are non-empty, a labeled "Queued" divider separates them. The
      `SortableContext` items array uses the same sorted order so DnD indices
      stay consistent. No engine changes needed. TypeScript clean. No docs
      changes needed — this is a pure UI sort with no API/schema impact.
    date: '2026-06-03T05:19:28.453Z'
    id: c-2026-06-03t05-19-28-453z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T05:19:28.453Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-06-03T05:20:07.274Z'
  - type: agent_session
    sessionId: 7a2e7ed1-64e8-4350-9486-929262bcbc34
    startedAt: '2026-06-03T05:20:07.284Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-06-03T05:20:07.284Z'
    outcome: Claude Code session stopped by user.
    endedAt: '2026-06-03T05:20:12.217Z'
title: separate columns into 'currently running' and not
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 404453
  outputTokens: 4079
  costUSD: 0.421772
  costIsEstimated: false
  cacheReadTokens: 360443
  cacheCreationTokens: 43987
id: FLUX-363
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

---
assignee: unassigned
tags:
  - feature
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T15:14:14.309Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 72986952-bba3-44df-ba90-dae470399f46
    startedAt: '2026-05-25T15:14:31.276Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:14:44.663Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket,list_tickets,get_board_config'
            max_results: 3
      - timestamp: '2026-05-25T15:14:47.211Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:14:49.068Z'
        message: Reading TaskCard.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TaskCard.tsx'
      - timestamp: '2026-05-25T15:14:56.970Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: subtasks
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: content
            '-n': true
      - timestamp: '2026-05-25T15:15:02.372Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:15:02.804Z'
        message: Reading types.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\types.ts'
            offset: 50
            limit: 50
      - timestamp: '2026-05-25T15:15:17.373Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T15:15:17.466Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__update_ticket,mcp__event-horizon__change_status
            max_results: 2
      - timestamp: '2026-05-25T15:15:32.383Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T15:15:43.640Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-317
            priority: Medium
            effort: M
            tags:
              - feature
            body: >-
              ## Problem / Motivation


              Parent tickets (those with subtasks) look identical to regular
              tickets on the board, making it hard to see at a glance which
              tickets are "epics" orchestrating child work and how much progress
              has been made. Users need a quick visual signal showing subtask
              completion status and a way to navigate to individual subtasks
              without opening the full ticket view.


              ## Implementation Plan


              ### 1. Epic card visual treatment in `TaskCard.tsx`

              - Detect when `task.subtasks?.length > 0` — this makes the card an
              "epic"

              - Add a subtle left-border accent (e.g., a 3px purple/indigo left
              border) to differentiate from regular cards

              - Add a small "Epic" label badge near the ticket ID


              ### 2. Subtask progress indicator

              - Resolve subtask IDs to Task objects using the `tasks` array from
              `AppContext`

              - Calculate `doneCount` (subtasks with status === 'Done' or in the
              archive/released statuses) vs `totalCount`

              - Render a compact progress bar + label (e.g., "3/5 done") below
              the description snippet

              - Use a segmented bar or filled bar with green for done, gray for
              remaining


              ### 3. Clickable subtask panel (popover)

              - Clicking the progress indicator opens a popover (similar to the
              existing comment popover pattern)

              - The popover lists each subtask with: status badge, title,
              assignee

              - Each subtask row is clickable and navigates to that ticket
              (using `openBoardTask`)

              - Include a header showing "Subtasks (3/5 done)"


              ### 4. Data flow

              - `Board.tsx` already builds `parentByChildId` — extend it to also
              pass resolved subtask Task objects to epic cards (or resolve
              inside `TaskCard` using context's `tasks` array)

              - Add a `tasks` lookup capability to `TaskCard` — either pass the
              full task list as prop or expose a helper from `AppContext`


              ### Key files

              - `portal/src/components/TaskCard.tsx` — main changes (epic
              styling, progress bar, popover)

              - `portal/src/components/Board.tsx` — may need to pass additional
              data

              - `portal/src/AppContext.tsx` — expose tasks lookup if needed
      - timestamp: '2026-05-25T15:15:47.388Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:15:50.837Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-317
            newStatus: Todo
            comment: >-
              Grooming complete. Plan covers: epic card visual differentiation
              (left accent + badge), subtask progress bar with done/total count,
              and a clickable popover panel listing all subtasks for navigation.
              Effort estimated at M due to the new popover UI and data
              resolution logic.
      - timestamp: '2026-05-25T15:15:58.280Z'
        message: >-
          FLUX-317 is groomed and moved to **Todo**. The plan covers three
          pieces:


          1. **Epic card styling** — purple left accent + "Epic" badge to
          visually differentiate parent tickets

          2. **Progress indicator** — compact bar + "3/5 done" label showing
          subtask completion

          3. **Subtask navigation popover** — click the progress indicator to
          see a list of subtasks with status/title/assignee, each clickable to
          navigate


          Effort: **M** | Priority: **Medium** | Tag: **feature**
    user: Claude Code
    date: '2026-05-25T15:14:31.276Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T15:15:59.440Z'
  - type: activity
    user: Agent
    date: '2026-05-25T15:15:43.655Z'
    comment: >-
      Updated description. Changed priority to Medium. Changed effort to M.
      Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Grooming complete. Plan covers: epic card visual differentiation (left
      accent + badge), subtask progress bar with done/total count, and a
      clickable popover panel listing all subtasks for navigation. Effort
      estimated at M due to the new popover UI and data resolution logic.
    date: '2026-05-25T15:15:50.840Z'
    id: c-2026-05-25t15-15-50-840z
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T15:15:50.840Z'
  - type: agent_session
    sessionId: f079515d-219a-437b-be4b-218d8c8f6aa3
    startedAt: '2026-05-25T15:16:25.281Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T15:16:25.281Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T15:16:33.360Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T15:17:28.212Z'
  - type: comment
    user: Agent
    comment: >-
      Implementation plan: 1) Add subtask progress bar and epic badge to
      TaskCard.tsx using the tasks array from AppContext to resolve subtask IDs.
      2) Add a clickable subtask popover (matching existing comment popover
      pattern) showing each subtask with status, title, and navigation. 3) Add
      subtle left-border accent for epic cards. No changes needed to Board.tsx
      or AppContext since tasks are already available via useApp().
    date: '2026-05-25T15:17:38.688Z'
    id: c-2026-05-25t15-17-38-688z
  - type: comment
    user: Agent
    comment: >-
      Implementation complete. Added to TaskCard.tsx: (1) Epic detection via
      task.subtasks — cards with subtasks get a 3px indigo left border and an
      "Epic" badge with Layers icon next to the ticket ID. (2) Progress bar
      below the description snippet showing done/total count with a green fill
      proportional to completion. (3) Clickable subtask popover — clicking the
      progress bar opens a portal-based dropdown listing each subtask with
      status dot (green=done, gray=pending), title, and status text. Each row
      navigates to that subtask. Uses existing openBoardTask pattern. Resolved
      subtask statuses include Done, Released, and the configured archive
      status. TypeScript passes, build succeeds.
    date: '2026-05-25T15:22:09.658Z'
    id: c-2026-05-25t15-22-09-658z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T15:22:09.658Z'
  - type: comment
    user: Guy
    date: '2026-05-25T15:25:13.076Z'
    comment: >-
      looks nice but couple of issues:


      1. no UI indicator that hovering on the bar of completion does anything,
      it should highlight and show maybe click mouse so i know i can click it to
      open the menu


      2. while hovering towards it, i may open the description by accident. then
      theres an overlap between the two items. clicking on opening the subtasks
      panel should close the description


      3. its too small and not detailed. we can make the panel 2x bigger, we can
      have the ticket ID in it and some more info maybe, like a mini card. we
      can show hover highlight of selected ticket to open.
    replyTo: c-2026-05-25t15-22-09-658z
    id: c-2026-05-25t15-25-13-066z
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T15:25:13.076Z'
    comment: Returned to work
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-25T15:38:25.988Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T15:39:03.039Z'
  - type: agent_session
    sessionId: c10cd946-70f4-40c4-a0ad-f39bac01d4e3
    startedAt: '2026-05-25T15:39:05.365Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T15:39:05.365Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T15:39:17.242Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Guy
    date: '2026-05-25T15:43:29.151Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T15:43:47.691Z'
  - type: agent_session
    sessionId: ddec6ac1-8f83-4f86-b6d3-0d58ec924650
    startedAt: '2026-05-25T15:43:48.494Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T15:44:13.860Z'
        message: Reviewing Ticket FLUX-317
        type: topic
        data:
          title: Reviewing Ticket FLUX-317
          summary: >-
            I am starting by retrieving the details for ticket FLUX-317 and
            checking the git history and diff to see what changes were actually
            made.
          strategicIntent: >-
            Reading the ticket details and Git history to perform the code
            review.
      - timestamp: '2026-05-25T15:44:19.358Z'
        message: Working
        type: tool
        data:
          toolName: mcp_event-horizon_get_ticket
          parameters:
            ticketId: FLUX-317
      - timestamp: '2026-05-25T15:44:19.374Z'
        message: 'Running: git log --oneline -10'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: git log --oneline -10
      - timestamp: '2026-05-25T15:44:20.785Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T15:44:26.081Z'
        message: 'Running: git status && git diff HEAD'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: git status && git diff HEAD
      - timestamp: '2026-05-25T15:44:39.993Z'
        message: 'Running: git status; git diff HEAD'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: git status; git diff HEAD
      - timestamp: '2026-05-25T15:45:20.180Z'
        message: 'Running: cat portal/src/AppContext.tsx | Select-String "tas...'
        type: tool
        data:
          toolName: run_shell_command
          parameters:
            command: 'cat portal/src/AppContext.tsx | Select-String "task" -Context 0,2'
      - timestamp: '2026-05-25T15:45:57.437Z'
        message: Working
        type: tool
        data:
          toolName: mcp_event-horizon_add_comment
          parameters:
            user: Linus
            ticketId: FLUX-317
            comment: >-
              What is this garbage? Did you even read the user's feedback before
              walking away from this? They told you exactly what was missing,
              and it's still not fixed.


              1. You completely ignored the user's review. They asked for a
              clear hover indicator, fixing the description overlap, and making
              the popover 2x bigger with more card-like details. None of that is
              here.

              2. The performance is a joke. You are doing `allTasks.find()`
              inside the render body for every single subtask. That's O(N * M)
              for every epic card on the board, on every single render. Build a
              map of tasks by ID! Do NOT search arrays inside render functions.

              3. `const doneStatuses = new Set(...)` — you are instantiating a
              new Set on every single render cycle. Stop generating garbage for
              the GC to clean up. Use `useMemo` or move it outside the
              component.

              4. Hardcoding magic numbers like `560` and `420` for popover
              boundaries based on `window.innerWidth`. Brittle and amateurish.


              I am rejecting this. Fix the algorithmic complexity, address the
              user's feedback, and write actual React code instead of this
              script-kiddie trash.
      - timestamp: '2026-05-25T15:46:02.746Z'
        message: Working
        type: tool
        data:
          toolName: mcp_event-horizon_change_status
          parameters:
            comment: Changes needed. Code review failed.
            ticketId: FLUX-317
            newStatus: In Progress
      - timestamp: '2026-05-25T15:46:22.219Z'
        message: Code Review Completed
        type: topic
        data:
          title: Code Review Completed
          summary: >-
            I reviewed the ticket's history and the current unstaged changes in
            TaskCard.tsx. The implementation completely ignored the previous
            user's feedback, performed O(N*M) lookups inside a React render
            loop, continuously created Sets in memory, and used hardcoded layout
            dimensions. I have posted a blunt "Linus-style" code review to the
            ticket and set its status back to In Progress.
          strategicIntent: >-
            Task complete. Added code review comment and transitioned status to
            In Progress.
      - timestamp: '2026-05-25T15:46:30.911Z'
        message: >-
          I have reviewed the unstaged changes for `TaskCard.tsx` and the ticket
          history. The previous implementer completely failed to address Guy's
          feedback, introduced O(N*M) algorithmic complexity into the board's
          render cycle, generated unnecessary garbage by instantiating Sets
          during every render, and hardcoded popover boundaries based on raw
          window dimensions.


          I've posted a blunt, Linus Torvalds-style code review as a comment on
          ticket **FLUX-317** and explicitly moved its status back to **In
          Progress** to enforce the required fixes. The review demands fixes to
          the performance bottlenecks and adherence to the user's explicit
          design instructions.
        type: text
    user: Gemini CLI
    date: '2026-05-25T15:43:48.494Z'
    outcome: Gemini CLI session ended with code 0.
    endedAt: '2026-05-25T15:46:34.062Z'
  - type: comment
    user: Linus
    comment: >-
      What is this garbage? Did you even read the user's feedback before walking
      away from this? They told you exactly what was missing, and it's still not
      fixed.


      1. You completely ignored the user's review. They asked for a clear hover
      indicator, fixing the description overlap, and making the popover 2x
      bigger with more card-like details. None of that is here.

      2. The performance is a joke. You are doing `allTasks.find()` inside the
      render body for every single subtask. That's O(N * M) for every epic card
      on the board, on every single render. Build a map of tasks by ID! Do NOT
      search arrays inside render functions.

      3. `const doneStatuses = new Set(...)` — you are instantiating a new Set
      on every single render cycle. Stop generating garbage for the GC to clean
      up. Use `useMemo` or move it outside the component.

      4. Hardcoding magic numbers like `560` and `420` for popover boundaries
      based on `window.innerWidth`. Brittle and amateurish.


      I am rejecting this. Fix the algorithmic complexity, address the user's
      feedback, and write actual React code instead of this script-kiddie trash.
    date: '2026-05-25T15:45:57.455Z'
    id: c-2026-05-25t15-45-57-455z
  - type: comment
    user: Agent
    comment: Changes needed. Code review failed.
    date: '2026-05-25T15:46:02.815Z'
    id: c-2026-05-25t15-46-02-815z
  - type: comment
    user: Gemini CLI
    date: '2026-05-25T15:46:34.062Z'
    comment: >-
      I have reviewed the unstaged changes for `TaskCard.tsx` and the ticket
      history. The previous implementer completely failed to address Guy's
      feedback, introduced O(N*M) algorithmic complexity into the board's render
      cycle, generated unnecessary garbage by instantiating Sets during every
      render, and hardcoded popover boundaries based on raw window dimensions.


      I've posted a blunt, Linus Torvalds-style code review as a comment on
      ticket **FLUX-317** and explicitly moved its status back to **In
      Progress** to enforce the required fixes. The review demands fixes to the
      performance bottlenecks and adherence to the user's explicit design
      instructions.
    id: c-2026-05-25t15-46-34-062z
title: add indicator on ticket with subtasks how many are done
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 555189
  outputTokens: 3670
  costUSD: 1.141278
  costIsEstimated: true
  cacheReadTokens: 390949
  cacheCreationTokens: 47699
order: 1
id: FLUX-317
---
## Problem / Motivation

Parent tickets (those with subtasks) look identical to regular tickets on the board, making it hard to see at a glance which tickets are "epics" orchestrating child work and how much progress has been made. Users need a quick visual signal showing subtask completion status and a way to navigate to individual subtasks without opening the full ticket view.

## Implementation Plan

### 1. Epic card visual treatment in `TaskCard.tsx`
- Detect when `task.subtasks?.length > 0` — this makes the card an "epic"
- Add a subtle left-border accent (e.g., a 3px purple/indigo left border) to differentiate from regular cards
- Add a small "Epic" label badge near the ticket ID

### 2. Subtask progress indicator
- Resolve subtask IDs to Task objects using the `tasks` array from `AppContext`
- Calculate `doneCount` (subtasks with status === 'Done' or in the archive/released statuses) vs `totalCount`
- Render a compact progress bar + label (e.g., "3/5 done") below the description snippet
- Use a segmented bar or filled bar with green for done, gray for remaining

### 3. Clickable subtask panel (popover)
- Clicking the progress indicator opens a popover (similar to the existing comment popover pattern)
- The popover lists each subtask with: status badge, title, assignee
- Each subtask row is clickable and navigates to that ticket (using `openBoardTask`)
- Include a header showing "Subtasks (3/5 done)"

### 4. Data flow
- `Board.tsx` already builds `parentByChildId` — extend it to also pass resolved subtask Task objects to epic cards (or resolve inside `TaskCard` using context's `tasks` array)
- Add a `tasks` lookup capability to `TaskCard` — either pass the full task list as prop or expose a helper from `AppContext`

### Key files
- `portal/src/components/TaskCard.tsx` — main changes (epic styling, progress bar, popover)
- `portal/src/components/Board.tsx` — may need to pass additional data
- `portal/src/AppContext.tsx` — expose tasks lookup if needed

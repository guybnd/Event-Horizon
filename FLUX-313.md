---
assignee: unassigned
tags:
  - feature
  - portal
  - ui-ux
priority: Medium
effort: M
implementationLink: ''
subtasks:
  - FLUX-314
history:
  - type: activity
    user: Guy
    date: '2026-05-25T11:46:08.122Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: d8bfc6cf-9806-4499-b4a8-407388502f65
    startedAt: '2026-05-25T11:46:11.765Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T11:46:27.649Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:get_ticket,get_board_config,list_tickets'
            max_results: 3
      - timestamp: '2026-05-25T11:46:28.482Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:46:34.077Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-313
      - timestamp: '2026-05-25T11:46:42.842Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Explore subtask picker UI
            subagent_type: Explore
            prompt: >-
              I need to understand the existing subtask picker implementation in
              this Event Horizon project. Find:

              1. The subtask picker component in the portal (likely in
              portal/src/)

              2. The TaskModal component where subtasks are managed

              3. Any existing search/filter functionality for tickets in the
              portal


              Look for files related to: subtask picker, parent ticket field,
              ticket search/filter components. Report file paths, key component
              names, and how the current subtask picking works (is it a
              dropdown? does it have search?).
      - timestamp: '2026-05-25T11:46:43.482Z'
        message: Delegating
        type: info
      - timestamp: '2026-05-25T11:46:44.658Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/**/*subtask*
      - timestamp: '2026-05-25T11:46:48.060Z'
        message: Reading TaskModal.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TaskModal.tsx'
      - timestamp: '2026-05-25T11:46:53.980Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: parentId|parentTask|parent_task|parentTicket
            path: 'C:\GitHub\EventHorizon'
            type: 'ts,tsx'
            head_limit: 50
      - timestamp: '2026-05-25T11:46:54.133Z'
        message: Reading types.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\types.ts'
            limit: 100
      - timestamp: '2026-05-25T11:46:58.484Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T11:47:08.287Z'
        message: 'Running: find /c/GitHub/EventHorizon/portal/src -type f \( ...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              find /c/GitHub/EventHorizon/portal/src -type f \( -name
              "*subtask*" -o -name "*parent*" \) 2>/dev/null | head -20
      - timestamp: '2026-05-25T11:47:12.280Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/hooks/**/*useTaskForm*
      - timestamp: '2026-05-25T11:47:13.485Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:47:15.192Z'
        message: Reading useTaskForm.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\hooks\useTaskForm.ts'
      - timestamp: '2026-05-25T11:47:21.957Z'
        message: 'Running: ls -la /c/GitHub/EventHorizon/portal/src/component...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              ls -la /c/GitHub/EventHorizon/portal/src/components/ | grep -i
              "select\|modal\|picker\|dropdown"
      - timestamp: '2026-05-25T11:47:28.105Z'
        message: Reading TagSelector.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\TagSelector.tsx'
      - timestamp: '2026-05-25T11:47:28.489Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T11:48:13.508Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T11:48:17.650Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-313
            priority: Medium
            effort: M
            tags:
              - feature
              - portal
              - ui-ux
            body: >-
              ## Problem / Motivation


              The subtask picker in the ticket modal is a plain `<select>`
              dropdown listing all available tickets with no search capability —
              unusable at scale. Additionally, there's no way to set a parent
              ticket from a child ticket; the relationship is one-directional
              (parent → child only). Users working on a ticket they want to nest
              under a parent must navigate away, open the parent, and attach
              from there.


              ## Implementation Plan


              ### 1. Add "Parent Ticket" field to the data model


              - Add optional `parentId: string` field to the `Task` type in
              `portal/src/types.ts`

              - Engine must persist `parentId` in ticket frontmatter and expose
              it via the API

              - When `parentId` is set on a child, the engine should also add
              the child ID to the parent's `subtasks` array (bidirectional sync)

              - When a subtask is detached from a parent, clear the child's
              `parentId`


              ### 2. Build a reusable searchable ticket picker component


              - Create a `TicketPicker` component (similar pattern to
              `TagSelector.tsx`)

              - Text input that filters tickets using existing `searchTasks()`
              from `taskSearch.ts`

              - Dropdown shows scored/filtered results (ID, title, status badge)
              — limit to ~7 results like `GlobalSearch`

              - Single-select mode (for parent picker) and multi-select mode
              (for subtask picker)

              - Exclude the current ticket and already-linked tickets from
              results


              ### 3. Replace the subtask `<select>` with the new picker


              - In `TaskModal.tsx` (lines ~924-1042), swap the `<select>` +
              "Attach" button for the new `TicketPicker` in multi-select/attach
              mode

              - Keep existing display of linked subtasks (clickable list with
              detach buttons)


              ### 4. Add "Parent Ticket" field to the metadata/subtask panel


              - Add a `TicketPicker` in single-select mode in the subtask
              section or metadata panel

              - Shows current parent (if any) with a link to open it and a
              detach button

              - Selecting a parent calls the API to set `parentId` and sync the
              parent's `subtasks` array


              ### 5. Engine API changes


              - `PUT /api/tasks/:id` must accept `parentId` and handle
              bidirectional linking

              - When `parentId` changes: remove child from old parent's
              subtasks, add to new parent's subtasks

              - When a subtask is detached from a parent ticket, clear the
              child's `parentId`
      - timestamp: '2026-05-25T11:48:28.508Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T11:48:36.786Z'
        message: >-
          Grooming complete for FLUX-313. I've:


          - Set **priority**: Medium, **effort**: M, **tags**: feature, portal,
          ui-ux

          - Rewrote the body with a concrete implementation plan covering:
          parent field on data model, reusable searchable ticket picker
          component, replacing the current `<select>`, and engine API changes
          for bidirectional sync

          - Moved to **Require Input** with two questions:
            1. Should setting a parent automatically sync the parent's subtasks array (bidirectional), or keep them independent?
            2. Should the picker dropdown show ID + title + status (like GlobalSearch), or include more fields?

          Waiting on your answers before moving to Todo.
    user: Claude Code
    date: '2026-05-25T11:46:11.765Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T11:48:38.187Z'
  - type: activity
    user: Agent
    date: '2026-05-25T11:48:17.659Z'
    comment: >-
      Updated description. Changed priority to Medium. Changed effort to M.
      Updated tags.
  - type: comment
    user: Agent
    comment: >-
      Two questions before moving to Todo:


      1. **Bidirectional sync scope**: When a user sets a parent from a child
      ticket, should the engine automatically add the child to the parent's
      `subtasks` array (and vice versa on detach)? Or should parent/child be
      independent fields the user manages separately? Proposed default:
      automatic bidirectional sync — setting parent on child also links the
      subtask on the parent.


      2. **Picker result display**: The GlobalSearch shows ID + title + status
      badge. Should the subtask/parent picker show the same fields, or do you
      want additional info (e.g. assignee, priority) in the dropdown results?
      Proposed default: ID + title + status badge (matches existing GlobalSearch
      pattern).
    date: '2026-05-25T11:48:27.131Z'
    id: c-2026-05-25t11-48-27-131z
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-25T11:48:27.131Z'
  - type: comment
    user: Guy
    date: '2026-05-25T11:49:34.437Z'
    comment: >-
      1. obviously synced ttwo way


      2.  same is enough we can have single code for both no need to reinvent
      the wheel
    replyTo: c-2026-05-25t11-48-27-131z
    id: c-2026-05-25t11-49-34-423z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-25T11:49:34.437Z'
    comment: Response submitted
  - type: agent_session
    sessionId: ca43d809-ffe1-4b83-87e5-008f249a7025
    startedAt: '2026-05-25T11:49:39.651Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T11:49:55.335Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T11:49:55.473Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: >-
              select:mcp__event-horizon__get_ticket,mcp__event-horizon__update_ticket,mcp__event-horizon__change_status
            max_results: 3
      - timestamp: '2026-05-25T11:49:58.886Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__get_ticket
          parameters:
            ticketId: FLUX-313
      - timestamp: '2026-05-25T11:50:10.339Z'
        message: Thinking
        type: info
      - timestamp: '2026-05-25T11:50:12.672Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__update_ticket
          parameters:
            ticketId: FLUX-313
            body: >-
              ## Problem / Motivation


              The subtask picker in the ticket modal is a plain `<select>`
              dropdown listing all available tickets with no search capability —
              unusable at scale. Additionally, there's no way to set a parent
              ticket from a child ticket; the relationship is one-directional
              (parent → child only). Users working on a ticket they want to nest
              under a parent must navigate away, open the parent, and attach
              from there.


              ## Implementation Plan


              ### 1. Add "Parent Ticket" field to the data model


              - Add optional `parentId: string` field to the `Task` type in
              `portal/src/types.ts`

              - Engine must persist `parentId` in ticket frontmatter and expose
              it via the API

              - Bidirectional sync: setting `parentId` on a child automatically
              adds the child to the parent's `subtasks` array; detaching from
              either side clears both


              ### 2. Engine API changes


              - `PUT /api/tasks/:id` accepts `parentId` and handles
              bidirectional linking

              - When `parentId` changes: remove child from old parent's
              `subtasks`, add to new parent's `subtasks`

              - When a subtask is detached from a parent ticket, clear the
              child's `parentId`

              - When `parentId` is cleared on a child, remove from old parent's
              `subtasks`


              ### 3. Build a reusable `TicketPicker` component


              - Single component used for both parent picker (single-select) and
              subtask picker (multi-select/attach mode) — same code, no
              duplication

              - Pattern after `TagSelector.tsx`: text input that filters tickets
              using existing `searchTasks()` from `taskSearch.ts`

              - Dropdown shows scored/filtered results: ID + title + status
              badge (same as `GlobalSearch`)

              - Limit to ~7 results

              - Exclude the current ticket and already-linked tickets from
              results


              ### 4. Replace the subtask `<select>` with `TicketPicker`


              - In `TaskModal.tsx` (subtask section, lines ~924-1042), swap the
              `<select>` + "Attach" button for `TicketPicker` in attach mode

              - Keep existing display of linked subtasks (clickable list with
              detach buttons)


              ### 5. Add "Parent Ticket" field to the subtask panel


              - Add `TicketPicker` in single-select mode above/below the subtask
              list

              - Shows current parent (if any) with a link to open it and a
              detach button

              - Selecting a parent calls `PUT /api/tasks/:id` with `parentId` —
              engine handles bidirectional sync
      - timestamp: '2026-05-25T11:50:21.606Z'
        message: >-
          Grooming complete. FLUX-313 is now **Todo** with a finalized plan:


          - Bidirectional sync confirmed (parent ↔ child auto-linked)

          - Single reusable `TicketPicker` component for both parent and subtask
          selection (no duplication)

          - Dropdown shows ID + title + status badge, matching `GlobalSearch`
          pattern

          - Engine API handles all bidirectional linking logic server-side
    user: Claude Code
    date: '2026-05-25T11:49:39.651Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T11:50:22.764Z'
  - type: activity
    user: Agent
    date: '2026-05-25T11:50:12.688Z'
    comment: Updated description.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-25T11:50:16.009Z'
  - type: agent_session
    sessionId: 0cbd71e2-d58c-4d71-a270-bfb5256ba9cc
    startedAt: '2026-05-25T11:51:27.845Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T11:51:27.845Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T11:51:36.388Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T11:52:44.673Z'
  - type: comment
    user: Agent
    comment: >-
      Implementation plan: 1) Add `parentId` field to Task type + engine schema,
      2) Handle bidirectional parentId sync in PUT route, 3) Build reusable
      TicketPicker component (search-based, pattern after TagSelector), 4)
      Replace subtask `<select>` with TicketPicker, 5) Add parent ticket field
      with TicketPicker in single-select mode.
    date: '2026-05-25T11:52:49.830Z'
    id: c-2026-05-25t11-52-49-830z
  - type: comment
    user: Agent
    comment: >-
      Implemented subtask picker improvements:


      1. **New `TicketPicker` component**
      (`portal/src/components/TicketPicker.tsx`) — reusable search-based picker
      using `searchTasks()` from `taskSearch.ts`. Shows ID + title + status
      badge in dropdown, limits to 7 results, excludes current ticket and
      already-linked items.


      2. **Replaced `<select>` dropdown** in TaskModal subtask panel with
      `TicketPicker` for attaching subtasks via search.


      3. **Added Parent Ticket field** — single-select `TicketPicker` above the
      subtasks section. Shows current parent with clickable link and detach
      button.


      4. **Form state** — `parentId` added to `useTaskForm` hook (syncs from
      modalTask, tracked in dirty check, included in save payload).


      5. **Engine bidirectional sync** — already in place in
      `engine/src/routes/tasks.ts` (PUT handler syncs parentId ↔ subtasks array
      both directions).


      Validated: portal type-checks clean, Vite build succeeds.
    date: '2026-05-25T11:59:39.814Z'
    id: c-2026-05-25t11-59-39-814z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T11:59:39.814Z'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-25T12:30:17.308Z'
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-05-25T12:30:25.988Z'
  - type: status_change
    from: Ready
    to: Done
    user: Guy
    date: '2026-05-25T12:33:22.874Z'
  - type: status_change
    from: Done
    to: Ready
    user: Guy
    date: '2026-05-25T12:33:27.804Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Guy
    date: '2026-05-25T12:33:40.738Z'
  - type: agent_session
    sessionId: 4366f41f-6bd1-4597-b54f-3600bd07fb46
    startedAt: '2026-05-25T12:33:41.742Z'
    status: cancelled
    progress: []
    user: Gemini CLI
    date: '2026-05-25T12:33:41.742Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T12:33:57.181Z'
title: subtask picker improvements
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 312672
  outputTokens: 3882
  costUSD: 0.539892
  costIsEstimated: false
  cacheReadTokens: 286557
  cacheCreationTokens: 26093
order: 0
id: FLUX-313
---
## Problem / Motivation

The subtask picker in the ticket modal is a plain `<select>` dropdown listing all available tickets with no search capability — unusable at scale. Additionally, there's no way to set a parent ticket from a child ticket; the relationship is one-directional (parent → child only). Users working on a ticket they want to nest under a parent must navigate away, open the parent, and attach from there.

## Implementation Plan

### 1. Add "Parent Ticket" field to the data model

- Add optional `parentId: string` field to the `Task` type in `portal/src/types.ts`
- Engine must persist `parentId` in ticket frontmatter and expose it via the API
- Bidirectional sync: setting `parentId` on a child automatically adds the child to the parent's `subtasks` array; detaching from either side clears both

### 2. Engine API changes

- `PUT /api/tasks/:id` accepts `parentId` and handles bidirectional linking
- When `parentId` changes: remove child from old parent's `subtasks`, add to new parent's `subtasks`
- When a subtask is detached from a parent ticket, clear the child's `parentId`
- When `parentId` is cleared on a child, remove from old parent's `subtasks`

### 3. Build a reusable `TicketPicker` component

- Single component used for both parent picker (single-select) and subtask picker (multi-select/attach mode) — same code, no duplication
- Pattern after `TagSelector.tsx`: text input that filters tickets using existing `searchTasks()` from `taskSearch.ts`
- Dropdown shows scored/filtered results: ID + title + status badge (same as `GlobalSearch`)
- Limit to ~7 results
- Exclude the current ticket and already-linked tickets from results

### 4. Replace the subtask `<select>` with `TicketPicker`

- In `TaskModal.tsx` (subtask section, lines ~924-1042), swap the `<select>` + "Attach" button for `TicketPicker` in attach mode
- Keep existing display of linked subtasks (clickable list with detach buttons)

### 5. Add "Parent Ticket" field to the subtask panel

- Add `TicketPicker` in single-select mode above/below the subtask list
- Shows current parent (if any) with a link to open it and a detach button
- Selecting a parent calls `PUT /api/tasks/:id` with `parentId` — engine handles bidirectional sync

---
assignee: unassigned
tags:
  - feature
  - portal
  - ui-ux
priority: Medium
effort: M
implementationLink: ''
subtasks: []
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
id: FLUX-313
title: subtask picker improvements
status: Require Input
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 183220
  outputTokens: 2321
  costUSD: 0.363206
  costIsEstimated: false
  cacheReadTokens: 169296
  cacheCreationTokens: 13911
---
## Problem / Motivation

The subtask picker in the ticket modal is a plain `<select>` dropdown listing all available tickets with no search capability — unusable at scale. Additionally, there's no way to set a parent ticket from a child ticket; the relationship is one-directional (parent → child only). Users working on a ticket they want to nest under a parent must navigate away, open the parent, and attach from there.

## Implementation Plan

### 1. Add "Parent Ticket" field to the data model

- Add optional `parentId: string` field to the `Task` type in `portal/src/types.ts`
- Engine must persist `parentId` in ticket frontmatter and expose it via the API
- When `parentId` is set on a child, the engine should also add the child ID to the parent's `subtasks` array (bidirectional sync)
- When a subtask is detached from a parent, clear the child's `parentId`

### 2. Build a reusable searchable ticket picker component

- Create a `TicketPicker` component (similar pattern to `TagSelector.tsx`)
- Text input that filters tickets using existing `searchTasks()` from `taskSearch.ts`
- Dropdown shows scored/filtered results (ID, title, status badge) — limit to ~7 results like `GlobalSearch`
- Single-select mode (for parent picker) and multi-select mode (for subtask picker)
- Exclude the current ticket and already-linked tickets from results

### 3. Replace the subtask `<select>` with the new picker

- In `TaskModal.tsx` (lines ~924-1042), swap the `<select>` + "Attach" button for the new `TicketPicker` in multi-select/attach mode
- Keep existing display of linked subtasks (clickable list with detach buttons)

### 4. Add "Parent Ticket" field to the metadata/subtask panel

- Add a `TicketPicker` in single-select mode in the subtask section or metadata panel
- Shows current parent (if any) with a link to open it and a detach button
- Selecting a parent calls the API to set `parentId` and sync the parent's `subtasks` array

### 5. Engine API changes

- `PUT /api/tasks/:id` must accept `parentId` and handle bidirectional linking
- When `parentId` changes: remove child from old parent's subtasks, add to new parent's subtasks
- When a subtask is detached from a parent ticket, clear the child's `parentId`

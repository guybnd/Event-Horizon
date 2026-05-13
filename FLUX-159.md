---
title: Show corrupted ticket indicator in the portal UI
status: Ready
priority: Medium
effort: S
tags:
  - reliability
  - ui
createdBy: Agent
updatedBy: Agent
assignee: unassigned
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-09T08:10:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T08:10:00.000Z'
    comment: >-
      Created per FLUX-83 acceptance criteria. Originally raised by Guy in
      FLUX-83: add a view or indicator for corrupted ticket files so the user
      can instruct agent to fix or undo it.
    id: c-2026-05-09t08-10-00-000z
  - type: comment
    user: Agent
    date: '2026-05-09T07:43:06.110Z'
    comment: 'CLI test: patch-ticket correctly sets fields and appends history'
    id: c-2026-05-09t07-43-06-110z
  - type: comment
    user: Guy
    date: '2026-05-09T07:43:42.680Z'
    comment: >-
      this hsould be workplace agnostic not depend on just .flux what about a
      different project?

      or maybe im misunderstanding the workflow in this product
    id: c-2026-05-09t07-43-42-680z
  - type: activity
    user: Agent
    date: '2026-05-10T05:44:53.027Z'
    comment: Launched Claude Code session (d4dc4fa3).
  - type: activity
    user: Agent
    date: '2026-05-10T05:44:53.201Z'
    comment: Claude Code session ended with code 1.
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:31.773Z'
    comment: Launched Claude Code session (edf2e10f).
  - type: activity
    user: Agent
    date: '2026-05-10T14:10:58.975Z'
    comment: Claude Code session stopped.
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-11T06:11:13.671Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-11T06:11:21.791Z'
  - type: comment
    user: Guy
    date: '2026-05-13T11:40:24.104Z'
    comment: should also apply to flux-data mode
    id: c-2026-05-13t11-40-24-046z
  - type: activity
    user: Agent
    date: '2026-05-13T11:44:36.503Z'
    comment: Launched Claude Code session (caa54eb3).
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-13T11:45:18.344Z'
  - type: comment
    user: Agent
    date: '2026-05-13T11:45:18.346Z'
    comment: >-
      Moving to In Progress. Will add API endpoint for parse errors and UI
      indicator in the portal.
    id: c-2026-05-13t11-45-18-346z
  - type: activity
    user: Agent
    date: '2026-05-13T11:48:36.406Z'
    comment: Claude Code session lost (engine restarted).
  - type: activity
    user: Agent
    date: '2026-05-13T11:49:00.892Z'
    comment: Claude Code session stopped.
  - type: comment
    user: Guy
    date: '2026-05-13T11:55:51.696Z'
    comment: >-
      This should have a dedicated seciton that is prompted from a button that
      has like a error notification with amount of errors from it, each distinct
      error gets its own button to open for details. i dont want it  taking up
      all the UI space
    id: c-2026-05-13t11-55-51-691z
  - type: activity
    user: Agent
    date: '2026-05-13T11:55:55.473Z'
    comment: Launched Claude Code session (8ae392c3).
  - type: activity
    user: Agent
    date: '2026-05-13T11:56:14.014Z'
    comment: Claude Code session lost (engine restarted).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T11:58:06.404Z'
  - type: comment
    user: Agent
    date: '2026-05-13T11:58:06.405Z'
    comment: >-
      Implementation complete. Replaced the ParseErrorBanner with
      ParseErrorButton that shows a compact button with an error badge count.
      Clicking the button opens a modal with expandable error cards - each
      distinct error gets its own collapsible section showing the ticket ID,
      file path, and detailed error message. The modal includes helpful
      instructions on how to fix the issues. The button appears in both Board
      and Backlog screens next to the TaskViewControls. Validated with FLUX-238
      which currently has a merge conflict in its YAML frontmatter.
    id: c-2026-05-13t11-58-06-405z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T11:58:15.550Z'
    comment: >-
      Perfect! The ticket is now in Ready status. Let me create a quick summary
      of what was implemented:


      ## Implementation Complete


      I've successfully implemented the corrupted ticket indicator with a
      dedicated UI section as requested:


      **What Changed:**


      1. **Created `ParseErrorButton.tsx`** - A compact button with an error
      badge that shows the count of corrupted files

      2. **Integrated into Board & Backlog** - The button appears next to
      TaskViewControls in both views, taking minimal space

      3. **Modal with Expandable Errors** - Clicking the button opens a modal
      where each distinct error has its own collapsible card showing:
         - Ticket ID (e.g., FLUX-238.md)
         - Full file path
         - Detailed error message
         - Helpful instructions on how to fix

      **Key Features:**

      - Only appears when there are parse errors (no UI clutter when everything
      is fine)

      - Badge shows total error count at a glance

      - Each error can be expanded independently for details

      - Includes guidance on fixing YAML frontmatter issues

      - Automatically clears when files are fixed and reloaded


      The implementation is currently live and can be tested with FLUX-238,
      which has a git merge conflict in its YAML frontmatter. The ticket is now
      in **Ready** status awaiting your review.
  - type: activity
    user: Agent
    date: '2026-05-13T12:03:30.483Z'
    comment: Claude Code session stopped.
  - type: activity
    user: Agent
    date: '2026-05-13T12:03:30.587Z'
    comment: Claude Code session stopped.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-13T12:03:37.417Z'
  - type: activity
    user: Agent
    date: '2026-05-13T12:03:37.468Z'
    comment: Launched Claude Code session (f4750d9c).
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-13T12:04:11.043Z'
  - type: comment
    user: Agent
    date: '2026-05-13T12:04:11.044Z'
    comment: >-
      Code review complete. Implementation is solid. Engine tracks parse errors
      in a separate map, exposes them via GET /tasks/errors, clears on
      successful reload. Portal polls alongside tasks, surfaces them via button
      with modal. Auto-clears on fix. No unnecessary abstractions, no missing
      error cases, clean separation of concerns. Passes.
    id: c-2026-05-13t12-04-11-044z
  - type: agent_message
    user: Claude Code
    date: '2026-05-13T12:04:16.213Z'
    comment: >-
      Done. Implementation passes review.


      **Summary:**


      The code is straightforward and correct. Engine maintains a `parseErrors`
      map alongside `tasksCache`, populates it on parse failure, clears it on
      success, exposes via `GET /tasks/errors`. Portal fetches alongside tasks,
      shows a button with badge count when errors exist, modal displays the
      error details with expand/collapse. Auto-clears when file is fixed. No
      over-engineering, no weird abstractions, handles the requirements exactly
      as specified.


      Ticket moved to Ready.
  - type: activity
    user: Agent
    date: '2026-05-13T12:04:16.252Z'
    comment: Claude Code session ended with code 0.
order: 161
tokenMetadata:
  inputTokens: 1048333
  outputTokens: 7623
  costUSD: 0.737874
  costIsEstimated: false
  cacheReadTokens: 959450
  cacheCreationTokens: 85068
---

## Summary

When a `.flux/*.md` ticket file has malformed YAML frontmatter the engine already logs `[FLUX VALIDATION ERROR]` to the terminal and drops the ticket from the cache. However the user gets no visual signal in the portal — the ticket silently disappears. This ticket adds a visible UI indicator so the user can see that a file is broken and take corrective action.

## Requirements

- The engine tracks which ticket files failed to parse (already done internally in `loadTask()`).
- Expose parse failures via a new API endpoint, e.g. `GET /api/tasks/errors`, returning `{ id, path, error }[]`.
- Add a UI indicator in the portal (board or backlog header banner, or dedicated error row) listing unparseable ticket filenames with the parse error message.
- The indicator clears automatically once the file is fixed and reloaded by the watcher.

## Likely Affected Areas

- `engine/src/index.ts`: maintain a `parseErrors` map alongside `tasksCache`; populate on `loadTask` failure; clear on success; expose via `GET /api/tasks/errors`
- `portal/src/`: add a banner or notification that reacts to `/api/tasks/errors`

## Acceptance Criteria

- [ ] Corrupted ticket file shows a visible warning in the portal with the filename and error
- [ ] Warning clears automatically when the file is fixed and the watcher reloads it
- [ ] No change to how valid tickets load or display

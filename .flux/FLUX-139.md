---
assignee: unassigned
tags: []
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T13:53:43.815Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-08T14:13:15.327Z'
    comment: Launched Claude Code session (aa2ff6c6).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:01.000Z'
    comment: >
      Plan: Add an "Active Agent Sessions" widget next to the User Prompts
      button in Header.tsx. Count tasks where cliSession.status is 'pending',
      'running', or 'waiting-input'. Style matches the User Prompts widget —
      green accent when count > 0, with an animated pulse dot. Clicking
      navigates to the board.
    id: c-2026-05-09t00-00-01-000z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:14:04.017Z'
    comment: >-
      ```text

      Now I'll implement the widget in `Header.tsx`. I'll add an "Active Agent
      Sessions" counter right after the User Prompts button.

      ```
    id: c-2026-05-08t14-14-04-017z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:14:13.813Z'
    comment: |-
      ```text
      Now add the widget after the User Prompts button:
      ```
    id: c-2026-05-08t14-14-13-813z
title: add next to user prompts at the top bar 'active agent sessions'
status: In Progress
createdBy: Guy
updatedBy: Agent
---
to get alive view of active sessions working

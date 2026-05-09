---
assignee: unassigned
tags: []
priority: Low
effort: XS
implementationLink: 66de616
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
      'running', or 'waiting-input'. Style: emerald accent + animated pulse dot
      when sessions are active. Clicking navigates to the board.
    id: c-2026-05-09t00-00-01-000z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-09T00:00:02.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:03.000Z'
    comment: >
      Implemented in portal/src/components/Header.tsx: - Imported Bot icon from
      lucide-react - Added activeSessionCount computed from tasks where
      cliSession.status is 'pending', 'running', or 'waiting-input' - Added
      "Agent Sessions" widget next to "User Prompts" — emerald accent + animated
      pulse dot when sessions are active - Clicking navigates to the board (same
      behaviour as User Prompts)
    id: c-2026-05-09t00-00-03-000z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:14:48.409Z'
    comment: >-
      ```text

      Done. Here's what was added to `portal/src/components/Header.tsx`:


      - **"Agent Sessions" widget** placed immediately after the "User Prompts"
      button

      - Counts tasks where `cliSession.status` is `pending`, `running`, or
      `waiting-input`

      - Emerald accent color + animated `animate-pulse` dot on the `Bot` icon
      when count > 0

      - Clicking navigates to the board (same as User Prompts)

      - Zero styling overhead when no sessions are active (neutral gray, same as
      the idle state of other widgets)


      Ticket is at **Ready** — say `finish FLUX-139` when you've reviewed and
      want to commit.

      ```
    id: c-2026-05-08t14-14-48-409z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T14:18:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-09T14:18:01.000Z'
    comment: >
      Shipped in commit 66de616. Added "Agent Sessions" widget to the header bar
      next to "User Prompts" — emerald accent with animated pulse dot when
      sessions are active, neutral gray when idle. Counts tasks with
      cliSession.status of pending/running/waiting-input. Clicking navigates to
      the board.
    id: c-2026-05-09t14-18-01-000z
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:18:56.703Z'
    comment: >-
      ```text

      FLUX-139 is done. Committed as `66de616` — "Agent Sessions" widget is live
      in the header.

      ```
    id: c-2026-05-08t14-18-56-703z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.348Z'
title: add next to user prompts at the top bar 'active agent sessions'
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.348Z'
releaseDocPath: release-notes/0.2.0
---
to get alive view of active sessions working

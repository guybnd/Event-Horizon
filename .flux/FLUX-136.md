---
assignee: unassigned
tags:
  - bug
priority: Low
effort: XS
implementationLink: a4232b5
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T13:35:12.636Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-08T13:39:37.362Z'
    comment: Launched Claude Code session (45abce52).
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T13:41:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T13:41:00.000Z'
    comment: >-
      Fixed in `portal/src/components/TaskCard.tsx`. The badge count and tooltip
      now show the unread count when unreads exist, falling back to total count
      when all comments are read. Changed lines 467 and 477.
    id: c-2026-05-08t13-41-00-000z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:41:06.163Z'
    comment: >-
      ```text

      Done. The fix is in `portal/src/components/TaskCard.tsx`:


      - **Badge count** (line 477): now shows `unreadComments.length` when
      unreads exist, falls back to `comments.length` when all read

      - **Tooltip** (line 467): now says "X unread comment(s)" when unreads
      exist


      Ticket is in `Ready` — say `finish FLUX-136` to commit and close.

      ```
    id: c-2026-05-08t13-41-06-163z
  - type: comment
    user: Guy
    date: '2026-05-08T13:43:53.762Z'
    comment: טסט
    replyTo: c-2026-05-08t13-41-00-000z
    id: c-2026-05-08t13-43-53-762z
  - type: activity
    user: Agent
    date: '2026-05-08T13:44:59.979Z'
    comment: Launched Claude Code session (318a3fa5).
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:45:04.456Z'
    comment: >-
      ```text

      [stderr] Warning: no stdin data received in 3s, proceeding without it. If
      piping from a slow command, redirect stdin explicitly: < /dev/null to
      skip, or wait longer.

      ```
    id: c-2026-05-08t13-45-04-456z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:45:10.228Z'
    comment: |-
      ```text
      Let me check the current state of the changes.
      ```
    id: c-2026-05-08t13-45-10-228z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:45:13.974Z'
    comment: >-
      ```text

      The fix is already in place and the ticket is in `Ready`. The changes at
      lines 467 and 477 are correct:


      - **Line 467**: tooltip shows `X unread comment(s)` when unreads exist

      - **Line 477**: badge count shows `unreadComments.length` when unreads
      exist, falls back to `comments.length`


      Say `finish FLUX-136` to commit and close.

      ```
    id: c-2026-05-08t13-45-13-974z
  - type: comment
    user: Guy
    date: '2026-05-08T13:49:30.782Z'
    comment: finish FLUX-136
    id: c-2026-05-08t13-49-30-782z
  - type: activity
    user: Guy
    date: '2026-05-08T13:51:01.537Z'
    comment: Updated title.
  - type: activity
    user: Agent
    date: '2026-05-08T13:57:12.585Z'
    comment: Launched Claude Code session (b263ac40).
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:16.801Z'
    comment: >-
      ```text

      [stderr] Warning: no stdin data received in 3s, proceeding without it. If
      piping from a slow command, redirect stdin explicitly: < /dev/null to
      skip, or wait longer.

      ```
    id: c-2026-05-08t13-57-16-801z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:22.034Z'
    comment: >-
      ```text

      Let me read the ticket and verify the current state of the changes before
      committing.

      ```
    id: c-2026-05-08t13-57-22-034z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:31.343Z'
    comment: >-
      ```text

      The fix is in place. Line 486 shows unread count in tooltip and line 496
      shows `unreadComments.length` when unreads exist. Now staging and
      committing atomically.

      ```
    id: c-2026-05-08t13-57-31-343z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:34.085Z'
    comment: >-
      ```text

      Good — the badge fix is confirmed in the diff. Now creating the commit and
      updating the ticket atomically.

      ```
    id: c-2026-05-08t13-57-34-085z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:38.730Z'
    comment: >-
      ```text

      Commit `a4232b5` created. Now updating the ticket with the implementation
      link and closing it.

      ```
    id: c-2026-05-08t13-57-38-730z
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:45.087Z'
    comment: |-
      ```text
      Now append the completion comment and status change to Done:
      ```
    id: c-2026-05-08t13-57-45-087z
  - type: comment
    user: Agent
    date: '2026-05-08T14:00:00.000Z'
    comment: >-
      Fixed in `portal/src/components/TaskCard.tsx`. Badge now shows
      `unreadComments.length` when unreads exist, falling back to total count
      when all read. Tooltip updated to match. Commit a4232b5.
    id: c-2026-05-08t14-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:00:01.000Z'
  - type: comment
    user: Claude Code
    date: '2026-05-08T13:57:57.721Z'
    comment: >-
      ```text

      FLUX-136 is done. Commit `a4232b5` — the comment badge now shows the
      unread count when there are unread comments, falling back to total count
      when all are read.

      ```
    id: c-2026-05-08t13-57-57-721z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.346Z'
title: >-
  notification popup should show only the amount of unread not the total
  messages
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.346Z'
releaseDocPath: release-notes/0.2.0
---

## Bug Fix

The comment badge on task cards was always showing the total comment count.

**Fix:** In `TaskCard.tsx`, when there are unread comments the badge now renders `unreadComments.length` instead of `comments.length`. The tooltip also reflects the unread count in that state. When all comments are read the badge falls back to showing the total count.

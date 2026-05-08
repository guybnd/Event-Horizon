---
assignee: unassigned
tags: []
priority: Low
effort: XS
implementationLink: '835253c'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T14:24:25.573Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-08T14:24:28.149Z'
    comment: Launched Claude Code session (7372896f).
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
    comment: >-
      Fixed in `portal/src/components/ContextMenu.tsx`. The `handleLaunchAgent`
      handler was calling both `startTaskCliSession` and
      `openTaskFullView`/`openTaskModal`, causing the ticket page to open
      alongside the agent launch. Removed the page-open calls — "Launch Agent"
      now only starts the session and closes the menu.
    id: c-2026-05-09t00-00-00-000z
  - type: status_change
    from: Grooming
    to: Ready
    user: Agent
    date: '2026-05-09T00:00:01.000Z'
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:25:17.673Z'
    comment: >-
      ```text

      Fixed. The bug was in `ContextMenu.tsx:79-87` — `handleLaunchAgent` was
      calling both `startTaskCliSession` and `openTaskFullView`/`openTaskModal`,
      so it launched the agent *and* navigated to the ticket page. Removed the
      navigation calls; now it only starts the session.


      Ticket is in `Ready` for your review. Say `finish FLUX-141` to commit and
      close.

      ```
    id: c-2026-05-08t14-25-17-673z
  - type: activity
    user: Agent
    date: '2026-05-08T14:26:49.686Z'
    comment: Launched Claude Code session (78bb42da).
  - type: comment
    user: Agent
    date: '2026-05-09T12:00:00.000Z'
    comment: >-
      Committed as 835253c. Removed the 5-line navigation block from
      `handleLaunchAgent` in `ContextMenu.tsx` — "Launch Agent" now only calls
      `onClose()` and `startTaskCliSession`, no page navigation. Validated via
      git diff before committing.
    id: c-2026-05-09t12-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T12:00:01.000Z'
title: right click launch agent opens the page instead of just launching it
status: Done
createdBy: Guy
updatedBy: Agent
---

## Fix

Remove the `openTaskFullView`/`openTaskModal` calls from `handleLaunchAgent` in `ContextMenu.tsx`. The right-click "Launch Agent" action should only fire the session start — it should not navigate to the ticket page.

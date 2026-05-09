---
assignee: unassigned
tags:
  - bug
priority: High
effort: XS
implementationLink: 4f5c6ee
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T01:30:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T01:30:00.000Z'
    comment: >-
      Closed. Removed `triggerRefresh()` from the 2.5s CLI session poller in
      `TaskModal.tsx` — it was calling `setRefreshTrigger` at full React
      priority on every tick, re-running `fetchTasks → setAllTasks` inside the
      modal and competing with every keystroke. Also wrapped all polling-driven
      state updates in `startTransition` in both `AppContext.tsx` and
      `TaskModal.tsx` so React yields to user input. Commit: 4f5c6ee.
    id: c-2026-05-09t01-30-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T01:30:01.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:52:05.719Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:52:05.719Z'
    comment: Updated implementation link.
  - type: activity
    user: Agent
    date: '2026-05-08T14:52:08.437Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.349Z'
title: typing into the 'reason for return' window inj the ready prompt is very laggy
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.349Z'
releaseDocPath: release-notes/0.2.0
---

Typing into the "reason for return" textarea in the Ready prompt is heavily laggy.

      ```
    id: c-2026-05-08t14-52-08-437z
title: typing into the 'reason for return' window inj the ready prompt is very laggy
status: Done
createdBy: Guy
updatedBy: Agent
---

Typing into the "reason for return" textarea in the Ready prompt is heavily laggy.

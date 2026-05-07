---
id: FLUX-41
title: subtask improvements
status: Released
priority: None
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T23:58:00.000Z'
    comment: >-
      Planned the first slice in two parts: make linked subtask rows open the
      child ticket from the modal, and derive parent relationships from subtask
      links so board cards can show a clickable parent badge.
    id: c-2026-05-06t23-58-00-000z
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-06T23:59:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T00:05:00.000Z'
    comment: >-
      Implemented the FLUX-41 subtask navigation improvements in the portal.
      Linked subtask rows now open the child ticket while detach remains an
      explicit separate control, and board cards now show a clickable parent
      badge derived from subtask relationships. Validated with `npm.cmd run
      build -w portal`. Commit: `f15f858` (`Improve subtask hierarchy
      navigation`).
    id: c-2026-05-07t00-05-00-000z
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-07T00:05:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.939Z'
effort: None
implementationLink: f15f858
subtasks:
  - FLUX-42
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.939Z'
releaseDocPath: release-notes/v0.1.0
---

1. clicking on a subtask inside a ticket should open that ticket, not unattach t he subtask
2. in the card, if a task has a higher task in the hierarchy it should be displayed there nicely in a box next to the ticket number like FLUX 18 -> FLUX 8
clicking on the parent should open that


---
assignee: unassigned
tags:
  - ux
  - board
priority: Low
effort: Small
implementationLink: 270dc2c850a8b6fa98879e38e67dd0606dd562db
subtasks: []
history:
  - type: activity
    user: GitHub Copilot
    date: '2026-05-08T00:03:00.000Z'
    comment: >-
      Completed ticket. Shipped centering logic for task card tooltips when
      height < 33% of viewport, with offscreen boundary clamping. (Commit:
      270dc2c)
  - type: activity
    user: GitHub Copilot
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Implemented the tooltip logic in `TaskCard.tsx`. If it is less than a
      third of the viewport, it's centered around the card. It's now Ready for
      review.
  - type: activity
    user: Guy
    date: '2026-05-07T15:25:23.007Z'
    comment: Created ticket.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.318Z'
id: FLUX-103
title: board tooltip centering
status: Released
createdBy: Guy
updatedBy: Guy
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.318Z'
releaseDocPath: release-notes/0.2.0
---
if small enough to fit (less than third of screen) it should be centered around the ticket location, without escaping out of screen border

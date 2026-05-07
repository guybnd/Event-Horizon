---
id: FLUX-30
title: description view in popup card should be proper markdown view
status: Backlog
priority: Medium
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags: []
history:
  - type: activity
    user: Guy
    date: '2026-05-06T09:44:18.377Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      This popup-only request overlaps heavily with FLUX-9 and FLUX-51. Should
      popup markdown rendering stay as a standalone first slice, or should it be
      folded into the shared ticket-description/editor work before it moves to
      `Todo`?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-30
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: comment
    user: Guy
    date: '2026-05-07T03:25:10.653Z'
    comment: maybe lets merge all 3 tickets in to 1?
    id: c-2026-05-07t03-25-10-653z
  - type: status_change
    from: Require Input
    to: Grooming
    user: Guy
    date: '2026-05-07T03:25:10.653Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Folded this popup-only slice into FLUX-51 so the shared description
      surface ships from one canonical ticket. Keeping FLUX-30 in hidden
      backlog for traceability only.
    id: c-2026-05-07t03-53-39-4816199z-flux-30
  - type: status_change
    from: Grooming
    to: Backlog
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
effort: None
implementationLink: ''
order: 0
---
## Tracking Note

This popup-specific request is now tracked under FLUX-51 so the shared
description surface lands once across popup, full view, and backlog.

similar to full view, it should show the proper formatting, and only if pressing on it should go into edit mode. (the pressing thing should be applied to full view as well instead of the edit button)

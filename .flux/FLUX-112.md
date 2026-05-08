---
priority: Low
effort: M
tags:
  - ux
  - feature
createdBy: Guy
updatedBy: Guy
title: Ready prompt as standalone popup from notification ticker
status: Grooming
assignee: unassigned
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:22:50.913Z'
    comment: >-
      Captured from FLUX-106 review comment. When a ticket reaches Ready, in
      addition to showing the prompt inside the ticket modal, allow the Ready
      prompt to surface as a distinct popup outside the ticket — triggered from
      a notification ticker. Logged here for grooming.
implementationLink: ''
subtasks: []
---
# Goal

Allow the Ready-for-merge prompt to appear as a standalone popup triggered from a notification ticker UI, outside the ticket modal itself.

# Context

Currently the Ready prompt only appears inside the ticket modal. Guy noted that it would be useful to have it surface from a notification-style ticker so users can review and act on ready tickets without opening the modal. Captured from FLUX-106 review.

# Requirements

- TBD during grooming. Key open questions:
  - Where does the notification ticker live in the UI? (header? corner toast?)
  - What does the standalone popup look like? (minimal card? full prompt panel?)
  - Should it badge/count ready tickets?
  - How does it interact with the existing modal — clicking opens the full modal?

# Out of Scope

- Changes to the in-modal Ready prompt (handled in FLUX-106).

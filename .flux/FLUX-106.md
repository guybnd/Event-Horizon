---
priority: Low
effort: S
tags:
  - ux
  - feature
createdBy: Unknown
updatedBy: Unknown
id: FLUX-106
title: Return to work button for Ready tickets
status: Grooming
assignee: unassigned
history:
  - type: activity
    user: Unknown
    date: '2026-05-07T23:54:29.753Z'
    comment: Created ticket.
---
# Goal

When a ticket is in the Ready-for-merge status, provide a way for the user to reject/send it back to work without it being committed.

# Context

Guy noted this when scoping FLUX-101: the `submitRequireInputResponse` auto-return flow should not apply to Ready tickets (excluded). Instead, there should be a dedicated UI affordance in the Ready state to return the ticket to a working status.

# Requirements

- Add a "Return to work" button (or similar) visible when a ticket is in the configured readyForMergeStatus.
- Clicking it moves the ticket to a chosen status (probably the previous one from history, or a picker).
- The existing `readyForMergeStatus` config field determines when this button shows.

# Out of Scope

- Auto-return logic (handled in FLUX-101).
- Committing or merging (the Ready status UI already handles that).

---
id: FLUX-126
title: Responding to a prompt shouldn't show up as an unread message
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - ux
  - feature
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T07:35:24.822Z'
    comment: Created ticket.
---

## Summary
When a user responds to a specific comment (like a "Require Input" prompt action), that comment and their response should automatically be marked as read.

## Requirements

### 1. Auto-Mark Read on Response
- When submitting a response to a "Require Input" comment, hook into the read-state logic.
- Automatically add the original comment ID and the new response comment ID to the user's `read-state.json`.

## Acceptance Criteria
- [ ] Replying to a prompt automatically marks the prompt as read for the current user.
- [ ] The user's newly created response comment is also immediately marked as read for themselves.
- [ ] No unread indicators remain for these specific comments after submitting a response.

## Likely Affected Areas
- `portal/src/components/TicketModal.tsx` or comment interaction handlers.
- Read state API calls.

## Notes
- This prevents the annoyance of creating a comment and immediately having to click to mark it as read.

## Original Request
for obvious reasons. when i respond to a specific commment as a require promtt action then it should mark both that and my messagte as read already

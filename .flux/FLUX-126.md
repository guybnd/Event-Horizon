---
id: FLUX-126
title: Responding to a prompt shouldn't show up as an unread message
status: In Progress
createdBy: Guy
updatedBy: Agent
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
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Plan: in `submitRequireInputResponse` (TaskModal.tsx), after `updateTask`
      returns the updated task, find (a) the prompt comment id (`lastAgentComment.id`)
      and (b) the user's new response comment id (match by `date === submittedAt`
      and `user === currentUser` in `updatedTask.history`). Call
      `ctxMarkAllCommentsRead(modalTask.id, [...idsToMark])` before `closeModal()`.
      The AppContext `markAllCommentsRead` is a synchronous state update with
      fire-and-forget persistence, so no await is needed.
    id: c-flux126-plan
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
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

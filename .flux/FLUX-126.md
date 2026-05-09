---
id: FLUX-126
title: Responding to a prompt shouldn't show up as an unread message
status: Released
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - ux
  - feature
priority: Medium
effort: S
implementationLink: 5ac8bb8c89f19a596630a0ae4fcd73487d7522cb
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T07:35:24.822Z'
    comment: Created ticket.
  - type: comment
    user: Antigravity
    date: '2026-05-08T08:36:00.000Z'
    comment: >-
      Implemented auto-read behavior in `portal/src/components/TaskModal.tsx`.
      When a user submits a response to a prompt, the system now looks up the
      original agent comment and the newly appended response comment, passing
      their IDs into `ctxMarkAllCommentsRead` so the user's read state is
      seamlessly updated without requiring an extra click. Committed in
      `5ac8bb8c89f19a596630a0ae4fcd73487d7522cb`.
    id: c-2026-05-08t08-36-00-000z
  - type: status_change
    from: Todo
    to: Done
    user: Antigravity
    date: '2026-05-08T08:36:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Plan: in `submitRequireInputResponse` (TaskModal.tsx), after `updateTask`
      returns the updated task, find (a) the prompt comment id
      (`lastAgentComment.id`) and (b) the user's new response comment id (match
      by `date === submittedAt` and `user === currentUser` in
      `updatedTask.history`). Call `ctxMarkAllCommentsRead(modalTask.id,
      [...idsToMark])` before `closeModal()`. The AppContext
      `markAllCommentsRead` is a synchronous state update with fire-and-forget
      persistence, so no await is needed.
    id: c-flux126-plan
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:01:00.000Z'
    comment: >-
      Done. In `submitRequireInputResponse` (TaskModal.tsx), after `updateTask`
      resolves, the code now collects the original prompt's comment id and the
      new response comment id (matched from `updatedTask.history` by `date` and
      `user`), then calls `ctxMarkAllCommentsRead` before `closeModal()`. Both
      comments are immediately marked read in the local React state with a
      fire-and-forget persist, so no unread indicator appears after submitting a
      Require Input response. Build clean.
    id: c-flux126-done
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T00:01:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.341Z'
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.341Z'
releaseDocPath: release-notes/0.2.0
---

## Summary
When a user responds to a specific comment (like a "Require Input" prompt action), that comment and their response should automatically be marked as read.

## Requirements

### 1. Auto-Mark Read on Response
- When submitting a response to a "Require Input" comment, hook into the read-state logic.
- Automatically add the original comment ID and the new response comment ID to the user's `read-state.json`.

## Acceptance Criteria
- [x] Replying to a prompt automatically marks the prompt as read for the current user.
- [x] The user's newly created response comment is also immediately marked as read for themselves.
- [x] No unread indicators remain for these specific comments after submitting a response.

## Likely Affected Areas
- `portal/src/components/TicketModal.tsx` or comment interaction handlers.
- Read state API calls.

## Notes
- This prevents the annoyance of creating a comment and immediately having to click to mark it as read.

## Original Request
for obvious reasons. when i respond to a specific commment as a require promtt action then it should mark both that and my messagte as read already

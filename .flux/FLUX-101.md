---
assignee: unassigned
tags:
  - ux
  - feature
priority: Medium
effort: XS
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T15:20:35.425Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T15:20:53.061Z'
    comment: Updated title.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. In TaskModal, `submitRequireInputResponse` currently creates a
      plain top-level comment. Plan: find the last `comment`-type history entry
      that has an `id`, and if found set `replyTo` on the new user comment to
      that id. The existing `repliesByParent` threading logic already renders
      replies nested under parent comments so no rendering change is needed.
    id: c-flux101-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Guy
    date: '2026-05-07T23:49:22.389Z'
    comment: >-
      responding to a user prompt should also return the ticket to the previous
      status it was in before it went to user queryable status. Ready status
      excluded from this ofc. for ready we should have a button for 'Return to
      work' or something like that to be able to 'reject' a ready ticket but
      this should be a separate ticket you should create and not in the scope of
      this task
    id: c-2026-05-07t23-49-22-389z
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T12:01:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:01:00.000Z'
    comment: >-
      Plan: (1) In `submitRequireInputResponse`, find the last comment entry
      with an `id` in `modalTask.history` and set `replyTo` on the new user
      comment. (2) Change `targetStatus` to use the ticket's status immediately
      before it entered Require Input — found by scanning history for the most
      recent status_change whose `to` equals the requireInputStatus and reading
      its `from` field. Ready status is excluded as per Guy's note.
    id: c-flux101-inprogress
  - type: comment
    user: Agent
    date: '2026-05-08T12:02:00.000Z'
    comment: >-
      Implemented. Added `useMemo` to compute `preRequireInputStatus` from
      history. Effect now sets `responseDestination` to that status on ticket
      load (if valid), falling back to the first non-promptable status. Response
      comment now carries `replyTo: lastAgentComment.id` when a parent comment
      with an id exists. Created FLUX-106 for the "Return to work" button on
      Ready tickets as Guy requested.
    id: c-flux101-done
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T12:02:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:15:00.000Z'
    comment: >-
      Validated via FLUX-108: reply threaded under agent question, status
      auto-returned to In Progress. Committed as 3a8b14a.
    id: c-flux101-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T12:15:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.317Z'
title: user prompt answer should be an inline comment reply
status: Released
implementationLink: 3a8b14a
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.317Z'
releaseDocPath: release-notes/0.2.0
---

# Goal

When a user submits a response to a "Require Input" prompt, the answer should be threaded as a reply to the last agent question comment rather than appearing as a standalone top-level comment in the history.

# Context

- `submitRequireInputResponse` in `portal/src/components/TaskModal.tsx` (line ~506) builds the comment history entry.
- History entries with `replyTo: <parentId>` are already rendered nested under the parent by the `repliesByParent` map (line ~380).
- The agent's question is the last `history` entry of `type: 'comment'` that has an `id` field.

# Implementation Plan

1. In `submitRequireInputResponse`, before building `historyUpdates`, find the last comment with an `id` in `modalTask.history`:
   ```ts
   const lastAgentComment = [...(modalTask.history || [])].reverse().find(e => e.type === 'comment' && e.id);
   ```
2. Add `replyTo: lastAgentComment?.id` to the new comment entry when a parent is found.
3. No rendering changes needed — threading is already implemented.

# Validation

- Open a ticket in "Require Input" status that has an agent comment with an `id`.
- Submit a response.
- The user's response appears nested under the agent question in the history, not as a top-level entry.


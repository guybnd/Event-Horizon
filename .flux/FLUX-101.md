---
assignee: unassigned
tags:
  - ux
  - feature
priority: Medium
effort: XS
implementationLink: ''
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
title: user prompt answer should be an inline comment reply
status: Todo
createdBy: Guy
updatedBy: Agent
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


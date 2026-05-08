---
assignee: Agent
tags:
  - feature
  - ux
priority: Low
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T04:32:28.120Z'
    comment: Created ticket.
  - type: comment
    id: c-flux119-plan
    author: Agent
    date: '2026-05-08T19:30:00.000Z'
    content: >
      **Plan:** Add a "Mark all read" button to each column header that appears
      only when the column has ≥1 task with unread comments. Calls
      markAllCommentsRead for every comment ID across all tasks in the column.
      Column needs readComments from AppContext. Button sits next to the task
      count badge in the existing column header flex row.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-05-08T19:30:00.000Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-08T19:35:00.000Z'
id: FLUX-119
title: add a mark all as read button on top of columns
status: Done
createdBy: Guy
updatedBy: Agent
---

## Problem / Motivation

When a column has many unread comments, there is no way to dismiss them all at
once at the column level — you have to open each card individually.

## Implementation Plan

1. **`Column.tsx`** — destructure `readComments` and `markAllCommentsRead` from
   `useApp()`. Compute `columnUnreadIds` (all comment IDs across column tasks
   not yet in readComments). Show a small "Mark all read" button next to the
   task count badge when `columnUnreadIds.length > 0`. On click, call
   `markAllCommentsRead` for each task in the column.

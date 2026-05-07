---
title: subtasks should appear under the upper task in the hierarchy
status: Require Input
priority: None
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags: []
history:
  - type: activity
    user: Guy
    date: '2026-05-06T12:53:15.458Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      This needs one product decision before it can move to `Todo`. When a
      subtask sits in a different status from its parent, should it appear only
      nested under the parent card, or should it also appear in its own status
      column with a parent reference and nested view affordances?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-42
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
effort: None
implementationLink: ''
subtasks: []
order: 1
---

subtickets should be nested under parent tickets in the kanban board, we should of course allow sorting them too appropriately or dragging ordering them inside etc. we should be able to collapse a parent task into or out of the subtask view in the board. we should consider how to show subtasks in separate columns that belong to the same upper task... not sure.. 

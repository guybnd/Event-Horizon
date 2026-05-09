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
    date: '2026-05-07T15:03:00.031Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed ticket. The "New Task" button will be conditionally hidden in all
      Board columns except the "Grooming" column by updating
      \portal/src/components/Column.tsx\ to check if \id === 'Grooming'\.
    id: c-agent-grooming
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Implemented the fix. The 'New Task' button conditionally renders only when
      the column id is 'Grooming' in \Column.tsx\. Scope increased: the user
      asked to make the button sticky on scroll and add a global 'New ticket'
      button in the Header.
    id: c-agent-implementation
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Implemented sticky 'New Task' button using \sticky top-3 z-10\ in
      \Column.tsx\. Added global 'New ticket' button in \Header.tsx\ next to the
      search bar using the \openTaskModal({ status: 'Grooming' })\ context
      function.
    id: c-agent-implementation-sticky
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.367Z'
id: FLUX-98
title: new task button should only be for grooming and not the other tabs in board
status: Released
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.367Z'
releaseDocPath: release-notes/0.2.0
---

## Summary
The "New Task" button in the Board view should only appear in the "Grooming" column, keeping the other columns clean. It should also stick on scroll. Additionally, a global "New Ticket" button is added to the header.

## Acceptance Criteria
- [x] Only the "Grooming" column has the "New Task" button at the bottom/top.
- [x] Other columns do not render the "New Task" button.
- [x] Button in Grooming column is sticky on scroll.
- [x] Header includes a "New Ticket" button next to global search.

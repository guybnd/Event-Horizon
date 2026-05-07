---
title: editable fields in kanban card
status: Done
priority: Medium
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags: []
history:
  - type: activity
    user: Guy
    date: '2026-05-06T12:12:15.912Z'
    comment: Created ticket.
  - type: comment
    user: Guy
    date: '2026-05-06T12:12:15.912Z'
    comment: think this was done already?
    id: c-2026-05-06t12-12-15-912z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-06T12:13:55.138Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-06T19:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      This no longer looks like a normal grooming candidate. The current board
      card implementation already supports inline title, assignee, priority, and
      tag editing in `TaskCard`, so the remaining decision is whether this
      ticket should be closed as already shipped or kept as a smaller follow-up
      for any missing inline gaps such as effort or status behavior. Which do
      you want?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-22
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
  - type: status_change
    from: Require Input
    to: Done
    user: Guy
    date: '2026-05-07T03:10:53.402Z'
  - type: comment
    user: Guy
    date: '2026-05-07T03:11:00.289Z'
    comment: closed
    id: c-2026-05-07t03-11-00-289z
effort: S
implementationLink: ''
order: 9
subtasks: []
---
## Groomed Scope

Support inline editing for the fields already visible on the kanban card so quick changes do not require opening the ticket modal.

## First Version Fields

- Title
- Assignee
- Priority
- Tags

Status is already editable elsewhere and can stay out of scope for this ticket if needed.

## Acceptance Criteria

- [ ] Each visible card field can be edited inline from the board
- [ ] Inline controls do not accidentally open the full ticket modal
- [ ] Saving an inline edit persists immediately and refreshes the board state
- [ ] Inline editing works without breaking drag-and-drop interactions

## Files Likely Affected

- `portal/src/components/TaskCard.tsx`
- `portal/src/api.ts`

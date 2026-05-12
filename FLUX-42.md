---
title: Subtasks should appear under the parent task in the hierarchy
status: Todo
priority: Medium
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - ui
  - feature
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
  - type: comment
    user: Guy
    date: '2026-05-07T03:15:44.640Z'
    comment: must appear in its relevant status column
    id: c-2026-05-07t03-15-44-640z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T03:15:44.640Z'
    comment: Response submitted
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Tightened this around the current implementation surface: parents already
      store `subtasks`, cards can already show parent context, and the missing
      work is nested rendering, cross-column behavior, and ordering. This is now
      concrete enough to stay in `Todo`.
    id: c-2026-05-07t03-53-39-4816199z-flux-42
effort: L
implementationLink: ''
subtasks: []
order: 15
---
## Summary

Render subtasks as child items under their parent card in the board hierarchy
while still keeping each subtask visible in its own status column. The board
needs a parent-child view layer, not a rule that forces child tickets into the
parent's status.

## Requirements

### 1. Preserve each subtask's own status
- A subtask must still appear in its relevant status column even when it belongs to a parent in another column
- Parent cards should make cross-column subtasks visible through a summary, badge, or expandable child list
- Moving a subtask between columns changes the subtask's status only; it must not silently drag the parent with it

### 2. Add nested hierarchy rendering
- When a parent and child share a column, render the child visually nested under the parent card
- Parent cards should support collapse and expand behavior for their child list
- Nested presentation should remain readable when a parent has multiple subtasks

### 3. Support ordering and drag behavior
- Parent tickets must remain sortable among peer tickets in the column
- Subtasks should have a stable order within the parent group
- Reordering subtasks must preserve the parent-child link instead of detaching the child
- Cross-column moves must keep the parent-child relationship intact

### 4. Expose the relationship clearly in ticket details
- Ticket detail views should show both linked subtasks and the parent reference where relevant
- The editor should prevent or surface invalid self-links or obvious cycles
- Existing parent-owned `subtasks` links should remain compatible with the board rendering changes

## Acceptance Criteria

- [ ] Subtasks render nested under their parent when they share a column
- [ ] Subtasks still appear in their own status columns when their status differs from the parent
- [ ] Parent cards can collapse and expand their child list
- [ ] Subtask ordering is stable and can be adjusted without losing the relationship
- [ ] The ticket detail surface clearly shows the hierarchy and handles broken links safely

## Likely Affected Areas

- `portal/src/components/Board.tsx`
- `portal/src/components/Column.tsx`
- `portal/src/components/TaskCard.tsx`
- `portal/src/components/TaskModal.tsx`
- `portal/src/types.ts`

## Notes

- The current board already derives parent context from the parent's `subtasks` list, so this ticket can build on that model instead of inventing a separate hierarchy schema first

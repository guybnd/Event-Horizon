---
assignee: unassigned
tags:
  - bug
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T03:30:08.119Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-12T09:43:39.090Z'
    comment: Launched Claude Code session (52533263).
  - type: activity
    user: Agent
    date: '2026-05-12T09:51:33.468Z'
    comment: Updated description.
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-12T09:51:53.770Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-12T09:51:54.387Z'
title: dragging ticket between column resets the view
status: In Progress
createdBy: Guy
updatedBy: Agent
---
## Problem

Dragging a ticket from one column to another resets the horizontal board scroll position, which feels jarring.

## Root Cause

`handleDragStart` in `portal/src/components/Board.tsx` saves `scrollerRef.current.scrollLeft` at pick-up time into `savedScrollRef`. When the drag ends, `handleDragEnd` blindly restores that saved value via `requestAnimationFrame` — even when dnd-kit auto-scrolled the board horizontally during the drag to reveal the target column.

Result: the view snaps back to where the drag started instead of staying where the card was dropped.

## Fix

Remove the scroll-save-and-restore logic entirely:
- Delete `savedScrollRef`
- Remove the `savedScrollRef.current = ...` assignment in `handleDragStart`
- Remove the `requestAnimationFrame` scroll restore in `handleDragEnd`

The browser already keeps the scroll position exactly where the pointer released the card. There is no need to intervene.

## Touchpoints

- `portal/src/components/Board.tsx` — `handleDragStart`, `handleDragEnd`, `savedScrollRef`

## Validation

- Drag a card left across multiple columns: board stays at the drop target column
- Drag a card right across multiple columns: same
- Reorder cards within the same column: scroll position unchanged

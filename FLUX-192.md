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
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-12T09:53:06.073Z'
  - type: comment
    user: Agent
    date: '2026-05-12T09:53:06.074Z'
    comment: >-
      Removed savedScrollRef and the requestAnimationFrame scroll-restore from
      Board.tsx. The scroll-save-on-drag-start / restore-on-drag-end pattern was
      fighting dnd-kit's auto-scroll: if the board scrolled horizontally during
      the drag to reveal the target column, handleDragEnd snapped it back to the
      pre-drag position. The browser keeps scroll exactly where the pointer
      released the card, so no intervention is needed. TypeScript check passes
      cleanly.
    id: c-2026-05-12t09-53-06-074z
  - type: agent_message
    user: Claude Code
    date: '2026-05-12T09:53:16.010Z'
    comment: >-
      Done. Here's the summary:


      **FLUX-192 — Ready for review**


      The bug was in `Board.tsx`: `handleDragStart` saved
      `scrollerRef.current.scrollLeft` at pick-up time, and `handleDragEnd` used
      a `requestAnimationFrame` to forcibly restore that position after every
      drop. When dnd-kit auto-scrolled the board horizontally to reveal the
      target column during a drag, the restore snapped the view back to the
      original column — the exact jarring UX reported.


      **Fix**: removed `savedScrollRef` and the rAF scroll-restore entirely (3
      lines deleted). The browser natively keeps the scroll position where the
      pointer released the card — no intervention needed.


      Ticket is now in `Ready`. Say `finish FLUX-192` when you're happy and I'll
      commit and close it.
  - type: activity
    user: Agent
    date: '2026-05-12T09:53:16.015Z'
    comment: Claude Code session ended with code 0.
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-05-12T10:22:26.915Z'
  - type: activity
    user: Agent
    date: '2026-05-12T10:22:27.112Z'
    comment: Launched Claude Code session (96dc780b).
title: dragging ticket between column resets the view
status: In Progress
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 910805
  outputTokens: 26523
  costUSD: 0.926876
  costIsEstimated: false
  cacheReadTokens: 862283
  cacheCreationTokens: 48496
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

---
assignee: Agent
tags:
  - bug
priority: Medium
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-11T03:30:11.661Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-11T05:51:21.571Z'
    comment: Launched Claude Code session (e6650a52).
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-11T05:56:02.206Z'
  - type: activity
    user: Agent
    date: '2026-05-11T05:56:02.206Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-11T05:56:12.232Z'
    comment: >-
      Groomed. Root cause: dnd-kit scroll manipulation during drag resets the
      horizontal scroll of the columns container on drop. Fix: save scrollLeft
      on dragStart, restore via requestAnimationFrame in handleDragEnd. Single
      change to Board.tsx. Status: Todo, ready for implementation.
    id: c-2026-05-11t05-56-12-232z
  - type: agent_message
    user: Claude Code
    date: '2026-05-11T05:56:16.479Z'
    comment: >-
      FLUX-193 is groomed and moved to **Todo**.


      **Root cause:** dnd-kit auto-scrolls the `overflow-x-auto` columns wrapper
      during drag. When drag ends, the scroll position resets — either from
      dnd-kit's internal cleanup or from the React re-render triggered by
      `triggerRefresh()` → `loadTasks()` → `setTasks()`.


      **Plan:** In `Board.tsx`, add a `ref` to the columns wrapper, save
      `scrollLeft` in `handleDragStart`, and restore it via
      `requestAnimationFrame` in `handleDragEnd`. The rAF defers the restore
      until after dnd-kit finishes its post-drag scroll cleanup. XS effort,
      single file.
  - type: activity
    user: Agent
    date: '2026-05-11T05:56:16.480Z'
    comment: Claude Code session ended with code 0.
title: dragging ticket between column resets the view
status: Todo
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 1007853
  outputTokens: 15575
  costUSD: 0.655407
  costIsEstimated: false
  cacheReadTokens: 973154
  cacheCreationTokens: 33756
---
## Problem

dnd-kit auto-scrolls the board columns container (`overflow-x-auto`) during cross-column drags. When the drag ends and the board re-renders (triggered by `triggerRefresh` -> `loadTasks`), the scroll position of the columns wrapper resets — the user is snapped back to the leftmost column.

## Root Cause

`Board.tsx` line 218: `DndContext` wraps the `overflow-x-auto` columns container with default `autoScroll` enabled. On drag end, after `applyStatusChange` calls `triggerRefresh()` -> `loadTasks()`, `setTasks(fetchedTasks)` causes a re-render while dnd-kit may have manipulated scroll position, resulting in scroll reset.

## Fix

In `portal/src/components/Board.tsx`:

1. Add a `useRef` for the columns wrapper `div` (the `overflow-x-auto` element).
2. In `handleDragStart`, save `scrollerRef.current.scrollLeft` into a local ref.
3. In `handleDragEnd`, after the active task is cleared, schedule a `requestAnimationFrame` that restores `scrollerRef.current.scrollLeft` to the saved value.

The `requestAnimationFrame` defers restoration until after dnd-kit finishes its post-drag scroll cleanup.

## Files Changed

- `portal/src/components/Board.tsx` — add `scrollerRef`, `savedScrollRef`, save on drag start, restore on drag end

## Validation

- Scroll board right and drag a card to a far column: scroll position stays at drop location
- Drag within same column: scroll unchanged
- Cancel drag: scroll unchanged

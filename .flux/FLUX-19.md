---
title: Allow ordering columns in kanban
status: Done
createdBy: Guy
updatedBy: Guy
assignee: Agent
tags:
  - feature
history:
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-06T17:49:00+10:00'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-06T17:56:00+10:00'
  - type: comment
    user: Agent
    date: '2026-05-06T17:56:00+10:00'
    comment: >-
      Implemented drag-and-drop column reordering in the Settings panel using
      @dnd-kit/sortable. Verified it correctly updates config.json and reflects
      on the board.
order: 5
---
## Summary

Allow users to configure the order of columns in the kanban board view. Columns should be reorderable via the Settings menu and optionally via drag-and-drop on the board itself.

## Requirements

### 1. Reorder via Settings
- In the Settings panel, the "Statuses (Columns)" section already shows a list of columns
- Add drag handles (grip icon) to each status row to allow drag-and-drop reordering
- The order in `config.columns` array determines the board column order
- Use `@dnd-kit/sortable` (already installed) for drag-and-drop in settings

### 2. Reorder via board drag-and-drop (optional, Phase 2)
- Drag a column header left/right to reorder columns directly on the board
- This is more complex and can be a follow-up; Settings reorder is the priority

### 3. Persistence
- Column order is already implicitly persisted via the order of the `config.columns` array in `config.json`
- When reordering in Settings, save the new array order via `PUT /api/config`
- No schema changes needed

## Current Behavior

The `config.columns` array is:
```json
[{ "name": "Todo" }, { "name": "In Progress" }, { "name": "Done" }, { "name": "Require Input" }]
```
Board renders columns in this order. Changing the array order changes the board order.

## Implementation Plan

### Settings.tsx changes
1. In the status/columns management section, wrap the list in a `<SortableContext>`
2. Each status row gets a drag handle
3. On drag end, reorder the `config.columns` array
4. Save triggers `PUT /api/config` with the reordered array

### Board.tsx changes
- No changes needed — it already reads `config.columns` in order
- Just ensure `allColumns` preserves the config order

## Acceptance Criteria

- [ ] Settings panel allows drag-and-drop reordering of column statuses
- [ ] Reordered columns immediately reflect on the kanban board
- [ ] Order persists after page reload (saved in `config.json`)
- [ ] Hidden statuses (Backlog) remain separate and unaffected
- [ ] Extra statuses (not in config) still appear at the end

## Files to Modify

- `portal/src/components/Settings.tsx` — Add sortable drag handles to column/status list
- No engine changes needed — `config.columns` array order already determines board order


---
title: Allow reordering tickets in kanban columns
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:31:00.000Z'
    comment: >-
      Fleshed this out with implementation approach using @dnd-kit/sortable
      which is already installed. Ready to implement.
---
## Summary

Allow users to drag tickets within a column to reorder them. Currently, drag-and-drop only moves tickets between columns (changes status). This adds intra-column sorting with persisted order.

## Requirements

### 1. Drag to reorder within a column
- Drag a card up or down within the same column to change its position
- Visual feedback during drag: insertion indicator line between cards
- Smooth animations when cards shift positions
- Existing cross-column drag (status change) still works

### 2. Persist sort order
- Add an `order` field to ticket frontmatter (numeric, e.g. `order: 1`)
- When reordering, update the `order` field on affected tickets
- On load, tickets within a column are sorted by `order` (then by ID as fallback)
- New tickets default to `order: 0` (appear at top) or `order: max+1` (appear at bottom)

### 3. @dnd-kit/sortable integration
- The project already has `@dnd-kit/core` installed
- Also has `@dnd-kit/sortable` installed — use `SortableContext` and `useSortable` hook
- Replace `useDraggable` in `TaskCard` with `useSortable`
- Column wraps its cards in `SortableContext`

## Implementation Plan

### 1. Add `order` field to types
```typescript
export interface Task {
  // ...existing fields
  order?: number;  // NEW — sort position within column
}
```

### 2. Update Column.tsx
- Wrap cards in `<SortableContext>` with `verticalListSortingStrategy`
- Sort tasks by `order` before rendering
- Pass sorted task IDs to `SortableContext`

### 3. Update TaskCard.tsx
- Replace `useDraggable` with `useSortable`
- `useSortable` provides both drag handle and drop target
- Apply `transform` and `transition` styles from `useSortable`

### 4. Update Board.tsx `handleDragEnd`
- Detect if drag is within same column (reorder) vs cross-column (status change)
- For reorder: calculate new `order` values and batch-update affected tickets
- For cross-column: existing logic + set `order` to place at end of target column

### 5. Update engine
- Accept `order` field in PUT `/api/tasks/:id`
- Include `order` in task frontmatter when saving

## Acceptance Criteria

- [ ] Cards can be dragged up/down within a column to reorder
- [ ] Visual insertion indicator shows where the card will be placed
- [ ] Order persists across page reloads (saved to frontmatter)
- [ ] Cross-column drag (status change) still works
- [ ] New tickets appear at a sensible position (top or bottom)
- [ ] Smooth drag animations

## Files to Modify

- `portal/src/types.ts` — Add `order` field to `Task`
- `portal/src/components/TaskCard.tsx` — Switch from `useDraggable` to `useSortable`
- `portal/src/components/Column.tsx` — Add `SortableContext`, sort tasks by order
- `portal/src/components/Board.tsx` — Handle intra-column reorder in `handleDragEnd`
- `engine/src/index.ts` — Ensure `order` field is persisted in frontmatter


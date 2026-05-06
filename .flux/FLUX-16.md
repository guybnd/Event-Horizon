---
title: Add priority field to tickets
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T07:32:00.000Z'
    comment: >-
      Fleshed out with full spec covering config, data model, card UI, and modal
      UI. Ready to implement.
---
## Summary

Add a priority field to tickets with configurable priority levels, icons, and colors. Priority should be visible on kanban cards and editable from both the card and the modal.

## Requirements

### 1. Priority configuration in Settings
- Add a "Priorities" section to the Settings panel (similar to Tags/Users/Statuses)
- Each priority has: `name`, `icon`, `color`
- Default priorities: `Critical` (🔴), `High` (🟠), `Medium` (🟡), `Low` (🟢), `None` (⚪)
- User can add, rename, reorder, and delete priorities
- Store in `config.json` under a new `priorities` field

### 2. Priority field on tickets
- Add `priority` field to ticket frontmatter (string matching a priority name)
- Default to `"None"` or empty for new tickets
- Include in the `Task` TypeScript interface

### 3. Kanban card display
- Show priority icon + label on each card (next to tags or next to assignee)
- Use a small colored dot or icon to indicate priority at a glance
- Optionally: colored left border on the card based on priority

### 4. Quick-change from card
- Click the priority indicator on the card to open a dropdown
- Select a new priority directly without opening the modal
- This saves immediately (like a quick status change)

### 5. Modal editing
- Add a "Priority" dropdown in the metadata section (alongside Status and Assignee)
- Shows the priority icon + name
- Saves with the rest of the ticket fields

## Data Model

### Config addition
```json
{
  "priorities": [
    { "name": "Critical", "icon": "🔴", "color": "text-red-500" },
    { "name": "High", "icon": "🟠", "color": "text-orange-500" },
    { "name": "Medium", "icon": "🟡", "color": "text-yellow-500" },
    { "name": "Low", "icon": "🟢", "color": "text-green-500" },
    { "name": "None", "icon": "⚪", "color": "text-gray-400" }
  ]
}
```

### Task interface update
```typescript
export interface Task {
  // ...existing fields
  priority?: string;  // NEW — matches a priority name from config
}
```

### Config interface update
```typescript
export interface PriorityDef {
  name: string;
  icon: string;
  color: string;
}

export interface Config {
  // ...existing fields
  priorities: PriorityDef[];
}
```

## Implementation Plan

1. **Config & types** — Add `PriorityDef` type and `priorities` to `Config`. Add migration in engine for existing configs without priorities.
2. **Settings UI** — Add priorities manager section in `Settings.tsx` (follows same pattern as tags/users)
3. **TaskCard.tsx** — Show priority icon on card, add click-to-change dropdown
4. **TaskModal.tsx** — Add priority dropdown in metadata section
5. **Board.tsx** — Pass priority data through, no major changes
6. **Engine** — Accept `priority` field, include in bulk-rename for priority renames

## Acceptance Criteria

- [ ] Config has `priorities` array with default values
- [ ] Settings panel allows managing priorities (add/edit/delete/reorder)
- [ ] Each ticket card shows its priority icon
- [ ] Priority can be changed directly from the card via dropdown
- [ ] Priority can be changed in the modal's metadata section
- [ ] Priority persists in the ticket's frontmatter
- [ ] Bulk rename handles priority renames across all tickets
- [ ] New tickets default to "None" priority

## Files to Modify

- `portal/src/types.ts` — Add `PriorityDef`, update `Task` and `Config`
- `portal/src/components/TaskCard.tsx` — Display priority, add quick-change dropdown
- `portal/src/components/TaskModal.tsx` — Add priority dropdown in metadata
- `portal/src/components/Settings.tsx` — Add priorities management section
- `engine/src/index.ts` — Handle `priority` field, config migration, bulk-rename
- `.flux/config.json` — Add default priorities


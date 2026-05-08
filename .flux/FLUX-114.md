---
assignee: unassigned
tags:
  - ux
priority: Medium
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:48:05.673Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T15:00:00.000Z'
    comment: >-
      Groomed. Plan: replace the 4 native `<select>` dropdowns in
      TaskViewControls.tsx (Sort, Assignee, Priority, Tag) with custom
      div-based dropdown components so icons and colored swatches can render
      inside both the pill trigger and the open option list. Priority items
      use the same icon+color as on cards (AlertCircle, ChevronUp,
      ChevronDown, Equal from lucide-react with the PriorityDef.color
      class). Tag items render as colored badge pills matching the
      `px-1.5 py-0.5 rounded text-[10px] font-medium` style on TaskCard,
      using TagDef.color. Assignee items show a User icon. Sort items show
      directional icons. Helper functions (getTagColor, getPriorityIcon)
      are already in TaskCard.tsx — they will be inlined locally in
      TaskViewControls since they only need config, not component state.
      Each custom dropdown closes on outside click (useRef + window
      mousedown listener). Moving to Todo.
    id: c-flux114-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T15:00:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T15:01:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T15:10:00.000Z'
    comment: >-
      Implemented. Replaced all 4 native `<select>` dropdowns in
      TaskViewControls.tsx with custom `FilterDropdown` + `DropdownItem`
      components. Sort shows ArrowUpDown icons per item. Assignee shows User
      icons. Priority renders the same icon+color as task cards
      (AlertCircle/ChevronUp/Equal/ChevronDown). Tag items render as colored
      badge pills using TagDef.color, matching the card style exactly.
      Active filter value is mirrored in the trigger pill. Dropdown closes
      on outside click via window mousedown listener. No TypeScript errors.
    id: c-flux114-impl
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T15:10:00.000Z'
id: FLUX-114
title: add icons and style to filters in the board view
status: Ready
createdBy: Guy
updatedBy: Agent
---

## Goal

Replace the 4 native `<select>` filter dropdowns in the board/backlog filter bar with custom styled dropdowns that show icons and colored swatches, matching the visual language used on task cards.

## Scope

File: `portal/src/components/TaskViewControls.tsx`

Replace all four native `<select>` elements (Sort, Assignee, Priority, Tag) with custom dropdown components built from `div`/`button` elements.

## Per-filter Rendering

**Sort** — each option shows a sort-direction icon (ArrowUpDown or similar) + label text.

**Assignee** — each option shows a `User` icon (lucide-react) + name. "All assignees" and "Unassigned" are special entries.

**Priority** — each option shows the same icon + color as on task cards: `AlertCircle` (Critical), `ChevronUp` (High), `Equal` (Medium), `ChevronDown` (Low), no icon for None. Icon class comes from `PriorityDef.color`.

**Tag** — each option renders a colored badge pill using `TagDef.color` and matching the `px-1.5 py-0.5 rounded text-[10px] font-medium` style from TaskCard. "All tags" is a plain text entry.

## Trigger Pill

The label row (`ASSIGNEE`, `PRIORITY`, etc.) stays; the current value is shown as text (or a badge for tags/priority). A small `ChevronDown` indicates it is interactive.

## Behaviour

- Click trigger toggles open; click outside (window mousedown) closes.
- Selected value highlighted in list.
- Dropdown panel: `absolute z-50` positioned below trigger, `bg-white dark:bg-[#252630]` with border and shadow matching existing popover style in the codebase.

## Helper Logic

Inline `getTagColor(name, config)` and `getPriorityIcon(name, config)` locally — same logic as TaskCard, no shared file needed.

## Validation

Open both Board and Backlog filter bars in dark mode and light mode, expand each dropdown, confirm icons and colors render correctly for all configured priorities and tags.

---
title: Full screen ticket view
status: Released
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
      Fleshed out with detailed layout spec inspired by Jira/Linear ticket
      views. Ready to implement.
    id: c-2026-05-06t07-32-00-000z
  - type: status_change
    from: Todo
    to: In Progress
    user: Guy
    date: '2026-05-06T07:59:32.144Z'
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-05-06T22:56:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T22:56:00.000Z'
    comment: >-
      Closing this out after verifying the full-view implementation in
      `TaskModal`. The current flow supports full-view toggle, back-to-board
      navigation, Escape handling, and full/popup URL state while preserving the
      ticket editing and comment functionality.
    id: c-2026-05-06t22-56-00-000z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.914Z'
order: 0
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.914Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary

Add a full-screen ticket view as an alternative to the current floating modal. This provides a dedicated, spacious layout for viewing and editing tickets — similar to Jira's ticket detail page.

## Requirements

### 1. Full-screen layout
- Replaces the floating `<Rnd>` modal with a full-page view
- Accessible via a "Full View" button on the modal, or by URL route (e.g. `/ticket/FLUX-4`)
- Takes up the entire viewport below the header

### 2. Two-column layout

```
┌─────────────────────────────────────────────────────────┐
│  Header Bar: [← Back] FLUX-4 · Title        [Save] [⋯] │
├──────────────────────────────────┬──────────────────────┤
│                                  │                      │
│  Description (rendered markdown) │  Status: [dropdown]  │
│  ─────────────────────────       │  Assignee: [dropdown]│
│  [Edit Description]              │  Priority: [dropdown]│
│                                  │  Tags: [tag chips]   │
│                                  │  Created by: Guy     │
│                                  │  Updated by: Agent   │
│                                  │  Created: May 6      │
│                                  │                      │
│  ───────────────────────────     ├──────────────────────┤
│  Activity & Comments             │                      │
│  [All] [Comments]                │  (right sidebar      │
│                                  │   scrolls             │
│  ┌─ Agent · 2 min ago ────┐     │   independently)     │
│  │ Posted a plan...        │     │                      │
│  └─────────────────────────┘     │                      │
│                                  │                      │
│  [Add comment...]                │                      │
│                                  │                      │
│  (70-80% width)                  │  (20-30% width)      │
└──────────────────────────────────┴──────────────────────┘
```

### 3. Left panel (70-80%)
- **Description area:** Rendered markdown by default (ties into FLUX-9), with edit button
- **Activity section below:** Full comment history, scrollable
- **Comment input:** Fixed at bottom of the left panel
- Both sections scroll independently

### 4. Right panel (20-30%)
- **Metadata fields:** Status, Assignee, Priority, Tags
- **Details:** Created by, updated by, dates
- **Actions:** Delete button, link to raw `.md` file
- Sticky positioning (doesn't scroll with left panel)

### 5. Navigation
- "← Back to Board" button returns to the kanban view
- Keyboard shortcut: `Escape` to go back
- Optional: URL routing so `/ticket/FLUX-4` opens the full view directly

## Implementation Plan

### Phase 1 — Full-screen view as modal mode
- Add a `isFullView` state to `TaskModal` or a new `TaskFullView` component
- Toggle between floating modal and full-screen view via button
- No URL routing yet — simpler implementation

### Phase 2 — URL routing (future)
- Add `react-router-dom` for client-side routing
- `/board` → Board view, `/ticket/:id` → Full view
- Clicking a card can go directly to full view

## Acceptance Criteria

- [ ] "Full View" button on the modal opens a full-screen ticket page
- [ ] Layout: left panel (description + comments) takes 70-80%, right panel (metadata) takes 20-30%
- [ ] Description shows rendered markdown (or edit mode)
- [ ] Activity/comments section is scrollable below description
- [ ] Right sidebar shows all metadata fields with edit capability
- [ ] "Back to Board" navigation works
- [ ] Responsive: both panels scroll independently
- [ ] Keyboard: Escape goes back to board
- [ ] All existing save/edit/comment functionality works in full view

## Files to Create/Modify

- `portal/src/components/TaskFullView.tsx` — **[NEW]** Full-screen ticket layout
- `portal/src/components/TaskModal.tsx` — Add "Full View" toggle button
- `portal/src/App.tsx` — Conditionally render full view vs board
- `portal/src/AppContext.tsx` — Add `isFullView` state

## Dependencies

- Pairs well with: FLUX-9 (rendered markdown view)
- Pairs well with: FLUX-16 (priority field — shown in right sidebar)


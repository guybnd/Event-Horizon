---
assignee: unassigned
tags:
  - ux
  - feature
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:45:14.254Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Groomed. Affected surfaces: Settings (already has a sticky bottom save
      bar), DocsScreen (Save button in the toolbar is fixed at top). Primary
      target is DocsScreen where the Save button is in a header bar that scrolls
      away on long docs. Plan: make the DocsScreen top toolbar position sticky
      so Save stays visible while scrolling. Settings bar is already sticky.
    id: c-flux72-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T06:16:27.284Z'
title: Dirty State improvements
status: Backlog
createdBy: Guy
updatedBy: Guy
---

# Goal

On pages with a Save button (DocsScreen, Settings), the button should remain visible and follow the user as they scroll, so they never lose access to it when the page is dirty.

# Context

- **Settings**: already has a `fixed bottom-0` save bar that slides in when dirty — this is working correctly.
- **DocsScreen**: has a toolbar row with the Save button at the top of the editor panel. If the doc content is long, the toolbar may scroll out of view.

# Implementation Plan

1. In `portal/src/components/DocsScreen.tsx`, locate the toolbar / header row that contains the Save button.
2. Make that row `sticky top-0 z-10` (or equivalent) so it stays pinned while the doc body scrolls beneath it.
3. Ensure the sticky header doesn't overlap the global app header (check z-index stacking).
4. Smoke-test on a long doc to confirm Save remains visible throughout scroll.

# Validation

- Open a long doc in DocsScreen, make an edit, scroll to the bottom — Save button should still be visible.
- Settings save bar continues to work as-is.

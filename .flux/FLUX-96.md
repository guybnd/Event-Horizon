---
assignee: unassigned
tags:
  - bug
priority: High
effort: XS
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T14:08:54.242Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Root cause identified: `originalPayload` in Settings.tsx does not include
      `docsRoot`, `hoverPopupsEnabled`, and `hoverPopupDelay`, but
      `currentSavedPayload` does. This causes a permanent JSON mismatch so
      `isDirty` is always true. Fix: add those three fields to `originalPayload`
      with the same fallback defaults used elsewhere. XS effort, no UX change.
    id: c-flux96-groom
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T12:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:00:00.000Z'
    comment: >-
      Added `docsRoot`, `hoverPopupsEnabled`, and `hoverPopupDelay` to
      `originalPayload` in Settings.tsx with matching fallback defaults. The
      `isDirty` flag is now false on fresh load.
    id: c-flux96-done
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T12:00:00.000Z'
id: FLUX-96
title: settings save button always show as dirty
status: Ready
createdBy: Guy
updatedBy: Agent
---

# Problem

In `portal/src/components/Settings.tsx`, the `isDirty` flag compares `currentSavedPayload` against `originalPayload`. `currentSavedPayload` includes `docsRoot`, `hoverPopupsEnabled`, and `hoverPopupDelay`, but `originalPayload` does not. This causes a permanent JSON mismatch so the save bar and dirty indicator are always visible on load.

# Implementation Plan

1. Open `portal/src/components/Settings.tsx`.
2. Add the three missing fields to `originalPayload` (around line 650):
   - `docsRoot: config.docsRoot || ''`
   - `hoverPopupsEnabled: config.hoverPopupsEnabled ?? true`
   - `hoverPopupDelay: config.hoverPopupDelay ?? 500`
3. Verify `isDirty` is `false` on fresh load and `true` only after an actual change.

# Validation

- Open Settings with no changes — save bar should not appear.
- Make a change — save bar appears.
- Save or discard — save bar disappears.


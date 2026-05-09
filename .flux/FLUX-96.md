---
assignee: unassigned
tags:
  - bug
priority: High
effort: XS
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
  - type: comment
    user: Agent
    date: '2026-05-08T12:15:00.000Z'
    comment: >-
      Validated via FLUX-108 test ticket. Closed and committed as a3f0de5.
      Settings save bar no longer appears on fresh load.
    id: c-flux96-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T12:15:00.000Z'
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.366Z'
id: FLUX-96
title: settings save button always show as dirty
status: Released
implementationLink: a3f0de5
createdBy: Guy
updatedBy: Agent
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.366Z'
releaseDocPath: release-notes/0.2.0
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


---
title: 'Bug: New task window shows blurred screen on top of modal'
status: Released
createdBy: User
updatedBy: Agent
assignee: ''
tags:
  - bug
  - ui
priority: High
effort: S
implementationLink: d8376823a5ecfe419bd2f67af39b946408dc4bfd
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-07T09:34:00.000Z'
    comment: >-
      Completed ticket. Added !z-[60] to TaskModal.tsx Rnd component to render
      the  modal window correctly above the background blur overlay instead of
      below it.  Committed as d837682.
  - type: activity
    user: Agent
    date: '2026-05-07T09:32:11.220Z'
    comment: Fixed z-index of Rnd component in TaskModal to appear above the overlay.
  - type: activity
    user: User
    date: '2026-05-07T09:28:19.000Z'
    comment: Created ticket.
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-07T13:54:26.990Z'
order: 84
version: v0.1.0
releasedAt: '2026-05-07T13:54:26.990Z'
releaseDocPath: release-notes/v0.1.0
---
## Summary

When opening the new task window, the UI is broken. A blurred screen overlay is displayed *on top* of the modal of the new item popup, obscuring the content and making it unusable.

## Steps to Reproduce
1. Click the button/action to create a new task.
2. Observe the modal that appears.

## Expected Behavior
The new task modal should appear clearly on top of the background, with the background overlay being blurred or dimmed behind the modal (e.g., lower `z-index`).

## Actual Behavior
The blurred overlay appears on top of the new task modal, covering the input fields.

## Likely Affected Areas
- `portal/src/components/` (specifically the New Task Modal or generic Modal component wrapper)
- CSS `z-index` configuration for the modal overlay vs. the modal content itself.

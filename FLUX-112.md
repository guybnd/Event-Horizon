---
title: Ready prompt as standalone popup from notification ticker
status: Backlog
assignee: unassigned
tags:
  - ux
  - feature
priority: Low
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T00:22:50.913Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-08T00:22:50.913Z'
    comment: >-
      Captured from FLUX-106 review comment. When a ticket reaches Ready, in
      addition to showing the prompt inside the ticket modal, allow the Ready
      prompt to surface as a distinct popup outside the ticket — triggered from
      a notification ticker. Logged here for grooming.
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-11T05:58:54.572Z'
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-11T05:58:58.230Z'
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T06:16:21.160Z'
createdBy: Guy
updatedBy: Guy
order: 160
---

## Summary
When a ticket reaches the "Ready" state, the prompt currently only appears inside the ticket modal. It would be useful to surface this prompt as a standalone popup outside the ticket, triggered from a notification-style ticker UI, so users can review and act on ready tickets without opening the modal.

## Requirements

### 1. Notification Ticker UI
- Implement a notification ticker or badge (e.g., in the header) that indicates the count of "Ready" tickets.
- Clicking the ticker should open a standalone popup or flyout.

### 2. Standalone Ready Popup
- The popup should display a minimal version of the "Ready for merge/release" prompt.
- Users should be able to approve or act on the prompt directly from this popup without needing to open the full ticket modal.

## Acceptance Criteria
- [ ] A notification ticker displays the number of ready tickets.
- [ ] Clicking the ticker opens a popup with the Ready prompt.
- [ ] Acting on the prompt in the popup updates the ticket correctly.

## Likely Affected Areas
- `portal/src/components/Header.tsx` (for the ticker).
- New component for the Ready Popup.

## Notes
- Handled outside of FLUX-106 (which focuses on the in-modal prompt).
- UI placement: Header is the most logical location for a global notification ticker.

## Original Request
Captured from FLUX-106 review comment. When a ticket reaches Ready, in addition to showing the prompt inside the ticket modal, allow the Ready prompt to surface as a distinct popup outside the ticket — triggered from a notification ticker. Logged here for grooming.

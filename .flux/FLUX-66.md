---
assignee: unassigned
tags:
  - ui
  - navigation
priority: Medium
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T04:50:17.787Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T05:23:46.190Z'
    comment: >-
      Grooming check: The implementation plan is defined in the description
      below.  Proposed Metadata: Priority: Medium, Effort: S, Tags: ui,
      navigation. Does this plan and metadata look correct? Please confirm or
      adjust.
    id: c-1778131426196-flux-66.md
  - type: comment
    user: Guy
    date: '2026-05-07T05:32:27.590Z'
    comment: confirm
    id: c-2026-05-07t05-32-27-590z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-07T05:32:27.590Z'
    comment: Response submitted
title: ticket view should keep top bar
status: Todo
createdBy: Guy
updatedBy: Guy
order: 12
---
## Summary

Ensure the top navigation bar remains visible in both popup and full ticket
view modes so users can search, navigate to other tickets, and switch between
views without closing the current ticket first.

## Requirements

### 1. Persistent top bar in full ticket view
- Full ticket view should render within the existing layout shell that includes the top navigation bar
- Search, view switching, and navigation controls remain accessible at all times
- The top bar should not scroll away with the ticket content

### 2. Persistent top bar in popup ticket view
- Popup ticket view overlay should not obscure the top bar
- Users should be able to interact with search and navigation without closing the popup first

## Acceptance Criteria

- [ ] Top navigation bar is visible in full ticket view
- [ ] Top navigation bar is visible and accessible in popup ticket view
- [ ] Search works from within ticket views
- [ ] Navigation to other views works without closing the ticket first

## Likely Affected Areas

- `portal/src/App.tsx` (routing/layout)
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/Header.tsx`

## Original Request
both popup and full ticket view should still keep the top bar navigation, to allow search to go to other ticket, and navigate to specific windows from there if wanted.

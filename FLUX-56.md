---
title: Add ticket deep links with hover preview
status: Backlog
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - ui
  - feature
priority: Low
effort: M
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T03:09:34.357Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-07T03:10:25.605Z'
    comment: Updated description.
  - type: comment
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
    comment: >-
      Groomed this into a concrete cross-ticket linking feature: detect ticket
      references in rendered markdown, show hover previews, and open the linked
      ticket directly from any ticket-description surface.
    id: c-2026-05-07t03-53-39-4816199z-flux-56
  - type: status_change
    from: Grooming
    to: Todo
    user: Agent
    date: '2026-05-07T03:53:39.4816199Z'
  - type: status_change
    from: Todo
    to: Backlog
    user: Guy
    date: '2026-05-25T13:25:32.638Z'
order: 7
---
## Summary

Support inline ticket references inside ticket text so a mention like
`[FLUX-8]` or `FLUX-8` can be previewed on hover and opened directly. The goal
is to make ticket cross-references understandable without forcing the user to
memorize ticket numbers.

## Requirements

### 1. Detect ticket references in rendered ticket text
- Recognize ticket IDs in markdown link text and plain rendered text patterns where practical
- Resolve only existing tickets in the local task dataset
- Leave unresolved references visually safe instead of pretending they link somewhere

### 2. Show a hover or focus preview
- Hovering or focusing a ticket reference should show a compact preview with title, status, and short description snippet
- The preview should work in popup, full-view, and backlog ticket-description surfaces
- Keyboard focus should trigger an equivalent preview path for accessibility

### 3. Open the linked ticket directly
- Clicking a referenced ticket should open that ticket in the configured ticket-view mode
- Users should be able to return to the current context without losing their place
- Prompt/status context should remain intact when navigating between linked tickets

### 4. Integrate with shared markdown rendering
- Implement the feature through the shared ticket markdown renderer rather than separate per-screen parsing logic
- Keep the design compatible with future file/deeplink features such as FLUX-34

## Acceptance Criteria

- [ ] Ticket references inside ticket descriptions are recognized and rendered as actionable links
- [ ] Hovering or focusing a ticket reference shows a compact preview
- [ ] Clicking a ticket reference opens the linked ticket
- [ ] Missing or invalid ticket references fail gracefully
- [ ] The behavior works in popup, full-view, and backlog ticket-description surfaces

## Likely Affected Areas

- Shared markdown description rendering introduced by FLUX-51
- `portal/src/components/TaskModal.tsx`
- `portal/src/components/BacklogScreen.tsx`
- `portal/src/AppContext.tsx` or shared ticket-open helpers

## Notes

- Related to FLUX-34, which is about editor/file deep links rather than ticket-to-ticket references

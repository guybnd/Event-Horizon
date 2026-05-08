---
id: FLUX-123
title: Read state resets when I refresh page
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - bug
  - reliability
priority: High
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-08T07:00:44.982Z'
    comment: Created ticket.
---

## Summary
The comment read state is resetting to unread whenever the user refreshes the portal page, indicating that the state is either not persisting to the backend correctly or failing to hydrate on load.

## Requirements

### 1. Fix Read State Persistence/Hydration
- Investigate the read state fetching mechanism on page load.
- Ensure that the portal accurately requests and applies the user's `read-state.json` upon initialization.
- If the read state is being correctly saved via PUT requests but lost on refresh, fix the initialization data fetch.

## Acceptance Criteria
- [ ] Marking a comment as read persists successfully.
- [ ] Refreshing the browser does not revert read comments back to unread.

## Likely Affected Areas
- `portal/src/App.tsx` or state initialization logic.
- `portal/src/api/` read state fetch endpoints.

## Notes
- This is likely a hydration timing issue or a missing fetch on the initial app load.

## Original Request
read state resets when i refresh page

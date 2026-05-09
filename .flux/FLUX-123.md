---
title: Read state resets when I refresh page
status: Released
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - bug
  - reliability
priority: High
effort: S
implementationLink: 988d7c70ecefd198d57ab82f756621b3491f71a1
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-09T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
    comment: >-
      Finished. Fix was delivered in commit 988d7c7 as part of the read-state
      feature (FLUX-93). Added `workspaceConfigured` to the read-state
      `useEffect` dependency array in `portal/src/AppContext.tsx:441` and an
      early-return guard at line 431. This ensures the fetch only fires once the
      workspace is confirmed ready, preventing the 503 silent-fail that left
      `readComments` empty on every page load.
    id: c-2026-05-09t00-00-00-000z
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-09T00:00:00.000Z'
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T14:54:22.971Z'
  - type: activity
    user: Agent
    date: '2026-05-08T14:54:22.971Z'
    comment: Updated implementation link.
  - type: comment
    user: Claude Code
    date: '2026-05-08T14:54:30.914Z'
    comment: >-
      ```text

      FLUX-123 is done. The fix was in commit `988d7c7` — added
      `workspaceConfigured` to the `useEffect` dependency array and an
      early-return guard in `portal/src/AppContext.tsx:431-441`, so the read
      state fetch now only fires once the workspace is confirmed ready instead
      of silently failing on the 503 during initial mount.

      ```
    id: c-2026-05-08t14-54-30-914z
  - type: status_change
    from: Done
    to: Released
    user: Agent
    date: '2026-05-09T08:10:27.339Z'
version: 0.2.0
releasedAt: '2026-05-09T08:10:27.339Z'
releaseDocPath: release-notes/0.2.0
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

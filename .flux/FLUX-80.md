---
title: Add lightweight update awareness via GitHub releases
status: Todo
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:55:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:55:00.000Z'
    comment: >-
      Split from FLUX-18. This is a polish feature — checking GitHub releases
      for newer versions on startup. Not a blocker for install.
    id: c-2026-05-07t06-55-00-000z-flux-80
order: 80
---
## Summary

On startup, make a single GET request to the GitHub releases API to check if a
newer version of Event Horizon is available. Show a one-line console message and
optionally surface it in the portal header. Fail silently when offline.

## Requirements

### 1. Version check on startup
- On engine startup, fetch `https://api.github.com/repos/{owner}/{repo}/releases/latest`
- Compare the remote version tag against the local `package.json` version
- Use a non-blocking async call — never delay startup for the network check

### 2. Notification
- If a newer version exists, log a one-line message to the console
- Optionally expose the update info via a new `GET /api/update-check` endpoint
  so the portal can show it in the header
- If offline or the request fails, do nothing — no errors, no warnings

### 3. Portal indicator (optional)
- If the engine reports an available update, show a subtle indicator in the
  portal header (e.g. a small badge or text)
- The indicator should link to the releases page

## Acceptance Criteria

- [ ] Engine checks GitHub releases on startup
- [ ] A newer version is reported via console log
- [ ] The check fails silently when offline
- [ ] Startup is never blocked or delayed by the check
- [ ] Optionally the portal shows an update indicator

## Likely Affected Areas

- `engine/src/index.ts` — startup update check
- `portal/src/components/Header.tsx` (optional)
- `portal/src/api.ts` (optional)

## Parent

- Subtask of FLUX-18

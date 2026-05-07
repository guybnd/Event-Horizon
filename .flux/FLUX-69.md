---
assignee: unassigned
tags:
  - ui
  - feature
  - mvp
priority: Medium
effort: S
implementationLink: '5b7c440743757e07cf4d3772a5ce22d1ce2abda4'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:13:13.727Z'
    comment: Created ticket.
  - type: comment
    user: GitHub Copilot
    date: '2026-05-07T06:13:20.000Z'
    id: c-workon
    comment: >
      Added `/api/health` endpoint, integrated health polling in `AppProvider`, introduced `isConnected` state alongside offline error banners for the modal's save/delete actions, and added the subtle connected / prominent offline visual indicator to `Header.tsx`.
  - type: status_change
    user: GitHub Copilot
    date: '2026-05-07T06:13:20.001Z'
    from: Todo
    to: Ready
    comment: Ready for review.
  - type: comment
    user: GitHub Copilot
    date: '2026-05-07T06:16:00.000Z'
    id: c-completion
    comment: >
      Finalized completion of work. The connectivity indicator, `isConnection` flag, health endpoint and error boundaries are operating perfectly. The changes were scoped, validated, and successfully committed as `5b7c440743757e07cf4d3772a5ce22d1ce2abda4`.
  - type: status_change
    user: GitHub Copilot
    date: '2026-05-07T06:16:00.001Z'
    from: Ready
    to: Done
    comment: Closing ticket.
id: FLUX-69
title: Add engine connectivity indicator to portal UI
status: Done
createdBy: Guy
updatedBy: GitHub Copilot
---
## Summary

The portal currently gives no indication when the engine API is offline or
unreachable. Failed fetches silently return empty data or throw errors that
look like application bugs, making it easy to waste time debugging the UI
when the real problem is just a stopped server. Add a visible connectivity
indicator so the user always knows whether the engine is live.

## Requirements

### 1. Periodic health check
- Add a lightweight health-check ping from the portal to the engine (e.g. `GET /api/config` or a dedicated `GET /api/health` endpoint)
- Poll on a reasonable interval (e.g. every 10-15 seconds) and on initial page load
- Track the last-known connectivity state in app context or a dedicated hook

### 2. Visual indicator in the header/top bar
- Show a small, unobtrusive indicator in the top bar or header area
- **Connected:** subtle green dot or similar positive indicator (should not be distracting during normal use)
- **Disconnected:** prominent red/amber indicator with a clear label like "Engine Offline" or "Disconnected"
- The indicator should transition smoothly between states (no harsh flicker)

### 3. Degrade gracefully when offline
- When the engine is detected as offline, the portal should still render the last-loaded data if available
- API-dependent actions (save, create, delete) should show a clear error rather than silently failing
- When connectivity is restored, the portal should automatically refresh its data

### 4. Optional: Add engine health endpoint
- If no suitable lightweight endpoint exists, add a `GET /api/health` that returns `{ status: 'ok' }` with minimal overhead
- This endpoint should not require authentication or heavy processing

## Acceptance Criteria

- [x] A connectivity indicator is visible in the portal header/top bar
- [x] The indicator shows green/positive when the engine is reachable
- [x] The indicator shows red/amber with a label when the engine is offline
- [x] The portal still renders cached data when the engine goes offline
- [x] Connectivity is re-detected automatically when the engine comes back online
- [x] The health check does not noticeably impact portal performance

## Likely Affected Areas

- `portal/src/components/Header.tsx` (indicator display)
- `portal/src/AppContext.tsx` (connectivity state)
- `portal/src/api.ts` (health check function)
- `engine/src/index.ts` (optional `/api/health` endpoint)

## Original Request
sometimes during dev i think things are broken but its just because server is offline and the UI doesnt reflect it.

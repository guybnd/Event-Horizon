---
title: Serve portal static assets from engine and use relative API URLs
status: Done
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
  - mvp
  - navigation
priority: High
effort: M
implementationLink: '63a33eb'
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
      Split from FLUX-18. Combines requirement 2 (static serving) and the
      portal-side API URL fix. Together these eliminate the two-process
      requirement and the hardcoded localhost:3001.
    id: c-2026-05-07t06-55-00-000z-flux-77
  - type: activity
    user: Guy
    date: '2026-05-07T07:38:43.897Z'
    comment: 'Updated tags to feature, mvp, navigation.'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T01:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T01:00:00.000Z'
    comment: >-
      Implemented. Engine now auto-detects portal/dist via resolvePortalDist()
      (--portal-dist flag or __dirname/../../../portal/dist default). Static
      middleware + SPA catch-all registered after all API routes. portal/src/api.ts
      API_URL changed from hardcoded 'http://localhost:3001/api' to relative '/api'.
      Vite dev proxy added in vite.config.ts proxying /api to localhost:3001 so
      two-process dev workflow still works. Validated: board loads with Engine
      Connected on http://localhost:5173 via proxy and engine prints Workspace
      and Portal URLs on startup.
    id: c-flux77-ready
  - type: comment
    user: Agent
    date: '2026-05-08T17:30:00.000Z'
    comment: >-
      Completed. Engine serves portal/dist/ at :3001. Portal uses relative /api
      URLs in production. Dev proxy in vite.config.ts for two-process dev.
      User confirmed.
    id: c-flux77-done
order: 77
---
## Summary

Add static file serving to the engine so it can serve the pre-built portal SPA
from a single process on a single port. Simultaneously switch the portal's API
client from hardcoded `http://localhost:3001/api` to relative `/api` paths so
both work from the same origin.

## Current Behavior

- Engine runs on port 3001 with only API routes
- Portal runs on port 5173 via Vite dev server
- Portal hardcodes `export const API_URL = 'http://localhost:3001/api'`

## Requirements

### 1. Static file serving in the engine
- Add `express.static()` middleware to serve `portal/dist/` (or a configurable path)
- Serve `index.html` as the SPA catch-all for client-side routing
- Static serving should be opt-in via a flag or auto-detected (if `portal/dist/` exists, serve it)
- API routes must take priority over static file serving

### 2. Relative API URLs in the portal
- Change `API_URL` from `'http://localhost:3001/api'` to `'/api'`
- Add a build-time or runtime mechanism to switch between relative URLs (production/packaged) and absolute URLs (dev mode with separate Vite server)
- Recommended: Use `import.meta.env.VITE_API_URL || '/api'` so dev mode can set `VITE_API_URL=http://localhost:3001/api` in a `.env.development` file

### 3. Dev mode compatibility
- The two-process dev workflow must continue to work for contributors
- Vite dev server proxy or env variable should handle the cross-origin API calls in dev

## Acceptance Criteria

- [ ] Engine serves `portal/dist/` static files when the directory exists
- [ ] SPA catch-all returns `index.html` for non-API routes
- [ ] Portal uses relative `/api` paths in production builds
- [ ] Dev mode still works with separate Vite dev server on port 5173
- [ ] Both portal and API are accessible from a single `http://localhost:3001` in production mode

## Likely Affected Areas

- `engine/src/index.ts` — static middleware, SPA catch-all
- `portal/src/api.ts` — `API_URL` constant
- `portal/vite.config.ts` — dev proxy or env config
- `portal/.env.development` (new) — dev-mode API URL

## Parent

- Subtask of FLUX-18

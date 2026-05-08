---
title: Make default project key configurable instead of hardcoded FLUX
status: Done
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - bug
  - mvp
priority: High
effort: S
implementationLink: '1a156b4'
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:50:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:50:00.000Z'
    comment: >-
      Created during install-readiness audit. The portal hardcodes `FLUX` as the
      default project key in AppContext.tsx. When Event Horizon is installed in
      another project, the default should come from config.json instead.
    id: c-2026-05-07t06-50-00-000z-flux-74
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T12:20:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:20:00.000Z'
    comment: >-
      Plan: (1) AppContext.tsx — initialise `currentProject` to `''` and set it
      to `config.projects[0]` (fallback `'PROJECT'`) in the `loadConfig` effect
      after `setConfig`. (2) engine/src/index.ts line 977 — change fallback from
      `'FLUX'` to `'PROJECT'`.
    id: c-flux74-plan
  - type: comment
    user: Agent
    date: '2026-05-08T12:21:00.000Z'
    comment: >-
      Implemented. AppContext initialises `currentProject` to `''` and sets it
      to `config.projects[0] || 'PROJECT'` after config loads (only if not
      already set, preserving any user-selected project across re-fetches).
      Engine fallback changed from `'FLUX'` to `'PROJECT'`. Existing repo
      unaffected — config already has `'FLUX'` as first project.
    id: c-flux74-done
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T12:21:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:22:00.000Z'
    comment: Committed as 1a156b4. Ticket closed.
    id: c-flux74-close
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T12:22:00.000Z'
order: 74
---
## Summary

The portal currently hardcodes `FLUX` as the default project key in
`AppContext.tsx`. When installed in another project, the first entry in
`config.json`'s `projects` array should be used as the default instead. This is
a small but critical change for portability.

## Current Behavior

```typescript
// portal/src/AppContext.tsx:139
const [currentProject, setCurrentProject] = useState('FLUX');
```

The config does have a `projects` array (`["FLUX"]`), but the portal ignores it
for the initial default.

## Requirements

### 1. Read default project from config
- On initial load, set `currentProject` to the first entry in `config.projects`
- Fall back to `'PROJECT'` if `config.projects` is empty or missing
- Remove the hardcoded `'FLUX'` default

### 2. Update task creation to use the config-driven project key
- The `createTask` API call passes `projectKey` — ensure this uses the
  current project from context, not a hardcoded value
- Verify the engine's `POST /api/tasks` handler respects the `projectKey`
  parameter (it already does via `req.body.projectKey || 'FLUX'`)

### 3. Engine fallback
- Update the engine's fallback project key from `'FLUX'` to `'PROJECT'` so
  both sides use the same neutral default when no config exists

## Acceptance Criteria

- [ ] Portal reads default project from `config.projects[0]` instead of hardcoded `FLUX`
- [ ] Creating a task uses the config-driven project key for the ID prefix
- [ ] Engine fallback matches portal fallback when no config exists
- [ ] Existing Event Horizon repo continues to work unchanged (config already has `FLUX`)

## Likely Affected Areas

- `portal/src/AppContext.tsx` — default project state
- `engine/src/index.ts` — fallback project key in task creation

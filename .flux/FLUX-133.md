---
id: FLUX-133
title: Stabilize portal dev startup on Node 22 and lock react-draggable
status: Done
createdBy: Agent
updatedBy: Agent
assignee: unassigned
tags:
  - bug
  - devx
priority: High
effort: XS
implementationLink: '1546a87'
subtasks: []
history:
  - type: activity
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
    comment: >-
      Plan: keep this fix minimal and cross-platform by removing a macOS-only
      rolldown binding dependency from manifests, pinning react-draggable to
      4.4.6 for portal compatibility, regenerating lockfile, and validating
      portal startup on Node 22.
    id: c-flux133-plan
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-08T00:00:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:09:55Z'
    comment: >-
      Implemented the minimal Node 22 startup stabilization: added a workspace
      override for react-draggable 4.4.6 in root package.json, pinned
      react-draggable 4.4.6 in portal/package.json, and regenerated lockfile.
      Validation: npm run dev -w portal starts successfully on Node 22 (Vite
      ready, local URL reported). Note: package-lock.json still includes
      rolldown platform bindings only as optional transitive entries under
      rolldown, not as direct hard dependencies in project manifests.
    id: c-flux133-ready-summary
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-08T12:09:55Z'
  - type: comment
    user: Agent
    date: '2026-05-08T12:12:04Z'
    comment: >-
      Completed ticket. Stabilized portal startup on Node 22 by pinning
      react-draggable to 4.4.6 via workspace override plus explicit portal
      dependency, and refreshed lockfile. Validation: npm run dev -w portal
      reached Vite ready state. Commit: 1546a87.
    id: c-flux133-done
  - type: status_change
    from: Ready
    to: Done
    user: Agent
    date: '2026-05-08T12:12:04Z'
---

## Problem / Motivation

Portal dev startup failed in this environment after Node 22 upgrade because `react-draggable@4.5.0` resolved without expected CJS utility files, causing unresolved imports through `react-rnd`. A temporary local workaround also introduced a platform-specific rolldown binding dependency that should not be committed as a hard dependency.

## Implementation

1. Pin `react-draggable` to `4.4.6` via workspace override and explicit portal dependency.
2. Remove platform-specific `@rolldown/binding-darwin-arm64` from committed manifests.
3. Regenerate `package-lock.json`.
4. Validate `npm run dev -w portal` startup on Node 22.

## Acceptance Criteria

- [x] `npm run dev -w portal` starts successfully on Node 22.
- [x] No platform-specific runtime binding is committed as a hard dependency.
- [x] Lockfile matches the final manifest state.

## Likely Affected Areas

- `package.json`
- `portal/package.json`
- `package-lock.json`

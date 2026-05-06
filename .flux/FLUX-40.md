---
id: FLUX-40
title: add execution mode controls and status UX to the portal
status: Todo
priority: Medium
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - ux
  - portal
  - agent
history:
  - type: comment
    user: Agent
    date: '2026-05-06T12:43:00.000Z'
    comment: >-
      Captured from the execution toggle vision. This ticket covers the user
      controls for choosing external versus internal execution and surfacing the
      right card status, run actions, and waiting states.
    id: c-2026-05-06t12-43-00-000z
effort: Medium
implementationLink: ''
---
## Summary

Add the portal controls that let a user choose which execution brain should run
the ticket. The UI should make it obvious whether Flux is waiting for an
external agent or is ready to run its own internal AI path.

## Requirements

### 1. Global execution mode setting
- Add a settings control for `Manual/External Agent` versus `Flux Internal AI`
- Support a global default with room for per-ticket override if needed
- If internal mode is selected, provide an API key input field or provider configuration entry point

### 2. Per-card execution controls
- If internal mode is active, show a `Run` action on ticket cards or ticket detail views
- If external mode is active, show a `Waiting for Agent...` state and a `Copy MCP Link` or equivalent handoff action
- Keep the controls aligned with the actual executor state so the UI does not imply execution has started when preflight failed

### 3. Surface execution and safety status
- Show whether the ticket is running in passive mode, active mode, blocked on follow-up, or waiting on sentry review
- Surface clean-working-tree preflight failures in a user-readable way before execution begins
- Make branch attachment versus dedicated-branch execution visible when that affects confidence in diff and review output

## Acceptance Criteria

- [ ] Settings expose a global execution mode choice
- [ ] Internal mode surfaces API configuration and a run action in the portal
- [ ] External mode surfaces waiting-state UI and handoff affordances for MCP-based work
- [ ] Execution status shown in the UI matches the underlying executor state
- [ ] Preflight failures such as dirty working trees are visible before execution begins

## Likely Affected Areas

- `portal/src/components/Settings.tsx`
- `portal/src/components/Board.tsx`
- `portal/src/components/TaskCard.tsx`
- `portal/src/components/TaskModal.tsx`
- `portal/src/AppContext.tsx`
- `portal/src/types.ts`
- `.flux/config.json`

## Dependencies

- Parent: FLUX-37
- Related to: FLUX-38
- Related to: FLUX-39

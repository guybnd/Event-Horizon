---
title: define dual-mode execution bridge and executor lifecycle
status: Require Input
priority: High
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - architecture
  - backend
  - agent
history:
  - type: comment
    user: Agent
    date: '2026-05-06T12:41:00.000Z'
    comment: >-
      Captured from the dual-mode Flux execution vision. This ticket defines the
      shared execution abstraction that allows Flux to either wait for an
      external agent or run an internal LLM orchestration path.
    id: c-2026-05-06t12-41-00-000z
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-06T13:18:50.889Z'
  - type: comment
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
    comment: >-
      The remaining implementation-critical choice is how execution ownership
      should be represented. Should the first version model `waiting for
      external work` and `internal execution` through dedicated statuses,
      through ticket metadata, or through both together?
    id: c-2026-05-07t13-01-33-5429940-10-00-flux-38
  - type: status_change
    from: Grooming
    to: Require Input
    user: Agent
    date: '2026-05-07T13:01:33.5429940+10:00'
effort: Large
implementationLink: ''
order: 2
---
## Summary

Create the backend execution abstraction that sits between the board workflow
and the concrete execution mode. Flux needs one orchestration layer that can
either delegate to an external agent and watch for changes or call an internal
LLM and apply validated edits itself.

## Requirements

### 1. Define the executor contract
- Introduce a backend interface such as `TaskExecutor` or `ExecutionProvider`
- Minimum lifecycle methods should cover `execute(ticket)`, `interrupt()`, and `status()`
- The current codebase is TypeScript, so the first implementation should be in the engine's native language while preserving parity with a future Go binary design

### 2. Model execution ownership explicitly
- Ticket state must make it clear who currently holds the pen: user, external agent, or Flux internal AI
- Define the metadata or statuses needed for `pending external execution` and `executing internal`
- Keep this compatible with configurable board statuses rather than hard-coding fragile assumptions into the portal

### 3. Share execution preflight checks
- Before any execution starts, verify the current git context and that the working tree is clean
- If the repo is dirty, block execution start or surface a user-confirmed override path with a clear warning
- Use one shared preflight path for passive and active execution so safety behavior stays consistent

### 4. Provide concrete executor implementations
- `PassiveExecutor` should put the ticket into an external-waiting state and hand off to watcher-driven progress
- `ApiExecutor` should hand off to the direct internal orchestration service without changing the surrounding workflow contract
- Both executors should write progress back to the same ticket model and history format

## Acceptance Criteria

- [ ] A backend executor interface exists with a stable lifecycle contract
- [ ] Passive and active executors can be swapped without changing the board workflow surface
- [ ] Ticket metadata or statuses show who owns execution at any given time
- [ ] Shared git and working-tree preflight checks gate execution starts
- [ ] The design is portable to a future single-binary implementation without rewriting the workflow model

## Likely Affected Areas

- `engine/src/index.ts`
- `engine/src/types.ts` or equivalent new shared type module
- `engine/src/execution/` new executor modules
- `portal/src/types.ts`
- `.flux/config.json`

## Dependencies

- Parent: FLUX-37
- Related to: FLUX-6

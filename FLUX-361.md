---
priority: High
effort: M
tags:
  - portal
  - refactor
  - agent
title: Unify agent-launch entry points across card and modal
status: In Progress
createdBy: Agent
updatedBy: Agent
assignee: unassigned
history:
  - type: activity
    user: Agent
    date: '2026-06-03T04:38:33.772Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T04:38:45.498Z'
  - type: comment
    comment: >-
      Starting. Order: 1) create portal/src/agentActions.ts with single
      registries (EFFORT_LEVELS, AGENT_COMMANDS, REVIEW_PERSONAS) and a pure
      runAgentAction(api) helper. 2) Expose runAgentAction from AppContext so
      all sites get one error/refresh path. 3) Rewire ContextMenu, TaskModal
      handlers, useCliSession.launchSession. 4) Add persona picker to
      ContextMenu Review. 5) Verify only call site of startTaskCliSession is
      inside agentActions.
    user: Agent
    date: '2026-06-03T04:38:45.498Z'
    id: c-2026-06-03t04-38-45-498z
author: Agent
---
Audit of every launch-agent entry point found seven discrepancies caused by each call site composing `startTaskCliSession` itself instead of going through a shared helper. Same shape of problem as the original review-button gap.

## Entry points today

| Location | Component | Call |
|---|---|---|
| Card → "Launch Agent" | `ContextMenu.handleLaunchAgent` | `startTaskCliSession(id, agent, undefined, true, effort)` |
| Card → "Send for Grooming" | `ContextMenu.handleSendForGrooming` | `updateTask(status:Grooming)` → `startTaskCliSession(id, agent, 'groom <id>', true)` |
| Card → "Run agent command" (Implement/Groom/Finish/Review) | `ContextMenu.handleAgentCommand` | `startTaskCliSession(id, agent, '<cmd> <id>', true)` |
| Modal CLI panel — split button | `useCliSession.launchSession` | `startTaskCliSession(id, framework, undefined, skipPermissions, effort)` |
| Modal — Grooming button | `TaskModal.handleGrooming` | `startTaskCliSession(id, framework, 'groom <id>', skipPermissions)` |
| Modal — Finish button | `TaskModal.sendFinishCommand` | branches: active session → `sendTaskCliInput` else `startTaskCliSession(id, framework, 'finish <id>')` |
| Modal — Code Review (ReadyForMergePrompt) | `TaskModal.handleSendForCodeReview` | `updateTask(status:'In Progress')` → `startTaskCliSession(id, framework, persona.prompt, skipPermissions)` |
| Modal — Save implementationLink + launch | `TaskModal` save flow | `launchSession()` |

## Discrepancies

1. **Card "Review" ≠ Modal "Code Review"** — same word, different behavior. Card sends bare `review <id>`; modal sends a persona prompt and moves ticket to `In Progress`. `CodeReviewButton` + `REVIEW_PERSONAS` only exist in the modal; the context menu can't reach them.
2. **`sendFinishCommand` drops `skipPermissions`** — every other modal call passes the toggled value; this one always uses the API default.
3. **Grooming differs**: card moves to `Grooming` first, modal does not touch status.
4. **Card command-runner ignores effort override**. Effort picker only wired to `handleLaunchAgent`, not `handleAgentCommand` or `handleSendForGrooming`.
5. **Framework selection diverges**. Card always uses `resolveEffectiveAgent(config.defaultAgent)`; modal uses session-mutable `selectedCliFramework`. No per-ticket override consulted from the card.
6. **Hardcoded `AGENT_COMMANDS` taxonomy in `ContextMenu`** is a parallel registry — adding a new verb means editing a constant nothing else knows about.
7. **No shared helper.** `useCliSession.launchSession` only covers the bare-launch case; anything needing `appendPrompt`, a pre-status, or a persona bypasses it and calls `startTaskCliSession` directly.

Plus minor: `EFFORT_LEVELS` duplicated in `ContextMenu.tsx` and `LaunchAgentSplitButton.tsx`; `ContextMenu` always passes `skipPermissions: true` ignoring user preference.

## Implementation plan

1. **Single registry** in a new `portal/src/agentActions.ts`:
   - `AGENT_COMMANDS` (label + verb + optional preStatus).
   - `REVIEW_PERSONAS` moved here from `CodeReviewButton.tsx` (component re-exports for back-compat).
   - `EFFORT_LEVELS` (single source).
2. **One entry function** `runAgentAction({ taskId, action, framework?, effortOverride?, skipPermissions?, preStatus? })` exposed from `AppContext` so every site shares one error + refresh path. `action` is either `{ kind: 'launch' }`, `{ kind: 'command', verb }`, or `{ kind: 'prompt', appendPrompt }`.
   - Handles optional `updateTask({ status: preStatus })` first, atomically followed by `startTaskCliSession`.
   - Resolves framework via `useCliSession.selectedCliFramework` when called from modal context; falls back to `resolveEffectiveAgent(task.assignee, config.defaultAgent)` so per-ticket overrides are honored from the card.
3. **Rewire callers** to use `runAgentAction`:
   - `ContextMenu` — all three handlers + add persona submenu for "Review".
   - `TaskModal` — `handleGrooming`, `handleSendForCodeReview`, `sendFinishCommand`, save+launch path.
   - `useCliSession.launchSession` becomes a thin alias for `runAgentAction({ kind: 'launch' })`.
4. **Pass `skipPermissions`** from a single store (probably keep on `useCliSession` + a sensible default for card-initiated runs).
5. **Fix #2** (Finish dropping `skipPermissions`) and #3 (align grooming behavior — pick whichever side is correct; preference: agent moves the status itself, so neither side should pre-move for grooming).

## Validation

- From the card, all four agent commands work and respect effort + framework.
- From the card, "Review" opens persona picker matching the modal's options.
- From the modal, every existing button still behaves the same.
- Grep `startTaskCliSession` — only call site is inside `runAgentAction`.

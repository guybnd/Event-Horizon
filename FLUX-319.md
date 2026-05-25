---
id: FLUX-319
title: Fix TypeScript strict-mode errors in claude-code.ts
status: In Progress
priority: Low
effort: XS
assignee: unassigned
tags:
  - bug
  - engine
createdBy: Guy
updatedBy: Agent
history:
  - type: activity
    user: Guy
    date: '2026-05-25T15:43:25.701Z'
    comment: Created ticket.
  - type: agent_session
    sessionId: 913867f9-cb81-4715-9fdc-95b307d35590
    startedAt: '2026-05-25T16:01:01.603Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-05-25T16:01:01.603Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-25T16:01:10.023Z'
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-05-25T16:01:40.913Z'
---
## Problem / Motivation

`npx tsc --noEmit` reports 6 errors in `engine/src/agents/claude-code.ts`. These don't cause runtime issues but block a clean type-check pass.

## Errors

1. **`exactOptionalPropertyTypes`** (lines 116, 125, 214, 268) — assigning `undefined` to fields typed as `T` instead of `T | undefined`. Fix: add `| undefined` to the type declarations for `flushTimer`, `lastProgressLog`, and `currentActivity`.

2. **Null safety** (line 192) — `proc.stdout` could be null. Fix: add a null guard before attaching the `'data'` listener.

3. **Index signature** (line 336) — `PROVIDER_CAPABILITIES` only declares `claude` and `copilot` keys but `framework` can be `'gemini'`. Fix: add a `gemini` entry to the capabilities object (or widen the index type).

## Implementation Plan

1. Update the session type to mark `flushTimer`, `lastProgressLog`, `currentActivity` as `T | undefined`.
2. Add `if (!proc.stdout) return;` or similar guard before line 192.
3. Add `gemini` key to `PROVIDER_CAPABILITIES`.

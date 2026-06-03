---
priority: Low
effort: M
tags:
  - refactor
  - agents
  - engine
assignee: unassigned
id: FLUX-348
title: 'Engine: extract BaseAdapter for agent integrations'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:31.398Z'
    comment: Created ticket.
---
## Problem

`agents/gemini.ts` (889), `copilot.ts` (728), and `claude-code.ts` (647) total 2,264 lines for three adapters. Most of the volume is shared scaffolding: child-process lifecycle, stream-json parsing skeleton, token/cost accounting, SSE bridging. The `AgentAdapter` interface in `types.ts` is too thin to host the shared concerns.

## Plan

- Introduce `agents/base-adapter.ts` covering:
  - Spawn + lifecycle (start, stop, cleanup).
  - Stream-json line buffering + dispatch to subclass-defined event handlers.
  - Token/cost ledger and `cliSession` field updates.
  - SSE `broadcastEvent` wiring.
- Each adapter overrides only framework-specific parsing and capability flags.
- Acceptance: each adapter file < 400 lines; no duplicated lifecycle code.

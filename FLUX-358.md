---
priority: Low
effort: XS
tags:
  - docs
  - documentation
  - agents
assignee: unassigned
id: FLUX-358
title: 'Docs: reference/agent-adapter-contract.md (Phase B)'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:39.078Z'
    comment: Created ticket.
---
## Problem

The `AgentAdapter` interface in `engine/src/agents/types.ts` defines the framework adapter contract, but no doc explains what an integrator implementing a new framework must provide, where stream-json parsing happens, or how token accounting flows.

## Plan

- Create `.docs/event-horizon/reference/agent-adapter-contract.md`.
- Cover: interface methods, lifecycle expectations, stream-json contract, token/cost reporting, SSE event surface.
- Link from `agent-integrations.md` and INDEX.md.
- Acceptance: a contributor could add a new framework using only this page plus an existing adapter as a sample.

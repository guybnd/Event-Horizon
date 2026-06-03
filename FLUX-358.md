---
priority: Low
effort: XS
tags:
  - docs
  - documentation
  - agents
assignee: unassigned
title: 'Docs: reference/agent-adapter-contract.md (Phase B)'
status: In Progress
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:39.078Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-06-03T03:59:29.013Z'
  - type: comment
    comment: >-
      Plan: derive reference/agent-adapter-contract.md from agents/types.ts
      (AgentAdapter interface, CliCapabilities) and the three existing adapters
      (claude-code.ts, copilot.ts, gemini.ts). Cover: interface methods,
      lifecycle, stream-json parsing expectations, token/cost reporting, SSE
      events emitted, registration path, how to add a new framework.
    user: Agent
    date: '2026-06-03T03:59:29.013Z'
    id: c-2026-06-03t03-59-29-013z
author: Agent
---
## Problem

The `AgentAdapter` interface in `engine/src/agents/types.ts` defines the framework adapter contract, but no doc explains what an integrator implementing a new framework must provide, where stream-json parsing happens, or how token accounting flows.

## Plan

- Create `.docs/event-horizon/reference/agent-adapter-contract.md`.
- Cover: interface methods, lifecycle expectations, stream-json contract, token/cost reporting, SSE event surface.
- Link from `agent-integrations.md` and INDEX.md.
- Acceptance: a contributor could add a new framework using only this page plus an existing adapter as a sample.

---
priority: Low
effort: XS
tags:
  - docs
  - documentation
  - agents
assignee: unassigned
title: 'Docs: reference/agent-adapter-contract.md (Phase B)'
status: Done
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
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-06-03T04:00:51.694Z'
  - type: activity
    user: Agent
    date: '2026-06-03T04:00:51.694Z'
    comment: Updated implementation link.
  - type: comment
    comment: >-
      Done. Wrote reference/agent-adapter-contract.md: AgentAdapter interface,
      ProviderManifest, CLI_CAPABILITIES matrix, full lifecycle (spawn →
      stream-json parsing → SSE events → exit cleanup), session-record fields
      adapters mutate, history helpers, and a step-by-step recipe for adding a
      new framework. Updated INDEX.md. Commit e40b50a.
    user: Agent
    date: '2026-06-03T04:00:51.694Z'
    id: c-2026-06-03t04-00-51-694z
author: Agent
implementationLink: e40b50a
---
## Problem

The `AgentAdapter` interface in `engine/src/agents/types.ts` defines the framework adapter contract, but no doc explains what an integrator implementing a new framework must provide, where stream-json parsing happens, or how token accounting flows.

## Plan

- Create `.docs/event-horizon/reference/agent-adapter-contract.md`.
- Cover: interface methods, lifecycle expectations, stream-json contract, token/cost reporting, SSE event surface.
- Link from `agent-integrations.md` and INDEX.md.
- Acceptance: a contributor could add a new framework using only this page plus an existing adapter as a sample.

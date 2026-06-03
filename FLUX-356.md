---
priority: Medium
effort: S
tags:
  - docs
  - documentation
  - mcp
assignee: unassigned
title: 'Docs: reference/rest-api.md and reference/mcp-tools.md (Phase B)'
status: In Progress
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:37.469Z'
    comment: Created ticket.
  - type: status_change
    from: Grooming
    to: In Progress
    user: Agent
    date: '2026-06-03T03:54:58.483Z'
  - type: comment
    comment: >-
      Plan: enumerate routes from engine/src/routes/*.ts and tools from
      mcp-server.ts. Write reference/rest-api.md (route, method, payload,
      response, middleware) and reference/mcp-tools.md (zod input, output, side
      effects, enforcement, example). Cross-link from INDEX.md and
      mcp-server.md.
    user: Agent
    date: '2026-06-03T03:54:58.483Z'
    id: c-2026-06-03t03-54-58-483z
author: Agent
---
## Problem

17 route modules in `engine/src/routes/` and 10 MCP tools in `mcp-server.ts` have no enumerated reference. Agents reverse-engineer endpoints from `portal/src/api.ts` and tools from skill prose. Drift risk is high.

## Plan

- Create `.docs/event-horizon/reference/rest-api.md`: every route, method, path, payload, response shape, middleware applied, error shape.
- Create `.docs/event-horizon/reference/mcp-tools.md`: every tool, zod input schema, output shape, side effects, enforcement rules, one realistic example call.
- Cross-link from INDEX.md and from `mcp-server.md`.
- Acceptance: pages cover all current endpoints and tools; samples copy-paste cleanly.

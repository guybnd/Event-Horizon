---
priority: Medium
effort: S
tags:
  - docs
  - documentation
  - mcp
assignee: unassigned
title: 'Docs: reference/rest-api.md and reference/mcp-tools.md (Phase B)'
status: Done
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
  - type: status_change
    from: In Progress
    to: Done
    user: Agent
    date: '2026-06-03T03:57:20.829Z'
  - type: activity
    user: Agent
    date: '2026-06-03T03:57:20.829Z'
    comment: Updated implementation link.
  - type: comment
    comment: >-
      Committed as `bd5d5e1`.


      - `.docs/event-horizon/reference/mcp-tools.md` (13 tools, with enforcement
      and example).

      - `.docs/event-horizon/reference/rest-api.md` (every /api/* route across
      17 modules).

      - INDEX.md REST/MCP rows now link to the references instead of
      placeholders.

      - mcp-server.md cross-links to the tool reference.
    user: Agent
    date: '2026-06-03T03:57:20.829Z'
    id: c-2026-06-03t03-57-20-829z
author: Agent
implementationLink: bd5d5e1
---
## Problem

17 route modules in `engine/src/routes/` and 10 MCP tools in `mcp-server.ts` have no enumerated reference. Agents reverse-engineer endpoints from `portal/src/api.ts` and tools from skill prose. Drift risk is high.

## Plan

- Create `.docs/event-horizon/reference/rest-api.md`: every route, method, path, payload, response shape, middleware applied, error shape.
- Create `.docs/event-horizon/reference/mcp-tools.md`: every tool, zod input schema, output shape, side effects, enforcement rules, one realistic example call.
- Cross-link from INDEX.md and from `mcp-server.md`.
- Acceptance: pages cover all current endpoints and tools; samples copy-paste cleanly.

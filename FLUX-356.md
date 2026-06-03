---
priority: Medium
effort: S
tags:
  - docs
  - documentation
  - mcp
assignee: unassigned
id: FLUX-356
title: 'Docs: reference/rest-api.md and reference/mcp-tools.md (Phase B)'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:37.469Z'
    comment: Created ticket.
---
## Problem

17 route modules in `engine/src/routes/` and 10 MCP tools in `mcp-server.ts` have no enumerated reference. Agents reverse-engineer endpoints from `portal/src/api.ts` and tools from skill prose. Drift risk is high.

## Plan

- Create `.docs/event-horizon/reference/rest-api.md`: every route, method, path, payload, response shape, middleware applied, error shape.
- Create `.docs/event-horizon/reference/mcp-tools.md`: every tool, zod input schema, output shape, side effects, enforcement rules, one realistic example call.
- Cross-link from INDEX.md and from `mcp-server.md`.
- Acceptance: pages cover all current endpoints and tools; samples copy-paste cleanly.

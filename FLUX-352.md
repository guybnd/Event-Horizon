---
priority: Medium
effort: M
tags:
  - research
  - architecture
  - mcp
assignee: unassigned
id: FLUX-352
title: 'Strategy: lean MCP-first, shrink REST surface to portal-only'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:34.307Z'
    comment: Created ticket.
---
## Problem

The project's defensibility is MCP — agents talk to a real protocol, not a scraped API. Today the REST surface duplicates most MCP functionality because the portal uses it. As MCP tools grow, the REST surface becomes a second source of truth to keep in sync.

## Plan

- Inventory every REST endpoint and tag each as (a) portal-only (SSE, asset upload, bulk-rename), (b) duplicates MCP (CRUD), (c) admin (workspace, settings).
- For (b), decide: keep both, or have the portal call MCP-over-HTTP shim. Recommend a path.
- Output: ADR in `.docs/event-horizon/decisions/` documenting which endpoints stay and the rationale.
- No code changes in this ticket — design only.

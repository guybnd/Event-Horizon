---
priority: Low
effort: S
tags:
  - refactor
  - engine
  - mcp
assignee: unassigned
id: FLUX-351
title: 'Engine: structured logger to make MCP mode safe by construction'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:33.591Z'
    comment: Created ticket.
---
## Problem

MCP mode redirects `console.log` to stderr in `index.ts` and `mcp-server.ts` to protect JSON-RPC framing on stdout. The rest of the engine still calls `console.log` directly, so any new code path could leak to stdout and corrupt MCP responses.

## Plan

- Add a tiny `log.ts` wrapper with `log.info`, `log.warn`, `log.error` that always writes to stderr.
- Replace `console.log` call sites across `engine/src/**` (excluding the deliberate stdout writes in MCP transport).
- Add an ESLint rule banning `console.log` in `engine/src/`.
- Acceptance: grep for `console.log` in engine source returns only the lint-suppressed exceptions.

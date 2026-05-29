---
id: FLUX-338
title: MCP tools for branch management
status: Todo
priority: Medium
effort: S
assignee: unassigned
tags:
  - feature
  - engine
  - mcp
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.898Z'
    comment: Created as subtask of FLUX-292.
---
## Problem / Motivation

Agents interact with Event Horizon through MCP tools. Branch operations need MCP tool equivalents so agents can manage branches natively.

## Implementation Plan

1. Add tools to `engine/src/mcp-server.ts` using the existing `server.tool()` pattern:
   - `create_branch` — params: `ticketId` (required), `baseBranch` (optional). Calls `createTicketBranch()`.
   - `switch_branch` — params: `ticketId`. Calls `switchToTicketBranch()`.
   - `get_branch` — params: `ticketId`. Returns `{ name, exists, ahead, behind }`.
   - `delete_branch` — params: `ticketId`, `force` (optional boolean). Calls `deleteTicketBranch()`.

2. Return `jsonResult()` for success, `errorResult()` for failures (branch not found, git errors).

3. Depends on Part 2 (branch-manager module) being complete.

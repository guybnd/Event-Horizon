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
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.449Z'
    comment: Updated description.
---
## Problem / Motivation

Agents interact with Event Horizon through MCP tools. Branch operations need MCP tool equivalents so agents can manage branches natively without shelling out to git directly.

## Implementation Plan

Add tools to `engine/src/mcp-server.ts` using the existing `server.tool()` pattern:

- `create_branch` — params: `ticketId` (required), `baseBranch` (optional, defaults to `master`). Calls `createTicketBranch()`. Returns `{ branch }` on success.
- `get_branch` — params: `ticketId`. Returns `{ name, exists, aheadCount, behindCount }`.
- `delete_branch` — params: `ticketId`, `force` (optional boolean). Calls `deleteTicketBranch()`. Refuses unmerged branches unless `force: true`.

**No `switch_branch` tool.** Agents must stay on their ticket branch for the full session. If a switch is ever required, the agent must confirm with the user in chat — not automate it via MCP. This prevents one agent session from pulling the rug out from under another in multi-agent scenarios.

Return `jsonResult()` for success, `errorResult()` for failures (branch not found, dirty working tree, git errors, `gh` not authenticated).

Depends on FLUX-337 (branch-manager module) being complete.

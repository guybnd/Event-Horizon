---
id: FLUX-6
title: implement MCP context and command server for passive execution mode
status: Todo
priority: High
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - integration
  - agent
history:
  - type: comment
    user: Guy
    date: '2026-05-06T06:56:11.085Z'
    comment: commente
    id: c-2026-05-06t06-56-11-085z
  - type: comment
    user: Agent
    date: '2026-05-06T07:29:00.000Z'
    comment: >-
      Fleshed this out with MCP tool definitions. Need your input on which tools
      you want and the transport mechanism — see Open Questions.
    id: c-2026-05-06t07-29-00-000z
  - type: comment
    user: Guy
    date: '2026-05-06T07:34:26.739Z'
    comment: >-
      1. im not sure what this means, maybe t should be ran from the executable
      of the service

      2. minimal is fine we can flesh it out later

      3. agnet pass distinct identity, think multi agent workflow

      4. they should be intertwined as makes sense
    id: c-2026-05-06t07-34-26-739z
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:34:30.913Z'
  - type: comment
    user: Agent
    date: '2026-05-06T12:40:00.000Z'
    comment: >-
      Refined this ticket around passive execution mode in the new dual-mode
      Flux architecture. Narrowed the first MCP surface to active-ticket context
      retrieval, ticket-status updates, and real-time board sync for external
      agents.
    id: c-2026-05-06t12-40-00-000z
order: 2
---
## Summary

Implement the MCP server that powers Flux passive execution mode. In this mode,
Flux opens the ticket to an external agent, exposes the current task context
through MCP, and reacts to the agent's updates instead of directly editing code
itself.

## Requirements

### 1. Run the MCP server inside the Flux service
- MCP server should run from the same executable or service entry point as the engine
- The first transport can be whichever best matches the current local runtime, but it should not require a separate standalone service for normal use
- Agent identity must be passed through by the caller so multi-agent workflows remain distinguishable

### 2. Expose the minimum passive-mode tool set

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `get_active_ticket` | Return the currently active ticket markdown plus linked file paths and execution metadata | `ticketId?` |
| `update_ticket_status` | Move the ticket through Flux board states from the external agent side | `id`, `status`, `user`, `comment?` |
| `add_comment` | Post blocker questions, plans, or progress notes to the ticket | `id`, `comment`, `user` |
| `get_config` | Read board config and execution-related settings | — |

The first version can keep broader ticket CRUD out of scope if that helps land the passive path faster.

### 3. Support the passive execution flow
1. Flux marks the ticket as waiting for external execution.
2. External agent reads the ticket and linked file context via `get_active_ticket`.
3. External agent works in its own environment or IDE.
4. External agent updates status or comments through MCP.
5. Flux watches file and git changes and updates the board in real time.

### 4. Broadcast live updates to the portal
- File-system changes triggered by the external agent must propagate to the web UI in near real time
- Board state should move as the ticket file changes, not only after a manual refresh
- The engine should use the same event path for passive-mode updates and local watcher updates where practical

### 5. Respect execution safety rules
- This ticket should integrate with shared execution preflight checks rather than inventing a separate safety model
- Starting passive execution should verify the working directory is clean or surface a clear override warning defined by the execution bridge

## Acceptance Criteria

- [ ] MCP server runs from the Flux service entry point rather than requiring a separate manual daemon for normal use
- [ ] External agents can fetch the active ticket context with linked file paths
- [ ] External agents can update ticket status and add comments through MCP
- [ ] File and status changes are broadcast to the portal so the board moves in real time
- [ ] Agent identity is preserved in ticket history for multi-agent workflows

## Files to Create/Modify

- `engine/src/mcp.ts` or equivalent MCP server module
- `engine/src/index.ts`
- `engine/package.json`
- `.mcp.json` or equivalent IDE-facing config if needed
- `portal/src/api.ts`
- `portal/src/App.tsx`

## Dependencies

- Related to: FLUX-8 (skill design)
- Related to: FLUX-37 (master orchestrator MVP)
- Related to: FLUX-38 (execution bridge)

## Notes

- Keep the first tool surface intentionally small; passive mode only needs enough control for an external agent to read the active ticket and move it through the board
- The MCP ticket should stay focused on passive execution. Internal LLM orchestration belongs to a separate ticket


---
title: Integrate with IDE via MCP
status: Todo
createdBy: Guy
updatedBy: Guy
assignee: unassigned
tags:
  - feature
history:
  - type: comment
    user: Guy
    date: '2026-05-06T06:56:11.085Z'
    comment: commente
  - type: comment
    user: Agent
    date: '2026-05-06T07:29:00.000Z'
    comment: >-
      Fleshed this out with MCP tool definitions. Need your input on which tools
      you want and the transport mechanism — see Open Questions.
  - type: comment
    user: Guy
    date: '2026-05-06T07:34:26.739Z'
    comment: >-
      1. im not sure what this means, maybe t should be ran from the executable
      of the service

      2. minimal is fine we can flesh it out later

      3. agnet pass distinct identity, think multi agent workflow

      4. they should be intertwined as makes sense
  - type: status_change
    from: Require Input
    to: Todo
    user: Guy
    date: '2026-05-06T07:34:30.913Z'
order: 2
---
## Summary

Create an MCP (Model Context Protocol) server so that AI agents in IDEs (e.g. Gemini in VS Code) can interact with Event Horizon tickets programmatically. This enables agents to read tickets, post updates, change statuses, and flag tickets for user input — all without leaving the IDE.

## Requirements

### MCP Tools to Expose

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `list_tickets` | List all tickets, optionally filtered by status/assignee/tag | `status?`, `assignee?`, `tag?` |
| `get_ticket` | Get full ticket details including description and history | `id` |
| `update_ticket` | Update ticket fields (status, assignee, tags, title, body) | `id`, `fields` |
| `add_comment` | Post a comment on a ticket | `id`, `comment`, `user` |
| `create_ticket` | Create a new ticket | `title`, `body?`, `status?`, `tags?`, `assignee?` |
| `move_to_require_input` | Flag a ticket for user input with a question | `id`, `question` |
| `get_config` | Read the board config (statuses, users, tags) | — |

### Agent Workflow Pattern

1. Agent receives instruction to work on a ticket
2. Calls `get_ticket` to read the full context and comments
3. Posts a plan as a comment via `add_comment`
4. Works on the implementation
5. Updates the ticket with summary via `update_ticket`
6. If blocked, calls `move_to_require_input` with a question
7. Reads follow-up comments via `get_ticket` to get user responses

### Transport

- MCP server runs alongside the engine (same process or spawned)
- Supports stdio transport for local IDE integration
- Config file tells the IDE where to find the MCP server

## Open Questions

> **@Guy — Need your input:**
>
> 1. **Transport preference?** Do you want stdio-based MCP (launched by the IDE) or SSE/HTTP-based (connects to the running engine)? Stdio is simpler but requires the IDE to spawn the process. HTTP reuses the already-running engine.
> 2. **Which tools are priority?** Should we start with a minimal set (list, get, update, comment) and add more later?
> 3. **Agent identity?** Should MCP tools auto-set `user: "Agent"` or should the agent pass its identity?
> 4. **Skill file?** This overlaps with FLUX-8 (design skill). Should we combine these tickets or keep them separate — one for the MCP server and one for the skill/prompt document?

## Acceptance Criteria

- [ ] MCP server exposes tools for reading and writing tickets
- [ ] Agent in IDE can list, read, and update tickets via MCP
- [ ] Agent can post comments and flag tickets for input
- [ ] MCP config file generated for easy IDE setup
- [ ] Works with at least one IDE (VS Code with Gemini/Copilot)

## Files to Create/Modify

- `engine/src/mcp.ts` — **[NEW]** MCP server implementation
- `engine/src/index.ts` — Wire up MCP server alongside Express
- `engine/package.json` — Add MCP SDK dependency
- `.mcp.json` or equivalent — **[NEW]** MCP config for IDE discovery

## Dependencies

- Blocked by or related to: FLUX-8 (Design Skill)


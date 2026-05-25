---
title: Implement MCP server for ticket operations
status: Done
priority: High
createdBy: Guy
updatedBy: Agent
assignee: unassigned
tags:
  - feature
  - integration
  - agent
history:
  - type: activity
    user: Guy
    date: '2026-05-06T06:56:11.085Z'
    comment: Created ticket.
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
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-24T13:27:15.440Z'
  - type: status_change
    from: Grooming
    to: Done
    user: Agent
    date: '2026-05-25T04:58:35.172Z'
  - type: activity
    user: Agent
    date: '2026-05-25T04:58:35.172Z'
    comment: >-
      Updated title. Updated description. Changed effort from XL to L. Updated
      implementation link.
  - type: comment
    user: Agent
    comment: >-
      Implemented MCP server with 10 tools, workflow installer MCP config
      generation, and updated all skill files. Verified: server starts, tools
      register correctly, queries return proper results, build passes, tests
      pass.
    date: '2026-05-25T04:58:35.172Z'
    id: c-2026-05-25t04-58-35-172z
  - type: comment
    user: Agent
    comment: >-
      MCP server implemented with 10 tools (get_ticket, list_tickets,
      get_board_config, create_ticket, create_subtask, update_ticket,
      change_status, add_comment, log_progress, finish_ticket). Stdio transport
      via @modelcontextprotocol/sdk. Workflow installer generates MCP config for
      all CLIs (Claude, Gemini, Copilot, Cursor, Cline, Windsurf). Skills
      updated to reference MCP tools as primary interface. Docs at
      .docs/event-horizon/mcp-server.md.
    id: c-1779687289925-11
    date: '2026-05-25T05:34:49.966Z'
order: 17
effort: L
implementationLink: FLUX-6 implementation (pending commit)
---
## Summary

Implemented an MCP (Model Context Protocol) server that exposes Event Horizon ticket operations as first-class tools for external agents. This replaces the unreliable curl-based REST API approach described in skill files with tools that appear directly in the agent's tool list, making them structurally harder to skip.

## Problem / Motivation

Agents (Claude Code, Gemini CLI, Copilot CLI) frequently failed to update tickets during workflow execution. The curl-based approach was "soft" � agents could forget, malform requests, or skip updates entirely. An MCP server makes ticket updates enforceable at the tool boundary.

## Implementation

### Architecture
- MCP server runs as a separate entry point: `engine/src/mcp-server.ts`
- Uses `@modelcontextprotocol/sdk` with stdio transport
- Shares all internals with the HTTP engine (task-store, schema, config, events)
- Console logging redirected to stderr to avoid corrupting the protocol stream
- Agents spawn it via their MCP config: `npx tsx engine/src/mcp-server.ts --workspace .`

### Tools (10 total)
| Tool | Purpose |
|------|-------|
| `get_ticket` | Read ticket by ID (full frontmatter + body + history) |
| `list_tickets` | List/filter tickets by status, assignee, tag, priority |
| `get_board_config` | Read board config (statuses, tags, project key) |
| `create_ticket` | Create a new ticket |
| `create_subtask` | Create a child ticket linked to a parent |
| `update_ticket` | Update metadata (title, priority, effort, tags, body) |
| `change_status` | Move to new status (enforces comment requirements) |
| `add_comment` | Append comment to history |
| `log_progress` | Log progress activity |
| `finish_ticket` | Atomic: set implementationLink + Done + completion comment |

### Key Enforcement
- `change_status` rejects transitions to Require Input or Ready without a comment
- `finish_ticket` is atomic � no partial completions
- All tools validate schema before writing
- All tools broadcast SSE events for portal sync

### CLI Configuration
The workflow installer generates MCP config for all supported frameworks:
- Claude Code: `.mcp.json`
- Gemini: `.gemini/settings.json` (mcpServers key)
- Copilot: `.github/copilot/mcp.json`
- Cursor/Cline/Windsurf: respective directories

### Skill File Updates
All skill files (orchestrator, grooming, implementation) updated to reference MCP tool names instead of curl/PUT patterns. REST API retained as documented fallback.

## Files
- `engine/src/mcp-server.ts` (new � MCP server with 10 tools)
- `.mcp.json` (new � root MCP config)
- `engine/package.json` (added @modelcontextprotocol/sdk, zod)
- `engine/src/workflow-installer.ts` (added installMcpConfig)
- `engine/scripts/build.js` (added mcp-server entry point)
- `.docs/skills/event-horizon-{orchestrator,grooming,implementation}.md` (MCP tool refs)

## Verification
- MCP server starts and responds to initialize + tools/list
- All 10 tools return proper JSON schemas
- list_tickets correctly filters by status
- get_ticket retrieves full ticket data
- Build passes, tests pass

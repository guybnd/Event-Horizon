---
title: MCP Server
order: 6
---
# MCP Server

Event Horizon includes an MCP (Model Context Protocol) server that exposes ticket operations as first-class tools for external agents. This replaces curl-based REST API calls with tools that appear directly in the agent's tool list.

## Quick Start

The MCP server is configured automatically by the workflow installer. To verify it works manually:

```bash
npx tsx engine/src/mcp-server.ts --workspace .
```

The server uses stdio transport — it reads JSON-RPC from stdin and writes responses to stdout.

## Architecture

```
Agent CLI (Claude Code / Gemini / Copilot)
    ↕ stdio (JSON-RPC)
MCP Server (engine/src/mcp-server.ts)
    ↓ imports
Shared internals: task-store, schema, config, events, workspace
    ↓ reads/writes
.flux/*.md ticket files
```

The MCP server shares all internals with the HTTP engine:
- **task-store.ts**: `tasksCache` for reads, `updateTaskWithHistory()` for atomic writes
- **schema.ts**: `validateTicketFrontmatter()` for validation before save
- **events.ts**: `broadcastEvent()` for portal sync (when HTTP engine also running)
- **config.ts**: `configCache` for board configuration
- **workspace.ts**: workspace resolution and `.flux/` directory management

Console logging is redirected to stderr so it doesn't corrupt the MCP protocol stream on stdout.

## Tools

For the full per-tool reference (inputs, outputs, enforcement, examples), see [Reference: MCP Tools](reference/mcp-tools.md). Summary table:

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `get_ticket` | Read ticket by ID (full frontmatter + body + history) | `ticketId` |
| `list_tickets` | List/filter tickets | `status?`, `assignee?`, `tag?`, `priority?` |
| `get_board_config` | Read board config (statuses, tags, project key) | — |
| `create_ticket` | Create a new ticket | `title` |
| `create_subtask` | Create a child ticket linked to a parent | `parentId`, `title` |
| `update_ticket` | Update metadata (NOT status) | `ticketId` |
| `change_status` | Move to new status | `ticketId`, `newStatus` |
| `add_comment` | Append comment to history | `ticketId`, `comment` |
| `log_progress` | Log progress activity | `ticketId`, `message` |
| `finish_ticket` | Atomic: link + Done + completion comment | `ticketId`, `implementationLink`, `completionComment` |

### Enforcement Rules

- `change_status` **rejects** transitions to `Require Input` without a `comment` (the question).
- `change_status` **rejects** transitions to `Ready` without a `comment` (completion summary).
- `finish_ticket` is atomic — sets implementationLink, adds completion comment, and moves to Done in one operation.
- All mutation tools validate the ticket schema before writing.
- All mutation tools broadcast SSE events for real-time portal updates.

## Configuration per CLI

The workflow installer (`engine/src/workflow-installer.ts`) generates MCP config for each supported framework:

| Framework | Config Path | Format |
|-----------|------------|--------|
| Claude Code | `.mcp.json` (project root) | `{ mcpServers: { "event-horizon": { command, args } } }` |
| Gemini | `.gemini/settings.json` | Merged into `mcpServers` key |
| Copilot | `.github/copilot/mcp.json` | Same as Claude |
| Cursor | `.cursor/mcp.json` | Same as Claude |
| Cline | `.cline/mcp.json` | Same as Claude |
| Windsurf | `.windsurf/mcp.json` | Same as Claude |

### Dev mode config example

```json
{
  "mcpServers": {
    "event-horizon": {
      "command": "npx",
      "args": ["tsx", "engine/src/mcp-server.ts", "--workspace", "."]
    }
  }
}
```

### Packaged binary config

```json
{
  "mcpServers": {
    "event-horizon": {
      "command": "./event-horizon",
      "args": ["--mcp", "--workspace", "."]
    }
  }
}
```

## Build

The MCP server is bundled as a separate entry point by esbuild:

```
engine/src/mcp-server.ts → engine/dist/mcp-server.js
```

This is built alongside `index.js` and `init.js` by `npm run build` in the engine directory.

## Relationship to REST API

The MCP tools and REST API coexist:
- **MCP tools** are the preferred path for agents — tools appear in the tool list and enforce workflow rules.
- **REST API** (`http://localhost:3067/api/tasks`) remains available as a fallback and is used by the portal UI.
- Both share the same `tasksCache` and file storage — changes from one are visible to the other immediately.

## Troubleshooting

**Tools don't appear in agent's tool list:**
- Verify the MCP config file exists in the correct location for your CLI
- Check that `npx tsx` is available (requires Node.js and tsx installed)
- Try running manually: `npx tsx engine/src/mcp-server.ts --workspace .` — should output nothing on stdout until it receives input

**"Workspace is activating, please retry":**
- The server is still loading tickets from disk. Wait and retry.

**Protocol errors / garbled output:**
- Ensure no other process is writing to the same stdout. The MCP server redirects all `console.log` to stderr.

## Key Files

- `engine/src/mcp-server.ts` — MCP server implementation (10 tools)
- `.mcp.json` — Root MCP config for this repo
- `engine/src/workflow-installer.ts` — Generates MCP config during workflow installation
- `engine/scripts/build.js` — Bundles MCP server as separate entry point

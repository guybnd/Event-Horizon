---
title: MCP Server
order: 6
---
# MCP Server

Event Horizon includes an MCP (Model Context Protocol) server that exposes ticket operations as first-class tools for external agents. This replaces curl-based REST API calls with tools that appear directly in the agent's tool list.

## Quick Start

The MCP server is configured automatically by the workflow installer: real installs connect to the running engine over the in-process HTTP `/mcp` mount — see [MCP Tools](reference/mcp-tools.md). There is no headless / no-engine mode — start the Event Horizon engine (tray app or `npm run dev`) and the MCP endpoint comes up with it.

## Architecture

```
Agent CLI (Claude Code / Gemini / Copilot)
    ↕ HTTP (JSON-RPC, loopback)
MCP Server (engine/src/mcp-server.ts), mounted in-process on the engine
    ↓ imports
Shared internals: task-store, schema, config, events, workspace
    ↓ reads/writes
.flux/*.md ticket files
```

The MCP server shares all internals with the HTTP engine:

- **task-store.ts**: `tasksCache` for reads, `updateTaskWithHistory()` for atomic writes
- **schema.ts**: `validateTicketFrontmatter()` for validation before save
- **events.ts**: `broadcastEvent()` for portal sync
- **config.ts**: `configCache` for board configuration
- **workspace.ts**: workspace resolution and `.flux/` directory management

## Tools

For the full per-tool reference (inputs, outputs, enforcement, examples), see [Reference: MCP Tools](reference/mcp-tools.md). Summary table:

| Tool | Purpose | Required Params |
|------|---------|----------------|
| `get_ticket` | Read ticket by ID (frontmatter + body + digested recent history) | `ticketId` |
| `get_session_log` | Read one prior agent session's full progress log | `ticketId`, `sessionId` |
| `list_tickets` | List/filter tickets | `status?`, `assignee?`, `tag?`, `priority?` |
| `get_board_config` | Read board config (statuses, tags, project key) | — |
| `create_ticket` | Create a new ticket (pass `parentId` for a linked subtask) | `title` |
| `update_ticket` | Update metadata (NOT status) | `ticketId` |
| `change_status` | Move to new status | `ticketId`, `newStatus` |
| `add_note` | Append a `comment` or `activity` entry to history | `ticketId`, `type`, `message` |
| `archive` | Archive / unarchive a ticket | `ticketId`, `action` |
| `branch` | Create / status / delete the ticket's branch | `ticketId`, `action` |
| `finish_ticket` | Atomic: link + Done + completion comment | `ticketId`, `implementationLink`, `completionComment` |

> FLUX-882 folded several single-op tools behind `action`/`type` params (e.g. `create_subtask`→`create_ticket(parentId)`, `add_comment`/`log_progress`→`add_note(type)`, branch/group-doc/swimlane/archive/delegate). See the [migration map](reference/mcp-tools.md#flux-882-tool-consolidation-migration).

### Enforcement Rules

- `change_status` **rejects** transitions to `Require Input` without a `comment` (the question).
- `change_status` **rejects** transitions to `Ready` without a `comment` (completion summary).
- `finish_ticket` is atomic — sets implementationLink, adds completion comment, and moves to Done in one operation.
- All mutation tools validate the ticket schema before writing.
- All mutation tools broadcast SSE events for real-time portal updates.
- `get_ticket` digests history for agents: `agent_session` entries lose `progress[]` (kept as `progressCount`; fetch via `get_session_log`), and history is windowed to the most recent ~20 entries (`historyLimit` to override, `olderHistoryEntries` reports omissions). REST keeps the full payload for the portal.
- `create_ticket` / `update_ticket` attach a soft warning when a body exceeds 10k chars (write still succeeds).

## Configuration per CLI

The workflow installer (`engine/src/workflow-installer.ts`) generates MCP config for each supported framework:

| Framework | Config Path | Format |
|-----------|------------|--------|
| Claude Code | `.mcp.json` (project root) | `{ mcpServers: { "event-horizon": { type, url, alwaysLoad } } }` |
| Gemini | `.gemini/settings.json` | Merged into `mcpServers` key |
| Copilot | `.github/copilot/mcp.json` | Same as Claude |
| Cursor | `.cursor/mcp.json` | Same as Claude |
| Cline | `.cline/mcp.json` | Same as Claude |
| Windsurf | `.windsurf/mcp.json` | Same as Claude |

### Config example (dev and packaged, identical shape)

```json
{
  "mcpServers": {
    "event-horizon": {
      "type": "http",
      "url": "http://127.0.0.1:3067/mcp",
      "alwaysLoad": true
    }
  }
}
```

The port is rendered by the installer from the engine's actual listen port and re-written on every engine start, so a port change is picked up automatically — no `command`/`args`/`--workspace` needed, dev or packaged.

## Build

The MCP server ships **inside** `engine/dist/index.js`. `index.ts` statically imports it (FLUX-705), so `npm run build`'s esbuild pass inlines `mcp-server.ts` into the engine bundle — there is no separate `dist/mcp-server.js` artifact (FLUX-710). The HTTP `/mcp` mount runs from `index.js`.

## Relationship to REST API

The MCP tools and REST API coexist:

- **MCP tools** are the preferred path for agents — tools appear in the tool list and enforce workflow rules.
- **REST API** (`http://localhost:3067/api/tasks`) remains available as a fallback and is used by the portal UI.
- Both share the same `tasksCache` and file storage — changes from one are visible to the other immediately.

## Troubleshooting

**Tools don't appear in agent's tool list:**

- Verify the Event Horizon engine is running — the HTTP `/mcp` mount only exists while the engine is up (there is no standalone/headless MCP process).
- Verify the MCP config file exists in the correct location for your CLI and its `url` port matches the running engine (`GET /api/health`).
- Running `npx tsx engine/src/index.ts --mcp` (with the engine down) now fails fast with an informative error instead of hanging — that's expected; it's not a way to run the MCP server standalone.

**"Workspace is activating, please retry":**

- The server is still loading tickets from disk. Wait and retry.

## Key Files

- `engine/src/mcp-server.ts` — MCP server implementation
- `.mcp.json` — Root MCP config for this repo
- `engine/src/workflow-installer.ts` — Generates MCP config during workflow installation

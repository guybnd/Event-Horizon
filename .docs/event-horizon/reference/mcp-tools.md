---
title: MCP Tools Reference
order: 1
---
# MCP Tools Reference

Authoritative list of every tool exposed by the Event Horizon MCP server ([`engine/src/mcp-server.ts`](../../../engine/src/mcp-server.ts)). Each entry lists the input schema, output shape, side effects, and enforcement rules.

> Agents should prefer MCP tools over the REST API. The portal uses REST; agents use MCP. Both share the same in-memory state and validation.

## How tools are exposed

The server speaks JSON-RPC over stdio using `@modelcontextprotocol/sdk`. The transport is `StdioServerTransport`. Logs go to stderr so they never corrupt protocol framing on stdout.

A single workspace must be provided at startup:

```bash
npx tsx engine/src/mcp-server.ts --workspace /path/to/project
```

The auto-installed MCP config (placed by the workflow installer) does this for you.

## Tool index

| Tool | Category | Mutates? |
|------|----------|----------|
| [`get_ticket`](#get_ticket) | Read | — |
| [`list_tickets`](#list_tickets) | Read | — |
| [`get_board_config`](#get_board_config) | Read | — |
| [`create_ticket`](#create_ticket) | Mutation | yes |
| [`update_ticket`](#update_ticket) | Mutation | yes |
| [`change_status`](#change_status) | Mutation | yes (enforced) |
| [`add_comment`](#add_comment) | Mutation | yes |
| [`log_progress`](#log_progress) | Mutation | yes |
| [`finish_ticket`](#finish_ticket) | Lifecycle (atomic) | yes |
| [`create_subtask`](#create_subtask) | Mutation | yes |
| [`create_branch`](#create_branch) | Branch | yes |
| [`get_branch`](#get_branch) | Branch | — |
| [`delete_branch`](#delete_branch) | Branch | yes |

---

## Read tools

### `get_ticket`

Read a ticket by ID.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `ticketId` | string | yes | e.g. `FLUX-42` |

**Output:** JSON — full frontmatter + `body` + `history`. The internal `_path` field is stripped.

**Errors:** `Ticket <id> not found`.

```jsonc
// example call
{ "tool": "get_ticket", "input": { "ticketId": "FLUX-42" } }
```

### `list_tickets`

List or filter tickets.

| Input | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | string | no | Filter by status name |
| `assignee` | string | no | Filter by assignee |
| `tag` | string | no | Ticket must include this tag |
| `priority` | string | no | One of: `Critical`, `High`, `Medium`, `Low`, `None` |

**Output:** JSON array of summaries `{ id, title, status, priority, effort, assignee, tags }`. Bodies and history are not included — use `get_ticket` for full content.

### `get_board_config`

Read board configuration.

**Input:** none.

**Output:** `{ statuses, projects, tags, priorities, users, requireInputStatus, readyForMergeStatus }`. `statuses` merges visible columns and hidden statuses.

---

## Mutation tools

All mutation tools:

- Validate frontmatter against [`schema.ts`](../../../engine/src/schema.ts) before writing.
- Set `updatedBy` to `'Agent'` (or the provided `user`/`author`).
- Auto-register any new tags into board config (`autoRegisterUnknownTags`).
- Broadcast an SSE `taskUpdated` or `taskCreated` event so the portal reacts live.

### `create_ticket`

Create a new ticket.

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `title` | string | yes | — |
| `status` | string | no | `Todo` |
| `priority` | string | no | `None` |
| `effort` | string | no | `None` |
| `assignee` | string | no | `unassigned` |
| `tags` | string[] | no | `[]` |
| `body` | string | no | `''` |
| `author` | string | no | `Agent` |

**Output:** `{ id, title, status }`.

**Side effects:** assigns the next `<projectKey>-N` id, writes `.flux/<id>.md`, seeds a creation activity entry in history.

**Errors:** `Workspace is activating, please retry`; `Schema validation failed: …`.

### `update_ticket`

Update metadata. Does **not** change status — use `change_status` for that.

| Input | Type | Notes |
|-------|------|-------|
| `ticketId` | string (required) | |
| `title`, `priority`, `effort`, `assignee`, `body`, `implementationLink` | string | omit to leave unchanged |
| `tags` | string[] | replaces the array (not a merge) |

**Output:** `Updated <id>`.

**Side effects:** appends a single `activity` history entry summarizing the field changes (e.g. *"Updated title. Changed priority to High."*).

### `change_status`

Move a ticket to a new status.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `newStatus` | string | yes |
| `comment` | string | conditional — see enforcement |

**Enforcement:**

- Transitioning **to** `Require Input` requires `comment` (the question to ask the user).
- Transitioning **to** `Ready` requires `comment` (the completion summary), unless `config.requireCommentOnStatusChange === false`.
- The `Require Input` / `Ready` status names are read from `configCache.requireInputStatus` / `readyForMergeStatus` and may be renamed in board config.

**Output:** `<id> moved to <status>`.

**Side effects:** appends a `comment` entry when one is provided, plus a `status_change` entry recording the transition.

### `add_comment`

Append a comment to history.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `comment` | string | yes |
| `user` | string | no — defaults to `Agent` |

**Output:** `Comment added to <id>`.

### `log_progress`

Append an `activity` entry (different from a comment — used for "agent did X" updates).

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `message` | string | yes |

**Output:** `Progress logged on <id>`.

---

## Lifecycle tool

### `finish_ticket`

Atomic close-out: set `implementationLink`, append a completion comment, move status to `Done`. If the ticket has an associated git branch *and* `gh` is authenticated, also opens a PR and stores the PR URL as the implementation link.

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |
| `implementationLink` | string | yes — commit hash or PR URL |
| `completionComment` | string | yes — summary of what was implemented |

**Output:** `<id> finished → Done (link: <url>)`.

**Side effects:**

- Attempts `gh pr create` if `task.branch` is set and `gh` is authenticated; replaces `implementationLink` with the PR URL on success.
- On `gh` failure, falls back to the provided commit hash and appends a warning to the completion comment.
- Writes status + link + comment in one disk write — no partial state on failure.

---

## Branch tools

These wrap git operations through [`branch-manager.ts`](../../../engine/src/branch-manager.ts). Branches are named `flux/<lowercased-ticket-id>-<slug>`.

### `create_branch`

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `ticketId` | string | yes | — |
| `baseBranch` | string | no | `master` |

**Output:** `{ branch: "<name>" }`.

**Errors:** ticket not found; `Ticket <id> already has branch: <name>`; git failure.

### `get_branch`

| Input | Type | Required |
|-------|------|----------|
| `ticketId` | string | yes |

**Output:** `{ name, exists, aheadCount, behindCount }`. If the ticket has no branch, returns `{ name: null, exists: false, aheadCount: 0, behindCount: 0 }`.

### `delete_branch`

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `ticketId` | string | yes | — |
| `force` | boolean | no | `false` |

**Output:** `Branch <name> deleted`.

**Enforcement:** refuses to delete unmerged branches unless `force === true`.

---

## Subtask tool

### `create_subtask`

Create a child ticket and link it from the parent's `subtasks` array atomically.

| Input | Type | Required | Default |
|-------|------|----------|---------|
| `parentId` | string | yes | — |
| `title` | string | yes | — |
| `status`, `priority`, `effort`, `assignee`, `body` | string | no | as `create_ticket` |
| `tags` | string[] | no | `[]` |

**Output:** `{ id, parentId, title, status }`.

**Side effects:**

- Allocates a new id from the same project key as the parent.
- Writes the child file with a creation activity entry referencing the parent.
- Rewrites the parent file to append the new id to its `subtasks` array.
- Broadcasts `taskCreated` with the `parentId` for portal hierarchy cues.

---

## Error model

All tools that detect a problem return `{ isError: true, content: [{ type: 'text', text: '<message>' }] }`. The MCP SDK surfaces this as a tool error in the calling agent. Common shapes:

| Message | Cause |
|---------|-------|
| `Ticket <id> not found` | unknown ticket |
| `Workspace is activating, please retry` | engine is still loading `.flux/` on startup or workspace switch |
| `Schema validation failed:\n<details>` | frontmatter would be invalid — see `schema.ts` |
| `Transitioning to <status> requires a comment …` | enforcement on `Require Input` / `Ready` |
| `Failed to <op>: <git error>` | git wrapper surfaced an underlying error |

## Cross-references

- [Architecture: MCP Server](../mcp-server.md) — high-level overview, how the MCP transport plugs in.
- [Reference: REST API](rest-api.md) — the portal-facing surface that shares the same state.
- [Code Map](../architecture/code-map.md) — where each subsystem lives.
- [Ticket Lifecycle](../workflow/ticket-lifecycle.md) — when to call which tool during a ticket.

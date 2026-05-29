---
title: Event Horizon Orchestrator
order: 1
---
> ⚠️ DO NOT DELETE — Required for Event Horizon agent workflow.

## Phase: Orchestrator

Scope: Route the agent to the correct phase-specific skill based on ticket status.

---

# Event Horizon Agent — Orchestrator

Version: 2.2.0

## Overview

Event Horizon is a local-first ticket board backed by markdown files. Tickets are stored either in `.flux/` (in-repo mode) or `.flux-store/` (orphan-branch mode using a git worktree on `flux-data`). The engine abstracts this — agents interact exclusively through MCP tools and never touch ticket files directly.

## Skill Routing

| Ticket Status | Load Skill |
|---|---|
| `Grooming`, `Require Input` | grooming skill |
| `Todo`, `In Progress` | implementation skill |
| Release orchestration | release skill |

Read-only tasks (explanation, search, discussion) need no phase skill.

## Ticket Model

Frontmatter fields: `id`, `title`, `status`, `priority`, `assignee`, `tags` (string[]), `createdBy`, `updatedBy`, `history` (event list), `effort` (`None`|`XS`|`S`|`M`|`L`|`XL`), `implementationLink`, `subtasks` (string[] of child ticket IDs). Markdown body below frontmatter for description.

**Subtasks**: The `subtasks` field is an array of ticket ID strings (e.g. `["FLUX-5", "FLUX-6"]`). Each subtask MUST be a separate ticket file. Never write inline objects. To create a subtask, use the `create_subtask` MCP tool.

History entry shapes:

```yaml
- type: comment
  user: Agent
  date: '2026-05-06T22:30:00.000Z'
  comment: Planned the implementation in three steps.

- type: status_change
  from: Todo
  to: In Progress
  user: Agent
  date: '2026-05-06T22:31:00.000Z'
```

**Schema landmines — get these wrong and the engine silently drops the entry:**

```yaml
# ✅ CORRECT status_change — uses from/to with a real ISO timestamp
- type: status_change
  from: Grooming
  to: Todo
  user: Agent
  date: '2026-05-25T13:42:18.331Z'

# ❌ WRONG — oldStatus/newStatus is not the canonical shape
- type: status_change
  oldStatus: Grooming
  newStatus: Todo
  user: Agent
  date: '2026-05-25T14:00:00.000Z'

# ❌ WRONG — round-number timestamps like 13:42:00.000Z look fabricated.
#    Use an actual current timestamp (millisecond precision).
```

**Subtask shape:** `subtasks` is an array of ticket ID strings. Inline objects are silently dropped if they lack an `id` field.

```yaml
# ✅ CORRECT
subtasks:
  - FLUX-282
  - FLUX-283

# ❌ WRONG — inline subtask objects without id are dropped on load
subtasks:
  - title: Research CLI capabilities
    status: Todo
```

## Working Surfaces

- Ticket storage: `.flux/` (in-repo) or `.flux-store/` (orphan mode) — agents NEVER access these directly
- Board config: `config.json` in the active flux directory
- Project docs: `.docs/**/*.md`
- Engine source: `engine/src/`
- Portal source: `portal/src/`
- Skill sources: `.docs/skills/*.md`
- Skill templates: `.flux/skills/*.md`

## APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/tasks` | List all tickets |
| `POST /api/tasks` | Create a ticket |
| `PUT /api/tasks/:id` | Update a ticket |
| `DELETE /api/tasks/:id` | Delete a ticket |
| `POST /api/tasks/:parentId/subtasks` | Create a linked subtask |
| `GET /api/config` | Get board config |
| `PUT /api/config` | Update board config |
| `POST /api/bulk-rename` | Bulk rename statuses/tags |

Portal: `localhost:5167` — Engine: `localhost:3067`

## User Input Routing

- Chat for broad discussion. Ticket system for ticket-specific decisions.
- `Require Input` → history comment with one clear question + proposed defaults → user answers → route back to next status.
- `Ready` → user reviews → `finish <ticket>` → agent commits + closes atomically.

## Ticket Resolution

- `FLUX-41` → use that ticket. Bare number like `41` or `do 41` → resolve to `FLUX-41`.
- Repo-changing work without a named ticket → find or create a ticket first.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes.

## Persisting Changes — CRITICAL

All ticket updates — status changes, metadata, body rewrites, history comments — **MUST** use the MCP tools listed below.

**NEVER do any of the following:**
- Use the `Write` tool on any file in `.flux/` or `.flux-store/`
- Use the `Edit` tool on any file in `.flux/` or `.flux-store/`
- Use `Bash` with `echo`, `sed`, `cat >`, or any shell command that writes to ticket files
- Use `curl` to hit the REST API when MCP tools are available
- Construct YAML frontmatter manually and write it to disk

The MCP tools handle schema validation, timestamps, history normalization, and portal sync. Direct file writes bypass all of this and can corrupt tickets.

### MCP Tools (use these — they appear in your tool list)

| Tool | Use When |
|---|---|
| `get_ticket` | Reading a ticket's full state (frontmatter + body + history) |
| `list_tickets` | Finding tickets by status, assignee, tag, or priority |
| `get_board_config` | Checking valid statuses, tags, project key |
| `create_ticket` | Creating a new ticket |
| `create_subtask` | Creating a child ticket linked to a parent |
| `update_ticket` | Changing metadata (title, priority, effort, tags, assignee, body) |
| `change_status` | Moving to a new status (comment required for Require Input/Ready) |
| `add_comment` | Adding a comment to ticket history |
| `log_progress` | Logging a progress update |
| `finish_ticket` | Completing a ticket (sets implementationLink + Done atomically) |

Notes:
- `change_status` enforces comment requirements: you MUST provide a `comment` when transitioning to `Require Input` (the question) or `Ready` (the completion summary).
- `finish_ticket` is atomic: it sets the implementation link, adds a completion comment, and moves status to Done in one operation.
- `create_subtask` creates a child ticket file and links it to the parent's `subtasks` array atomically.
- All tools handle timestamps, history normalization, and schema validation server-side.

### REST API (last-resort fallback)

ONLY use the REST API if MCP tools genuinely fail to load (i.e., `ToolSearch` returns no `event-horizon` tools). If MCP tools appear in your tool list, use them — never fall back to curl/REST "for convenience."

REST base: `http://localhost:3067`

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/tasks` | Create a ticket |
| `PUT` | `/api/tasks/:id` | Update a ticket (use `appendHistory` for comments) |
| `POST` | `/api/tasks/:parentId/subtasks` | Create a linked subtask |

If neither MCP tools nor the API are reachable, surface the problem to the user and wait. Do not edit files directly under any circumstances.

Ticket changes that only exist in chat or agent memory are **lost**. The engine is the single source of truth.

## Critical Rules

- NEVER use Write, Edit, or Bash to modify files in `.flux/` or `.flux-store/`. These paths are engine-managed.
- Treat ticket files as schema-sensitive. The engine validates and rejects malformed writes.
- Do not delete ticket history; append only.
- The `finish <ticket>` handoff is required before committing. Commit creation, `implementationLink` update, and status → `Done` happen as one atomic step.

## End-to-End Checklist

- Ticket read fully — Relevant docs reviewed — Plan comment added
- Grooming produced a concrete plan with filled metadata
- Implementation-critical choices clarified before coding
- Status moved at the right time — Code changed in smallest surface — Validation passed
- Docs refreshed before `Ready`/`Done`
- Questions went through `Require Input`, not only chat
- `finish <ticket>` received before commit — Completion comment added — Status → `Done`

---
title: Event Horizon Orchestrator
order: 1
---
> ⚠️ DO NOT DELETE — Required for Event Horizon agent workflow.

## Phase: Orchestrator
Scope: Route the agent to the correct phase-specific skill based on ticket status.

---

# Event Horizon Agent — Orchestrator

Version: 2.1.0

## Overview

Event Horizon is a local-first ticket board backed by markdown files in `.flux/`.
Each ticket is a markdown document with YAML frontmatter and a markdown body.

## Skill Routing

| Ticket Status | Load Skill |
|---|---|
| `Grooming`, `Require Input` | `grooming.md` |
| `Todo`, `In Progress` | `implementation.md` |
| Release orchestration | `release.md` |

Read-only tasks (explanation, search, discussion) need no phase skill.

## Ticket Model

Frontmatter fields: `id`, `title`, `status`, `priority`, `assignee`, `tags` (string[]), `createdBy`, `updatedBy`, `history` (event list), `effort` (`None`|`XS`|`S`|`M`|`L`|`XL`), `implementationLink`, `subtasks` (string[] of child ticket IDs). Markdown body below frontmatter for description.

**Subtasks**: The `subtasks` field is an array of ticket ID strings (e.g. `["FLUX-5", "FLUX-6"]`). Each subtask MUST be a separate `.flux/<id>.md` file. Never write inline objects. To create a subtask, use `POST /api/tasks/:parentId/subtasks` with `{ title, status?, priority?, body? }` — this atomically creates the child ticket and links it.

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

# ❌ WRONG — oldStatus/newStatus is not the canonical shape; gates that protect
#    Require Input / Ready transitions will fail to recognize this entry
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

- `.flux/*.md`: tickets — `.flux/config.json`: board config — `.docs/**/*.md`: project docs
- `engine/src/`: Express API — `portal/src/`: React UI
- `.docs/skills/*.md`: editable skill sources — `.flux/skills/*.md`: bootstrap templates

## APIs

- `GET/POST /api/tasks`, `PUT/DELETE /api/tasks/:id` — `GET/PUT /api/config` — `POST /api/bulk-rename`
- `POST /api/tasks/:parentId/subtasks` — create a child ticket and link it to the parent
- CLI: `npx tsx engine/src/patch-ticket.ts --add-subtask <parentId> --title <value> [--status] [--priority] [--effort] [--body]`
- Portal: `localhost:5167` — Engine: `localhost:3067`

## User Input Routing

- Chat for broad discussion. Ticket system for ticket-specific decisions.
- `Require Input` → history comment with one clear question + proposed defaults → user answers → route back to next status.
- `Ready` → user reviews → `finish <ticket>` → agent commits + closes atomically.

## Ticket Resolution

- `FLUX-41` → use that ticket. Bare number like `41` or `do 41` → resolve to `FLUX-41`.
- Repo-changing work without a named ticket → find or create a ticket first.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes.

## Persisting Changes

All ticket updates — status changes, metadata, body rewrites, history comments — **MUST** use the MCP tools listed below. Do not edit `.flux/<id>.md` files directly. The tools handle schema validation, timestamps, and portal sync automatically.

### MCP Tools (use these — they appear in your tool list)

| Tool | Use When |
|------|----------|
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

### REST API (fallback if MCP tools are unavailable)

If MCP tools do not appear in your tool list, use the engine REST API at `http://localhost:3067`:

```
POST /api/tasks — create a ticket
PUT  /api/tasks/:id — update a ticket (use appendHistory for comments)
POST /api/tasks/:parentId/subtasks — create a linked subtask
```

If neither MCP tools nor the API are reachable, surface the problem to the user and wait. Do not edit files directly.

Ticket changes that only exist in chat or agent memory are **lost**. The engine is the single source of truth.

## Critical Rules

- Treat `.flux/*.md` as schema-sensitive. Use spaces (not tabs) in YAML frontmatter. Do not delete ticket history; append only.
- The `finish <ticket>` handoff is required before committing. Commit creation, `implementationLink` update, and status → `Done` happen as one atomic step.

## End-to-End Checklist

- Ticket read fully — Relevant docs reviewed — Plan comment added
- Grooming produced a concrete plan with filled metadata
- Implementation-critical choices clarified before coding
- Status moved at the right time — Code changed in smallest surface — Validation passed
- Docs refreshed before `Ready`/`Done` — YAML checked after ticket edits
- Questions went through `Require Input`, not only chat
- `finish <ticket>` received before commit — Completion comment added — Status → `Done`

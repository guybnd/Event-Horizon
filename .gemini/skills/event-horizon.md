<skill_module name="event-horizon-orchestrator">
---
title: Event Horizon Orchestrator
order: 1
---
> ⚠️ DO NOT DELETE — Required for Event Horizon agent workflow.

## Phase: Orchestrator

Scope: Route the agent to the correct phase-specific skill based on ticket status.

---

# Event Horizon Agent — Orchestrator

Version: 2.3.0

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

Tickets have these fields (relevant when calling `update_ticket` or reading `get_ticket` output):

| Field | Type | Notes |
|---|---|---|
| `id` | string | e.g. `FLUX-41` — set by engine, never change |
| `title` | string | Short description |
| `status` | string | Board column (e.g. `Grooming`, `Todo`, `In Progress`, `Ready`, `Done`) |
| `priority` | string | `None`, `Low`, `Medium`, `High`, `Critical` |
| `effort` | string | `None`, `XS`, `S`, `M`, `L`, `XL` |
| `assignee` | string | User name or `unassigned` |
| `tags` | string[] | From board config |
| `body` | markdown | Description / plan in the ticket body |
| `subtasks` | string[] | Child ticket IDs — use `create_subtask` to add |
| `implementationLink` | string | Commit hash or PR URL — set by `finish_ticket` |
| `branch` | string | Git branch name (e.g. `flux/FLUX-41-add-effort-field`) — set by `create_branch` or portal Start Task prompt |

History is an append-only event log (types: `comment`, `status_change`, `activity`, `agent_session`). You read it via `get_ticket` and append to it via `add_comment`, `change_status`, `log_progress`. Never construct history entries manually.

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
| `create_branch` | Create a git feature branch for a ticket (`flux/<ID>-<slug>`) and store its name on the ticket |
| `get_branch` | Get branch name + existence + ahead/behind counts vs master |
| `delete_branch` | Delete the branch associated with a ticket (refuses unmerged unless `force: true`) |

Notes:
- `change_status` enforces comment requirements: you MUST provide a `comment` when transitioning to `Require Input` (the question) or `Ready` (the completion summary).
- `finish_ticket` is atomic: it sets the implementation link, adds a completion comment, and moves status to Done in one operation. When the ticket has a `branch`, it also pushes the branch and creates a PR via `gh` — the PR URL becomes the `implementationLink`.
- `create_subtask` creates a child ticket file and links it to the parent's `subtasks` array atomically.
- All tools handle timestamps, history normalization, and schema validation server-side.
- There is **no** `switch_branch` tool. Agents stay on their ticket branch for the full session. Switching branches requires explicit user confirmation in chat.

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
- **Reference docs (`.docs/event-horizon/reference/*`) are kept in sync with code.** If the ticket changes ticket-schema, MCP tools, REST endpoints, realtime channels, or the agent-adapter contract, the matching reference page MUST be updated in the same ticket. Fix the drift; do not file a follow-up.

## End-to-End Checklist

- Ticket read fully — Relevant docs reviewed — Plan comment added
- Grooming produced a concrete plan with filled metadata
- Implementation-critical choices clarified before coding
- Status moved at the right time — Code changed in smallest surface — Validation passed
- **Docs refreshed before `Ready`/`Done` — reference pages match the new behavior, code-map points at any new modules, and the completion comment says either "docs updated: …" or "no docs needed because …"**
- Questions went through `Require Input`, not only chat
- `finish <ticket>` received before commit — Completion comment added — Status → `Done`
</skill_module>

<skill_module name="event-horizon-grooming">
---
title: Event Horizon Grooming
order: 2
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break grooming behaviour.

## Phase: Grooming / Require Input
Scope: Interpret requirements, update frontmatter, and handle `.flux` metadata during the planning phase.

---

# Event Horizon Agent — Grooming Skill

Version: 2.3.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Grooming Workflow

1. Use `get_ticket` to read the full ticket, including all history.
2. Read `.docs/INDEX.md` to identify relevant docs, then read only those files. Skip docs entirely for XS/S effort tickets.
3. Treat `Grooming` as a planning phase — do not code. Use `update_ticket` to tighten the ticket body into a concrete plan and fill inferable metadata (`priority`, `effort`, `tags`, hierarchy links).
4. If implementation-critical choices are unresolved, use `change_status` with `newStatus: 'Require Input'` and a `comment` containing one question + proposed defaults, then wait.
5. Once resolved, use `update_ticket` to rewrite `body` with:
   - **Problem / Motivation** (1–3 sentences): what problem, who benefits, why prioritised.
   - **Implementation plan**: concrete steps so another agent could pick up without re-discovery.
6. Use `change_status` with `newStatus: 'Todo'`. **CRITICAL: Stop execution after moving to Todo — do not begin implementation.**

All persistence uses MCP tools — see the orchestrator skill's "Persisting Changes" section.

## Metadata Conventions

| Field | Values |
|---|---|
| `priority` | `None`, `Low`, `Medium`, `High`, `Critical` |
| `effort` | `None`, `XS`, `S`, `M`, `L`, `XL` |
| `tags` | Use existing tags from board config; propose new ones only when clearly distinct |
| `assignee` | Set if user indicated ownership; leave `unassigned` otherwise |

## Editing & Safety

- All writes go through MCP tools (or the REST API as last-resort fallback). NEVER use Write, Edit, or Bash to modify ticket files.
- MCP tools handle `updatedBy` attribution and history normalization automatically.
- Do not read or write files in `.flux/` or `.flux-store/` — use `get_ticket` instead.

## Comment Conventions

- Keep comments factual and short. End input requests with a concrete question and proposed default.
- Prefer comments that help the next agent continue without re-discovery.
</skill_module>

<skill_module name="event-horizon-implementation">
---
title: Event Horizon Implementation
order: 3
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break implementation behaviour.

## Phase: Todo / In Progress
Scope: Write code, validate logic, format commits, and close tickets during the implementation phase.

---

# Event Horizon Agent — Implementation Skill

Version: 2.4.0

## When This Skill Applies

Load this skill when a ticket's status is `Todo` or `In Progress`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Implementation Workflow

1. Use `get_ticket` to read the full ticket, including all history, before touching any file.
2. **Check for a branch.** Call `get_branch` on the ticket. If `branch` is set, run `git fetch origin <branch>` then `git checkout <branch>` before making any changes (the branch is created remotely via the portal and may not exist locally yet). If no branch is set, proceed on the current branch (the user chose "start normally" at task start).
3. For M+ effort tickets, check `.docs/INDEX.md` for relevant docs. Read nearby implementation files. Prefer the smallest owning surface.
4. Use `add_comment` to post your implementation plan before substantial work.
5. Use `change_status` with `newStatus: 'In Progress'` before the first substantive code change.
6. Make small, local changes and validate immediately after the first edit.
7. Use `log_progress` to record progress when scope changes, validation fails, or the user redirects.
8. If clarification is needed, use `change_status` with `newStatus: 'Require Input'` and a `comment` — do not ask only in chat.
9. When moving to `Ready`: use `change_status` with `newStatus: 'Ready'` and a `comment` summarizing what was implemented, validated, and any caveats. Keep code files uncommitted at this stage.
10. **Before `Ready` or `Done`, update `.docs/` so the docs match the new behavior.** This is part of the ticket, not a follow-up. Check first:
    - `.docs/event-horizon/reference/*` — if you changed ticket schema, MCP tools, REST endpoints, realtime channels, or the agent-adapter contract, the matching reference page MUST be updated.
    - `.docs/event-horizon/architecture/code-map.md` — add an entry when a new module becomes the right "land here first" file for future agents.
    - `.docs/event-horizon/agent-integrations.md`, `workflow/*.md`, root `README.md`, and `.flux/skills/` templates when user-facing or agent-facing behavior changes.
    - If nothing needs updating, say so explicitly in the completion comment ("no docs needed because …") instead of skipping the check silently.
11. On `finish <ticket>`: stage all relevant files (code + docs), create the commit, then use `finish_ticket` with `implementationLink` (commit hash) and `completionComment`. If the ticket has a `branch`, the engine pushes the branch and creates a PR automatically — the PR URL becomes `implementationLink`. Status moves to Done atomically. The completion comment should name the docs you updated, or state why none were needed.

## Branch Rules

- **Stay on your branch.** Once on a ticket branch, never run `git checkout` to another branch without explicit user confirmation in chat. If a switch is genuinely needed, stop and ask first.
- **Branch creation is not your decision.** The user chose whether to create a branch when starting the ticket from the portal. Do not create one unless `get_branch` returns no branch and the user explicitly asks.
- **Returning from Ready.** If the ticket is moved back to `In Progress` after review, re-read the most recent comment first. Check out the existing branch (still in the `branch` field), apply changes, commit, then run `git push origin <branch>` explicitly before calling `finish_ticket`. The open PR updates automatically from the push.
- **XS tickets.** Branch creation is optional and often skipped for XS effort tickets.

## Reviewer Agent Handoff

Reviewer agents are triggered manually by the user — not automatically when a ticket reaches `Ready`. When a reviewer sends a ticket back to `In Progress`, a structured comment explains what needs changing. Read that comment before making any changes. The review conversation lives on the ticket; the GitHub PR is the diff artifact.

All persistence uses MCP tools — see the orchestrator skill's "Persisting Changes" section.

## File Boundaries

You may freely read and write files in:
- `engine/src/` — Express API and engine logic
- `portal/src/` — React UI components
- `.docs/` — project documentation
- Any other source code directories

You MUST NOT read or write files in:
- `.flux/` — ticket storage (in-repo mode)
- `.flux-store/` — ticket storage (orphan mode)
- `.flux/config.json` — use `get_board_config` MCP tool instead

Use MCP tools for all ticket interactions. Use Read for source code only.

## Common Project Patterns

- Ticket persistence: engine, not portal. Docs: `.docs/`. Cards: `TaskCard.tsx`. Modal: `TaskModal.tsx`. State: `AppContext.tsx`.
- Installer: `engine/src/workflow-installer.ts` and `engine/src/skill-installer.ts`.
- MCP server: `engine/src/mcp-server.ts` — defines all agent-facing tools.
- Ticket store: `engine/src/task-store.ts` — cache, file watchers, persistence.

## Commit Guidance

- One focused commit per ticket. Describe shipped behavior, not files touched.
- Wait for `finish <ticket>` before committing. Commit + implementationLink + Done = atomic.
- Good: `Add ticket effort field editing`. Bad: `fix stuff`, `updates`.

## Comment Conventions

- Keep comments factual and short. Completion comments: behavior, key files, validation, commit hash.
- Prefer comments that help the next agent continue without re-discovery.
</skill_module>

<skill_module name="event-horizon-release">
---
title: Event Horizon Release
order: 4
---
> ⚠️ DO NOT DELETE — Required for release orchestration.

## Phase: Release Orchestration

---

# Event Horizon Agent — Release Skill

Version: 2.3.0

## When This Skill Applies

Load when the user asks to create a release or run a release.

## Release Workflow

1. Determine version (e.g. `v1.2.0`). If not provided, propose one based on semantic versioning.
2. Summarize what's in `Done` status and confirm ready for release.
3. Run `npm run flux:release <version>` in `engine/`. This gathers Done tickets, generates release notes in `.docs/`, and moves tickets to `Released`.
4. Review generated release notes; adjust if needed.
5. Create a git commit immediately (e.g. `Release <version>`).
6. Notify the user: tickets released, committed, point to release notes.
</skill_module>
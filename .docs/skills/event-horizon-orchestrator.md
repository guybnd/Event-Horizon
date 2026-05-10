---
title: Event Horizon Orchestrator
order: 1
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break the agent skill routing.

## Phase: Orchestrator
Scope: Route the agent to the correct phase-specific skill based on the active ticket status.

---

# Event Horizon Agent — Orchestrator

Version: 2.0.0

## Overview

Event Horizon is a local-first ticket board backed by markdown files in `.flux/`.
Each ticket is a markdown document with YAML frontmatter and a markdown body.
The portal UI and engine API both operate on that file-based source of truth.

## Skill Routing

When working on a ticket, load the appropriate phase-specific skill based on the ticket's current status:

| Ticket Status | Load Skill |
|---------------|-----------|
| `Grooming`, `Require Input` | `event-horizon-grooming.md` |
| `Todo`, `In Progress` | `event-horizon-implementation.md` |
| Release orchestration requested | `event-horizon-release.md` |

For read-only tasks (explanation, search, discussion) no phase skill is required.

## Ticket Model

Each ticket file typically contains:

- `id`: stable ticket id such as `FLUX-28`
- `title`: short summary
- `status`: board column/status name
- `priority`: configured priority label
- `assignee`: assigned user or `unassigned`
- `tags`: string array
- `createdBy`, `updatedBy`: actor names
- `history`: chronological event list
- `effort`: T-shirt estimate (`None`, `XS`, `S`, `M`, `L`, `XL`)
- `implementationLink`: commit or PR URL when available
- markdown body below frontmatter for the full ticket description

History entries use one of these shapes:

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

## Working Surfaces

- `.flux/*.md`: ticket source files
- `.flux/config.json`: board configuration and configured priorities/tags/users
- `.docs/**/*.md`: project documentation served in the Docs screen
- `.docs/skills/*.md`: editable phase-specific skill files (this directory)
- `README.md`: repo-level overview and workflow install guidance
- `.flux/skills/*.md`: source workflow asset templates (bootstrap copies)
- `engine/src/index.ts`: Express API that reads and writes tickets
- `portal/src/`: React portal UI for board, backlog, settings, and ticket modal flows

## Available APIs

When running against the local engine, use these endpoints:

- `GET /api/tasks`: list all tickets
- `POST /api/tasks`: create a ticket
- `PUT /api/tasks/:id`: update ticket fields and history
- `DELETE /api/tasks/:id`: delete a ticket
- `GET /api/config`: read board configuration
- `PUT /api/config`: update board configuration
- `POST /api/bulk-rename`: rename tags/users/statuses/priorities across tickets

Default local URLs used by this project:

- Portal: `http://localhost:5167`
- Engine: `http://localhost:3067`

## User Input Routing

- Use normal chat for broad discussion, planning, or non-ticket conversation.
- Use the ticket system for ticket-specific clarification, approval, or decisions that should remain attached to the work item.
- Use `Require Input` during grooming when a material implementation choice or applicable metadata value is still open. Include the proposed fill values in that question. After the user answers, route the ticket back to `Grooming` to finish planning or to `Todo` when the plan is ready for pickup.
- When a ticket is blocked on user input, the canonical path is: status `Require Input` → history comment with one clear question → user answers through the focused response UI → ticket routed back to the next workflow status.
- When a ticket enters the configured ready-for-merge status, the human review path is: ticket moved to `Ready` → user reviews the work → user tells the agent `finish <ticket>` → agent automatically stages all files, creates the commit, updates the implementationLink, and closes the ticket together.
- Do not mark a blocked ticket `Done` while the question is still open.

## End-to-End Checklist

- Ticket was read fully
- Relevant docs were reviewed during grooming or task start-up
- Grooming tickets were turned into a concrete plan before coding started
- Applicable ticket metadata was filled or proposed during grooming
- Implementation-critical choices were clarified with the user before coding when they materially affected the solution
- Plan comment added
- Status moved to `Todo` or `In Progress` at the right time for the ticket state
- Code changed in the smallest owning surface
- Focused validation passed
- Relevant docs were refreshed before `Ready` or `Done` when behavior changed
- Ticket markdown edits were checked for valid frontmatter when `.flux/*.md` files changed
- Ticket-specific user questions went through the configured user-input status, not only chat
- Ready-for-merge tickets were only moved to `Done` after the explicit `finish <ticket>` handoff or equivalent user approval
- Focused commit created for the finished code change, or the reason it was deferred was recorded
- Ticket updated with descriptive completion notes
- Status moved to `Done`

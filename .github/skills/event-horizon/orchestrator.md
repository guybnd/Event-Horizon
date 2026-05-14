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

Frontmatter fields: `id`, `title`, `status`, `priority`, `assignee`, `tags` (string[]), `createdBy`, `updatedBy`, `history` (event list), `effort` (`None`|`XS`|`S`|`M`|`L`|`XL`), `implementationLink`. Markdown body below frontmatter for description.

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

## Working Surfaces

- `.flux/*.md`: tickets — `.flux/config.json`: board config — `.docs/**/*.md`: project docs
- `engine/src/`: Express API — `portal/src/`: React UI
- `.docs/skills/*.md`: editable skill sources — `.flux/skills/*.md`: bootstrap templates

## APIs

- `GET/POST /api/tasks`, `PUT/DELETE /api/tasks/:id` — `GET/PUT /api/config` — `POST /api/bulk-rename`
- Portal: `localhost:5167` — Engine: `localhost:3067`

## User Input Routing

- Chat for broad discussion. Ticket system for ticket-specific decisions.
- `Require Input` → history comment with one clear question + proposed defaults → user answers → route back to next status.
- `Ready` → user reviews → `finish <ticket>` → agent commits + closes atomically.

## Ticket Resolution

- `FLUX-41` → use that ticket. Bare number like `41` or `do 41` → resolve to `FLUX-41`.
- Repo-changing work without a named ticket → find or create a ticket first.
- Pure explanation, brainstorming, or read-only discussion does not require ticket state changes.

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

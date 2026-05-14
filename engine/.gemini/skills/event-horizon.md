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

Version: 2.1.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Grooming Workflow

1. Read the full ticket, including all history.
2. Read `.docs/INDEX.md` to identify relevant docs, then read only those files. Skip docs entirely for XS/S effort tickets.
3. Treat `Grooming` as a planning phase — do not code. Tighten the ticket body into a concrete plan, fill inferable metadata (`priority`, `effort`, `tags`, hierarchy links).
4. If implementation-critical choices are unresolved, move to `Require Input`, post one question with proposed defaults in ticket history, and wait.
5. Once resolved, rewrite the ticket body with:
   - **Problem / Motivation** (1–3 sentences): what problem, who benefits, why prioritised.
   - **Implementation plan**: concrete steps so another agent could pick up without re-discovery.
6. Move to `Todo` when grooming is complete. **CRITICAL: Stop execution after moving to Todo — do not begin implementation.**

## Metadata Conventions

- `priority`: `None` | `Low` | `Medium` | `High` | `Critical`
- `effort`: `None` | `XS` | `S` | `M` | `L` | `XL`
- `tags`: use existing tags from `.flux/config.json`; propose new ones only when clearly distinct
- `assignee`: set if user indicated ownership; leave `unassigned` otherwise

## Editing & Safety

- Preserve YAML validity. Spaces only (no tabs) in frontmatter — tabs can make tickets disappear.
- Keep `updatedBy` accurate. Do not delete history; append only.
- After editing a ticket file, verify it still parses through the system.

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

Version: 2.1.0

## When This Skill Applies

Load this skill when a ticket's status is `Todo` or `In Progress`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Implementation Workflow

1. Read the full ticket, including all history, before touching any file.
2. For M+ effort tickets, check `.docs/INDEX.md` for relevant docs. Read nearby implementation files. Prefer the smallest owning surface.
3. Post a short plan comment before substantial work.
4. Move to `In Progress` before the first substantive code change.
5. Make small, local changes and validate immediately after the first edit.
6. Post progress comments when scope changes, validation fails, or the user redirects.
7. If clarification is needed, move to `Require Input` with a history comment — do not ask only in chat.
8. When moving to `Ready`: add a concise summary comment (what was implemented, validated, any caveats). Keep files uncommitted at this stage.
9. Before `Ready` or `Done`, update `.docs/` when behavior changed.
10. On `finish <ticket>`: stage all relevant files, create the commit, set `implementationLink`, and move to `Done` — all as one atomic step.
11. Add a completion comment (what changed, validated, caveats, commit hash) then move to `Done`.

## Common Project Patterns

- Ticket persistence: engine, not portal. Docs: `.docs/`. Cards: `TaskCard.tsx`. Modal: `TaskModal.tsx`. State: `AppContext.tsx`.
- Installer: `engine/src/workflow-installer.ts` and `engine/src/skill-installer.ts`.

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

Version: 2.1.0

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
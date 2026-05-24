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
3. `PUT /api/tasks/:id` with `appendHistory: [{ type: 'comment', user: 'Agent', comment: '<plan>' }]` before substantial work.
4. `PUT /api/tasks/:id` with `status: 'In Progress'` before the first substantive code change. The engine appends the status_change entry automatically.
5. Make small, local changes and validate immediately after the first edit.
6. `PUT /api/tasks/:id` with `appendHistory` to add progress comments when scope changes, validation fails, or the user redirects.
7. If clarification is needed, `PUT` with `status: 'Require Input'` and an `appendHistory` comment — do not ask only in chat.
8. When moving to `Ready`: `PUT` with `status: 'Ready'` and an `appendHistory` summary comment (what was implemented, validated, any caveats). Keep code files uncommitted at this stage.
9. Before `Ready` or `Done`, update `.docs/` when behavior changed.
10. On `finish <ticket>`: stage all relevant files, create the commit, then `PUT` with `implementationLink` and `status: 'Done'` — all as one atomic step.
11. Include a completion comment in the same `appendHistory` (what changed, validated, caveats, commit hash).

All persistence above goes through the engine API — see the orchestrator skill's "Persisting Changes" section.

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

---
title: Event Horizon Implementation
order: 3
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break implementation behaviour.

## Phase: Todo / In Progress
Scope: Write code, validate logic, format commits, and close tickets during the implementation phase.

---

# Event Horizon Agent — Implementation Skill

Version: 2.0.0

## When This Skill Applies

Load this skill when a ticket's status is `Todo` or `In Progress`.

## Implementation Workflow

1. Read the full ticket, including all history comments, before touching any file.
2. **[HARD GATE] Verify the ticket body contains a concrete implementation plan before writing any code.** If the body still reads as the original vague user description, grooming is incomplete — stop, rewrite the body using the grooming skill steps, move the ticket to `Todo`, then return here. Do not proceed past this step with an ungroomed ticket body.
3. **[HARD GATE] Verify the ticket history contains a `Grooming → Todo` status change before setting `In Progress`.** If that transition is absent, the ticket skipped the grooming checkpoint — treat it as incomplete grooming and stop.
4. Read nearby implementation files before editing. Prefer the smallest owning surface.
5. Post a short plan comment to the ticket before substantial work.
6. Move the ticket to `In Progress` before making the first substantive code change.
7. Make small, local changes and validate immediately after the first substantive edit.
8. Post progress comments when scope changes, validation fails, or the user redirects the work.
9. If clarification is required during implementation, do not ask only in chat. Move the ticket to the configured user-input status (`requireInputStatus` in `.flux/config.json`, default `Require Input`), leave one explicit question in ticket history, and use the focused response flow so the user can answer through the system.
10. When a ticket enters the configured ready-for-merge status (`readyForMergeStatus` in `.flux/config.json`, default `Ready`), treat it as awaiting user review rather than fully closed work. Keep files uncommitted or on a working branch at this stage.
11. Before moving a ticket to `Ready` or `Done`, review whether `.docs/`, `README.md`, or `.docs/skills/*.md` should be updated and refresh the relevant docs when behaviour, workflow expectations, or touchpoints changed.
12. If the user says `finish FLUX-XX` for a ticket in the ready-for-merge status, stage all relevant files and perform the final ticket-close sequence. The commit creation, recording its hash in `implementationLink`, and the status transition to `Done` must happen simultaneously as one atomic step.
13. Add a descriptive completion comment that explains what changed, what was validated, any follow-up caveats, and the commit reference when available. Then move the ticket to `Done`.

## Common Project Patterns

- Ticket persistence is handled by the engine, not directly by the portal.
- Repo-backed docs live under `.docs/` and are the first stop for project-level context.
- Card-level interactions usually live in `portal/src/components/TaskCard.tsx`.
- Full ticket editing lives in `portal/src/components/TaskModal.tsx`.
- URL/view state is coordinated through `portal/src/AppContext.tsx`.
- Installer logic lives in `engine/src/workflow-installer.ts` and `engine/src/skill-installer.ts`.

## Commit Guidance

- Prefer one focused commit per completed ticket or tightly related ticket slice.
- Do not mix unrelated work into the same commit.
- Wait for user confirmation (`finish <ticket>`) before creating a commit. The commit, implementation link population, and transition to Done must happen atomically.
- Use a message that states the shipped behaviour, not just the touched file or a vague verb.
- Prefer messages that would still make sense in a release note or git log skim, for example: `Add ticket effort field editing` or `Implement board and backlog ticket search`.
- Avoid low-information messages like `fix stuff`, `updates`, or `work on ticket`.
- If a ticket is intentionally left uncommitted because the user asked to batch commits later, record that in the completion comment instead of pretending the task is fully wrapped.

## Comment Conventions for Implementation

- Keep comments factual and short.
- Record decisions, validation results, blockers, and follow-up needs.
- When closing work, write a completion comment that summarises the implemented behaviour, the key files or surfaces changed when relevant, the validation performed, and the commit hash if one was created.
- Prefer comments that help the next agent continue without re-discovery.

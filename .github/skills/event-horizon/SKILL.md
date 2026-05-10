# Event Horizon Agent Skill

Version: 1.4.1

## Overview

Event Horizon is a local-first ticket board backed by markdown files in `.flux/`.
Each ticket is a markdown document with YAML frontmatter and a markdown body.
The portal UI and engine API both operate on that file-based source of truth.

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
- `README.md`: repo-level overview and workflow install guidance
- `.flux/skills/*.md`: source workflow asset templates
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

## Agent Workflow

When assigned a ticket, follow this sequence:

1. Read the full ticket, including all history comments and status changes.
2. Read the relevant docs to understand scope and touchpoints before editing. Start with `.docs/`, then `README.md`, then `.flux/skills/*.md` when the task touches workflow behavior or installer output.
3. If the ticket is in `Grooming`, treat that as a planning phase rather than implied implementation. Tighten the ticket body into a concrete plan, capture likely touchpoints and intended validation, review the applicable ticket metadata, and fill anything that is already inferable from the current context. Applicable fields can include `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when they matter for the work.
4. If those implementation-critical choices or applicable metadata values are unresolved, do not silently pick a direction. Move the ticket to the configured user-input status (`requireInputStatus` in `.flux/config.json`, default `Require Input`), leave one explicit question in ticket history, include the proposed fill values or defaults for the missing fields, and wait for the answer to route the ticket back to `Grooming` or `Todo`.
5. Read nearby implementation files before editing. Prefer the smallest owning surface.
6. Post a short plan comment to the ticket before substantial work.
7. Move the ticket to `Todo` when grooming is complete but coding is not starting yet, or to `In Progress` when implementation starts.
8. Make small, local changes and validate immediately after the first substantive edit.
9. Post progress comments when scope changes, validation fails, or the user redirects the work.
10. If clarification is required for the ticket during implementation, do not ask only in chat. Move the ticket to the configured user-input status (`requireInputStatus` in `.flux/config.json`, default `Require Input`), leave one explicit question in ticket history, and use the focused response flow so the user can answer through the system.
11. When a ticket enters the configured ready-for-merge status (`readyForMergeStatus` in `.flux/config.json`, default `Ready`), treat it as awaiting user review and finalization rather than as fully closed work. Maintain files uncommitted or on a working branch at this stage.
12. Before moving a ticket to `Ready` or `Done`, review whether `.docs/`, `README.md`, or `.flux/skills/*.md` should be updated and refresh the relevant docs when behavior, workflow expectations, or touchpoints changed.
13. If the user says `finish FLUX-44` or otherwise asks to finish a ticket that is in the ready-for-merge status, stage all files relevant to the ticket and perform the final ticket-close sequence. The creation of the commit, recording its hash in `implementationLink`, and the status transition to `Done` must happen simultaneously as one atomic step.
14. If the work changes repository files and the user expects commits, wait for the final user confirmation (`finish <ticket>`) before creating a focused commit. The commit should be scoped to the ticket work and use a clear, descriptive message that states the user-visible or system behavior that was shipped.
15. When finished, update the ticket body or summary as needed, add a descriptive completion comment that explains what changed, what was validated, any follow-up caveats, include the commit reference when available, and then move the ticket to `Done`.
16. Re-read fresh user comments before assuming the ticket is complete.

## Release Orchestration

When the user asks to "create a release", "release the current version", or run a release:

1. Determine the version number (e.g. `v1.2.0`). If the user hasn't provided one, ask them for the target version label or propose one based on recent changes and semantic versioning.
2. Provide a brief summary of what's currently in `Done` status and confirm they are ready to be released under this version.
3. Execute the release script via `npm run flux:release <version>` in the `engine` directory or root workspace. This script automatically gathers `Done` tickets, applies the version, generates release notes in the `.docs` system according to Release Settings, and moves the tickets to `Released`.
4. Review the generated release notes in the `.docs` directory and optionally adjust them if they need more narrative context beyond the ticket summaries.
5. Create a git commit to clean up the git status immediately after generating the release files and modifying the tickets. Use a sensible message like "Release <version>".
6. Notify the user that the release was successfully created, the tickets were moved to `Released`, committed, and point them to the generated release notes doc or the Releases view.

## User Input Routing

- Use normal chat for broad discussion, planning, or non-ticket conversation.
- Use the ticket system for ticket-specific clarification, approval, or decisions that should remain attached to the work item.
- Use `Require Input` during grooming when a material implementation choice or applicable metadata value is still open. Include the proposed fill values in that question. After the user answers, route the ticket back to `Grooming` to finish planning or to `Todo` when the plan is ready for pickup.
- When a ticket is blocked on user input, the canonical path is: status `Require Input` (or the configured user-input alias) -> history comment with one clear question -> user answers through the focused response UI -> ticket routed back to the next workflow status.
- When a ticket enters the configured ready-for-merge status, the human review path is: ticket moved to `Ready` (or the configured alias) -> user reviews the work -> user tells the agent `finish <ticket>` -> agent automatically stages all files, creates the commit, updates the implementationLink, and closes the ticket together.
- Do not mark a blocked ticket `Done` while the question is still open.

## Commit Guidance

- Prefer one focused commit per completed ticket or tightly related ticket slice.
- Do not mix unrelated work into the same commit.
- Wait for user confirmation (`finish <ticket>`) before creating a commit. The commit, implementation link population, and transition to Done must happen atomically.
- Use a message that states the shipped behavior, not just the touched file or a vague verb.
- Prefer messages that would still make sense in a release note or git log skim, for example: `Add ticket effort field editing` or `Implement board and backlog ticket search`.
- Avoid low-information messages like `fix stuff`, `updates`, or `work on ticket`.
- If a ticket is intentionally left uncommitted because the user asked to batch commits later, record that in the completion comment instead of pretending the task is fully wrapped.

## Comment Conventions

- Keep comments factual and short.
- Record decisions, validation results, blockers, and follow-up needs.
- Prefer comments that help the next agent continue without re-discovery.
- When asking for input, end with a concrete question and proposed default if one exists.
- When closing work, write a completion comment that summarizes the implemented behavior, the key files or surfaces changed when relevant, the validation performed, and the commit hash if one was created.

## Editing Conventions

- Preserve YAML validity in ticket frontmatter.
- Use spaces, not tabs, in YAML frontmatter. Tab indentation in `history`, lists, or nested fields can make a ticket disappear from the board.
- Keep `updatedBy` accurate for the last actor.
- Do not delete history; append new entries instead.
- Promote durable behavior changes into the nearest project docs instead of leaving the context only in ticket history.
- Prefer root-cause fixes over purely visual patches.
- Validate with the narrowest check available before widening scope.

## Ticket File Safety

- Treat `.flux/*.md` edits as schema-sensitive changes, not casual markdown edits.
- Keep the frontmatter block at the top of the file between the opening and closing `---` markers.
- When adding `history` entries, preserve YAML list indentation exactly with spaces.
- Do not place non-ticket assets under paths that the engine indexes as tasks.
- After editing a ticket file, verify that the ticket still parses through the system. Prefer checking the live task list or API payload over assuming the markdown file is valid.
- If a ticket disappears after editing, suspect malformed frontmatter first.

## Common Project Patterns

- Ticket persistence is handled by the engine, not directly by the portal.
- Repo-backed docs live under `.docs/` and should be the first stop for project-level context.
- Card-level interactions usually live in `portal/src/components/TaskCard.tsx`.
- Full ticket editing lives in `portal/src/components/TaskModal.tsx`.
- URL/view state is coordinated through `portal/src/AppContext.tsx`.

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

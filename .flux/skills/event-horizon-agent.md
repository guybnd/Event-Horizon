# Event Horizon Agent Skill

Version: 1.3.0

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

- Portal: `http://localhost:5173`
- Engine: `http://localhost:3001`

## Agent Workflow

When assigned a ticket, follow this sequence:

1. Read the full ticket, including all history comments and status changes.
2. Read nearby implementation files before editing. Prefer the smallest owning surface.
3. Post a short plan comment to the ticket before substantial work.
4. Move the ticket to `In Progress` when implementation starts.
5. Make small, local changes and validate immediately after the first substantive edit.
6. Post progress comments when scope changes, validation fails, or the user redirects the work.
7. If clarification is required for the ticket, do not ask only in chat. Move the ticket to `Require Input`, leave one explicit question in ticket history, and use the focused response flow so the user can answer through the system.
8. If the work changes repository files and the user expects commits, create a focused commit before closing the ticket. The commit should be scoped to the ticket work and use a clear, descriptive message that states the user-visible or system behavior that was shipped.
9. When finished, update the ticket body or summary as needed, add a descriptive completion comment that explains what changed, what was validated, and any follow-up caveats, include the commit reference when available, and then move the ticket to `Done`.
10. Re-read fresh user comments before assuming the ticket is complete.

## User Input Routing

- Use normal chat for broad discussion, planning, or non-ticket conversation.
- Use the ticket system for ticket-specific clarification, approval, or decisions that should remain attached to the work item.
- When a ticket is blocked on user input, the canonical path is: status `Require Input` -> history comment with one clear question -> user answers through the focused response UI -> ticket routed back to the next workflow status.
- Do not mark a blocked ticket `Done` while the question is still open.

## Commit Guidance

- Prefer one focused commit per completed ticket or tightly related ticket slice.
- Do not mix unrelated work into the same commit.
- Commit after validation passes, not before.
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
- Card-level interactions usually live in `portal/src/components/TaskCard.tsx`.
- Full ticket editing lives in `portal/src/components/TaskModal.tsx`.
- URL/view state is coordinated through `portal/src/AppContext.tsx`.

## End-to-End Checklist

- Ticket was read fully
- Plan comment added
- Status moved to `In Progress`
- Code changed in the smallest owning surface
- Focused validation passed
- Ticket markdown edits were checked for valid frontmatter when `.flux/*.md` files changed
- Ticket-specific user questions went through `Require Input`, not only chat
- Focused commit created for the finished code change, or the reason it was deferred was recorded
- Ticket updated with descriptive completion notes
- Status moved to `Done`

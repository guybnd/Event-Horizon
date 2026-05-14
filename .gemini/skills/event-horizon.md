<skill_module name="event-horizon-orchestrator">
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

Version: 2.0.0

## When This Skill Applies

Load this skill when a ticket's status is `Grooming` or `Require Input`.

## Grooming Workflow

1. Read the full ticket, including all history comments and status changes.
2. Read the relevant docs to understand scope and touchpoints before editing. Start with `.docs/`, then `README.md`, then `.docs/skills/*.md` when the task touches workflow behaviour or installer output.
3. Treat `Grooming` as a planning phase, not implied permission to code. Review the ticket body, capture likely touchpoints and intended validation, review the applicable ticket metadata, and fill anything that is already inferable from the current context.
4. Applicable metadata fields to review and fill: `priority`, `effort`, `tags`, hierarchy links, and related-ticket references when they matter for the work.
5. **Before writing the plan, actively scan for any of these trigger conditions:**
   - **Alternative approaches** — two or more plausible implementation paths with meaningfully different tradeoffs
   - **Scope ambiguity** — the ticket could be interpreted to include or exclude certain work
   - **Acceptance-criteria gap** — unclear what "done" looks like or how the result will be verified
   - **Architectural tradeoff** — the work touches existing patterns in a way that allows multiple valid designs
   - **Unresolved metadata** — `priority`, `effort`, `tags`, or `assignee` not clearly inferable without user input

   If **any** of these conditions are present, do not silently pick a direction. Leave one explicit question in ticket history — stating the tradeoff or ambiguity, listing the options with their implications, and proposing a default — **and in the same API call set `"requireInput": true`** in the `PUT /api/tasks/:id` payload. The engine will atomically transition the ticket to the configured user-input status. After the user answers, return to grooming and then write the plan.

   **[HARD GATE] Never post a question as a history comment without also sending `"requireInput": true` in the same request. A history comment ending in `?` without a concurrent status transition to `Require Input` is a grooming failure. The engine enforces this: a `PUT` that sets status to `Require Input` without a new `comment` entry in `history` is rejected with `REQUIRE_INPUT_MISSING_COMMENT`.**
6. **[MANDATORY] Rewrite the ticket body into a self-contained implementation plan.** The body IS the plan — not a history comment, not a chat message, not a text response to the user. Use `PUT /api/tasks/:id` with a `body` field to update the body via the API. Another agent must be able to pick up this ticket and implement it without any re-discovery. Writing the plan only as a chat message or history comment is a grooming failure.
7. **[HARD GATE] Do not move the ticket to `Todo` until step 6 is complete.** Verify the ticket body has been rewritten before setting `Todo`. A body that still reads as the original user-typed description means grooming is not finished.
8. Move the ticket to `Todo` when grooming is complete and the body has been rewritten. **CRITICAL: Once the ticket is moved to `Todo`, you MUST immediately stop execution and wait for further instructions from the user. Do not transition straight to `In Progress` or begin implementation.**

## Ticket Metadata Conventions

- `priority`: fill based on user impact and urgency — `None`, `Low`, `Medium`, `High`, `Critical`
- `effort`: T-shirt estimate — `None`, `XS`, `S`, `M`, `L`, `XL`
- `tags`: use existing project tags from `.flux/config.json`; propose new ones only when clearly distinct
- `assignee`: set if the user has indicated ownership; leave `unassigned` otherwise
- `subtasks`: use for large tickets that break naturally into tracked sub-items

## Editing Conventions

- Preserve YAML validity in ticket frontmatter.
- Use spaces, not tabs, in YAML frontmatter. Tab indentation in `history`, lists, or nested fields can make a ticket disappear from the board.
- Keep `updatedBy` accurate for the last actor.
- Do not delete history; append new entries instead.
- Promote durable behaviour changes into the nearest project docs instead of leaving context only in ticket history.

## Ticket File Safety

- Treat `.flux/*.md` edits as schema-sensitive changes, not casual markdown edits.
- Keep the frontmatter block at the top of the file between the opening and closing `---` markers.
- When adding `history` entries, preserve YAML list indentation exactly with spaces.
- Do not place non-ticket assets under paths that the engine indexes as tasks.
- After editing a ticket file, verify that the ticket still parses through the system. Prefer checking the live task list or API payload over assuming the markdown file is valid.
- If a ticket disappears after editing, suspect malformed frontmatter first.

## Text Output vs Ticket Body

These are two distinct operations that must not be confused:

- **Text output to the user** — what you write as a chat/response message. This may be visible in the session panel but is NOT saved to the ticket body.
- **Ticket body update** — use `patch-ticket` with `--body "..."` or `--body-file <path>`, or a `PUT /api/tasks/:id` API call with a `body` field. These are the only operations that rewrite the plan into the ticket.

Both must happen during grooming, but they are separate steps. Sending a chat message about the plan does not update the ticket body. Moving the ticket to `Todo` with `patch-ticket --status` does not update the body either — body and status are separate flags and must both be passed explicitly.

## Comment Conventions for Grooming

- Keep comments factual and short.
- When asking for input, end with a concrete question and proposed default if one exists.
- Record decisions, open questions, and rationale for metadata choices.
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
9. If clarification is required during implementation, do not ask only in chat. Leave one explicit question in ticket history and **set `"requireInput": true` in the same `PUT /api/tasks/:id` call** — the engine will atomically transition the ticket to the configured user-input status. Never post a question as a history comment without `"requireInput": true` in the same request. The engine enforces this: a `PUT` that sets status to `Require Input` without a new `comment` entry in `history` is rejected with `REQUIRE_INPUT_MISSING_COMMENT`.
10. **[HARD GATE] When implementation work is complete, you MUST — before ending the session:**
    - Review whether `.docs/`, `README.md`, or `.docs/skills/*.md` should be updated and refresh them when behaviour, workflow expectations, or touchpoints changed.
    - **In a single `patch-ticket` call**, pass both `--status "Ready"` and `--comment "..."` together. The comment must summarise what changed, what was validated, and any follow-up caveats. The engine enforces this: a transition to `Ready` without a concurrent comment is rejected with `READY_MISSING_COMMENT`. An `agent_message` auto-logged from the chat session is NOT a substitute.
    - Example: `npm run patch-ticket -- FLUX-XX --status "Ready" --comment "Implemented X. Validated Y. No follow-up needed."`
    - **Never end a session leaving the ticket at `In Progress`** and never call `--status "Ready"` and `--comment` as two separate commands — the comment must be in the same request as the status transition.
11. While a ticket is in the `Ready` status, treat it as awaiting user review — keep files uncommitted or on a working branch.
12. If the user says `finish FLUX-XX` for a ticket in the ready-for-merge status, stage all relevant files and perform the final ticket-close sequence. The commit creation, recording its hash in `implementationLink`, and the status transition to `Done` must happen simultaneously as one atomic step.
13. Add a descriptive completion comment that explains what changed, what was validated, any follow-up caveats, and the commit reference when available. Then move the ticket to `Done`.

## Ticket Editing — MANDATORY

**Never edit `.flux/*.md` frontmatter (YAML) using direct file-replacement tools.** Doing so frequently breaks YAML formatting and causes tickets to silently vanish from the board.

Use the `patch-ticket` CLI instead. Run from the `engine/` directory:

```
npm run patch-ticket -- <id> --status "In Progress"
npm run patch-ticket -- <id> --comment "your message here"
npm run patch-ticket -- <id> --status "Ready" --comment "implementation complete"
npm run patch-ticket -- <id> --assignee "Agent" --priority "High" --effort "M"
npm run patch-ticket -- <id> --body "## Plan\n\nFull markdown plan here."
npm run patch-ticket -- <id> --body-file /tmp/plan.md
```

Or from the repo root (no `cd` required):

```
npx tsx engine/src/patch-ticket.ts <id> --workspace . --status "In Progress"
```

Use `--body` or `--body-file` to update the ticket body (the markdown plan below the frontmatter). Do not edit the `.flux/*.md` file directly even for body-only changes — use `patch-ticket` so the write is atomic and safe.

The engine watcher will emit a `[FLUX VALIDATION ERROR]` to the terminal if a `.flux/*.md` file has invalid frontmatter — watch for this and use `patch-ticket` to correct it.

## Common Project Patterns

- Ticket persistence is handled by the engine, not directly by the portal.
- Repo-backed docs live under `.docs/` and are the first stop for project-level context.
- Card-level interactions usually live in `portal/src/components/TaskCard.tsx`.
- Full ticket editing lives in `portal/src/components/TaskModal.tsx`.
- URL/view state is coordinated through `portal/src/AppContext.tsx`.
- Installer logic lives in `engine/src/workflow-installer.ts` and `engine/src/skill-installer.ts`.

## Storage Mode Awareness

The engine supports two storage modes. Mode is detected at runtime — never assume in-repo mode.

| Mode | Ticket files location | How to detect |
|------|-----------------------|---------------|
| **In-repo** (default) | `.flux/*.md` | `.flux-store/` worktree does **not** exist |
| **Orphan branch** (opt-in) | `.flux-store/*.md` | `.flux-store/` worktree exists |

Key facts for implementation work:
- `engine/src/workspace.ts` exports `isOrphanMode()` and `getActiveFluxDir()` — use these instead of hardcoding `.flux/` paths when writing engine code that reads or writes ticket files.
- The `patch-ticket` CLI already resolves the active flux dir automatically — no change needed there.
- When editing ticket files directly (body-only writes), target `getActiveFluxDir()`, not `getFluxDir()`.
- `engine/src/storage-sync.ts` owns migration logic (`migrateToOrphan`, `restoreToInRepo`, `attachWorktreeIfPresent`).
- `engine/src/sync-watcher.ts` auto-commits `.flux-store/` changes to the `flux-data` branch with a 30s debounce.
- The Settings UI Storage Mode card lives in `portal/src/components/settings/WorkspaceSection.tsx`.

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
</skill_module>

<skill_module name="event-horizon-release">
---
title: Event Horizon Release
order: 4
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break release orchestration behaviour.

## Phase: Release Orchestration
Scope: Version bumping, changelog generation, and running the release tool.

---

# Event Horizon Agent — Release Skill

Version: 2.0.0

## When This Skill Applies

Load this skill when the user asks to "create a release", "release the current version", or run a release.

## Release Workflow

1. Determine the version number (e.g. `v1.2.0`). If the user hasn't provided one, ask them for the target version label or propose one based on recent changes and semantic versioning.
2. Provide a brief summary of what's currently in `Done` status and confirm they are ready to be released under this version.
3. Execute the release script via `npm run flux:release <version>` in the `engine` directory or root workspace. This script automatically gathers `Done` tickets, applies the version, generates release notes in the `.docs` system according to Release Settings, and moves the tickets to `Released`.
4. **[MANDATORY] Rewrite the generated release notes** in `.docs/release-notes/<version>.md` with clean, public-friendly titles grouped by category (e.g. Performance, Bug Fixes, UI & UX, Developer Experience). Raw ticket titles from the internal board are not suitable for public release notes — rewrite every entry to be descriptive and user-facing before committing.
5. Create a git commit to clean up the git status immediately after generating the release files and modifying the tickets. Use a sensible message like `Release <version>`.
6. **[MANDATORY] Confirm with the user before pushing** — pushing the tag is irreversible and will trigger a public CI build and GitHub Release. Show the user what will be pushed and wait for explicit approval.
7. Push the commit and tag to trigger the GitHub Actions release pipeline:
   - `git push origin master` (or current branch) to push the release commit
   - `git tag <version> && git push origin <version>` to trigger the `.github/workflows/release.yml` workflow
   - The workflow will build the macOS and Windows executables and publish a GitHub Release with the artifacts automatically.
8. Once the Actions run completes, apply the custom release notes to the GitHub Release: `gh release edit <version> --notes-file .docs/release-notes/<version>.md`
9. Notify the user that the release was created, tickets moved to `Released`, tag pushed, GitHub Actions triggered to build and publish artifacts, and point them to the Actions run and the GitHub Releases page.
</skill_module>
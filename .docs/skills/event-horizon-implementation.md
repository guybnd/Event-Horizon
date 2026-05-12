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
10. When a ticket enters the configured ready-for-merge status (`readyForMergeStatus` in `.flux/config.json`, default `Ready`), treat it as awaiting user review rather than fully closed work. Keep files uncommitted or on a working branch at this stage.
11. Before moving a ticket to `Ready` or `Done`, review whether `.docs/`, `README.md`, or `.docs/skills/*.md` should be updated and refresh the relevant docs when behaviour, workflow expectations, or touchpoints changed.
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

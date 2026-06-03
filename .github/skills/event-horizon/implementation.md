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

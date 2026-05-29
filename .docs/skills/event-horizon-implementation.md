---
title: Event Horizon Implementation
order: 3
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break implementation behaviour.

## Phase: Todo / In Progress
Scope: Write code, validate logic, format commits, and close tickets during the implementation phase.

---

# Event Horizon Agent — Implementation Skill

Version: 2.2.0

## When This Skill Applies

Load this skill when a ticket's status is `Todo` or `In Progress`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Implementation Workflow

1. Use `get_ticket` to read the full ticket, including all history, before touching any file.
2. For M+ effort tickets, check `.docs/INDEX.md` for relevant docs. Read nearby implementation files. Prefer the smallest owning surface.
3. Use `add_comment` to post your implementation plan before substantial work.
4. Use `change_status` with `newStatus: 'In Progress'` before the first substantive code change.
5. Make small, local changes and validate immediately after the first edit.
6. Use `log_progress` to record progress when scope changes, validation fails, or the user redirects.
7. If clarification is needed, use `change_status` with `newStatus: 'Require Input'` and a `comment` — do not ask only in chat.
8. When moving to `Ready`: use `change_status` with `newStatus: 'Ready'` and a `comment` summarizing what was implemented, validated, and any caveats. Keep code files uncommitted at this stage.
9. Before `Ready` or `Done`, update `.docs/` when behavior changed.
10. On `finish <ticket>`: stage all relevant files, create the commit, then use `finish_ticket` with `implementationLink` (commit hash or PR URL) and `completionComment` — this moves status to Done atomically.

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

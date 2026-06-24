---
title: Event Horizon Implementation
order: 3
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break implementation behaviour.

## Phase: Todo / In Progress
Scope: Write code, validate logic, format commits, and close tickets during the implementation phase.

---

# Event Horizon Agent — Implementation Skill

Version: 2.6.0

## When This Skill Applies

Load this skill when a ticket's status is `Todo` or `In Progress`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Commit-Before-Ready — CRITICAL (FLUX-730)

**If the ticket has a branch or worktree, you MUST `git commit` your work BEFORE moving it to `Ready`.** Moving to `Ready` is what opens the PR for review, and a branch with **no commits ahead of base cannot open a PR** — so reaching `Ready` uncommitted means the work sits silently in the worktree and no review ever happens (the FLUX-716/717/719 incident).

- **The engine now ENFORCES this for worktree branches.** `change_status → Ready` is **refused** (status unchanged, an error returned) when a worktree branch has 0 commits ahead of base. You will *not* reach `Ready`; you'll get an error telling you to commit and retry. Don't fight it — commit, then retry the move.
- Do **not** confuse this with the branchless flow below. **Branch/worktree ticket → commit, THEN `Ready`.** Branchless ticket → stay uncommitted until `finish`. These are opposite; never apply the branchless "don't commit yet" habit to a branch/worktree ticket.
- One focused commit with a real message ("Add X", not "wip"). The engine pushes it for you when you move to `Ready`; `finish` then merges the resulting PR.

## End-of-Turn Action Contract — CRITICAL (FLUX-651)

**When you finish working a ticket, you MUST end the turn on a board action — never finish the work and just summarize it in chat.** This holds in a chat/discussion session exactly as much as in a phase launch: "this is only a discussion turn" is **not** a license to sit on completed work.

- Implementation complete and validated → `change_status` to `Ready` (with a completion summary). If blocked on a decision → `change_status` to `Require Input` with the question + a proposed default.
- Cannot decide whether to proceed → that *is* a `Require Input`. Raise it; do not leave the decision only in your final chat message.

If you leave the ticket parked in a working status (`Grooming` / `In Progress`) without an action, the engine flags it **"Needs Action"** on the board and notifies the user (the backstop exists precisely because narrating-and-stopping was a recurring defect). Do not rely on the backstop — take the action yourself.

## Implementation Workflow

1. Use `get_ticket` to read the full ticket, including all history, before touching any file.
2. **Check for a branch.** Call `get_branch` on the ticket. If `branch` is set, run `git fetch origin <branch>` then `git checkout <branch>` before making any changes (the branch is created remotely via the portal and may not exist locally yet). If no branch is set, proceed on the current branch (the user chose "start normally" at task start). **Exception — dedicated worktree:** if your working directory is already inside `.eh-worktrees/` (an Event Horizon task worktree), you are ALREADY checked out on the ticket branch in an isolated tree — do **not** `git checkout` (it's unnecessary, and you must never switch the worktree's branch). Just work in place — and remember you **MUST `git commit` in the worktree before `Ready`** (the engine refuses the `Ready` move otherwise — see "Commit-Before-Ready" above).
3. For M+ effort tickets, check `.docs/INDEX.md` for relevant docs. Read nearby implementation files. Prefer the smallest owning surface.
4. Use `add_comment` to post your implementation plan before substantial work.
5. Use `change_status` with `newStatus: 'In Progress'` before the first substantive code change.
6. Make small, local changes and validate immediately after the first edit.
7. Use `log_progress` to record progress when scope changes, validation fails, or the user redirects.
8. If clarification is needed, use `change_status` with `newStatus: 'Require Input'` and a `comment` — do not ask only in chat.
9. When moving to `Ready`: use `change_status` with `newStatus: 'Ready'` and a `comment` summarizing what was implemented, validated, and any caveats.
   - **Branch / worktree tickets (PR flow):** **commit your work BEFORE moving to `Ready`** — see "Commit-Before-Ready" above. For a worktree branch the engine **refuses** the `Ready` move with 0 commits ahead (status unchanged); commit, then retry. Moving to `Ready` then opens the PR for review.
   - **Branchless tickets (direct flow):** keep code files uncommitted at this stage; the commit happens at `finish`.
10. **Before `Ready` or `Done`, update `.docs/` so the docs match the new behavior.** This is part of the ticket, not a follow-up. Check first:
    - `.docs/event-horizon/reference/*` — if you changed ticket schema, MCP tools, REST endpoints, realtime channels, or the agent-adapter contract, the matching reference page MUST be updated.
    - `.docs/event-horizon/architecture/code-map.md` — add an entry when a new module becomes the right "land here first" file for future agents.
    - `.docs/event-horizon/agent-integrations.md`, `workflow/*.md`, root `README.md`, and `.flux/skills/` templates when user-facing or agent-facing behavior changes.
    - If nothing needs updating, say so explicitly in the completion comment ("no docs needed because …") instead of skipping the check silently.
11. On `finish <ticket>`:
    - **Branchless tickets:** stage all relevant files (code + docs), create the commit, then use `finish_ticket` with `implementationLink` (commit hash) and `completionComment`. Status moves to Done atomically.
    - **Branch / worktree tickets:** the implementation commit already exists (made before `Ready`) and a PR is open. `finish_ticket` merges the PR and advances to Done — the PR URL is the `implementationLink`. If you made further changes (e.g. docs) after `Ready`, commit + `git push origin <branch>` first so the PR updates, then `finish_ticket`.
    The completion comment should name the docs you updated, or state why none were needed.
12. **Never end a session with a blocking decision only in your final chat message.** If you cannot safely finish (e.g. the branch bundles other tickets' work / an integration PR, or the merge is an irreversible one-way door you're unsure about), move the ticket to **Require Input** with the decision + options and stop — a question left only in your final message is invisible on the board and will be missed (FLUX-570).
13. **Shared-PR finish guard (FLUX-569).** `finish_ticket` **refuses** to finish a member ticket whose branch is shared by **non-Done sibling tickets** — merging would advance them all to Done as a one-way door (the FLUX-556/PR#6 incident). When you hit this: either finish/close the siblings first, merge the whole branch via the **PR ticket's** Merge action, or — only if you genuinely intend to land the entire shared PR — re-run with `force: true`. Don't reflexively force; if it's a real decision, route it through Require Input (per #12). PR tickets (`kind:'pr'`) are exempt — merging one to advance its members is the sanctioned shared-merge surface.

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
- **Branchless tickets:** wait for `finish <ticket>` before committing (commit + implementationLink + Done = atomic).
- **Branch / worktree tickets:** commit BEFORE moving to `Ready` — the PR opens at `Ready` and needs commits to exist. `finish` then merges that PR.
- Good: `Add ticket effort field editing`. Bad: `fix stuff`, `updates`.

## Comment Conventions

- Keep comments factual and short. Completion comments: behavior, key files, validation, commit hash.
- Prefer comments that help the next agent continue without re-discovery.
- **Substantial comments: add a faithful `summary`.** When `add_comment` / `log_progress` carries a long or verbose note, pass a `summary` — capture the decision, the why, and anything a future agent must act on. As concise as it can be WITHOUT losing substance; length scales with importance — do **not** force one line. Skip it for short, already-dense notes. Once the note ages past the recent window the agent digest shows the summary in place of the full text (the full text stays fetchable via `get_ticket` with `expand: ["<id>"]`). A too-short summary makes the next agent expand everything — err toward robust.
- **Pin critical entries:** set `pin: true` on review handoffs and key decisions so they are NEVER collapsed in the digest.

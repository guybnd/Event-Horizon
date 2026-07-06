---
title: Event Horizon Implementation
order: 3
---
> ⚠️ DO NOT DELETE — This file is required for the Event Horizon agent workflow. Deleting it will break implementation behaviour.

## Phase: Todo / In Progress
Scope: Write code, validate logic, format commits, and close tickets during the implementation phase.

---

# Event Horizon Agent — Implementation Skill

Version: 2.13.0

## When This Skill Applies

Load this skill when a ticket's status is `Todo` or `In Progress`.
Refer to the orchestrator skill for the ticket model, APIs, and end-to-end checklist.

## Commit-Before-Ready — CRITICAL (FLUX-730)

**If the ticket has a branch or worktree, you MUST `git commit` your work BEFORE moving it to `Ready`.** Moving to `Ready` is what opens the PR for review, and a branch with **no commits ahead of base cannot open a PR** — so reaching `Ready` uncommitted means the work sits silently in the worktree and no review ever happens (the FLUX-716/717/719 incident).

- **The engine now ENFORCES this for worktree branches.** `change_status → Ready` is **refused** (status unchanged, an error returned) when a worktree branch has 0 commits ahead of base. You will *not* reach `Ready`; you'll get an error telling you to commit and retry. Don't fight it — commit, then retry the move.
- Do **not** confuse this with the branchless flow below. **Branch/worktree ticket → commit, THEN `Ready`.** Branchless ticket → stay uncommitted until `finish`. These are opposite; never apply the branchless "don't commit yet" habit to a branch/worktree ticket.
- One focused commit with a real message ("Add X", not "wip"). The engine pushes it for you when you move to `Ready`; `finish` then merges the resulting PR.

## End-of-Turn Action Contract (FLUX-651/826)

Full contract lives in the orchestrator skill's "End-of-Turn Action Contract" section — read it there. For implementation specifically: complete and validated → `change_status` to `Ready` with a completion summary; blocked on a decision → `change_status` to `Require Input` with the question + a proposed default. "Cannot decide whether to proceed" is itself a `Require Input` — raise it, don't leave it only in your final chat message. This applies just as much on a ticket that's already **Done / Ready / Todo / Backlog / Released / Archived** (a PR follow-up, a backfill, a "should I commit this / file a ticket / leave it?" call) — raise it via `ask_user_question`, not chat prose.

## Implementation Workflow

1. Use `get_ticket` to read the full ticket, including all history, before touching any file. If the body carries a `## ⚠️ Reground before starting` section, **execute it before any code change** — see "Reground Before Coding" below.
2. **Check for a branch.** Call `branch` with `action: 'status'` on the ticket. If `branch` is set, run `git fetch origin <branch>` then `git checkout <branch>` before making any changes (the branch is created remotely via the portal and may not exist locally yet). If no branch is set, proceed on the current branch (the user chose "start normally" at task start). **Exception — dedicated worktree:** if your working directory is already inside `.eh-worktrees/` (an Event Horizon task worktree), you are ALREADY checked out on the ticket branch in an isolated tree — do **not** `git checkout` (it's unnecessary, and you must never switch the worktree's branch). Just work in place — and remember you **MUST `git commit` in the worktree before `Ready`** (the engine refuses the `Ready` move otherwise — see "Commit-Before-Ready" above).
3. For M+ effort tickets, check `.docs/INDEX.md` for relevant docs. Read nearby implementation files. Prefer the smallest owning surface.
4. Use `add_note` (`type: 'comment'`) to post your implementation plan before substantial work.
5. Use `change_status` with `newStatus: 'In Progress'` before the first substantive code change.
6. Make small, local changes and validate immediately after the first edit.
7. Use `add_note` (`type: 'activity'`) to record progress when scope changes, validation fails, or the user redirects.
8. If clarification is needed, use `change_status` with `newStatus: 'Require Input'` and a `comment` — do not ask only in chat.
9. When moving to `Ready`: use `change_status` with `newStatus: 'Ready'` and a `comment` summarizing what was implemented, validated, and any caveats.
   - **Branch / worktree tickets (PR flow):** **commit your work BEFORE moving to `Ready`** — see "Commit-Before-Ready" above. For a worktree branch the engine **refuses** the `Ready` move with 0 commits ahead (status unchanged); commit, then retry. Moving to `Ready` then opens the PR for review.
   - **Branchless tickets (direct flow):** keep code files uncommitted at this stage; the commit happens at `finish`.
   - **Visual Recap (judgment call, FLUX-976):** for a UI/UX or structurally interesting change, consider publishing a visual recap of the diff *before* the `Ready` move so the reviewer scans "what changed" instead of only the raw PR diff — see "Visual Recap Artifact" below. Skip it for bug fixes, XS/S effort, and trivial diffs.
   - **Structured completion payload (judgment call, FLUX-1147):** for a non-trivial change, also pass a `completion` object to `change_status` alongside the `comment` — `changedFiles` (repo-relative paths), `validation` (the commands you ran + whether each passed), `decisions` (non-obvious calls worth flagging), `residualRisk`, `docsUpdated` — so the reviewer/next agent/Furnace read fields instead of re-parsing your prose. It's persisted on the comment entry, not frontmatter, and is purely additive (never required). Skip it for the same bar as Visual Recap: bug fixes, XS/S effort, trivial diffs.
10. **Before `Ready` or `Done`, update `.docs/` so the docs match the new behavior.** This is part of the ticket, not a follow-up. Check first:
    - `.docs/event-horizon/reference/*` — if you changed ticket schema, MCP tools, REST endpoints, realtime channels, or the agent-adapter contract, the matching reference page MUST be updated.
    - `.docs/event-horizon/architecture/code-map.md` — add an entry when a new module becomes the right "land here first" file for future agents.
    - `.docs/event-horizon/agent-integrations.md`, `workflow/*.md`, root `README.md`, and `.flux/skills/` templates when user-facing or agent-facing behavior changes.
    - If nothing needs updating, say so explicitly in the completion comment ("no docs needed because …") instead of skipping the check silently.
11. On `finish <ticket>`:
    - **Branchless tickets:** stage all relevant files (code + docs), create the commit, then use `finish_ticket` with `implementationLink` (commit hash) and `completionComment`. Status moves to Done atomically. If you skipped the `completion` payload at `Ready` (or the ticket has no `Ready` step at all), `finish_ticket` accepts the same `completion` param — same judgment call as step 9.
    - **Branch / worktree tickets:** the implementation commit already exists (made before `Ready`) and a PR is open. `finish_ticket` merges the PR and advances to Done — the PR URL is the `implementationLink`. If you made further changes (e.g. docs) after `Ready`, commit + `git push origin <branch>` first so the PR updates, then `finish_ticket`.
    The completion comment should name the docs you updated, or state why none were needed.
12. **Never end a session with a blocking decision only in your final chat message — on any status.** If you cannot safely finish (e.g. the branch bundles other tickets' work / an integration PR, or the merge is an irreversible one-way door you're unsure about), move the ticket to **Require Input** with the decision + options and stop — a question left only in your final message is invisible on the board and will be missed (FLUX-570). This applies just as much when the ticket is already **Done/Ready/closed**: route the decision through `ask_user_question` (the status-independent picker), not chat prose, so it's caught even if the user isn't watching the live chat (FLUX-826).
13. **Shared-PR finish guard (FLUX-569).** `finish_ticket` **refuses** to finish a member ticket whose branch is shared by **non-Done sibling tickets** — merging would advance them all to Done as a one-way door (the FLUX-556/PR#6 incident). When you hit this: either finish/close the siblings first, merge the whole branch via the **PR ticket's** Merge action, or — only if you genuinely intend to land the entire shared PR — re-run with `force: true`. Don't reflexively force; if it's a real decision, route it through Require Input (per #12). PR tickets (`kind:'pr'`) are exempt — merging one to advance its members is the sanctioned shared-merge surface.

**Body convention (FLUX-953):** whenever you rewrite or extend a ticket `body`, keep a plain-language **TL;DR** blockquote as its first line — add one if it's missing, refresh it if the gist changed. The user reads that TL;DR instead of the whole body (see the orchestrator skill's "Body convention").

## Reground Before Coding — tickets with a "⚠️ Reground before starting" section (FLUX-1048)

Tickets filed from a **point-in-time codebase analysis** (tech-debt sweeps, refactor epics, audit/churn findings) carry a `## ⚠️ Reground before starting` body section — the grooming skill's convention. That section is a **work instruction to you, the implementer**, not background prose: the plan was written against a snapshot of the code, and by pickup time the evidence has often drifted. Before the first substantive code change:

1. **Treat every cited file:line as historical.** Re-derive the evidence via Serena/grep against current code — the section's snapshot date tells you how stale it may be. Never edit at a recorded line number without re-verifying it.
2. **Check for partial fixes already landed.** Check `<releaseNotesPath>/INDEX.md` (default `.docs/release-notes/INDEX.md`) first — the agent-consumable index of every released ticket with a one-line completion gist (FLUX-1151), cheaper than scanning release-note files line by line. It only covers already-*released* work, so also scan sibling tickets and recently Done/Released tickets — another ticket may have absorbed part (or all) of the work.
3. **Update the plan first, then code.** Rewrite the body against current reality via `update_ticket` (keep the TL;DR honest) and note what you re-verified in your plan comment (workflow step 4).
4. **If the finding no longer exists, do not implement the stale plan.** Re-scope the ticket, or propose archiving — route that decision through `Require Input` (or `ask_user_question` on a resting ticket), per the End-of-Turn Action Contract.

Skipping the reground because "the plan still looks plausible" is exactly the failure mode this section exists to prevent — plausible-but-stale plans implement cleanly and land wrong.

## Visual Recap Artifact (`publish_artifact`) — the exception, not the norm

The grooming skill publishes a plan-time **"before"** artifact (a mockup/diagram the user reasons against before code is written). This is the **"after"** half: at `Ready`, publish a **visual recap** of the diff so the reviewer reviews a scannable rendering of *what changed* instead of only the raw PR diff — inspired by Builder.io's agent-native `/visual-recap`. Shared mechanics (sandbox rules, CDN policy, revisions, annotation round-trip, layout-audit gate, richer artifact kinds) live in the orchestrator skill's "Rich Artifacts" section — read it there before your first emit.

Not required for every `Ready` move — keep it the exception, not ceremony. Default OFF when unsure.

- **Emit when** the change is UI/UX, touches a data model / API shape, or is otherwise structurally interesting — anything where a rendered "what changed" surface helps the reviewer more than the raw diff.
- **Skip when** it's a bug fix, an XS/S-effort ticket, or a trivial diff with no shape worth visualizing. A plain completion comment is the right output for these.

**How to emit** (do this *before* `change_status → Ready`, so the recap is present when the PR opens):
1. Build the diff against base — `git diff <baselineCommit>...HEAD` (branch/worktree tickets) or `git diff` on the uncommitted working tree (branchless). Pull out the touched-file list and the key hunks (the ones a reviewer actually needs — not the full raw patch).
2. Author a **complete, self-contained HTML document** as `html`: a touched-file tree, styled key diff hunks (not the entire patch), and a short plain-language summary of what changed and why. Lean on the **`frontend-design`** skill for the rendering.
3. Call `publish_artifact` with a `title` and a `note` that both include the word **"recap"** — this is what tags the revision as an implementation recap (distinct from grooming revisions in history) and is what the portal reads to label the panel **"Visual Recap"** instead of "Artifact".
4. Then proceed with the `Ready` move as normal.

## Branch Rules

- **Stay on your branch.** Once on a ticket branch, never run `git checkout` to another branch without explicit user confirmation in chat. If a switch is genuinely needed, stop and ask first.
- **Branch creation is not your decision.** The user chose whether to create a branch when starting the ticket from the portal. Do not create one unless `branch` (`action: 'status'`) returns no branch and the user explicitly asks.
- **Returning from Ready.** If the ticket is moved back to `In Progress` after review, re-read the most recent comment first. Check out the existing branch (still in the `branch` field), apply changes, commit, then run `git push origin <branch>` explicitly before calling `finish_ticket`. The open PR updates automatically from the push.
- **XS tickets.** Branch creation is optional and often skipped for XS effort tickets.

## Reviewer Agent Handoff

When a reviewer sends a ticket back to `In Progress`, read that structured comment before making any changes — it explains what needs fixing. For the reviewer's side of this handoff (the reviewState contract, severity taxonomy, diff scoping, and the acceptance-criteria checklist convention from FLUX-1148), see the review skill.

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
- **Substantial comments: add a faithful `summary`.** When an `add_note` comment/activity carries a long or verbose note, pass a `summary` — capture the decision, the why, and anything a future agent must act on. As concise as it can be WITHOUT losing substance; length scales with importance — do **not** force one line. Skip it for short, already-dense notes. Once the note ages past the recent window the agent digest shows the summary in place of the full text (the full text stays fetchable via `get_ticket` with `expand: ["<id>"]`). A too-short summary makes the next agent expand everything — err toward robust.
- **Pin critical entries:** set `pin: true` on review handoffs and key decisions so they are NEVER collapsed in the digest.
- **Supersede dead decisions:** when a note reverses or replaces an earlier decision in *this* ticket (e.g. "abandoned approach A, going with B"), pass `supersedes: ["<id>"]` on `add_note` pointing at the now-dead entry — don't just append and leave the stale one to confuse the next session. The superseded entry then collapses to a one-line marker in the agent digest (still recoverable via `expand`), so a later agent reads the *live* decision, not the abandoned plan. Do **NOT** supersede a still-valid entry; superseding a `pin: true` or user-authored entry is **advisory-only** — the engine keeps it full (it will not bury human intent on an agent's say-so).

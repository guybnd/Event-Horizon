---
title: Event Horizon Tools
order: 7
delivery: [pull-only, modular]
deliveryNote: "🚚 pull-only everywhere — reached only via read_skill('tools', '<tool-name>') (any framework, Claude included) or as an on-demand file for copilot/cline. Never injected, never concatenated — not paid by any always-on prelude (the FLUX-1468 diet this module exists for)."
---
> ⚠️ DO NOT DELETE — Required for on-demand MCP tool guidance.

## Pullable, not installed

This module is **not** part of any phase's injected prelude. Each MCP tool's schema `description` carries only the behavioral contract (what's required, what's refused, what shapes are accepted); anything else — rationale, edge cases, FLUX history, cross-tool disambiguation — lives here, one `##` section per registered tool name. Pull a section on demand with `read_skill('tools', '<tool-name>')` when a slimmed description says "Full lore: read_skill(...)" or you're unsure how to call something correctly. Section headings below are the exact registered tool names (case-insensitive match, exact-then-substring) — this is a wire contract; don't rename a heading without updating every pointer sentence that names it.

## get_ticket

Returns frontmatter, body, and a digested history: `agent_session` entries collapse to one-line summaries, older entries beyond the recent window collapse further to a summary + id. Pass `expand:[ids]` to un-collapse specific entries by the `id` shown on a collapsed one — prefer this over `fullHistory:true`, which defeats the digest and re-inflates context for the whole ticket. A very large body is truncated with a recoverable size hint by default (`fullBody:true` overrides).

## get_session_log

Investigate what a specific prior agent session actually did, beyond the summary `get_ticket` already returns (`sessionId` + `progressCount` per session entry). Rarely needed — reach for it only when the digest isn't enough.

## read_skill

Serves a skill module's full text, or one `##` section, live from the engine's skill root — this is how a cross-module pointer resolves in a **user repo**, where the module files don't exist as installed assets (only the engine install carries them). Unknown module or an unreadable file returns a fallback string, never throws. A requested `section` with no match returns the full body plus the list of available `##` headings so the caller can retry.

## list_tickets

Active-by-default and bounded (a deliberate FLUX-489 guardrail): with no explicit `status`, only non-terminal tickets are returned (Done/Released/Archived excluded) and results cap at 40 rows. This is NOT a silent truncation — a bounded or empty result carries a `note` disclosing what was hidden and that `includeAll:true` would reveal it. An explicit `status` bypasses the active screen entirely (so you CAN list Done/Released/Archived by naming the status directly).

## get_board_config

Agent-facing projection of board config — Tailwind color classes are stripped (agents never render them) since this re-bills every session an orchestrator reads it.

## get_project_group

Reports `membership` (role: parent vs member, group name, parent root) only when the current workspace is actually bound into a multi-repo group; otherwise returns a clear "no group configured" notice rather than an empty/ambiguous payload.

## create_ticket

`parentId` links the new ticket into the parent's `subtasks` array atomically (through the parent's per-ticket write lock) — a concurrent `add_note`/`change_status`/another `create_ticket` on the same parent can't interleave and drop history/subtasks.

## extract_ticket

The promotion gate: carve a `fromSeq..toSeq` slice of a conversation stream (default `__board__`, the orchestrator thread) into a brand-new ticket. Source turns are never moved or copied — the new card re-derives the slice on read. The one exception: promoting a `kind:"scratch"` stream **consumes** it (archives the source) so no live duplicate remains. Human-approved only — surfaced via the board-rebase `promote` proposal, never auto-applied.

## merge_tickets

The inverse of extract: fold several tickets/streams into ONE survivor. The survivor re-derives as the chronological union of its own turns plus every source's turns — additive, not destructive. Each source is tombstoned and archived (never deleted), so the fold is reversible in spirit. Human-approved only — surfaced via the board-rebase `fold` proposal.

## update_ticket

Metadata only — never touches status (`change_status` is the only status-changing tool, by design, so status transitions always go through the comment-gate/swimlane/session-pause machinery). `parentId` (re)links this ticket under a parent: a string (re)parents and keeps both the old and new parent's `subtasks` arrays in sync; `null` detaches entirely; omitting the field leaves the parent link untouched. Self-parenting and cycles are rejected before any write.

## change_status

The ONLY tool that changes status — `update_ticket` deliberately never does, so every status transition goes through this tool's comment-gate and scatter-gather guard. A comment is REQUIRED moving to Require Input (the question) or Ready (the completion summary) unless config waives it. `callerRole` (e.g. `"orchestrator"`) is required to change status while parallel scatter-gather step sessions are active on the ticket — a lone step session can't unilaterally move status out from under the others.

- `reviewState` / `planReviewState` are parallel review-verdict fields: `reviewState` is the post-Todo code-review gate (Ready ⇄ In Progress), `planReviewState` is the Grooming → Todo plan gate (set while `newStatus` stays `"Grooming"`) — they never overload each other. Both are distinct from the GitHub-synced `reviewDecision`. `null` clears either.
- `completion` is a courtesy field (`z.unknown()` at the schema layer — never a gate): `{ changedFiles?, validation?: {command,passed}[], decisions?, residualRisk?, docsUpdated? }`, attached to the comment history entry (not frontmatter) alongside the required prose comment, for reviewers/Furnace/the next implementer/the portal to read as fields instead of re-parsing prose. Malformed or oversized input is silently dropped/truncated by `sanitizeCompletion`, never rejected — a garbage payload can never block the status move.
- `noDiffExpected` lifts the FLUX-730 commit-before-Ready refusal for a worktree branch with 0 commits ahead of base (and skips opening a PR, since there's nothing to merge) — but ONLY when the ticket's scope genuinely produced no diff (a verification/investigation/spike that confirmed nothing needed to change). It is still refused if the worktree has uncommitted changes sitting in it (that would contradict the zero-diff claim). Do not set this to route around forgotten/uncommitted work.

## start_plan_review

The plan gate's explicit human-invoked entry point — use under the "you" gate value, or any time before moving Grooming to Todo. A deterministic plan lint runs first (free, no LLM session spawned) and bounces on mechanical defects before a real review pass is ever started. Runs exactly one pass and records the verdict to `planReviewState`; it deliberately does not move the ticket itself.

## archive

"archive" is the reversible alternative to deletion — there is no hard-delete tool in Event Horizon; history is fully preserved and the ticket can always come back via "unarchive" (default target status Todo, or an explicit `toStatus`). Archiving clears any active swimlane and reaps stale parked sessions on the ticket so it doesn't linger with a stale blocked flag or zombie session.

## swimlane

A swimlane is orthogonal to status — the ticket stays in its status column but is visually flagged. "set" needs a known swimlane id (rejects unknown ids with the available list) and a comment when the swimlane definition has `commentRequired` (e.g. `"require-input"`, which also pauses any active session on the ticket). "clear" removes whatever is active; clearing `"require-input"` also dismisses its notifications.

## add_note

`type:"comment"` is human-facing (author defaults to Agent, but any freeform `user` claim is marked self-attested — FLUX-1271 — so it can never satisfy the merge-lock's human-touch check no matter what name is passed); `type:"activity"` is always attributed to Agent. `summary`, `pin`, and `supersedes` apply to both kinds: write a `summary` for a long/substantial note so the agent digest shows it instead of the full text once the note ages out (full text stays fetchable via `get_ticket`'s `expand`); `pin` keeps a note permanently un-collapsed (review handoffs, key decisions); `supersedes` retires an earlier now-wrong entry (it collapses to a one-line marker, still recoverable via `expand`) — use it ONLY when genuinely reversing a decision, since a pinned or user-authored target is advisory-only and the engine keeps it full regardless.

## publish_artifact

A concrete rendering instead of prose, for plan-time mockups or Ready-time diff recaps. Every call adds a new revision — publishing never overwrites a prior one. The HTML must be fully self-contained (inline CSS/JS; Mermaid via a CDN script tag is allowed for diagrams; the Tailwind Play CDN is allowed but is a heavy last resort, not the default) because it renders inside a sandboxed opaque-origin iframe that cannot reach the portal, cookies, or storage, and cannot make network requests at all (`connect-src` is blocked) — everything the artifact needs must be inlined or loaded from an allowed CDN. Emit for UI/architecture work; skip it for bug fixes, XS/S-effort tickets, and backend plumbing with no visual shape to show.

**Guided-annotation controls (FLUX-1440):** the viewer upgrades specific markup into interactive controls that auto-stage annotations the user sends back:
- `<div data-eh-feel data-eh-label data-eh-min data-eh-max data-eh-default data-eh-unit>` becomes a live slider.
- `<div data-eh-decision data-eh-question>` with child `<button data-eh-opt>Option</button>` elements becomes a choice card. Options MUST be `data-eh-opt` children — a `data-eh-decision` host with no `data-eh-opt` children is skipped entirely.
- Never hand-render your own chips/sliders mimicking this look — only the engine-injected controls actually stage anything; a lookalike you build yourself is inert.

## finish_ticket

Atomically sets `implementationLink`, adds the completion comment, and moves status to Done — the merge path. Refused if the ticket isn't in the ready-for-merge status yet, or if it's a `kind:"scratch"` ticket (promote it first via `extract_ticket`).

**Shared-PR guard (FLUX-569):** finishing one member of a branch SHARED by other non-Done sibling tickets would merge the whole PR and advance every bundled sibling to Done as a one-way door — refused unless `force:true` (or the branch's dedicated `kind:'pr'` ticket does the finishing, which is the sanctioned shared-merge surface). Don't reach for `force` reflexively; if it's a real decision, raise it via Require Input instead.

**Merge-lock (FLUX-1264):** this is the one merge path an agent session can reach on its own initiative, so it runs a defense-in-depth check (on top of the schema-level guarantee that `merge` isn't a configurable gate value) requiring proof a human touched this ticket. A self-attested `add_note` comment `user` claim can never satisfy it (FLUX-1271).

## branch

"create" opens a feature branch, and — unless `worktree:false` — a dedicated worktree (agent branch sessions are worktree-isolated by DEFAULT so parallel ticket sessions never share a checkout; `worktree:false` is the single-checkout/human-manual escape). Refused for a `kind:"scratch"` ticket (promote it first). "status" reports name + existence + ahead/behind counts. "delete" refuses an unmerged branch unless `force:true`; if a worktree still holds the branch checked out, deleting first stops any session on it and detaches the worktree — uncommitted work is preserved as a stash ref, but NOT applied onto master (an abandon, not a merge).

## list_available_agents

Read-only roster lookup — id, label, description, role (lead/worker/flex), and phases per persona. Filter by `phase` to narrow to personas relevant to a specific workflow stage.

## delegate

Spawns child agent sessions and BLOCKS until they finish (unlike `start_session`, which is fire-and-forget). A single delegation runs serially; passing more than one runs them concurrently. Reach for a specialist persona when its domain knowledge produces materially better results than doing the work yourself — not for routine steps you can do directly.

## start_session

Fire-and-forget dispatch — returns immediately, unlike `delegate` which blocks on completion. Use it whenever the user asks to groom/implement/review/finalize a ticket, instead of doing that work yourself in the current session. `phase:'fast-path'` (FLUX-1380) grooms AND implements an XS/S ticket in one session (Grooming → In Progress → Ready), structurally skipping the plan gate — refused server-side for L/XL-effort tickets or tickets with their own subtasks.

`worktree` defaults to true because dispatch is unattended and often concurrent — it must never share a checkout with another session. A branch-bearing agent session is ALWAYS worktree-isolated at spawn regardless of this flag (FLUX-1018): `worktree:false` only skips pre-creating the worktree up front, since the spawn creates one anyway the moment a branch exists (a branch on the shared main checkout previously let a single-shot agent commit to master — the bug this closed). To genuinely run in the shared main tree, start the session branchless instead of passing `worktree:false`. The flag is ignored entirely for `phase:"grooming"` (FLUX-1214) — grooming never writes code or opens a PR, so it always runs branchless in the shared checkout.

## furnace_get

Read-only view of one batch (tickets + config + PRs + burn report) or every batch (optionally filtered by `status`). A batch is a named bucket the Furnace burns unattended: implement → review → re-implement (up to `retryCap`) → leaves the PR open at Ready — it NEVER merges on its own.

## furnace_update

Live-adjusts a batch's tuning knobs while it runs or sits in draft — title, burn rate, kind, retry cap, circuit breaker (`maxConsecutiveFailures`), rate-limit cooldown timing, and the auto-`trigger` (auto-ignite once a referenced batch or PR merges). A title rename while burning only updates the display name, never the branch. `kind` and `branch` are changeable only while the batch is still a draft — once burning, the branch topology is locked in. This tool never ignites or stops a batch itself (see `furnace_batch`).

## furnace_build

Builds a new batch from the groomed backlog as an editable DRAFT (not yet burning). Requires an explicit selector — `tag` or `tickets` — by design; there is no way to pool the entire backlog by accident. Reasons about ticket independence: excludes parent/child pairs from the same batch and flags file overlaps between candidates. Enforces one-active-batch. Defaults to `kind:'parallel'` (each ticket its own branch+PR, concurrency = `burnRate`); `kind:'sequential'` stacks every ticket onto one shared branch+PR, burning in order.

`adoptBranchFrom` (FLUX-1270) reuses an existing ticket's still-open-PR branch as the new batch's shared branch instead of minting a fresh one — the mechanism for splitting a same-branch-dependent follow-up + its parent out of a parallel batch into their own standalone sequential batch. The named ticket must already have a `branch` with an OPEN PR on it; this forces `kind` to `sequential` (refused if `kind:"parallel"` was explicitly passed, since a per-ticket-branch batch has nothing to adopt onto).

## furnace_batch

The lifecycle-transition tool for an EXISTING batch (folds what would otherwise be four separate tools — FLUX-1085). `ignite`: draft → burning, claims a worktree slot from the global pool, and burns every ticket unattended — refused with `no_slots` (plus the current slot holders) if the worktree pool is full. `stop`: halts the batch — graceful drain by default, or `hard:true` for an immediate cutoff that kills in-flight sessions. `resume`: parked/finished → burning again, re-queuing any tickets that were skipped. `discard`: permanently deletes a draft or terminal (non-burning) batch — refused while the batch is actively burning (stop it first).

## furnace_ticket

Per-ticket operations inside a batch (folds six formerly-separate tools — FLUX-1085, since they all share the same `(batchId, ticketId)` signature). `retry`: resets a parked/failed ticket to queued with a fresh retry budget. `dismiss`: clears the Require-Input flag without re-queuing the ticket. `takeover`: hands control to a human (pulls it out of Furnace-managed burning). `handback`: returns a taken-over ticket's control to the Furnace. `add`: appends a ticket to the batch — normally only groomed tickets in `allowedStatuses` (default `["Todo"]`) qualify; pass a wider `allowedStatuses` (e.g. `["In Progress"]`) to pull in a mid-implementation follow-up ticket that's branch-adopting its parent (FLUX-1270). `remove`: drops a ticket from the batch — refused while it's actively burning (stop the batch first), and refused mid-dispatch (a session spawn already in flight for it) to avoid orphaning that session.

## get_board_state

Live snapshot of exactly which tickets have an active agent session running right now, what each is doing, and ticket counts by status — check this before dispatching new work (to avoid double-dispatch onto a ticket that's already got a live session) or to see what's currently in flight.

## propose_board_rebase

The board-rebase ritual (FLUX-659): the ONLY sanctioned way to batch-propose board restructuring. Reach for this instead of calling `extract_ticket`/`merge_tickets`/`archive`/`change_status` directly whenever you're triaging, doing an end-of-session cleanup, or the user asks to "rebase the board." The call fires the batch to the human and returns immediately (unlike `permission_prompt`, which blocks) — nothing is applied until the human reviews each item in the portal and clicks "Apply approved" (or "Dismiss"). `kind:"leave"` is the deliberate safe default for anything you're not sure about — it keeps the item in the orchestrator thread rather than silently dropping it.

## permission_prompt

Internal plumbing — a gated agent CLI's permission-prompt hook calls this to decide whether a tool call is allowed, never something you call directly as part of normal workflow. Read-only operations auto-allow. Destructive operations (`change_status`, `finish_ticket`, `archive`, `branch` delete, `furnace_batch` discard, `group_doc` delete, `Bash`) route to the EH portal for a human decision — the CLI blocks on the response.

## ask_user_question

The working substitute for a native ask-user-question tool that can't be fulfilled in unattended/print-mode CLI invocations. BLOCKS until the user answers (held open server-side, under a ~4-minute timeout that returns an `unanswered` sentinel so the fetch doesn't get killed by an upstream timeout first) — use it whenever a real decision or ambiguity needs resolving; never guess and proceed. On `unanswered`, proceed with your best judgment or ask again only if the answer is truly essential.

## group_doc

Cross-project knowledge base shared across a multi-repo group — works identically whether called from the parent workspace or a bound member. `path` for `read`/`delete` is the full path exactly as `list` returned it (e.g. `"Product/features/payments"`); for `submit` it's a store-relative path WITHOUT the group prefix and WITHOUT a `.md` extension (e.g. `"features/payments-api"`) — a single safe path segment, no `".."` and no absolute paths (traversal is rejected). `submit` fans the new/updated doc out to every member; `delete` fans the removal out the same way.

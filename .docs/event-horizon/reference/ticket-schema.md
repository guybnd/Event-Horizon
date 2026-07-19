---
title: Ticket Schema Reference
order: 3
---
# Ticket Schema Reference

Authoritative description of the ticket file format. Source of truth: [`engine/src/schema.ts`](../../../engine/src/schema.ts) and [`engine/src/history.ts`](../../../engine/src/history.ts).

> Every mutation tool (MCP) and REST endpoint validates frontmatter through `validateTicketFrontmatter` before writing. Invalid writes are rejected with a `SCHEMA_VALIDATION_FAILED` error and never reach disk.

## File layout

Each ticket is a single markdown file at `.flux/<ID>.md` (in-repo mode) or `.flux-store/<ID>.md` (orphan mode). File name = `<projectKey>-<n>.md` (e.g. `FLUX-42.md`). The file is YAML frontmatter followed by a markdown body:

```markdown
---
id: FLUX-42
title: Example ticket
status: Todo
priority: High
effort: M
assignee: unassigned
tags: [feature, engine]
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T10:00:00.000Z'
    comment: 'Ticket created.'
---

Markdown body. Free-form. May contain image links to `.flux/assets/FLUX-42/<name>`.
```

## Frontmatter fields

### Required

| Field | Type | Notes |
|-------|------|-------|
| `title` | string (non-empty) | Validated. |

### Required-by-convention (not enforced by schema, but always present in practice)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Set by the engine on create. Format `<PROJECT>-<n>` (e.g. `FLUX-42`). Never change. **FLUX-1225:** a `kind:'scratch'` entity is minted in its own `SCRATCH-<n>` namespace instead — a parallel counter (scanned per-prefix in `createTask`) so scratch chats never consume the `FLUX-n` sequence and are trivially distinguishable from board tickets. |
| `status` | string | Must match a column or hidden status name in `config.json`. Schema only checks "non-empty string" — board config defines the allowed set. |
| `priority` | string | One of the names in `config.priorities`. Default `None`. |
| `effort` | string | `XS`, `S`, `M`, `L`, `XL`, or `None`. |
| `assignee` | string | A name in `config.users`, or `unassigned`. |
| `tags` | string[] | New tags are auto-registered in board config on save. |
| `createdBy` / `updatedBy` | string | Stamped by the engine. |
| `history` | HistoryEntry[] | See below. |

### Optional

| Field | Type | Notes |
|-------|------|-------|
| `subtasks` | string[] \| `{id: string}[]` | Child ticket ids. Object form is tolerated but objects without `id` are silently dropped on load (validation surfaces a warning). |
| `implementationLink` | string | Commit hash or PR URL. Set by `finish_ticket`. |
| `branch` | string \| null | Git branch name when one has been created for the ticket. |
| `mergedInto` | string | **FLUX-657.** Tombstone pointer set by the [`merge_tickets`](mcp-tools.md#merge_tickets) verb on a folded-away source ticket: the **survivor** ticket id its chat was folded into. The source is archived (not deleted); its turns stay intact in the substrate and now re-derive in the survivor's view. Reversible — removing the `merge` op from the curation op-log reverts the fold. Set by the verb, not hand-authored. |
| `baselineCommit` | string | Diff anchor captured at first session launch (Start Task). For a branch/PR ticket it is the branch's fork point from the default branch (`git merge-base`), **not** the engine's HEAD at launch — anchoring at HEAD could land on an unrelated sibling commit and make `baselineCommit..HEAD` diffs show phantom reversions (FLUX-585). Branch-less tickets anchor at current HEAD. A baseline recorded before this fix that isn't an ancestor of its branch is self-healed to the merge-base on the next session launch. Note: generic diffs are reliable only for sequential work on a shared branch; concurrent work on a shared branch will include commits from other tickets in its diff range. |
| `diffSummary` | `{file, additions, deletions}[]` | Per-file change counts captured at `finish_ticket`. The matching full unified diff is written to `<flux-dir>/<ID>.diff` as a sidecar (2 MB hard cap). |
| `order` | number | Per-status manual sort position (set by drag and drop). |
| `needsAction` | string \| null | **FLUX-651 / FLUX-826.** Set by the engine when an agent leaves an open item with no board action. Three triggers: (1) **hard** — a turn ends in a working status (`Grooming` / `In Progress`) with no board action; (2) **soft (FLUX-826)** — a turn ends in a resting/terminal status (`Todo`/`Ready`/`Done`/`Backlog`/…) having posted a fresh agent comment but taken no board action and raised no `ask_user_question`; (3) **question timeout (FLUX-826)** — a ticket-bound `ask_user_question` times out unanswered. Truthy = the board renders the ticket in a **"Needs Action"** group and a notification is raised; the string is the reason. Cleared automatically when the ticket's status moves, a Require-Input swimlane is raised, or work resumes on the next turn. Not hand-authored. |
| `kind` | `'ticket'` \| `'pr'` \| `'scratch'` | Ticket kind. Absent/`'ticket'` = a normal ticket. `'pr'` marks an **engine-managed PR ticket** (FLUX-566) — id `PR-<gh-number>`, created/synced/resolved from `gh` by `syncPrTickets` (never hand-authored). Do not author or hand-edit `kind:'pr'` tickets. The PR ticket's **markdown body mirrors the gh PR description** (FLUX-751), refreshed each sync. `'scratch'` marks a **freeform Scratch Chat** (FLUX-1225) — a conversation you spawn from the ChatDock ("+ New Scratch") with no board work behind it; id `SCRATCH-<n>` (own namespace, see `id` above). A scratch entity is **hidden from board columns** (`Board.tsx` `boardTasks` filter) and from `list_tickets`' active-default screen (fetchable only via an explicit `status` filter or `includeAll`). Persists its own history like any ticket, so it survives reload. **Cannot be implemented in place (FLUX-1443):** file-mutation tools are disallowed for any `kind:'scratch'` session regardless of `status` (`isScratchSession`, `engine/src/agents/shared.ts`), and `branch`/`finish_ticket` refuse it server-side — a scratch chat must be **promoted** via `extract_ticket` (which already consumes it per FLUX-1249, see below) into a real ticket before it can be implemented. |
| `prNumber` / `prState` / `reviewDecision` / `isDraft` | number / string / string\|null / boolean | **PR tickets only.** The gh PR number, state (`OPEN`/`MERGED`/`CLOSED`), review decision, and draft flag — refreshed each sync. |
| `reviewState` | `'approved'` \| `'changes-requested'` \| null | **FLUX-816, clear-on-bounce FLUX-1089.** The outcome of an EH (non-GitHub) review. Set by the review orchestrator when it concludes — `approved` on the move to `Ready`, `changes-requested` on the move back to `In Progress` — via the `reviewState` param on [`change_status`](mcp-tools.md#change_status), or set/cleared manually by a human from the TaskModal. Surfaces a review badge on the card (`reviewChip`). **Distinct from `reviewDecision`** (GitHub-synced, PR-only, uppercase enum); on PR cards the badge falls back to `reviewState` when `reviewDecision` is absent, so an internally-approved PR isn't shown as unreviewed just because GitHub was never told. `null` = never reviewed (no badge — never a false "approved"). **FLUX-1089: cleared on leaving Ready without a fresh verdict** — `change_status` auto-clears a stale `reviewState` whenever a ticket moves OUT of `Ready` and the same call doesn't pass an explicit `reviewState` (pure decision: `resolveReviewStateOnMove` in `mcp-server.ts`); this also fires on the FLUX-569 changes-requested unwind (`bounceMembersToInProgress` in `pr-tickets.ts`), so a Ready member's `approved` verdict never survives a bounce back to `In Progress`. An explicit `reviewState` on the same `change_status` call (e.g. a reviewer recording `changes-requested`) always wins over the auto-clear. A new commit after approval, with no status move, still does not clear it. |
| `tempering` / `temperAttempts` | boolean / number | **FLUX-1071 (Temper).** Set by the engine while a ticket is in the single-ticket auto-review loop ("Furnace for one ticket"). `tempering: true` = the loop owns this ticket; `temperAttempts` = re-implementation attempts so far. Written via [`change_status`](mcp-tools.md#change_status)'s Ready trigger (`maybeStartTemper` in `temper.ts`) when the resolved `review` gate (`config.gatePolicy.boardDefault.review`, or this ticket's own `gatePolicyOverride.review` — see below) is `'auto'` and a **branch** ticket enters Ready; cleared when the review approves (PR left open at Ready — **never merged**), the retry cap parks it (Require Input), or a Furnace batch takes the ticket over. The loop is driven engine-side (`temper.ts`, reusing the Furnace Stoker's `decideTicketAction`), so it survives the portal being closed. Not hand-authored — surfaces the "tempering…" card badge. |
| `gatePolicyOverride` | `{ plan?, review?: "auto" \| "auto-then-you" \| "you" }` | **FLUX-1261.** Per-ticket override of one or both gate policies — wins over `config.gatePolicy.boardDefault` for this ticket only (board-default → ticket-override cascade, `resolveGateValue` in `models/gate-policy.ts`). Engine-internal in v1: no portal surface writes this yet — **FLUX-1264** only reads it, to show a live "N tickets override this" count in the ⚙ modal's board-default presets (so applying a preset, which never touches this field, doesn't leave a stale override silently confusing). `merge` is never a representable key in either the board default or this override — that's the structural half of the merge-lock; `finish_ticket` independently refuses to merge a branch ticket with no human touch in its history (`hasHumanGateTouch`) as the runtime half. |
| `planReviewState` | `'approved'` \| `'changes-requested'` \| null | **FLUX-1247 epic decision #2, landed FLUX-1263.** Verdict from the `plan` gate's review pass — parallel to `reviewState` (kept separate so `review` keeps writing its own field unchanged). Written via [`change_status`](mcp-tools.md#change_status)'s `planReviewState` param (`resolvePlanReviewStateOnMove` in `mcp-server.ts`) by a plan-review session while it stays in `Grooming`; under `auto-then-you` (**FLUX-1288**: after looping review → revise to convergence, same as `auto`) or a manually-run `start_plan_review` pass, the ticket stays in `Grooming` with this set until a human confirms by moving it to Todo — that move clears the field. Detected by the AttentionDock's 📋 `plan-approval` item (**FLUX-1262**, `isPlanApprovalPending` in `pendingInteractions.tsx`). **FLUX-1289** made every surface verdict-aware: a `changes-requested` verdict shows the reviewer's latest feedback comment (`historyDigest.planReviewComment` — see [REST API § `GET /api/tasks`](rest-api.md)) alongside Send-for-re-grooming / Re-review / Set aside actions, shared by the AttentionDock tray item, `ChatPlanApprovalCard`, and the full-screen `PlanApprovalPanel` (see [Code Map](../architecture/code-map.md)). Dismissing has **two independent levels** (FLUX-1289, restored **FLUX-1312** after a brief FLUX-1303 unification): a **dock-only snooze** (`usePlanReviewDockDismiss` in `attentionAck.ts`, localStorage-keyed by ticket id + verdict) hides just the AttentionDock tray item without touching this field, while the durable **Set aside** (`dismissPlanReview` in `pendingInteractions.tsx`) clears this field (plus `planReviewBodyHash` and `needsAction`) the same as a human confirm, without moving the ticket to Todo. |
| `planReviewBodyHash` | string \| null | **FLUX-1303.** djb2/base36 hash of the ticket `body` at the moment the current `planReviewState` verdict was recorded (`planBodyHash` — `engine/src/models/gate-policy.ts`, mirrored in `portal/src/lib/planBodyHash.ts`). Stamped by `change_status` whenever an explicit `planReviewState` lands (nulled when the verdict clears) and by `POST /api/tasks/:id/plan-review/revise`. Lets the portal tell whether the plan changed since that review — gates `PlanApprovalPanel`'s "Re-review plan" button, so re-reviewing an unchanged plan (which can only re-produce the same verdict, including re-approving a plan a human just rejected) isn't offered. Not hand-authored. |
| `planGateRunning` / `planGateAttempts` / `planGateMode` | boolean / number / `'one-pass'` \| `'loop-confirm'` \| `'loop-auto'` | **FLUX-1263, mode 3-way'd FLUX-1288 (replaces the old `planGateOneShot` boolean).** Set by the engine while a ticket is in the `plan` gate's review→revise loop (the generalized, gate-parametrized sibling of Temper's `tempering`/`temperAttempts`, `gate-runner.ts`). `planGateRunning: true` = the loop owns this ticket; `planGateAttempts` = revise attempts so far; `planGateMode` = the loop shape (`resolvePlanGateMode` in `mcp-server.ts`) — `one-pass` (a manually-triggered `start_plan_review` pass, any gate value) stops after ONE verdict regardless of outcome; `loop-confirm` (`auto-then-you`) and `loop-auto` (`auto`) both loop `changes-requested` → revise → re-review the same way, differing only on `approved`: `loop-auto` moves the ticket to Todo automatically, `loop-confirm` stops and flags a human to confirm. Triggered by `change_status` intercepting a Grooming → Todo move when the resolved `plan` gate is `auto`/`auto-then-you` and no verdict has been recorded yet (`evaluatePlanGateTrigger`); cleared when the loop stops (auto-moved, human-confirm flagged, or the retry cap parks it — Require Input, kept in `Grooming`). A restart rehydrates a legacy `planGateOneShot: true` ticket as `one-pass` and absent/`false` as `loop-auto` (`rehydrateGateRunner`). Not hand-authored. |
| `members` | string[] | **PR tickets only.** The **work-gated** member ticket ids that fold into this PR — normal tickets on the PR's branch that are In Progress/Ready. Todo/Grooming/Backlog tickets on the branch are deliberately excluded (they stay in their pile). **FLUX-1089:** the PR card's own review chip is DERIVED from these members' `reviewState` at render time (never propagated onto the PR ticket) — see the PR-card review signal precedence below. |
| `links` | `{type, target, label?}[]` | Typed relationships to other tickets (FLUX-593; generalized by epic FLUX-596). `type` is a relation kind (`'retries'` is the first — set on a ticket created by **Retry PR**, pointing at the merged `PR-<n>`), `target` is the related ticket id, `label` an optional display string. Schema-permissive (not yet a closed enum). |
| `cliSession` | object | **Not persisted** — serialized into API responses from the in-memory session store. Holds the most recent session summary for the ticket. Do not write this to the file. |
| `cliSessions` | object[] | **Not persisted** — full list of session summaries for the ticket, serialized from the session store. Present when the ticket has any sessions; the portal uses it to group sessions launched together (shared `groupId`) into one orchestration run. Each summary may carry `groupId`, `groupSeq`, `groupTotal`, `groupType` (`relay` \| `scatter-gather` \| `supervisor`), and `groupVariant` (`combiner` \| `headless`). `groupTotal` is the expected session count in the group, letting the UI render placeholder slots before all sessions have spawned. |
| `tokenMetadata` | object | Aggregated token counters surfaced to the UI. |

### PR-card review signal (FLUX-1089)

A PR ticket's own review chip (rendered in `PrDeckCard.tsx`) is **derived from its members' `reviewState` at render time** (`aggregateMemberReviews` in `ReviewChip.tsx`) — never propagated onto the PR ticket's own frontmatter, since `members` is recomputed on every sync (`selectMembers` in `pr-tickets.ts`) and a copied field would go stale the instant a ticket joins the branch or a member bounces. Precedence, red wins:

1. Any member `reviewState === 'changes-requested'`, OR the PR's GitHub `reviewDecision === 'CHANGES_REQUESTED'` → red "changes requested" chip.
2. GitHub `reviewDecision === 'APPROVED'` → the existing green "approved" chip.
3. Every **current** member approved internally (`reviewState === 'approved'` AND still `Ready` — the stale-approval guard), at least one member, GitHub silent → a visually distinct teal **"Reviewed (internal)"** chip. This is what makes mid-batch Furnace progress visible: a sequential batch's earlier members post comment-only approvals (see `pickPrReview` / `isFinalSequentialApproval` in `furnace-stoker.ts`), so GitHub itself stays quiet (`REVIEW_REQUIRED`) until the final member's real `--approve`.
4. Some but not all members approved → an "n/m reviewed" progress chip.
5. Otherwise → the pre-FLUX-1089 fallback (`reviewDecision` — e.g. a bare `REVIEW_REQUIRED` — falling back to the PR ticket's own `reviewState`).

A single-member PR (parallel Furnace mode) naturally collapses rule 3 to that member's verdict, not a "1/1" progress chip. A shrinking member set (members drop out on Done/terminal) is evaluated over the live set only — a 3→1 set flipping to "all approved" is accepted as correct. The merge-confirm prompt separately surfaces "N member(s) have changes requested" from the same per-member `reviewState` — a warning only, it does not block the merge.

### PR-card sync-conflict resolution (FLUX-1427)

The GitHub-owned vs EH-owned split documented above (`kind`, `prState`/`reviewDecision`/`isDraft`/`ciStatus`/`prNumber`/`branch`/`title`/`implementationLink` re-derived by the poller; `status`/`swimlane`/`members`/`history` locally authored or preserved) is the same taxonomy FLUX-1428's journal classifies by: the poller's field-mirror writes (`upsertManagedTicket`) are `derived` — never journaled, simply re-derived by the next ~90s `syncPrTickets` poll if a sync race discards them — while a human/agent intent touching a PR card (send-for-review, a comment) IS journaled and replayed. Two engines' flux-data sync racing on a `PR-*.md` file therefore no longer reaches a text-level merge at all: the losing side's periodic tick resets onto the winner's already-current version outright. `mergePrTicketConflict` (`engine/src/sync-watcher.ts`) still implements this exact GitHub-owned-vs-EH-owned split (GitHub-owned scalars take the remote side, `history[]` unions by entry identity, `swimlane`/`status`/`members` follow `prTicketFields`'s preservation rules) but is reachable only through the manual `resolveConflicts()` path now, for a worktree that's genuinely mid-merge on disk from some other source — not something the periodic tick produces on its own.

### Validation rules

From `validateTicketFrontmatter`:

- Frontmatter must be an object.
- `title` must be a non-empty string.
- `status`, if present, must be a non-empty string.
- `tags`, if present, must be an array of strings.
- `history`, if present, must be an array; each entry is validated individually.
- `subtasks`, if present, must be an array of strings or `{id}` objects.

## History entries

`history` is an append-only array. Every entry has the common shape:

```ts
{
  type: string;        // see types below
  user: string;        // who recorded it (e.g. 'Agent', 'guy')
  date: string;        // ISO-8601 timestamp
  ...                  // type-specific fields
}
```

Common requirements (validated for every entry):

- `type` non-empty string.
- `user` non-empty string.
- `date` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}` and parses as a valid `Date`.

### Per-type fields

| `type` | Required extra fields | Used for |
|--------|----------------------|----------|
| `comment` | `comment: string` (non-empty) | User or agent comments in the activity feed. |
| `activity` | `comment: string` (non-empty) | Engine-recorded field changes ("Updated title."), creation activity, agent progress notes. |
| `agent_message` | `comment: string` (non-empty) | Out-of-band agent message captured outside a session. |
| `status_change` | `from: string`, `to: string` (both non-empty) | Status transitions. Old field names `oldStatus`/`newStatus` are explicitly rejected. |
| `agent_session` | `sessionId: string`, `startedAt: ISO date`, `status: string` | A CLI agent session run against the ticket. Also carries `framework`, `endedAt`, `progress[]`, token counters; written by the agent adapters. When a session reaches a terminal status, the engine **compacts** the stored `progress[]` (`compactSessionProgress` in [`history.ts`](../../../engine/src/history.ts), invoked from `updateAgentSession`): raw per-second `text` chunks are dropped in favor of typed milestones (`tool`, `topic`, `info`), error-looking entries, and the last couple of text chunks; the last text chunk is promoted to a first-class `finalMessage` field and `originalProgressCount` records the pre-compaction length. Sessions that are part of an orchestration run also carry `groupId` (shared run id), `role` (e.g. `reviewer:architect`, `orchestrator`), and `pattern` (the execution pattern) so the activity feed can render the whole run as one collapsible block. `enginePid: number` (FLUX-1572) records the PID of the ENGINE process (not the CLI subprocess) that started the session, stamped by `buildAgentSessionEntry`; the boot-time `reconcileOrphanedSessions` reconcile only abandons an `active` entry as "Session abandoned (engine restarted)" when `enginePid` is absent (pre-fix legacy entries) or that pid is dead — a live `enginePid` means a live sibling engine bound to the same shared store still owns the session, so a second engine on that workspace no longer falsely kills it. |

**Digest fields (optional, cross-cutting):** `comment`, `activity`, and `agent_session` entries may carry an optional `summary: string` and `pin: boolean`. They don't affect the file or the portal — they drive the **agent** digest (`get_ticket` / `?view=agent`): older entries with a `summary` (or, for `agent_session`, the existing `outcome`) are returned collapsed to `{ …, summary, id, collapsed: true }` instead of full text, with a `collapsedCount` reported; `pin: true` keeps an entry full regardless of age. Set them via `add_note` (`type:'comment'` / `'activity'`); recover a collapsed body with `get_ticket(…, expand: ["<id>"])`. See [MCP tools → get_ticket](mcp-tools.md#get_ticket).

**Temporal supersession (`supersedes`, FLUX-811):** `comment` and `activity` entries may carry `supersedes: string[]` — ids of earlier entries this one makes obsolete (a decision reversed/replaced). `normalizeHistoryEntries` coerces it to a string array and drops any id that doesn't reference an existing entry, points at itself, or points forward (no dangling/forward links). In the agent digest, an entry superseded by a **later** entry collapses to a one-line marker `{ type, user?, date, supersededBy: "<superseder-id>", summary?, id, collapsed: true }` — **independent of the recent-window** (a dead decision collapses even when recent), still recoverable via `expand: ["<id>"]`. **Authority-before-recency guardrail:** an *agent*-authored supersession never collapses a `pin: true` or user-authored target — that target stays full with an advisory `supersededByAdvisory: "<superseder-id>"` annotation instead. Supersession is an annotation, never a delete — history stays append-only.

**Self-attested authorship (`selfAttested`, FLUX-1271):** a `comment` entry written via [`add_note`](mcp-tools.md#add_note) always carries `selfAttested: true` — its `user` field is a caller-controlled claim (the MCP tool takes any string), not an authenticated write. `hasHumanGateTouch` (`models/gate-policy.ts`, the [`finish_ticket` merge-lock](mcp-tools.md#finish_ticket)) ignores any `comment`/`status_change` entry carrying this flag when checking for a genuine human touch, regardless of the claimed `user` — closing the gap where a single MCP session could `add_note({user:'SomeHuman', ...})` then immediately `finish_ticket`. Entries written through any other path (the portal's own writes, or the engine's hardcoded `user: 'Agent'` entries) never carry it.

**Structured completion handoff (`completion`, FLUX-1147):** a `comment` entry written by [`change_status`](mcp-tools.md#change_status) or [`finish_ticket`](mcp-tools.md#finish_ticket) may carry an optional `completion: { changedFiles?: string[], validation?: {command: string, passed: boolean}[], decisions?: string[], residualRisk?: string, docsUpdated?: string[] | boolean }` — a machine-readable companion to the entry's prose `comment`, for downstream readers (reviewer sessions, Furnace, the next implementer, the portal) to consume as fields instead of re-parsing free text. Point-in-time event data, so it lives on the history entry — **not** ticket frontmatter (unlike `reviewState`, which is current-state). Set via the `completion` param on either tool; best-effort validated (`sanitizeCompletion` in [`completion-payload.ts`](../../../engine/src/completion-payload.ts)) — malformed/oversized fields are silently dropped/truncated, never rejected, so a garbage payload can never block the write. The portal renders it as a structured summary (`CompletionSummary.tsx`) instead of raw JSON; an entry with no `completion` (or an explicitly empty `{}`) shows nothing extra.

Any other `type` value is rejected by the validator as `unknown history entry type`.

### Append-only and normalization

- Never delete or rewrite past entries; engine helpers always append.
- `normalizeHistoryEntries` (in [`history.ts`](../../../engine/src/history.ts)) dedupes consecutive `comment` entries from the same user with identical text, and collapses redundant `status_change` entries that don't actually change status.
- `ensureCreationActivity` guarantees the first entry is a creation `activity` entry. The engine adds this on create.

## Status transition enforcement

Validation is purely schema-shaped. **Behavioral** rules live in the MCP `change_status` tool and the REST `PUT /api/tasks/:id` handler:

- Moving **to** `Require Input` requires a `comment` (the question to ask).
- Moving **to** `Ready` requires a `comment` (the completion summary), unless `config.requireCommentOnStatusChange === false`.
- The names of these two statuses are read from `config.requireInputStatus` / `config.readyForMergeStatus`. They can still be overridden in board config, but as of FLUX-770 the portal Settings → Board editor treats statuses as **system-managed** (recolor-only) and no longer offers renaming them — the workflow engine and agent instructions assume the canonical names.

See [Reference: MCP Tools](mcp-tools.md#change_status) for the canonical enforcement description.

## Subtask conventions

- `subtasks` holds child ticket ids only. Object-form entries (`{id: 'FLUX-42'}`) are tolerated for back-compat but objects missing `id` are dropped.
- Parent relationships are derived from these links; no field on the child stores its parent. Cards compute their parent badge by reverse-lookup on the cache.
- `create_ticket` with `parentId` (MCP) and `POST /api/tasks/:parentId/subtasks` (REST) maintain both files atomically.

## Body conventions

The `body` field is free-form markdown — the schema does not parse it. Some structure is nonetheless a documented **convention** the agent skills and portal both understand, without being schema-enforced:

- **Acceptance criteria (FLUX-1148).** A ticket may include a `## Acceptance criteria` section (a top-level, i.e. `##`, heading) as a GFM checkbox list (`- [ ] …` / `- [x] …`) — concrete, checkable statements a reviewer can verify against the diff. This is **advisory only**:
  - **No schema field, no engine gate.** Unlike `reviewState` or the FLUX-730 commit-before-Ready check, nothing on the engine reads or enforces this section — it's markdown in `body`, same as any other heading.
  - **Grooming** writes it (Plan Discipline item 5 in the grooming skill) for tickets with a Ready/PR review flow; skipped for XS/S-effort or no-Ready-flow tickets.
  - **Review** (the review skill's "Acceptance Criteria Checklist" section) has the reviewer tick off satisfied items via `update_ticket` before recording a verdict — bookkeeping, not a blocking condition.
  - **Portal** renders a read-only "X/Y criteria checked" progress indicator (on the board card and in the description surface header) parsed client-side (`portal/src/lib/acceptanceCriteria.ts`). Parsing rules: only the ticket's own **first** top-level `## Acceptance criteria` heading counts; counting stops at the next heading of the same or higher level (a deeper, e.g. `###`, heading doesn't end the section); only **top-level** (non-indented) checkbox items are counted, so nested sub-bullets don't inflate the total; a heading inside a blockquote (e.g. a subtask quoting its parent's criteria) never matches, since it isn't a real heading line. No section, or a section with zero checkbox items, renders no indicator — never a "0/0" badge.
  - Existing tickets are **not** backfilled with this section — it's opt-in per ticket going forward.

## Atomic write guarantees

All mutations go through `atomicWriteFile` in [`task-store.ts`](../../../engine/src/task-store.ts):

1. Write content to `<file>.tmp`.
2. `renameSync` over the target.
3. On cross-device-rename failure, fall back to direct write and clean up the temp file.

`readTaskFromDisk` defends against transient corrupt reads (empty file or missing `title`) by falling back to the cached copy and logging a warning.

## When in doubt

- Use [MCP tools](mcp-tools.md) — they validate and update history correctly by construction.
- Do not hand-edit `.flux/*.md` files while the engine is running unless you understand the watcher reload flow.

## Cross-references

- [Reference: MCP Tools](mcp-tools.md)
- [Reference: REST API](rest-api.md)
- [Reference: Realtime Channels](realtime-channels.md) — how schema-validated writes propagate to the UI.
- [Ticket Model](../architecture/ticket-model.md) — higher-level conceptual overview.

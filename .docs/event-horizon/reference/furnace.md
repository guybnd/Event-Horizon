---
title: The Furnace
order: 6
---
# The Furnace — reference

**The Furnace** (FLUX-1008) is EventHorizon's overnight autonomous ticket runner. You load a curated,
ordered batch of already-groomed, independent tickets — the *magazine* — and the Furnace **stokes** it:
it implements each ticket, sends it through automated review, re-implements up to `retryCap` (2) times if
review fails, and leaves the resulting **PR open at `Ready`** for a human to merge in the morning. It
**never merges** (`finish_ticket` is never called) — morning human review is the gate.

It is a *conductor* over the existing headless-session machinery (`start_session`, worktrees,
`reviewState`), not new agent plumbing.

## Metaphor

| Term | Meaning |
|---|---|
| **Magazine** | the curated, ordered, editable batch of tickets loaded for a run |
| **Coal / charge** | one loaded ticket (a `MagazineEntry`) |
| **Stoke / the Stoker** | the loop tick that feeds the next ticket in and tends the burning ones (S3) |
| **Burn** | one charge's lifecycle: implement → review → (re-implement ≤2) → leave PR open |
| **Burn rate** | concurrency — how many charges burn at once (S4) |
| **Burn report** | the summary emitted when the magazine empties or a hard stop trips (S7) |

## Data model (`engine/src/models/furnace.ts`)

### `FurnaceRun`
| Field | Type | Notes |
|---|---|---|
| `id` | `string` | uuid, engine-assigned |
| `status` | `building \| burning \| paused \| completed \| stopped` | run-level state; `building` drafts are editable, ≤1 run is `burning`/`paused` at a time |
| `config` | `FurnaceConfig` | see below |
| `magazine` | `MagazineEntry[]` | ordered charges |
| `report?` | `FurnaceReport` | present once the run is terminal (S7) |
| `consecutiveFailures` | `number` | running counter for the circuit breaker; reset on any success |
| `createdAt` / `updatedAt` | ISO string | |
| `ignitedAt?` / `endedAt?` | ISO string | set when it starts burning / reaches a terminal status |
| `title?` / `stopReason?` / `createdBy?` | `string` | |

### `MagazineEntry` (a charge)
| Field | Type | Notes |
|---|---|---|
| `ticketId` | `string` | the loaded ticket |
| `order` | `number` | burn order (contiguous 0..n-1, re-orderable) |
| `state` | `queued \| implementing \| reviewing \| reimplementing \| cooling-down \| pr-open \| parked \| failed \| skipped` | per-charge lifecycle (`cooling-down` = rate-limited, waiting to auto-retry — FLUX-1063) |
| `attempts` | `number` | implementation attempts (increments per re-implement) |
| `sessionIds` | `string[]` | every session spawned for the charge |
| `currentSessionId?` / `currentPhase?` | | the in-flight session + which phase (`implementation`/`review`) |
| `lastReviewState?` | `approved \| changes-requested \| null` | last verdict read off the ticket |
| `prUrl?` | `string` | the open PR once `pr-open` |
| `mergedAt?` | ISO string | FLUX-1210: set once a `pr-open` charge is detected as already merged (board status flipped to `Done`/`Released` outside the Furnace) — annotation only, `state` stays `pr-open` |
| `note?` | `string` | human-facing status note (park/fail reason) |
| `title?` / `overlapWarning?` | `string` | denormalized title; S2 soft file-overlap flag |
| `groupId?` | `string` | grouped-serial (FLUX-1041): members sharing a `groupId` stack onto one shared branch/PR |
| `startedAt?` / `endedAt?` / `sessionStartedAt?` | ISO string | timing; `sessionStartedAt` is the watchdog basis (S5) |
| `rateLimitFirstSeenAt?` / `rateLimitAttempts?` / `nextRetryAt?` / `preCooldownState?` | | rate-limit cooldown bookkeeping while `cooling-down` (FLUX-1063): episode start (ceiling basis), retries spawned, next retry time, and the active state to restore on retry |

### `FurnaceConfig`
| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `sequential \| parallel \| parallel-implement-serial-review \| grouped-serial` | `sequential` | burn-rate mode (S4); `grouped-serial` stacks overlap groups onto one branch (FLUX-1041) |
| `burnRate` | `number` | `1` | concurrency; clamped to the worktree cap (S4) |
| `hardStop` | `{ at?, maxTickets?, maxConsecutiveFailures? }` | `{ maxConsecutiveFailures: 3 }` | stop conditions + circuit breaker (S5) |
| `retryCap` | `number` | `2` | re-implementation attempts before parking |
| `reviewDepth` | `single \| scatter` | `single` | one reviewer persona, or a review panel |
| `reviewPersonaId?` | `string` | `senior-dev` | reviewer for `single` depth — every dispatch also carries a `focusComment` telling the persona it is the sole reviewer for this run, so it's authorized to call `change_status` itself (FLUX-1078; see below) |
| `sessionTimeoutMs?` | `number` | 45 min | per-session watchdog (S5; Furnace-local until FLUX-996 S1's hardened runner lands) |
| `rateLimitRetryIntervalMs` | `number` | 20 min | how often a rate-limited (`cooling-down`) charge auto-retries (FLUX-1063) |
| `rateLimitMaxWaitMs` | `number` | 5 h | ceiling a charge may stay in rate-limit cooldown before failing outright (FLUX-1063) |

### Core invariant
**Approved ⇒ leave the PR open at `Ready`, mark the charge `pr-open`, and pull the next charge — never call `finish_ticket`.** Encoded as a guard in the Stoker (S3), not just a convention.

### Sole-reviewer focus + the verdict-marker nudge (FLUX-1078)
Every built-in reviewer persona prompt (`engine/src/orchestration-personas.ts`) hedges for multi-reviewer synthesis flows: "do NOT call `change_status` unless your focus instructions explicitly say you are the SOLE reviewer." The Furnace only ever runs **one** reviewer per ticket, so `reviewDispatchOpts()` attaches a `focusComment` to every review-phase dispatch (`review`, `redrive`/`retry-exhausted`/`retry-rate-limited` when the phase is `review`) that states exactly that — without it, a persona would post a correct, well-structured `**APPROVED**` comment and still never call `change_status`, and the ticket would be parked as if the review never happened.

As a second line of defense, if a review session still completes with `reviewState` unset, `lastCommentMatchesVerdictMarker()` checks whether the ticket's most recent comment starts with the known `**APPROVED**`/`**CHANGES NEEDED**` convention. A match (and no nudge already spent this pass — `BatchTicket.reviewNudgeSent`) produces a `review-nudge` action: one corrective follow-up session (`REVIEW_NUDGE_FOCUS`) asked only to read its own last comment and call `change_status` to match — not to re-review the diff. No match, or the nudge already fired once, falls back to the original park.

### PR-review mirroring (FLUX-1033)
The reviewer's verdict is also posted onto the **real GitHub PR** so approval/rejection is visible on the PR itself (a green check / a "changes requested" review), not only inside EH. When the charge leaves `reviewing`, the Stoker computes what to mirror via the pure `pickPrReview` (`furnace-stoker.ts`) and calls `postPrReview` (`branch-manager.ts`) once per verdict: **approved ⇒ `gh pr review --approve`**, **changes-requested ⇒ `gh pr review --request-changes`** (the latter fires per-member whether the charge then re-implements or parks). Both link back to the ticket's EH review comment.

**Group-aware approval (grouped-serial shared PR).** In `grouped-serial` mode a whole group shares **one** PR that keeps accumulating commits until its **last** member finishes, so a per-charge `--approve` is wrong there — it would green-check an incomplete PR and, worse, leave a bogus approval standing if a later member is parked/changes-requested. The gate:
- **Single / parallel mode** (1 ticket = 1 PR): per-charge `--approve` on approval — unchanged.
- **Grouped-serial:** the real `--approve` fires **once**, only when the approved charge is the group's **final member** (highest `order`) **and every other member is already approved**. A **non-final** member's approval instead posts a plain `gh pr review --comment` (visible progress, never a formal approval). If any earlier member wasn't approved (e.g. parked/skipped), the final approve is withheld too — the shared PR never shows "approved" over work a member rejected.
- **`--request-changes`** always fires **per-member** on rejection (the PR genuinely isn't mergeable; in grouped mode that member also halts the rest of the group).
- **Board visibility (FLUX-1089).** A non-final member's comment-only approval leaves GitHub's `reviewDecision` at `REVIEW_REQUIRED` until the final member's real `--approve` — but each such member still records its own `reviewState: 'approved'` in EH via `change_status`. The board's PR card derives a review chip from the **live member set** (see the "PR-card review signal" section in [ticket-schema.md](ticket-schema.md)), so mid-batch progress is visible there — an "n/m reviewed" chip while some members are still pending, flipping to a distinct "Reviewed (internal)" chip once every current member has approved — without waiting on the GitHub-side signal at all.

**Self-approval caveat.** GitHub rejects a formal `--approve`/`--request-changes` review when the authenticated `gh` user **authored** the PR — and the Furnace opens the PR under that same token, so the formal review usually fails. `postPrReview` therefore attempts the formal decision first (it lands cleanly only when a **distinct reviewer token** is configured for `gh`) and, on any failure, falls back to a plain `gh pr review --comment` so the verdict is still visible on the PR. The whole path is **best-effort**: no PR url, or a `gh` failure, is logged and swallowed — a charge is never failed because the PR couldn't be annotated. To get a true green "approved" (not just a comment), run the Furnace's `gh` under a reviewer identity that didn't author the PRs.

## Persistence (`engine/src/furnace-store.ts`)

Runs are JSON sidecars at `<activeFluxDir>/furnace/<id>.json` (`.flux/furnace/` or `.flux-store/furnace/`
in orphan mode), written with `atomicWriteFile` (tmp + rename). Persisted so a mid-burn engine restart
resumes; gitignored runtime state, like `.flux/workflows/`. An in-memory cache is shared by the REST
routes, MCP tools, and the Stoker (one process — FLUX-705). Concurrent read-modify-writes are serialized
per-run via `withFurnaceLock` / `mutateFurnaceRun`.

**What "resumes" means (scope, honestly).** A restart recovers the **run state and magazine queue** from
the sidecar; on the next tick the Stoker reconciles each in-flight charge, adopting a still-live session
for the charge's phase when one exists (`getActiveSessionsForTask`, phase-filtered) or re-driving the
phase otherwise. An in-flight agent session is **restarted, not reattached** to the same process. This is
verified safe on a **graceful** shutdown (which stops all sessions first — `stopAllCliSessions`). On an
**ungraceful crash**, a re-drive spawns a fresh session into the charge's reused worktree; a non-detached
orphan child that outlived the crash is not something the Furnace itself guards against (inherited from
the general session machinery — see FLUX-996). Ignition is single-active-slot: `claimActiveRun` does the
active-run check and the flip to `burning` synchronously (no `await` between), so two concurrent ignites
can't both reach `burning` (FLUX-1008 M1). Status transitions go **only** through
ignite/pause/resume/stop — the `PUT /api/furnace/:id` route does not accept a raw `status` (M2).

Store functions: `loadFurnaceRuns`, `ensureFurnaceLoaded`, `getFurnaceRun(s)Cache`, `getActiveFurnaceRun`,
`createFurnaceRun`, `updateFurnaceRun`, `mutateFurnaceRun`, `claimActiveRun`, `deleteFurnaceRun`.

## REST surface (`/api/furnace`, `engine/src/routes/furnace.ts`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/furnace` | list all runs |
| `GET` | `/api/furnace/:id` | one run |
| `POST` | `/api/furnace` | create a `draft` batch (`{ title, kind?, ticketIds? \| tickets?, burnRate?, trigger? }`) |
| `POST` | `/api/furnace/:id/ignite` | ignite the run (building/paused → burning); enforces ≤1 active run |
| `POST` | `/api/furnace/:id/pause` | pause a burning run (→ paused; the tick halts feeding + advancement) |
| `POST` | `/api/furnace/:id/resume` | resume a paused run (→ burning) |
| `POST` | `/api/furnace/:id/stop` | stop the run (→ stopped); `{ reason?, hard? }` (graceful drain by default) |
| `PUT` | `/api/furnace/:id` | patch **config / magazine / title only** — `status` is NOT patchable (all transitions go through ignite/pause/resume/stop, which enforce the guards + single-active invariant — FLUX-1008 M2). A title rename on a **draft** batch also recomputes its derived `branch` (`batchBranchName`) since no worktree/branch ref exists yet; once burning/terminal the branch is fixed and the rename is display-only (FLUX-1062). |
| `POST` | `/api/furnace/:id/ticket` | append a single ticket (`{ ticketId }`) to a batch (draft or burning); 409 if already in the batch, if the batch is `done`, if the id fails the existence/status gate, or if it's already queued in a *different* non-terminal batch (FLUX-1081, FLUX-1051) |
| `DELETE` | `/api/furnace/:id/ticket/:ticketId` | remove a ticket from a batch; 409 if it is actively burning in a `burning` batch (FLUX-1081) |
| `DELETE` | `/api/furnace/:id` | delete a batch (409 if it is burning) |

`furnace_build` (the tag/id-scan builder below) has **no REST route** — it is deliberately MCP-only; `POST /api/furnace` above is the raw-CRUD twin (explicit `ticketIds`/`tickets`, no curation, no tag scan). The `PUT`/`POST /` raw-CRUD paths and `POST /:id/ticket` share the same `validateBatchTickets` gate as `furnace_build`'s explicit-ids selector, including the one-active-batch check (see below).

### Auto-trigger (`trigger`, FLUX-1142)

A batch may carry `trigger: { type: 'batch' | 'pr', ref } | null`, evaluated by the Stoker's trigger watcher (`checkTriggers`/`isTriggerSatisfied` in `furnace-stoker.ts`) — only for **draft** batches, once per drive cycle. `type: 'batch'` is satisfied once `ref` (a batch id) is terminal (`done`/`parked`) with every one of its PRs `merged`; `type: 'pr'` is satisfied once any batch's `prs` contains a `merged` entry matching `ref` (a PR url or `#number`). `PUT /api/furnace/:id` and the `furnace_update` MCP tool both patch `trigger` through the same `validateBatchTrigger` (`models/furnace.ts`), which rejects with **400** (`{error}`, no mutation) a `batch`-type trigger that would:
- point a batch at **itself**, or
- form a **direct A→B→A cycle** (the candidate `ref` already has a trigger pointing back at this batch).

Longer cycles (A→B→C→A) and a `ref` naming a batch that doesn't exist yet aren't rejected — the latter simply never satisfies (or, in the portal, renders as "(deleted batch)" if the batch existed and was since deleted). The portal's Furnace drawer (S6, below) is the only editor: a small trigger control next to `KindToggle`, enabled whenever the batch isn't `burning` (draft/parked/done), backed by this same validation.

## Curation & independence — the magazine builder (`engine/src/furnace-builder.ts`)

`buildBatchTickets(tickets, opts)` is a **pure, deterministic** function (no LLM) that turns the groomed
backlog into a proposed batch. The MCP layer (`furnace_build`) passes `Object.values(tasksCache).map(toBuildCandidate)`;
it returns `{ tickets, excluded, notes }`.

### Intentional-selection contract (FLUX-1051)

**A batch must always be an intentional selection — there is no way to pool the entire backlog.**
`buildBatchTickets` requires at least one of `opts.tag` / `opts.tickets` (explicit ids); given neither, it
refuses outright (`tickets: []`, a `notes[0]` explaining why) instead of scanning every groomed ticket. The
MCP tool enforces the same gate up front. There is deliberately **no `allTickets: true` override** — an
escape hatch is the bug with a permission slip; whoever truly wants everything can tag everything.

- **Tag selector** — every ticket carrying `opts.tag` (the opt-in convention is **`burn-furnace`**) enters
  the selection pool, **regardless of its current status** — unlike a plain status filter, a tagged ticket
  sitting in the wrong status is never silently dropped; see accounting below.
- **Explicit-ids selector** (`opts.tickets`) — the other selector, usable instead of or alongside `tag`.
  Named ids run through the **same curation** as a tag scan (parent/child exclusion, file-overlap flag +
  order-apart) — unlike the raw-CRUD REST/`furnace_ticket action:"add"` path, which loads ids as-is with no curation.
- **Full accounting** — every ticket that enters the selection pool lands in the result **exactly once**:
  in `tickets`, or in `excluded` with a concrete reason — `tagged but status <X> (not allowed)` (or `status
  <X> (not allowed)` for an explicit id), `already queued in batch <id>`, `parent of loaded ticket <id> —
  burning the independent leaf instead`, `capped by limit`, or `unknown ticket id`. Nothing tagged or named
  ever silently vanishes. `notes` leads with `⚠ N tagged ticket(s) NOT loaded — see excluded` whenever a tag
  scan drops anything, and echoes a non-default `statuses` override so a narrowed/widened scan window is
  never invisible.
- **One-active-batch invariant** — a ticket may belong to at most one non-terminal (`draft`/`burning`)
  batch at a time. `findActiveBatchFor(ticketId, batches)` is the shared check; `buildBatchTickets` excludes
  an already-queued-elsewhere ticket (reason `already queued in batch <id>`) rather than double-loading it,
  and the same check gates `furnace_ticket action:"add"` / `POST /:id/ticket` / the raw `POST /` and `PUT /:id`
  routes (via `validateBatchTickets`'s `activeBatches`/`excludeBatchId` options) — rejecting with the owning
  batch id instead of allowing a second queue.

Independence reasoning, unchanged:

- **Parent/child** (`excludeParentChildPairs`): a parent is excluded whenever any of its subtasks is also a
  candidate (detected via the parent's `subtasks` *or* a child's `parentId`) — burn the independent leaf,
  never both. Each exclusion is reported in `excluded[]` with a reason.
- **File overlap** (soft, `extractMentionedPaths` + pairwise): any file path (a `dir/file.ext` mention) shared
  by ≥2 kept tickets sets a `note` on each `BatchTicket`. It is **never** a hard exclude — each ticket burns
  in its own worktree; the only real risk is two PRs colliding at *human* merge time. `orderApart` then
  sequences the batch so overlapping tickets aren't adjacent in burn order when avoidable.
- **Cap** (`opts.limit`): applied last, after ordering — anything past the cap is excluded with reason
  `capped by limit`, not just silently truncated.

The editable proposal is materialized as a **`draft` batch** (created by `furnace_build`, MCP-only — see
below): `draft` is the editable-before-ignition state, mutated live via `furnace_update`, `furnace_ticket
action:"add"` / `action:"remove"`, and the S6 drawer.

## MCP tools (`engine/src/mcp-server.ts`)

- **`furnace_get`** — `{ runId? }` → one run (full magazine + config + report) or, without `runId`, every run.
- **`furnace_build`** — `{ tag?, tickets?, statuses?, limit?, kind?, burnRate?, title? }` → requires `tag` and/or `tickets` (FLUX-1051 — no selector, no build); builds a `draft` batch from the selection and returns `{ batchId, batch, excluded, notes }`.
- **`furnace_update`** — live-adjust a run's config: `burnRate`, `mode`, `reviewDepth`, `retryCap`, `hardStop`, `title`. Changes are honored on the next stoke tick. Does not ignite/pause/stop.
- **`furnace_batch`** (FLUX-1085 — folds `furnace_ignite`/`furnace_stop`/`furnace_resume`/`furnace_discard`) — `{ action, batchId, reason?, hard? }`:
  - `action: 'ignite'` → move a batch `draft`→`burning` and start burning. Enforces at most one active run.
  - `action: 'stop'` (`reason?`/`hard?` only valid here) → stop a batch. Default is a **graceful** stop (stop feeding, let in-flight charges drain, then → stopped); `hard: true` is an immediate cutoff (kill in-flight, park them, skip the rest).
  - `action: 'resume'` (FLUX-1066) → a halted/finished batch → `burning`: reset the breaker, clear the stop, re-queue halt-skipped tickets, claim a slot.
  - `action: 'discard'` (FLUX-1081) → permanently delete a batch; refuses a `burning` batch (stop it first). The cleanup path for a stale/superseded draft that a full `furnace_build` rebuild used to leave orphaned forever.
- **`furnace_ticket`** (FLUX-1085 — folds `furnace_retry`/`furnace_dismiss`/`furnace_takeover`/`furnace_handback`/`furnace_add_ticket`/`furnace_remove_ticket`) — `{ action, batchId, ticketId }`:
  - `action: 'retry'` (FLUX-1066) → reset a parked/failed ticket to `queued` with a fresh attempt budget; re-burns next tick if the batch is burning.
  - `action: 'dismiss'` (FLUX-1066) → clear the board flag + mark dismissed without re-queuing (works on a done batch).
  - `action: 'takeover'` (FLUX-1066) → owner → human; the Furnace yields (stops its session, keeps the worktree). Hand back with `action: 'handback'`.
  - `action: 'handback'` (FLUX-1070) → owner → furnace; re-queue a human-owned ticket with a fresh attempt budget, bypassing the pr-open/active-state guards (a human is deliberately returning it). Errors if the ticket is not currently human-owned — unlike `retry`, which has no such guard.
  - `action: 'add'` (FLUX-1081) → append one ticket to a batch (draft or burning) without a full rebuild; same existence/status gate as `furnace_build`, plus the one-active-batch invariant (FLUX-1051): rejected if the ticket is already queued in a different non-terminal batch.
  - `action: 'remove'` (FLUX-1081) → remove one ticket from a batch; disallowed while it is actively burning in a `burning` batch.

> **FLUX-1085 consolidation note:** these two tools replace 10 single-op tools (`furnace_ignite`, `furnace_stop`, `furnace_resume`, `furnace_discard`, `furnace_retry`, `furnace_dismiss`, `furnace_takeover`, `furnace_handback`, `furnace_add_ticket`, `furnace_remove_ticket`) — a hard cut, no old-name aliases. `furnace_get`/`furnace_build`/`furnace_update` were deliberately **not** folded in: their per-action param sets (read filters, build selectors, live-config knobs) are too heterogeneous to merge into one schema without hurting usability, unlike the two groups above where every merged action shares an (almost) identical signature. See the [MCP tools reference](mcp-tools.md#flux-1085-furnace-tool-consolidation-migration) for the full old→new mapping.

## The Stoker — the lifecycle loop (`engine/src/furnace-stoker.ts`)

The background loop that burns each charge. `startStoker()` (booted in `index.ts`) runs a tick every 5s that drives the single `burning` run; each tick:

1. **Reconciles** every in-flight charge — resolves its session (the recorded id, or adopts an active session for the task after a restart), then advances it.
2. **Feeds coal** — starts the next queued charge(s) up to the burn rate.
3. **Completes** the run when every charge is terminal.

The decision core is a **pure, exhaustively unit-tested** function `decideTicketAction(...)` → `wait | review | reimplement | pr-open | park | redrive | review-nudge`:

| Charge state | Session / verdict | Action |
|---|---|---|
| implementing/reimplementing | session running | `wait` |
| implementing/reimplementing | completed | `review` (unless the agent parked the ticket → `park`) |
| reviewing | completed + `reviewState: approved` | `pr-open` — **leave the PR open at Ready; never merge** |
| reviewing | completed + `changes-requested`, attempts < retryCap | `reimplement` |
| reviewing | completed + `changes-requested`, attempts = retryCap | `park` |
| reviewing | completed + no verdict, last comment matches the `**APPROVED**`/`**CHANGES NEEDED**` marker convention, not yet nudged | `review-nudge` — one corrective session told to call `change_status` (FLUX-1078) |
| reviewing | completed + no verdict, no marker (or already nudged once) | `park` (never falsely approve) |
| any active | `failed` + `terminalReason: context-exhausted`, retries left | `retry-exhausted` — re-drive the phase with a fresh session (FLUX-1047) |
| any active | `failed` + `terminalReason: rate-limited` | `cooldown-rate-limited` — enter `cooling-down`, **not** a park (FLUX-1063) |
| `cooling-down` | `now < nextRetryAt` | `wait` |
| `cooling-down` | retry window elapsed, under the max-wait ceiling | `retry-rate-limited` — restore the phase, spawn a fresh session |
| `cooling-down` | past the `rateLimitMaxWaitMs` ceiling | `park` — the limit never cleared; fail outright |
| any active | `failed`/`cancelled`/`waiting-input` session | `park` |
| any active | no observable session | `redrive` the current phase |

**Correctness safeguards:** ticks never overlap (a `ticking` guard); the charge state is advanced **before** a session is spawned so a crash mid-spawn can't double-dispatch (the next tick re-drives or adopts instead of re-deciding the old phase); `feedCoal` adopts an already-running session for a queued ticket rather than re-spawning; and the stale `reviewState` is cleared before each fresh review so a prior verdict is never mis-read. The core invariant — **approved ⇒ leave PR open, never `finish_ticket`** — is a guard in the executor, not a convention.

## Burn rate & modes (S4)

The Stoker keeps at most `effectiveConcurrency(run)` charges non-terminal at once:

| Mode | Effective concurrency | Notes |
|---|---|---|
| `sequential` | 1 | one charge at a time, regardless of `burnRate` |
| `parallel` | `min(burnRate, cap)` | up to `burnRate` charges burn at once |
| `parallel-implement-serial-review` | `min(burnRate, cap)` total | implementations fan out, but only **one** charge reviews at a time (`reviewSlotAvailable`) |
| `grouped-serial` | 1 | one charge at a time, and members of an overlap group stack onto **one shared branch/worktree/PR** (FLUX-1041) |

- **Worktree-cap clamp (v1 decision):** the effective rate is clamped to `FURNACE_WORKTREE_CAP` = `DEFAULT_MAX_TASK_WORKTREES` (4). The Furnace does **not** get its own higher cap (raising it changes engine-wide resource pressure); the S3 spawn-failure backstop handles an actually-exhausted cap. A stored `burnRate` above the cap is allowed but clamped at runtime, and `furnace_build`/`furnace_update` return a `warning` saying so.
- **Live adjustment:** `furnace_update` mutates `burnRate`/`mode` and the **next stoke tick honors it** — raise the rate to feed more coal; lower it and in-flight charges finish before new ones start (the tick never exceeds the new rate). No restart needed.

## Grouped same-branch mode — `grouped-serial` (FLUX-1041)

The default one-charge-one-branch model is ideal for **independent** tickets but the worst case for a
**coupled cluster** (e.g. six tickets that all edit `FurnaceScreen.tsx`): N PRs off the same baseline that
all conflict at merge time, and N worktree slots consumed. `grouped-serial` fixes both by burning a group
of related charges as **one stacked PR on one shared branch/worktree**.

- **Grouping** happens at build time — `furnace_build` with `mode: 'grouped-serial'` sets the builder's
  `groupOverlaps`, so overlap clusters become groups (`groupId` on each member). Edit membership/order in
  the magazine before igniting.
- **Shared branch/worktree** is the whole mechanism, and it needs **no new git plumbing**. Before the
  group's **anchor** (its lowest-`order` member) is dispatched, `ensureGroupBranchAssigned` pins every
  member's `task.branch` to one name (`flux/furnace-<runShort>-<groupId>`). Because `resolveTaskExecutionRoot`
  resolves a worktree **by branch**:
  - the anchor's isolated spawn **creates** that branch + the one shared worktree;
  - each **follower** dispatches **without** `isolation` (`dispatchSession({ skipIsolation })`) and reuses the
    anchor's worktree — so its commits stack on top. One branch, one worktree slot, one PR.
- **Strictly serial** (`effectiveConcurrency` = 1): member N+1 only starts after member N reaches `pr-open`,
  so it always stacks on committed work — never a half-finished base.
- **Failure halts the group:** when a grouped charge parks (review still failing past `retryCap`, a watchdog
  kill, a spawn failure), `parkCharge` marks the group's still-`queued` siblings **`skipped`** (stacking more
  work on a broken base is worse than stopping). Other groups and independent charges are untouched.
- **Per-ticket + shared-PR guard:** members share `task.branch`, so the shared-PR finish guard
  (`sharedNonDoneSiblings`, FLUX-556/569) already treats them as one PR — merging one member (a human action;
  the Furnace never merges) advances the set. No finish-guard change was needed.
- **v1 simplification:** per-charge review sees the **cumulative** branch diff (baseline = the group branch's
  merge-base), not a strictly commit-scoped diff — keeping the Stoker free of raw git. Commit-scoped review
  and post-PR worktree reclaim (with FLUX-1031) are follow-ups.

## Hard stops, watchdog & circuit breaker (S5)

Every stoke tick, before feeding, the Stoker enforces safety limits (`furnace-stoker.ts`):

- **Stop conditions** (`evaluateStopConditions`, pure): checked in priority order —
  1. **Circuit breaker** — `hardStop.maxConsecutiveFailures` (default 3) consecutive **hard-fail** parks → **hard** halt (assume a broken environment). `consecutiveFailures` increments only on a `hard-fail` park (`countsTowardBreaker`, FLUX-1066 M4 — a `needs-input` park is a legitimate human question and must not trip the breaker) and resets on a `pr-open` success.
  2. **Wall-clock** — `hardStop.at` (e.g. "stop at 07:00") → **soft** stop.
  3. **Max tickets** — `hardStop.maxTickets` terminal charges reached → **soft** stop.
  - A **soft** stop stops feeding new charges, lets in-flight charges drain to terminal, marks any never-started charges `skipped`, then → `stopped`. A **hard** cutoff kills in-flight sessions, parks them, skips the queued, and → `stopped` immediately.
- **Per-session watchdog** (`isSessionTimedOut`, pure + `runWatchdog`): a charge whose session outlives `config.sessionTimeoutMs` (default 45 min) is killed (process tree, via `stopAllSessionsForTask`) and parked. This is **Furnace-local** until FLUX-996 S1's unified hardened runner (timeout + non-interactive env + kill-tree) lands — an untimed `git`/`gh` hang is exactly the failure this guards against overnight. Per-charge: the run keeps burning.
- **Manual stop** (`furnace_batch action:"stop"`): graceful drain by default, `hard: true` for an immediate cutoff.

> **FLUX-996 gate:** because the watchdog is Furnace-local for now, the Furnace should not be advertised as "safe to run unattended all night" until FLUX-996 S1–S3 land. Ship it behind that gate.

## Rate-limit cooldown (FLUX-1063)

A usage/quota exhaustion (the 5-hour session limit, HTTP 429, an Anthropic overload) is **transient** — it clears at the provider's reset window — so the Furnace must not treat it like a hard crash. Without this, a batch that hits the limit mid-burn parks several charges and trips its own circuit breaker, needing manual re-ignition despite nothing being wrong with the work.

- **Detection (adapter).** On a terminal `is_error` result, `claude-code.ts` classifies the cause: `isRateLimitError` (matching "session/usage/rate limit", 429, quota, overloaded) — plus an explicit `api_error_status === 429` — sets `terminalReason: 'rate-limited'`. This is **disjoint** from `isContextExhaustionError` (a context overflow is recovered by a fresh session, not a cooldown). The 5-hour-limit payload hides the reason in `result` (`"You've hit your session limit …"`) with `subtype:"success"`, so the classifier inspects `result` + `api_error_status`, not just `error`.
- **Cooldown, not a park.** `decideTicketAction` turns a `rate-limited` failed session into `cooldown-rate-limited`: the charge moves to the **`cooling-down`** state (visibly distinct from a park — no `require-input` swimlane; the board gets an informational note, not a "needs a human" flag), records `rateLimitFirstSeenAt` (the ceiling clock) + `nextRetryAt`, and kills the dead session. It **does not** bump `attempts`/`retryCap`, `exhaustionAttempts`, or `consecutiveFailures` — a transient limit never false-trips the circuit breaker.
- **Auto-retry cadence.** A dedicated per-tick pass (`reconcileCooldown`) advances cooling-down charges: keep waiting until `nextRetryAt`, then `retry-rate-limited` — restore the pre-cooldown phase (impl / review / re-impl) and spawn a **fresh** session (no `--resume`). Retries repeat every `rateLimitRetryIntervalMs` (**default 20 min**) until the limit clears (the charge makes forward progress → cooldown fields cleared) or `rateLimitMaxWaitMs` (**default 5 h**) is exceeded, at which point it **parks/fails outright**.
- **Batch-wide feed pause (account-wide quota).** Quota is per-account, so a freshly-fed sibling would immediately 429 into the same limit. While **any** charge in a batch is `cooling-down`, `feedCoal` **pauses feeding new coal** entirely; in-flight charges are left to drain. Feeding resumes once the cooldown resolves.
- **Stop interaction.** A **hard** halt parks cooling-down charges (real work in flight); a **graceful** stop skips them (a stop must not block up to the multi-hour ceiling).
- **Config.** `rateLimitRetryIntervalMs` (20 min) and `rateLimitMaxWaitMs` (5 h) are global defaults in `configCache.furnaceSettings` (new batches inherit them) and per-batch overridable via `furnace_update` / `updateFurnaceBatch`.

## Reconciling controller, ownership handoff & failure taxonomy (FLUX-1066)

Early Furnace batches kept a per-ticket `state` the Stoker **wrote but never re-derived** from reality — a database pretending to be a controller. Anything outside the 5-second loop (a rate limit, an engine restart, a merge on GitHub, or a human opening the chat and driving a ticket) desynced it, leaving stale `parked` rows, undismissable flags, and phantom slot counts. FLUX-1066 reworks the Stoker into a **reconciling controller** (the Kubernetes pattern: desired vs observed, reconcile, repeat). The governing rule is **no dead ends** — every non-happy state renders its *cause* and at least one *next action*.

### 1. Reconcile against ground truth every tick + on read (`reconcileBatch`)

`reconcileBatch(batchId)` runs at the **top of every stoke tick** (before the watchdog / feed) and for **terminal batches** each drive cycle (the Stoker doesn't tick those) — always unthrottled, so ground truth still closes within one drive cycle. It is idempotent and cheap — it reads in-memory caches and writes only when something actually changed. For each ticket the Stoker is **not** actively driving (live impl/review is left to `reconcileTicket`'s normal flow), it closes the gap to intent from two sources of truth:

- **Board ticket status** (`tasksCache[id].status`) — a ticket a human took to **Ready / Done / Released / Archived** outside the Furnace flips to `pr-open`, its board flag drops, and (for a terminal batch) the burn report regenerates. It is never left stuck `parked`.
- **Merge detection for an already-`pr-open` charge (FLUX-1210)** — `pr-open` is terminal, so the Stoker's own job stops there and it never merges a PR. Nothing else used to notice when a human later merged it anyway (`finish_ticket`, a manual `gh pr merge`, or the portal Merge button) — the charge, `furnace_get`'s response, and the burn report all kept describing it as still awaiting review. `reconcileBatch` now also checks a `pr-open` charge's board status specifically for **`Done`/`Released`** (narrower than the `boardSuccess` set above — `Ready` is exactly what `pr-open` already represents, not a merge) and stamps `mergedAt` — `state` stays `pr-open`, this is annotation only. `assembleBurnReport` splits `prsOpened` accordingly into still-open vs `merged`, and the Smelter persona is instructed to check `mergedAt`/the report's `merged` bucket before describing a charge as needing review or suggesting a retry/re-ignite.
- **Live session registry** (`getActiveSessionsForTask`) — an **active non-Furnace session** (an ad-hoc chat/drive session — no Furnace `phase`, id not in the ticket's `sessionIds`) marks the ticket **owner: `human`** (move #2).
- **Worktree pool** (FLUX-1067, below) — slots are derived from the *actual* pool, never the Furnace's own burn count.

**Read-path TTL (FLUX-1145) + stale-while-revalidate (FLUX-1185).** Reads (`furnace_get`, `GET /api/furnace`, `GET /:id`) also reconcile against ground truth, but through `reconcileBatchCached`/`reconcileAllBatchesCached` — a 3s TTL + single-flight gate in front of the same `reconcileBatch`, mirroring `refreshWorktreePool`'s existing pool-refresh gate. The portal polls `GET /api/furnace` every ~3s — close enough to the 3s/1.5s TTLs that almost every poll landed past expiry, and the REST routes used to `await` the gated reconcile/pool-refresh before answering, paying the full pass inline (694-906ms measured in production). FLUX-1185 stopped the REST routes (`GET /`, `GET /slots`, `GET /:id`) from awaiting them: each now answers from the already-loaded batch/pool cache instantly and fires the gated reconcile/pool-refresh in the background (still TTL-gated + single-flighted, failures logged and swallowed rather than 500ing the read) for the *next* poll to pick up. `furnace_get` (the MCP tool) is unchanged and still awaits the gate — it's an on-demand agent call, not a hot poll path. The TTL only throttles *read-triggered* reconciliation — the drive-cycle tick above always calls `reconcileBatch` directly, so a ticket completed/taken over outside the Furnace is reflected within one tick regardless of read traffic, and a stale REST read is now bounded by (poll interval + background-refresh time), never lost.

**Spawn-window race (FLUX-1090).** `feedCoal` only writes a freshly-dispatched ticket's session id (`setInFlight`) *after* the spawn resolves — until then the ticket is still `queued`, which `reconcileBatch`'s active-state guard does not skip, so a concurrent reconcile (every tick, or a portal GET landing mid-spawn) could see the Furnace's own brand-new live session as a foreign one and misfire `owner: human`. Two defenses, applied in `feedCoal`/`reconcileBatch`:
- A `dispatching` set (ticket ids with a spawn in flight, in-memory only) makes `isHumanTakeover` short-circuit to `false` for the whole window between deciding to dispatch and `setInFlight` completing — added before `spawnOrCount`/the crash-adopt path, removed in a `finally`.
- Defense in depth: `reconcileBatch` only *acts* on a detected takeover once it holds on **two consecutive** reconcile passes (`suspectedHumanTakeover`) — a lone transient blip can never misfire ownership by itself.

### 2. Explicit ownership handoff (Furnace ⇄ Human)

Every ticket is owned by `furnace` (autonomous — an undefined `owner`) or `human` (taken over). Auto-detected on reconcile, or set explicitly via `furnace_ticket action:"takeover"` / the drawer's **Take over** control:

- **Furnace → Human:** a non-Furnace live session (or an explicit takeover) → the Furnace **yields**. `reconcileTicket`, `runWatchdog`, and finalization all skip a `human`-owned ticket, it is never parked under the human, and — because it sits at a non-terminal board status — the worktree-reclaim sweep leaves its worktree alone. `isSettledTicket` (terminal **or** human-owned) is what lets the batch finalize instead of wedging on a ticket the Furnace no longer drives. The drawer shows a **"you're driving this"** badge instead of a park. Both the explicit takeover AND the auto-detected one **clear the board `require-input` flag** (FLUX-1066 M1/B1) — a taken-over ticket must never keep an undismissable flag.
  - **Takeover detection** (`isHumanTakeover`) keys on session **identity, not phase** (M1): a genuinely live (`pending`/`running`) session on the ticket whose id is **not** in the Furnace's `sessionIds` is a human's — including a human-started `implementation`/`review` session. Stalled `waiting-input` stubs are **excluded** (an abandoned session must not flip ownership with no expiry).
  - **Auto ≡ explicit settling (FLUX-1090).** An auto-detected takeover (`reconcileBatch`) settles the ticket exactly like the explicit `takeoverTicket` action — for a `cooling-down` ticket it parks it (clears `currentSessionId`/`currentPhase`/`failureClass`, drops the cooldown clock) — minus stopping the session, since here it's the human's own. Before this fix the auto path only flipped `owner`, so a ticket caught by the spawn-window race stayed `implementing`/`reviewing` forever under `owner: human`, which then rejected hand-back as "still burning" with no live session left to stop — a dead end with no recovery.
- **Human → Furnace:** `furnace_ticket action:"handback"` (drawer **Hand back**) re-queues it under Furnace ownership with a fresh attempt budget (may re-burn even a `pr-open` ticket — the human is deliberately returning it). **FLUX-1090:** it also stops any still-live session for the ticket first (mirroring `takeoverTicket`'s use of this in the opposite direction) and its `retryTicket(force: true)` call bypasses *both* the `pr-open` guard (M2) and the still-burning/active-state guard — so a ticket stuck in an active state (a zombie from the spawn-window race, or a human who left a session running) can always be reclaimed instead of hitting a dead-end rejection.

### 3. Failure taxonomy — `failureClass` instead of one opaque `parked`

`decideTicketAction`'s park now carries a `failureClass`, and `parkTicket` rests the ticket accordingly:

| Class | Example | State | Handling |
|---|---|---|---|
| **transient** | rate limit / 429 | `cooling-down` | cooldown + auto-retry (FLUX-1063) — never reaches a park |
| **recoverable** | context exhausted | (in-flight) | fresh session (FLUX-1047) — never reaches a park |
| **needs-input** | review changes-requested past `retryCap`; agent left it in Require Input; waiting-input | `parked` | legit Require Input — a human decides. **Does NOT feed the circuit breaker** (M4) |
| **hard-fail** | crash/cancel, no-verdict, watchdog timeout, spawn failure, cooldown ceiling exceeded | `failed` | offer **Retry / Take over / Dismiss**. **Feeds the circuit breaker** (`countsTowardBreaker`) |

Both park classes raise the board `require-input` flag; the drawer badge (`needs input` amber vs `failed` red vs `you're driving` violet) and the burn report's `parked`/`failed` lists split by class.

### 4. Manual recovery actions (the escape hatch)

Exposed as REST (`POST /api/furnace/:id/...`), MCP tools, and drawer controls — so the orchestrator can unstick a batch it has no live UI for:

- **Retry a ticket** (`furnace_ticket action:"retry"` · `.../tickets/:ticketId/retry`) — reset a parked/failed ticket to `queued` with a **fresh attempt budget** (attempts / exhaustion / spawn-failure counters + cooldown all cleared), owner → `furnace`. Re-burns next tick if the batch is burning. **A `pr-open` ticket is REJECTED** (FLUX-1066 M2): it already succeeded, so re-burning would drop its open PR link and duplicate the work — dismiss its flag or take it over instead. Only the explicit **hand back** path (below) may re-burn a `pr-open` ticket.
- **Resume a batch** (`furnace_batch action:"resume"` · `.../resume`) — a halted (`parked`) or finished (`done`) batch → `burning`: resets `consecutiveFailures` (so the breaker doesn't re-trip), clears the stop request + stale report, re-queues tickets that were merely `skipped` by the halt, and claims a worktree slot (`no_slots` when the pool is full). Parked/failed tickets are **not** auto-re-queued — retry those individually; `pr-open` successes are preserved. The terminal **append guard** is relaxed so a `parked` batch can take new tickets before a resume.
- **Dismiss a flag** (`furnace_ticket action:"dismiss"` · `.../tickets/:ticketId/dismiss`) — clear the board flag + mark `flagDismissed` **without** re-queuing ("I've got this"). Works on a `done`/terminal batch too.
- **Take over / Hand back** (`furnace_ticket action:"takeover"` · `.../takeover`; `furnace_ticket action:"handback"` · `.../handback`) — move #2's explicit transitions.

## Worktree-slot count from the real pool (FLUX-1067)

The slot gauge (`used / free / max`) and the ignite/resume clamp derive `used` from the **actual live task-worktree pool** (`listTaskWorktrees`), refreshed each drive cycle and on every read/ignite via `refreshWorktreePool` → `setObservedWorktrees` (which records each worktree's **owning ticket id** via `ticketIdFromWorktreePath`, not just a count). `globalSlotsInUse` = `computeSlotsInUse(reservedTicketIds, observed)` sums the **independent** observed worktrees (those NOT backing a current Furnace reservation — a manually resumed / taken-over ticket) with the Furnace's own reservations (`furnaceReservedTicketIds` per burning batch), counting a reservation **once** whether or not its worktree is on disk yet.

This replaces the earlier `max(reservations, observed)` (FLUX-1066 M3): the two views are **disjoint sets, not nested**, so `max` undercounted whenever an independent/manual worktree coexisted with a freshly-claimed reservation not yet on disk (true total = the *sum* of the parts, but `max` reported only the larger) — letting an ignite over-spawn past the real pool. The identity-aware sum can neither undercount (a reservation with no on-disk worktree still counts) nor double-count (a reservation already on disk is counted once).

**The gauge is physical truth, not batch-state inference (FLUX-1157, replacing FLUX-1090).** FLUX-1090 tried to release a slot at batch finalize by *excluding* an observed worktree belonging to a ticket in a terminal (`done`/`parked`) batch from `globalSlotsInUse` — on the assumption that a finalized batch's worktree was reclaimed. Nothing guaranteed that: takeover semantics never delete the directory, a dirty tree (stray build artifacts) blocks reclaim, and a non-reclaimable ticket status leaves it on disk indefinitely. Observed in production: the gauge read `used: 0, free: 4` while `git worktree list` showed 4 live task worktrees (three with active sessions) — every batch that ignited into that "free" pool hard-failed at `createTaskWorktree`'s own independent cap within seconds. `globalSlotsInUse` now counts **every** observed worktree, full stop — no batch-state exemption. The real fix for FLUX-1090's problem is to actually **reclaim**, not discount: `igniteBatch`/`resumeBatch` run `reclaimReadyWorktrees` (the same Ready/terminal + no-live-session + clean-tree predicate the Ready-worktree sweep uses, `pr-cleanup.ts`) immediately before reconciling the pool, so a genuinely stale worktree really frees its slot before the count/claim happens. One that can't be reclaimed (dirty tree, live session, non-reclaimable status) correctly keeps holding it — which is the physical truth the clamp needs. When a claim still fails `no_slots`, the response/MCP error names the current holders and why reclaim skipped each one (`describeSlotHolders`) — a `live-session` / `recent-activity` / `status` / dirty-tree reason per ticket — so the drawer's no-slot popup and the MCP error text tell the user which ticket to finish/abandon/take over instead of leaving them to guess.

## The Smelter persona (FLUX-1175)

**Furnace Operator ("Smelter")** is a phase-agnostic **lead** persona (`id: 'smelter'`, `phases: []`,
`engine/src/orchestration-personas.ts`) that owns the Furnace end-to-end: it plans a burn (surveys the
backlog for groomed/independent/furnace-safe candidates, checks `get_board_state` for live human sessions
before igniting — the slot pool doesn't account for those, see FLUX-1067 above — then builds/tunes a batch
with `furnace_build`/`furnace_update`) and troubleshoots a stalled one (reads `furnace_get` + a parked
ticket's `get_session_log`, classifies the failure, repairs the plan, then `furnace_ticket action:"retry"`
or a crisp `ask_user_question`). It is the counterpart to the Epic Decomposer persona (FLUX-1176), which
recommends a batch shape but never calls a `furnace_*` tool itself — building and running the batch is the
Smelter's job.

**Authority mode.** `config.furnaceSettings.smelterMode` (`'drafting'` default | `'operator'`) is composed
into the Smelter's resolved prompt at launch (`resolvePersonaPrompt`'s `SMELTER_MODE_CONTRACTS`, keyed by
this setting rather than by launch phase — the phase-keyed `PHASE_CONTRACTS` mechanism, FLUX-1170, doesn't
apply to `role: 'lead'` personas):
- **Drafting** (manual) — full authority over `draft` batches (`furnace_build`/`furnace_update`), but any
  real-execution call (`furnace_batch` ignite/stop/resume/discard, `furnace_ticket retry`) requires an
  `ask_user_question` confirmation first.
- **Operator** (autonomous) — once asked to manage a burn, full lifecycle authority with no per-action
  confirmation; still raises a question for a genuinely ambiguous or destructive call outside the normal
  burn lifecycle.

**Drawer entry point.** The portal's Furnace drawer (`FurnaceDrawer.tsx`) has a **Chat with Smelter** button
+ a drafting/operator toggle. There is no ticket-independent, non-`__board__` conversation surface in the
portal, so the chat rides on the existing board-orchestrator conversation (`BOARD_CONVERSATION_ID`) rather
than a new sentinel: the button calls `startTaskCliSessionEx(BOARD_CONVERSATION_ID, { personaId: 'smelter', phase: 'chat', ... })`,
and the engine's `__board__` branch of `POST /:id/cli-session/start` (`routes/cli-session.ts`) resolves the
persona server-side and passes it as `SendInputOptions.personaPrompt` to `startBoardSession` — which
threads it into `buildBoardPrompt`'s `identity` override (`board-core.ts`) in place of the default
board-orchestrator identity block for that turn's opening message. Since the board is a single persistent
conversation, starting a Smelter chat supersedes whatever board conversation was previously idle there
(the same behavior a fresh Orchestrator chat already has) — a persona's identity is established once, on
the opening turn, exactly like a per-ticket persona launch.

## Portal view (S6)

`portal/src/components/FurnaceScreen.tsx` (route `/furnace`, `Flame` nav item, purple/violet tint) is the live view. It owns its own run state — an initial `GET /api/furnace` plus the `subscribeToEvent('furnace-updated' | 'furnace-deleted')` bus (the single shared EventSource in `AppContext`), with a 4s poll as a fallback — so **no `appStore` change** was needed. It shows the ignited-or-latest run as sectioned lanes: **Needs you** (parked/failed) → **PRs waiting** (pr-open, with PR links + an approved badge) → **Burning** (implementing/reviewing/reimplementing, phase + attempt) → **Magazine** (queued, with reorder/remove) → **Skipped**. A finished run renders its burn report (S7) as the resting state. Controls: Ignite / Pause / Resume / Stop (contextual to run status), a burn-rate slider (1..cap, `PUT` config), and per-charge reorder (up/down) + remove (`PUT` magazine). A cold Furnace shows a **Build a magazine** action (`POST /api/furnace/build`). Design follows the rev-3 mockup: professional, **no emoji** — a clean `Flame` mark, square colour-dot section headers, the dedicated `--eh-furnace-accent` (purple/violet #7c3aed) / Geist / stone tokens, and per-state pill colours.

## Burn report (S7)

When a run reaches a terminal state — magazine drained (`completed`), soft-stop drained, or hard cutoff
(`stopped`) — every path funnels through one `finalizeRun(runId, status)` that stamps the run's `status`
+ `endedAt` + a `report` (`assembleBurnReport`, pure) and fires a first-class **`completion`
notification** (`addNotification`) so the morning digest surfaces on the board without opening the Furnace
view. The `FurnaceReport` carries: counts by final state; `prsOpened` (with PR links, still awaiting
merge); `merged` (FLUX-1210: `pr-open` charges already merged outside the Furnace — split out of
`prsOpened`, same shape); `parked`/`failed` (with reasons from each charge's note); `processed`;
`durationMs` (ignite → end); `breakerTripped`; `stopReason`; and `nextActions` (review N PRs / unblock N
parked / investigate N failed / check the environment if the breaker tripped — the PR count only
reflects `prsOpened`, not `merged`). The S6 view renders the report as the run's resting state.

## Realtime events (SSE `/api/events`)

- **`furnace-updated`** — `{ id, run }` on any create/mutate; the portal Furnace view (S6) re-renders from it.
- **`furnace-deleted`** — `{ id }`.

## Dependency: FLUX-996 (stability)

An overnight runner is the most exposed consumer of the untimed-git-hang problem tracked in FLUX-996.
Until FLUX-996 S1 (the unified hardened git/`gh` runner) lands, the Furnace watchdog (S5) imposes its own
per-session timeout + kill so a hung `git`/`gh` call can't stall the run all night.

## See also

- [Code Map](../architecture/code-map.md) — `models/furnace.ts` + `furnace-store.ts`.
- [Reference: MCP tools](mcp-tools.md) · [Reference: REST API](rest-api.md) · [Reference: realtime channels](realtime-channels.md)

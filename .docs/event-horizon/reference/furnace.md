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
| `reviewPersonaId?` | `string` | `senior-dev` | reviewer for `single` depth |
| `sessionTimeoutMs?` | `number` | 45 min | per-session watchdog (S5; Furnace-local until FLUX-996 S1's hardened runner lands) |
| `rateLimitRetryIntervalMs` | `number` | 20 min | how often a rate-limited (`cooling-down`) charge auto-retries (FLUX-1063) |
| `rateLimitMaxWaitMs` | `number` | 5 h | ceiling a charge may stay in rate-limit cooldown before failing outright (FLUX-1063) |

### Core invariant
**Approved ⇒ leave the PR open at `Ready`, mark the charge `pr-open`, and pull the next charge — never call `finish_ticket`.** Encoded as a guard in the Stoker (S3), not just a convention.

### PR-review mirroring (FLUX-1033)
The reviewer's verdict is also posted onto the **real GitHub PR** so approval/rejection is visible on the PR itself (a green check / a "changes requested" review), not only inside EH. When the charge leaves `reviewing`, the Stoker computes what to mirror via the pure `pickPrReview` (`furnace-stoker.ts`) and calls `postPrReview` (`branch-manager.ts`) once per verdict: **approved ⇒ `gh pr review --approve`**, **changes-requested ⇒ `gh pr review --request-changes`** (the latter fires per-member whether the charge then re-implements or parks). Both link back to the ticket's EH review comment.

**Group-aware approval (grouped-serial shared PR).** In `grouped-serial` mode a whole group shares **one** PR that keeps accumulating commits until its **last** member finishes, so a per-charge `--approve` is wrong there — it would green-check an incomplete PR and, worse, leave a bogus approval standing if a later member is parked/changes-requested. The gate:
- **Single / parallel mode** (1 ticket = 1 PR): per-charge `--approve` on approval — unchanged.
- **Grouped-serial:** the real `--approve` fires **once**, only when the approved charge is the group's **final member** (highest `order`) **and every other member is already approved**. A **non-final** member's approval instead posts a plain `gh pr review --comment` (visible progress, never a formal approval). If any earlier member wasn't approved (e.g. parked/skipped), the final approve is withheld too — the shared PR never shows "approved" over work a member rejected.
- **`--request-changes`** always fires **per-member** on rejection (the PR genuinely isn't mergeable; in grouped mode that member also halts the rest of the group).

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
| `POST` | `/api/furnace` | create a `building` run (`{ config?, magazine?  \| ticketIds?, title? }`) |
| `POST` | `/api/furnace/build` | build a magazine from the backlog + create a `building` run → `{ run, excluded, notes }` |
| `POST` | `/api/furnace/:id/ignite` | ignite the run (building/paused → burning); enforces ≤1 active run |
| `POST` | `/api/furnace/:id/pause` | pause a burning run (→ paused; the tick halts feeding + advancement) |
| `POST` | `/api/furnace/:id/resume` | resume a paused run (→ burning) |
| `POST` | `/api/furnace/:id/stop` | stop the run (→ stopped); `{ reason?, hard? }` (graceful drain by default) |
| `PUT` | `/api/furnace/:id` | patch **config / magazine / title only** — `status` is NOT patchable (all transitions go through ignite/pause/resume/stop, which enforce the guards + single-active invariant — FLUX-1008 M2). A title rename on a **draft** batch also recomputes its derived `branch` (`batchBranchName`) since no worktree/branch ref exists yet; once burning/terminal the branch is fixed and the rename is display-only (FLUX-1062). |
| `DELETE` | `/api/furnace/:id` | delete a run (409 if it is burning/paused) |

## Curation & independence — the magazine builder (`engine/src/furnace-builder.ts`)

`buildMagazine(tickets, opts)` is a **pure, deterministic** function (no LLM) that turns the groomed
backlog into a proposed magazine. The REST/MCP layer passes `Object.values(tasksCache)`; it returns
`{ entries, excluded, notes }`:

- **Candidates** = tickets in a groomed status (default `Todo`; `opts.statuses` overrides), optionally
  filtered by `opts.tag` (an `overnight`/`furnace` opt-in hint) / `opts.excludeTags`, capped by `opts.limit`.
- **Parent/child** (`excludeParentChildPairs`): a parent is excluded whenever any of its subtasks is also a
  candidate (detected via the parent's `subtasks` *or* a child's `parentId`) — burn the independent leaf,
  never both. Each exclusion is reported in `excluded[]` with a reason.
- **File overlap** (soft, `extractMentionedPaths` + pairwise): any file path (a `dir/file.ext` mention) shared
  by ≥2 candidates sets an `overlapWarning` on each. It is **never** a hard exclude — each charge burns in its
  own worktree; the only real risk is two PRs colliding at *human* merge time. `orderApart` then sequences the
  magazine so overlapping charges aren't adjacent in burn order when avoidable.
- **Overlap clustering** (`opts.groupOverlaps`, FLUX-1041): the inverse of `orderApart`. Instead of spreading
  overlapping charges apart, `clusterByOverlap` computes the **connected components** of the file-overlap graph
  (transitive closure), assigns each ≥2-member cluster a shared `groupId` (`g1`, `g2`, …), and emits its members
  **contiguously** in burn order. The build/`furnace_build` layer turns this on automatically when `mode` is
  `grouped-serial`. Independent charges are untouched; a cluster left with a single surviving member after the
  cap loses its `groupId`. This is what feeds grouped-serial mode's shared-branch stacking (see below).

The editable proposal is materialized as a **`building` run** (created by `furnace_build` / `POST /api/furnace/build`):
`building` is the editable-before-ignition state, mutated live via `furnace_update` and the S6 view. (This deliberately
does **not** reuse `proposeBoardRebase`, whose items are board verbs; the board-rebase editable-list *interaction* only
informs the S6 magazine editor.)

## MCP tools (`engine/src/mcp-server.ts`)

- **`furnace_get`** — `{ runId? }` → one run (full magazine + config + report) or, without `runId`, every run.
- **`furnace_build`** — `{ tag?, statuses?, limit?, burnRate?, mode?, title? }` → builds a magazine from the backlog and creates a `building` run; returns `{ runId, run, excluded, notes }`.
- **`furnace_update`** — live-adjust a run's config: `burnRate`, `mode`, `reviewDepth`, `retryCap`, `hardStop`, `title`. Changes are honored on the next stoke tick. Does not ignite/pause/stop.
- **`furnace_ignite`** — `{ runId }` → move a run `building`→`burning` and start burning. Enforces at most one active run.
- **`furnace_stop`** — `{ runId, reason?, hard? }` → stop a run. Default is a **graceful** stop (stop feeding, let in-flight charges drain, then → stopped); `hard: true` is an immediate cutoff (kill in-flight, park them, skip the rest).
- **`furnace_retry`** (FLUX-1066) — `{ batchId, ticketId }` → reset a parked/failed ticket to `queued` with a fresh attempt budget; re-burns next tick if the batch is burning.
- **`furnace_resume`** (FLUX-1066) — `{ batchId }` → a halted/finished batch → `burning`: reset the breaker, clear the stop, re-queue halt-skipped tickets, claim a slot.
- **`furnace_dismiss`** (FLUX-1066) — `{ batchId, ticketId }` → clear the board flag + mark dismissed without re-queuing (works on a done batch).
- **`furnace_takeover`** (FLUX-1066) — `{ batchId, ticketId }` → owner → human; the Furnace yields (stops its session, keeps the worktree). Hand back with `furnace_retry`.

## The Stoker — the lifecycle loop (`engine/src/furnace-stoker.ts`)

The background loop that burns each charge. `startStoker()` (booted in `index.ts`) runs a tick every 5s that drives the single `burning` run; each tick:

1. **Reconciles** every in-flight charge — resolves its session (the recorded id, or adopts an active session for the task after a restart), then advances it.
2. **Feeds coal** — starts the next queued charge(s) up to the burn rate.
3. **Completes** the run when every charge is terminal.

The decision core is a **pure, exhaustively unit-tested** function `decideChargeAction(...)` → `wait | review | reimplement | pr-open | park | redrive`:

| Charge state | Session / verdict | Action |
|---|---|---|
| implementing/reimplementing | session running | `wait` |
| implementing/reimplementing | completed | `review` (unless the agent parked the ticket → `park`) |
| reviewing | completed + `reviewState: approved` | `pr-open` — **leave the PR open at Ready; never merge** |
| reviewing | completed + `changes-requested`, attempts < retryCap | `reimplement` |
| reviewing | completed + `changes-requested`, attempts = retryCap | `park` |
| reviewing | completed + no verdict | `park` (never falsely approve) |
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
- **Manual stop** (`furnace_stop`): graceful drain by default, `hard: true` for an immediate cutoff.

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

`reconcileBatch(batchId)` runs at the **top of every stoke tick** (before the watchdog / feed), for **terminal batches** each drive cycle (the Stoker doesn't tick those), and on **every read** (`furnace_get`, `GET /api/furnace`, `GET /:id`). It is idempotent and cheap — it reads in-memory caches and writes only when something actually changed. For each ticket the Stoker is **not** actively driving (live impl/review is left to `reconcileTicket`'s normal flow), it closes the gap to intent from two sources of truth:

- **Board ticket status** (`tasksCache[id].status`) — a ticket a human took to **Ready / Done / Released / Archived** outside the Furnace flips to `pr-open`, its board flag drops, and (for a terminal batch) the burn report regenerates. It is never left stuck `parked`.
- **Live session registry** (`getActiveSessionsForTask`) — an **active non-Furnace session** (an ad-hoc chat/drive session — no Furnace `phase`, id not in the ticket's `sessionIds`) marks the ticket **owner: `human`** (move #2).
- **Worktree pool** (FLUX-1067, below) — slots are derived from the *actual* pool, never the Furnace's own burn count.

### 2. Explicit ownership handoff (Furnace ⇄ Human)

Every ticket is owned by `furnace` (autonomous — an undefined `owner`) or `human` (taken over). Auto-detected on reconcile, or set explicitly via `furnace_takeover` / the drawer's **Take over** control:

- **Furnace → Human:** a non-Furnace live session (or an explicit takeover) → the Furnace **yields**. `reconcileTicket`, `runWatchdog`, and finalization all skip a `human`-owned ticket, it is never parked under the human, and — because it sits at a non-terminal board status — the worktree-reclaim sweep leaves its worktree alone. `isSettledTicket` (terminal **or** human-owned) is what lets the batch finalize instead of wedging on a ticket the Furnace no longer drives. The drawer shows a **"you're driving this"** badge instead of a park. Both the explicit takeover AND the auto-detected one **clear the board `require-input` flag** (FLUX-1066 M1/B1) — a taken-over ticket must never keep an undismissable flag.
  - **Takeover detection** (`isHumanTakeover`) keys on session **identity, not phase** (M1): a genuinely live (`pending`/`running`) session on the ticket whose id is **not** in the Furnace's `sessionIds` is a human's — including a human-started `implementation`/`review` session. Stalled `waiting-input` stubs are **excluded** (an abandoned session must not flip ownership with no expiry).
- **Human → Furnace:** `furnace_handback` (drawer **Hand back**) re-queues it under Furnace ownership with a fresh attempt budget (may re-burn even a `pr-open` ticket — the human is deliberately returning it).

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

- **Retry a ticket** (`furnace_retry` · `.../tickets/:ticketId/retry`) — reset a parked/failed ticket to `queued` with a **fresh attempt budget** (attempts / exhaustion / spawn-failure counters + cooldown all cleared), owner → `furnace`. Re-burns next tick if the batch is burning. **A `pr-open` ticket is REJECTED** (FLUX-1066 M2): it already succeeded, so re-burning would drop its open PR link and duplicate the work — dismiss its flag or take it over instead. Only the explicit **hand back** path (below) may re-burn a `pr-open` ticket.
- **Resume a batch** (`furnace_resume` · `.../resume`) — a halted (`parked`) or finished (`done`) batch → `burning`: resets `consecutiveFailures` (so the breaker doesn't re-trip), clears the stop request + stale report, re-queues tickets that were merely `skipped` by the halt, and claims a worktree slot (`no_slots` when the pool is full). Parked/failed tickets are **not** auto-re-queued — retry those individually; `pr-open` successes are preserved. The terminal **append guard** is relaxed so a `parked` batch can take new tickets before a resume.
- **Dismiss a flag** (`furnace_dismiss` · `.../tickets/:ticketId/dismiss`) — clear the board flag + mark `flagDismissed` **without** re-queuing ("I've got this"). Works on a `done`/terminal batch too.
- **Take over / Hand back** (`furnace_takeover` · `.../takeover`; `.../handback`) — move #2's explicit transitions.

## Worktree-slot count from the real pool (FLUX-1067)

The slot gauge (`used / free / max`) and the ignite/resume clamp derive `used` from the **actual live task-worktree pool** (`listTaskWorktrees`), refreshed each drive cycle and on every read/ignite via `refreshWorktreePool` → `setObservedWorktrees` (which records each worktree's **owning ticket id** via `ticketIdFromWorktreePath`, not just a count). `globalSlotsInUse` = `computeSlotsInUse(reservedTicketIds, observed)` sums the **independent** observed worktrees (those NOT backing a current Furnace reservation — a manually resumed / taken-over ticket) with the Furnace's own reservations (`furnaceReservedTicketIds` per burning batch), counting a reservation **once** whether or not its worktree is on disk yet.

This replaces the earlier `max(reservations, observed)` (FLUX-1066 M3): the two views are **disjoint sets, not nested**, so `max` undercounted whenever an independent/manual worktree coexisted with a freshly-claimed reservation not yet on disk (true total = the *sum* of the parts, but `max` reported only the larger) — letting an ignite over-spawn past the real pool. The identity-aware sum can neither undercount (a reservation with no on-disk worktree still counts) nor double-count (a reservation already on disk is counted once).

## Portal view (S6)

`portal/src/components/FurnaceScreen.tsx` (route `/furnace`, `Flame` nav item, purple/violet tint) is the live view. It owns its own run state — an initial `GET /api/furnace` plus the `subscribeToEvent('furnace-updated' | 'furnace-deleted')` bus (the single shared EventSource in `AppContext`), with a 4s poll as a fallback — so **no `appStore` change** was needed. It shows the ignited-or-latest run as sectioned lanes: **Needs you** (parked/failed) → **PRs waiting** (pr-open, with PR links + an approved badge) → **Burning** (implementing/reviewing/reimplementing, phase + attempt) → **Magazine** (queued, with reorder/remove) → **Skipped**. A finished run renders its burn report (S7) as the resting state. Controls: Ignite / Pause / Resume / Stop (contextual to run status), a burn-rate slider (1..cap, `PUT` config), and per-charge reorder (up/down) + remove (`PUT` magazine). A cold Furnace shows a **Build a magazine** action (`POST /api/furnace/build`). Design follows the rev-3 mockup: professional, **no emoji** — a clean `Flame` mark, square colour-dot section headers, the dedicated `--eh-furnace-accent` (purple/violet #7c3aed) / Geist / stone tokens, and per-state pill colours.

## Burn report (S7)

When a run reaches a terminal state — magazine drained (`completed`), soft-stop drained, or hard cutoff
(`stopped`) — every path funnels through one `finalizeRun(runId, status)` that stamps the run's `status`
+ `endedAt` + a `report` (`assembleBurnReport`, pure) and fires a first-class **`completion`
notification** (`addNotification`) so the morning digest surfaces on the board without opening the Furnace
view. The `FurnaceReport` carries: counts by final state; `prsOpened` (with PR links); `parked`/`failed`
(with reasons from each charge's note); `processed`; `durationMs` (ignite → end); `breakerTripped`;
`stopReason`; and `nextActions` (review N PRs / unblock N parked / investigate N failed / check the
environment if the breaker tripped). The S6 view renders the report as the run's resting state.

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

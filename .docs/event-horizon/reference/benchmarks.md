# Benchmarks — reference (FLUX-1739)

Run the **same seed task many times under different agent configurations** and score each run the way
SWE-bench does: a held-out validation command either passes or it doesn't. Then measure the other
half — **where EventHorizon itself got in the way**.

The idea the whole design rests on: **the score is not a judgment, it is an exit code** from a command
the agent could not tamper with.

---

## Manifest

`POST /api/benchmarks`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Optional; generated when absent. |
| `seedTitle` | string | Title stamped on each throwaway `BENCH-n` ticket. |
| `seedPrompt` | string | **The task.** Identical across every cell — that is what makes cells comparable. |
| `baseCommit` | string | A commit **SHA**, never a branch name. Rejected otherwise. |
| `validation` | object? | `{ command, args, paths, timeoutMs }`. Absent ⇒ telemetry-and-friction only, no verdict. |
| `matrix` | `BenchmarkCell[]` | `{ framework, model?, effortOverride?, phase }`. |
| `repetitions` | int ≥ 1 | Runs per cell. |
| `concurrency` | int? | Default **2**, clamped to a ceiling of **3** (`DEFAULT_MAX_TASK_WORKTREES − 1`). |
| `wallClockBudgetMs` | int? | Per-run budget; also sizes the collection guard's TTL. |

`validation.command` and `validation.args` are **split** because the runner spawns them
`execFile`-shaped and **never through a shell**. `validation.paths` is the **held-out** set.

**Rejected before any process spawns:** empty matrix, duplicate cells, non-positive or non-integer
`repetitions`, unknown framework, a `baseCommit` that is not SHA-shaped or does not resolve, a
`validation` block with no held-out paths.

### Not v1 dimensions

Review count/depth (`gatePolicy`/`planReviewDepth` are **board-global**, so sweeping them mutates
shared config between cells and breaks isolation) and model **tier** (reachable only via `taskKey` —
pass a raw `model` string). Follow-ups, not silent drops.

---

## Run identity

`runId = sha256(suiteId + baseCommit + serializedCell + repetitionIndex)`, truncated.

Timestamps, pids, ticket ids and outputs are recorded as **data** and never feed identity, so
re-expanding one manifest reproduces the same run set with the same ids — which is what makes two
reports comparable. Cell serialization uses a **fixed field order**, not `Object.keys`, so identity
does not depend on how the manifest was parsed.

---

## Starting a benchmark from the portal — the seed registry

`bench/seeds/*.json` (prompts beside them as `.md`) is the curated list of tasks a suite can be
started from. A seed fixes everything a comparison must hold constant — `baseRef` (branch or commit,
resolved to a commit at creation and pinned), the prompt (`seedPrompt`, or `promptFile`, with
`{{ticketBody}}` filled from `ticketId`), the held-out `validation`, the `regression` check, a
`defaultMatrix`, repetitions, concurrency, budget, and `notes` for the picker. `track` is `fix`
(held-out regression test decides) or `build` (held-out acceptance harness decides, quality judged
beside it).

- `GET /api/benchmarks/seeds` lists them with `baseCommit` resolved (or `resolveError`).
- `POST /api/benchmarks/from-seed` (`seedId`, optional `suiteId`, `matrix`, `repetitions`,
  `concurrency`, `wallClockBudgetMs`, `calibrate` default true, `start`) creates the suite, calibrates
  inline, and starts it fire-and-forget. A seed whose held-out check does not fail at base is created
  but refused a start, with the reason in `refusedStart`.
- The portal's **New benchmark** panel on the Benchmarks screen is this route as a form: pick a seed,
  edit only the configurations (framework / model / effort), repetitions, concurrency and budget.

Seed files are reviewed and versioned like any other fixture; CLI names live in seed files, never in
engine code outside `agents/` (the adapter-boundary guard enforces this).

## The build track and run artefacts

A `track: "build"` seed asks the agent to build a small complete product from a spec (the first is
the Tower Defense task in the standalone `eh-gauntlet` workspace). The held-out check is an acceptance
harness (Playwright driving a documented contract) rather than a regression test, so the L1 verdict
stays a deterministic fail-to-pass bit. What differs is what is kept: a build seed lists `artifacts`
(worktree-relative paths, e.g. the harness's screenshots and the built `game/`), which collection
copies into `<benchmarks dir>/artifacts/<suiteId>/<runId>/` **before** teardown removes the worktree
and records on the run as `artifacts[]`. `GET /api/benchmarks/:id/artifacts/:runId/<path>` serves them (path form, so a built page's relative `./game.js` resolves inside the same artefact directory; sub-resources without `?ws=` are located by scanning open boards for the `(suiteId, runId)` directory; `?p=<path>` still accepted)
(path-guarded to the run's directory; HTML gets a CSP that blocks network access), and the run row
shows screenshot thumbnails and a **Play this build** link. Quality is judged from those beside the
verdict, never folded into it.

## Authoring a seed

A seed is a `bench/<ticket>-holdout` branch: the pre-fix commit plus ONE commit adding the held-out
test. Three traps, each observed to cost every run in a suite minutes and to split otherwise identical
runs on a choice the task never posed:

- **The held-out test must pass every gate the agent is told to run**, at base, except the assertion
  it exists to fail. Register it in `engine/test-tiers.json` if `check:classify` would detect it as a
  spawn/fixture test (`node engine/scripts/classify-tests.mjs --check` on the seed branch). Derive
  CLI names from `CLI_CAPABILITIES` — a `framework: 'claude'` literal outside `engine/src/agents/`
  fails `check:boundary` on a file the agent is forbidden to touch.
- **The regression command must be green at base with the held-out paths removed** (calibration
  records it). A held-out test that references the API the fix introduces cannot type-check before
  the fix; that is fine because the regression check parks the held-out paths, but a red baseline for
  any *other* reason blinds the check.
- **Behavioural assertions, not structural ones.** The seed prompt names the fix shape from the
  ticket; the test should still pass an equivalent implementation. Copying the fix's own test is the
  quickest start and is acceptable when the ticket plan prescribes the interface.

Prefer recent fixes (weeks, not months) so the shared `node_modules` still matches the base tree.

## Calibration — the fail-to-pass precondition

`POST /api/benchmarks/:id/calibrate` runs the validation command at `baseCommit`, in a detached
throwaway worktree, **with no agent**. It must **fail**.

`start` is refused until a calibration exists **for the current `baseCommit`** and shows the seed
failing there. Keyed on the commit because re-pinning invalidates the old calibration.

A seed whose validation already passes at base scores every configuration 100% and measures nothing —
and that is **invisible in the report**, because a uniformly perfect matrix reads as a great result
rather than a broken benchmark. Neither a timeout nor a spawn failure counts as `failsAtBase`.

---

## The scoring ladder

### L0 — primitives, recorded never scored

Session status and durable outcome, validation exit code, duration, tokens, `costUSD`, change size,
failure class. **Absent token/cost data is `null`, never `0`** — a run whose telemetry was lost is not
a free run.

### L1 — the run verdict

`solved` requires **all three**: a normal terminal state, a **non-empty diff**, and validation passing
against the **restored** tree. No `validation` block ⇒ `solved` is `undefined`, not `false`: *we did
not check* is not *it failed*.

### Attrition

Five **infrastructure** classes leave every rate's denominator entirely and are reported as attrition:
`unavailable`, `auth`, `rate-limit`, `crash`, `cancelled`. Scoring a provider down for being
rate-limited measures the network, not the agent. `timeout`, `validation-failed` and `config-invalid`
stay in the denominator.

### The regression check — "did it break anything else?"

A suite may carry a second, **broader** command (`regression: { command, args, timeoutMs }`, typically
the project's real test suite or type-check). It answers a different question from the held-out
`validation` ("did it fix the thing") and is deliberately **not a fourth clause of `solved`** — "did
not fix the bug" and "fixed the bug but broke the build" call for different responses, so the portal
shows the second as its own outcome, *solved · broke the build*.

- **Compared against a recorded baseline, never against zero.** Calibration runs the broader command
  at `baseCommit` and stores its exit code on the manifest (`regression.baselineExitCode`). A run is
  `regressed` only when its exit code differs from the baseline *and* is non-zero; a repo already red
  at base cannot have that redness blamed on the run.
- **Runs on the restored tree**, after the held-out paths are put back from `baseCommit`, so an edit
  to the held-out check cannot make the broader suite look green either.
- **Held-out paths are removed for the duration of the check**, at calibration and at run time alike.
  They are the seed's own check, not "anything else" — and a held-out test that references the API
  the fix introduces cannot even compile at base (observed on the FLUX-1700 seed), which would make
  the baseline red and a real regression indistinguishable from it. The paths are parked outside the
  tree and returned exactly afterwards.
- Recorded on the run as `regression: ValidationOutcome` and `regressed: boolean`; the analyst brief
  carries the failing tail.

### Harness failures are attrition

When the harness itself cannot judge the work — the held-out restore from `baseCommit` does not
apply, for instance — the outcome carries `harnessError`, `deriveSolved` returns *undefined*, and the
run is classified `crash` (attrition). It never scores `solved: false`: that would charge the agent
for the harness's failure. Observed live on a worktree husk left behind by a failed teardown.

### Re-deriving friction

Friction rules evolve (the Ready-hand-off heuristic, the working-status rule). Each run freezes the
ticket state it ended with (`taskView`: status, needsAction, swimlane, session count, input tokens)
because the archive that follows collection clears `needsAction`. `POST /api/benchmarks/:id/report`
with `{ "recomputeFriction": true }` re-derives every finished run's friction from the transcript,
the durable progress and that snapshot under the current rules, then rebuilds the report. Runs
collected before the snapshot existed keep their stored friction and are listed in
`frictionNotRecomputed`. The L1 verdict is never touched.

### Cleanup — run branches are for recollection, then they go

`POST /api/benchmarks/:id/cleanup` deletes the LOCAL run branches a finished suite no longer needs:
those of `completed` runs and scored failures, whose evidence (changed paths, validation output,
cost, duration) is already on the record. A `crash` run keeps its branch — that is the case
recollection exists for — as does any run still in flight or still holding a worktree. Refused while
the suite is running; never touches the remote (run branches are never pushed). Each removed run is
stamped `branchRemovedAt`, after which it is no longer recollectable.

### Recollection — a collector bug must never decide a run's score

`POST /api/benchmarks/:id/recollect` (body: optional `runIds[]`) re-runs collection for runs whose
agent finished but whose collection crashed — by default every `failed`/`crash` run that has a
branch. The evidence is durable (teardown commits the diff onto the run's branch; cost and duration
live on the ticket), so the worktree is recreated from the branch if teardown already removed it, the
prior verdict is cleared, and the same collect → teardown → archive sequence runs again. Refused while
the suite is running. Observed need: an `EXDEV` in held-out parking scored two solved runs as crashes.

### L2 — per cell, over its `n` **scored** runs

| Metric | Definition / rule |
|---|---|
| `solveRate` | solved / scored. `null` when `n = 0`. |
| `solveRateInterval` | **Wilson** 95%. Chosen over the normal approximation because cells routinely have `n = 3` and `p = 0` or `1`, where the normal interval claims certainty from three samples. |
| `pass@k` | `1 − ∏(n−c−i)/(n−i)`. Defined only for `1 ≤ k ≤ n`; **`null` outside, never `NaN`**. |
| `pass^k` | `∏(c−i)/(n−i)`. Same domain rule. |
| `costPerSolve` | Spend of the **scored runs only**, over runs solved. **`null` at zero solves**, never Infinity. |
| `attritionCostUSD` | Attrition spend. Real, reported, and entering **neither side** of `costPerSolve`. |
| `tamperRate` | Fraction of scored runs that modified a held-out path. |
| cost / duration / tokens | median + IQR. |

`k > n` is **routine**, not exotic: a cell configured `repetitions: 5` that loses one run to a rate
limit has `n = 4`, and `C(n,k) = 0` there would divide by zero and poison every downstream aggregate.

### L2.5 — platform friction

Recorded for **solved and unsolved runs alike**. **Never** an input to `solved`, any L2 rate, or the
frontier — a platform that obstructed a successful agent still obstructed it.

| Signal | Meaning |
|---|---|
| `toolFailures` / `ehToolFailures` | All tool failures, and the `mcp__event-horizon__*` subset — the sharpest signal. |
| `refusedByDesign` / `refusedUnexpected` | Split on `[benchmark-refused]`. **A correct refusal is not a defect.** |
| `repeatCalls` | ≥3 identical tool+params calls — thrash. Two is a retry. |
| `reReads` | Repeat `get_ticket` on its own ticket, or repeat `Read` of one path — disorientation. |
| `deniedToolAttempts` | Calls to tools the session's own scoping denied — prompt and scoping disagree. |
| `protocolViolations` | From the detectors already in `parked-ticket.ts`, which today only flag. |
| `humanInterrupts` | `ask-question` / `permission-request` turns, which stall an unattended run to its HITL timeout. |
| `sessionRestarts` | Sessions on the run's ticket beyond the first. |
| `orientationCost` | EH-injected context over the run's input tokens. `null` when either side is unknown. |

Every count carries an **evidence locator** (`turnId`, or a progress timestamp).

### `frictionGrade` — computed, not judged

Aggregated over the **same scored-run denominator as `solveRate`**, so the two are read against the
same `n`.

| Grade | Rule |
|---|---|
| `clean` | No friction at all. |
| `noisy` | Friction in a **minority** of runs. |
| `obstructive` | Friction in a **majority**, **or** one EH tool failure repeated ≥3× in a run. |
| `blocking` | A run reached a terminal state **only** because of EH-side friction. |

### Agent CLI provenance

Each run also records `cli: { framework, version }` — `<binary> --version` at dispatch, probed once
per framework per engine process (`engine/src/agents/cli-version.ts`), `null` when the probe fails
so "unknown" is a value rather than an absence. A CLI auto-update between two cells changes the thing
under test as surely as an engine rebuild; the portal's Provenance panel shows one line per framework
and marks a suite whose runs saw more than one version, the same treatment as a dirty engine tree.

### Work — recorded, never scored

Each run records `work: { turns, toolCalls, linesAdded, linesRemoved }` — transcript turns, tool
invocations, and `git diff --numstat` against `baseCommit` over the agent's own tree. These exist
because solve rate saturates: three seeds at 18/18 said nothing about the configurations until cost,
wall clock and work were lined up side by side. They never enter `solved`, the frontier or a grade.

### Across seeds — `GET /api/benchmarks/compare`

One row per configuration over every finished suite. Per seed: solved/scored, cost per solve,
median time, friction grade, regressions (a seed the config did not run on is `null`, never 0).
Pooled: solved/scored and a Wilson interval over the **union** of the config's scored runs (so the
interval tightens honestly with more seeds, rather than averaging per-seed rates that would weight a
1-run seed like a 9-run one), cost per solve, total spend, median time, median turns / tool calls /
lines changed, summed EH tool failures, the **worst** friction grade across seeds. Unfinished suites are
listed as excluded rather than silently omitted. Nothing is re-scored — every per-seed number is its
suite's own report, quoted.

### L3 — the Pareto frontier

Non-dominated cells on `solveRate ↑`, `costPerSolve ↓`, `medianDuration ↓`. **No weighted composite
and no rank**: the weights are a value judgment belonging to the reader, and one number would launder
that judgment into something that looks like a measurement.

**A zero-solve cell is EXCLUDED from the frontier, never compared on it.** JavaScript coerces
`null < x` to `0 < x`, so a cell with `costPerSolve: null` would read as infinitely cheap and could
**dominate** — the worst possible failure for a report whose whole premise is that the reader judges.
Those cells are listed separately as what they are.

---

## Validation runs one at a time, and retries a per-test timeout once

Held-out checks that build real git fixtures under a per-test timeout are sensitive to machine load,
and three runs collecting while two siblings still execute full test suites is exactly that load.
Observed: one run validated in 288 s against 42–95 s for its siblings, failed a 30 s per-test
timeout, and scored unsolved for a patch its own in-session run of the same file had passed. So:

- validations are **serialized** per engine process (the benchmark's own contribution to the noise
  is removed);
- a held-out check that fails with a per-test-timeout signature (`Test timed out in Nms`, `Exceeded
  timeout of N ms`) is **retried once** after a pause, and the tail records that it was retried. A
  genuine failure fails again; a load artefact usually does not. Nothing else about the verdict
  changes — a second failure is a failure.

## The tamper guard — ordering is the guarantee

1. **Record the full change set first** — this is `tamperRate`'s input.
2. **Copy the agent's version of every held-out path aside**, outside the worktree, deletions included.
3. **Restore** held-out paths from `baseCommit` (`runGit`; a bare git spawn fails the build).
4. **Run validation** against the restored tree.
5. **Copy the agent's version back.**

Without (1), a run whose *only* edits were inside `validation.paths` measures an empty diff and L1's
non-empty-diff clause flips a real solve to `unsolved`. Without (5), an uncommitted agent edit to a
held-out path is destroyed. Because (3) precedes (4), an agent that weakened or deleted the check
still cannot pass it — while (1) records that it tried.

---

## Isolation guarantees

- **Pinned base.** Every run's worktree is created from `baseCommit`, and change size is measured
  against that same commit — not the default branch's live HEAD, which drifts between cells started
  minutes apart.
- **Local-only branches.** `createTicketBranch(..., { push: false })` via
  `ensureTicketIsolation({ pushBranch: false })`. **Nothing a suite does reaches `origin`.**
- **Four refused PR/push surfaces**, server-side on `kind`, with no adapter in play:
  `finish_ticket`, `branch action:'create'`, `merge_tickets`, and the `change_status` → Ready PR
  block. The Ready **transition still succeeds** — it is a legitimate terminal state evidence
  collection reads — and records a marked activity entry in place of the PR. The doc-recap emit is
  skipped, and **Temper is not armed** (a run has a branch by construction, so otherwise every cell
  would spawn a review session and a `changes-requested` verdict would overwrite the status the run
  is scored on).
- **Protected collection window.** `worktreeUnreclaimableReason` returns `'benchmark-collecting'`
  while a run is live or being measured. Deliberately **not** gated on `honorReadyGrace`: the cap
  backstop passes `false` to bypass the Ready grace buffer, and it is the likeliest racer. The window
  opens **before dispatch**, because the runner does not regain control at the instant a session ends.
- **Safe teardown.** Commit onto the run's own branch → remove only a **clean** tree → residue goes
  to `detachTaskWorktree({ applyToMain: false })`. **Archive only after teardown succeeds:** `Ready`
  is not in `TERMINAL_TICKET_STATUSES`, so a failed teardown leaves the reconcile sweep declining to
  touch a dirty non-terminal tree instead of applying the run's diff onto the user's own checkout.
  That ordering is what makes a crashed runner safe too.

---

## Scheduling

The task-worktree pool is **board-wide**, shared with the Furnace and every human session — a suite
does not own it. `concurrency` is clamped to `DEFAULT_MAX_TASK_WORKTREES − 1` so a slot stays free.

A cap hit (a rejection matching `/limit reached/i`) **requeues** with backoff and produces **no run
record, no failure class and no friction record** — it is a scheduler wait state (`waiting-for-slot`),
deliberately not a failure, because a cell's effective `n` must never be a function of unrelated
board activity. A suite wall-clock budget aborts if slots never free; whatever completed stays
scoreable at its real denominator.

**Preflight never substitutes.** An unavailable framework, model or effort is recorded with a reason
and never swapped for something that would run — MLPerf's closed division: a silent substitution
makes the result a lie about what was measured.

---

## The Benchmark Analyst

One session per finished suite, over the report, the raw run records and the transcripts. Its subject
is **EventHorizon**, not the agent's work.

- **Cites a `runId` plus an evidence locator on every claim.** An uncited claim is the exact failure
  mode this design exists to prevent.
- **Never states an L1/L2/L3 number or its own grade.** All of those are computed and reproducible
  without it. It may record a **dissent** — stored *beside* the computed grade, never replacing it.
- **Files no tickets.** It proposes ranked EventHorizon defects; a human promotes them.
- **Advisory, never a gate.** A suite is complete and fully scoreable whether or not the analyst ran.

Attribution uses the cross-cell separation: a signal in **every cell** is an EventHorizon defect; one
confined to **one framework's cells** is an adapter defect; one confined to **one effort level** is a
prompt-budget defect.

### How it runs

`POST /api/benchmarks/:id/analyze` (body: optional `framework`, `model`, `force`) — **on demand,
never automatic**: an analyst pass is a paid model session and a suite is complete without one.
Requires the suite to be `done`/`aborted` with a report; `409` while a pass is in flight or a
narrative already exists (`force:true` replaces it). Returns `202` with `suite.analysis` when the
session started, `502` when the dispatch was refused (the analysis ticket is archived with the reason).

- The analyst runs as an ordinary `phase:'chat'` session on a throwaway `kind:'benchmark'` ticket
  (`Benchmark analysis: <suite>`), with `personaId:'benchmark-analyst'` and the **brief** as launch
  focus. The brief (`buildAnalystBrief`, `engine/src/benchmark-analyst.ts`) is built from the persisted
  sidecar alone: the report **quoted**, plus every run's L0 record, validation/regression tails,
  friction evidence locators and ticket id (so it can `get_ticket` a run for context).
- It answers by moving its ticket to `Ready` with a completion comment containing one fenced `json`
  block (`summary`, `claims[{statement, runId, locator, attribution}]`, `proposedDefects[]`,
  `dissent[{cellIndex, grade, reasoning}]`).
- `GET /api/benchmarks/:id` **harvests on read**: the newest comment with a parseable block becomes
  `record.narrative`; `suite.analysis.harvestedAt`/`droppedClaims` are stamped. A claim whose `runId`
  is not a run of this suite is **dropped at parse time** and counted — the design's one hard rule,
  enforced mechanically rather than by instruction. Free text with no block is never promoted to a
  narrative. Dissent naming a non-existent cell or grade is discarded.
- Stored **beside** the report, never inside it; the report is still recomputable from raw records.

---

## Non-goals

- **Merging anything.** A benchmark run is measured, never merged.
- **Judging solution quality.** Out of scope. If subjective quality is wanted later, the credible
  route is pairwise comparison over stored diffs, not a 1–10 LLM score.
- **Cross-machine timing comparisons.** Machine load and provider rate limits dominate wall-clock, so
  timings compare only within one suite run on one machine — hence median + IQR, not raw seconds.
- **General model rankings.** A single seed is a single data point; per-task variance swamps
  per-model differences. Multi-seed suites are the natural follow-up.

---

## Where the code lives

| Module | Owns |
|---|---|
| `engine/src/models/benchmark.ts` | Pure data model, defaults, `BENCHMARK_KIND`, `BENCHMARK_REFUSAL_MARKER`. |
| `engine/src/benchmark-matrix.ts` | Expansion, validation, `runId`. Pure. |
| `engine/src/benchmark-score.ts` | L1–L3. Pure. |
| `engine/src/benchmark-friction.ts` | L2.5. Pure. |
| `engine/src/benchmark-validation.ts` | Tamper guard, validation spawn, calibration. |
| `engine/src/benchmark-evidence.ts` | L0 collection, failure classification, `deriveSolved`. |
| `engine/src/benchmark-collection-guard.ts` | The reclaim guard. Imports nothing. |
| `engine/src/benchmark-store.ts` | Per-suite JSON sidecars under `<activeFluxDir>/benchmarks/`. |
| `engine/src/benchmark-runner.ts` | Dispatch, scheduling, teardown. |
| `engine/src/routes/benchmarks.ts` | `/api/benchmarks`. |

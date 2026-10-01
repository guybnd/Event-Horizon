// The Benchmark suite — data model (FLUX-1739).
//
// A benchmark runs the SAME seed task many times under different agent configurations and scores
// each run the way SWE-bench does: a held-out validation command either passes or it doesn't. It
// also measures the other half — where EventHorizon itself got in the way (the L2.5 friction layer).
//
// This file is the pure data model (types + defaults + small pure helpers, no I/O). Matrix expansion
// and run identity live in `benchmark-matrix.ts`, scoring in `benchmark-score.ts`, friction
// extraction in `benchmark-friction.ts`, persistence in `benchmark-store.ts`, and the runner that
// spawns sessions in `benchmark-runner.ts`.
//
// DELIBERATELY NOT a Furnace variant: `FurnaceBatch`/`BatchTicket` key on `ticketId` throughout, so
// two concurrent rows for the SAME ticket have no representation — which is exactly what N repetitions
// of one seed require. This file must never import `models/furnace.ts`; it reuses Furnace's *patterns*
// (sidecar store, self-fetch dispatch, report shape) and none of its types.

import type { CliFramework, LaunchPhase } from '../agents/types.js';

/** The persisted `kind` value every throwaway benchmark ticket carries. */
export const BENCHMARK_KIND = 'benchmark';

/** Id namespace for benchmark tickets, so they never consume the project's `FLUX-n` sequence. */
export const BENCHMARK_ID_PREFIX = 'BENCH';

/**
 * Prefix on every by-design refusal a benchmark run receives.
 *
 * The friction layer (step 10) MUST be able to tell "EventHorizon correctly refused something this
 * run was never meant to do" from "EventHorizon's tools failed the agent". Without a stable marker
 * the two are indistinguishable in a transcript, and every suite would grade itself `obstructive`
 * for working as designed.
 */
export const BENCHMARK_REFUSAL_MARKER = '[benchmark-refused]';

/** True for a ticket that is one benchmark run's throwaway surface. */
export function isBenchmarkTicket(task: { kind?: string } | null | undefined): boolean {
  return task?.kind === BENCHMARK_KIND;
}

// ── Validation (the held-out check that makes a verdict mean something) ────────
//
// `command` + `args` are split rather than one string because the validation runner spawns them
// `execFile`-shaped and NEVER through a shell — a suite manifest is caller-supplied, and a shell
// would turn it into arbitrary command injection with a different blast radius than "the engine
// spawns agent CLIs", which is the trust boundary that already exists.
export interface BenchmarkValidation {
  /** Executable to run. Never interpreted by a shell. */
  command: string;
  /** Arguments passed verbatim. */
  args: string[];
  /**
   * The HELD-OUT paths. Restored from `baseCommit` before validation runs, so an agent cannot pass
   * the check by editing it. Also the input to `tamperRate`.
   */
  paths: string[];
  /** Hard timeout for one validation run, in ms. */
  timeoutMs: number;
}

/**
 * The broader "did it break anything else" check. No `paths`: nothing is held out, because this runs
 * against what the agent actually produced — that IS the thing under test.
 */
export interface BenchmarkRegressionCheck {
  command: string;
  args: string[];
  timeoutMs: number;
  /**
   * Baseline exit code at `baseCommit`, recorded at calibration. A repo whose suite is already red
   * at base cannot attribute redness to the run, so the comparison is against THIS, never against
   * zero — otherwise every run in a repo with pre-existing failures reads as a regression.
   */
  baselineExitCode?: number | null;
  /** Test names already failing at base, so a run is only blamed for NEW failures. */
  baselineFailures?: string[];
}

/**
 * Recorded proof that the seed is a real fail-to-pass task at `baseCommit` — SWE-bench's precondition.
 * A seed whose validation ALREADY passes at base would score every configuration 100%, measuring
 * nothing. `start` is refused until a calibration exists for the current `baseCommit`.
 */
export interface BenchmarkCalibration {
  baseCommit: string;
  /**
   * Exit code observed at base with no agent in the loop. Must be non-zero for the suite to start.
   * `null` when the command could not be spawned at all — which is a broken manifest, not a
   * fail-to-pass seed, so {@link BenchmarkCalibration.failsAtBase} stays false for it.
   */
  exitCode: number | null;
  /** True only when `exitCode !== 0` — i.e. the seed is a genuine fail-to-pass instance. */
  failsAtBase: boolean;
  outputTail?: string;
  calibratedAt: string;
}

// ── The matrix ────────────────────────────────────────────────────────────────

/**
 * One configuration under test. The cartesian product of the manifest's matrix × `repetitions`
 * is the run set.
 *
 * NOT dimensions in v1, deliberately: review count/depth (`gatePolicy`/`planReviewDepth` are
 * board-GLOBAL, so sweeping them mutates shared config between cells and breaks isolation) and
 * model *tier* (reachable only via `taskKey` — pass a raw `model` string instead).
 */
export interface BenchmarkCell {
  framework: CliFramework;
  /** Raw model id passed to the adapter. Absent = the adapter's own default for the task key. */
  model?: string;
  /** Requested effort. Recorded as requested-vs-applied: not every adapter supports it. */
  effortOverride?: string;
  phase: LaunchPhase;
}

export interface BenchmarkSuite {
  id: string;
  title?: string;
  /** Title given to each throwaway `BENCH-n` ticket. */
  seedTitle: string;
  /** The task every run is asked to do. Identical across every cell — that is what makes cells comparable. */
  seedPrompt: string;
  /** Pinned commit every run's worktree is created from. Never a branch name — branches move. */
  baseCommit: string;
  validation?: BenchmarkValidation;
  /**
   * A BROADER check run against the agent's own tree — typically the project's real test suite.
   *
   * The held-out `validation` answers "did it fix the thing". This answers "did it break anything
   * else", which is the first question a human reviewer asks and was previously invisible: a run
   * could fix its ticket perfectly, break thirty unrelated tests, and score `solved`.
   *
   * Deliberately NOT a fourth clause of `solved`. "Did not fix the bug" and "fixed the bug but broke
   * the build" are different findings that call for different responses, and folding the second into
   * the first would hide it inside a red tick the same way it was previously hidden inside a green
   * one. It is recorded beside the verdict and surfaced as its own outcome.
   */
  regression?: BenchmarkRegressionCheck;
  matrix: BenchmarkCell[];
  repetitions: number;
  /**
   * How many runs execute concurrently. Clamped to {@link MAX_BENCHMARK_CONCURRENCY}; defaults to
   * {@link DEFAULT_BENCHMARK_CONCURRENCY}. The worktree pool is NOT owned by this suite — it is
   * shared with the Furnace and every human session — so the ceiling deliberately leaves a slot free.
   */
  concurrency?: number;
  /** Whole-suite wall-clock budget in ms. Aborts a suite whose slots never free. */
  wallClockBudgetMs?: number;
  status: BenchmarkSuiteStatus;
  calibration?: BenchmarkCalibration;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  /** Set when the suite stopped for a reason other than completing. */
  abortReason?: string;
  /**
   * The analyst pass, when one was requested. Recorded on the suite (not the report) because the
   * analyst is advisory: a suite is complete and scoreable with this absent, and the report must
   * never depend on it.
   */
  analysis?: BenchmarkAnalysisRequest;
  /** `fix` (held-out regression test decides) or `build` (held-out acceptance harness decides; quality judged beside it). */
  track?: 'fix' | 'build';
  /**
   * Worktree-relative paths to PRESERVE after collection (screenshots the harness took, the built
   * artefact itself). Copied into the suite's artifact store before teardown removes the worktree;
   * without this a build run leaves nothing a human could look at.
   */
  artifacts?: string[];
  /**
   * Archived suites stay on disk (their sidecar is the audit trail) but leave the comparison and the
   * default listing. Debugging suites from before a fix are the case: their numbers are real and
   * their engine is not comparable to anything after it.
   */
  archived?: boolean;
}

/** Bookkeeping for one analyst dispatch — its ticket, its session, and how the request went. */
export interface BenchmarkAnalysisRequest {
  ticketId: string;
  sessionId?: string;
  requestedAt: string;
  /** Set when the dispatch itself was refused; the ticket is archived in that case. */
  error?: string;
  /** Claims the analyst wrote that named no admissible run and were dropped at parse time. */
  droppedClaims?: number;
  harvestedAt?: string;
}

export type BenchmarkSuiteStatus = 'draft' | 'calibrated' | 'running' | 'done' | 'aborted';

export const BENCHMARK_SUITE_STATUSES: readonly BenchmarkSuiteStatus[] = [
  'draft', 'calibrated', 'running', 'done', 'aborted',
] as const;

// ── Run outcome ───────────────────────────────────────────────────────────────

/**
 * Why a run produced no verdict.
 *
 * The first five are INFRASTRUCTURE failures: they leave the solve-rate denominator entirely and are
 * reported as attrition. Scoring a provider down for being rate-limited measures the network, not
 * the agent. The rest are real outcomes that stay in the denominator.
 */
export type BenchmarkFailureClass =
  | 'unavailable'    // adapter/binary/capability missing at preflight — never substituted for
  | 'auth'           // not authenticated
  | 'rate-limit'     // provider refused for quota reasons
  | 'crash'          // the session died abnormally
  | 'cancelled'      // stopped by a human or by suite abort
  | 'timeout'        // exceeded the per-run wall-clock budget
  | 'validation-failed'
  | 'config-invalid';

/** The five classes excluded from every rate's denominator and reported as attrition instead. */
export const INFRASTRUCTURE_FAILURE_CLASSES: ReadonlySet<BenchmarkFailureClass> = new Set([
  'unavailable', 'auth', 'rate-limit', 'crash', 'cancelled',
]);

export function isInfrastructureFailure(cls: BenchmarkFailureClass | undefined): boolean {
  return cls != null && INFRASTRUCTURE_FAILURE_CLASSES.has(cls);
}

/** What a validation spawn observed. Absent on a suite with no `validation` block. */
export interface ValidationOutcome {
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Bounded tail of combined output — never the full log. */
  outputTail?: string;
  /**
   * Set when the HARNESS failed before the command could be judged — e.g. the held-out restore
   * from `baseCommit` did not apply. That is infrastructure, not the agent's work: the run leaves
   * the denominator as a `crash` instead of being scored unsolved.
   */
  harnessError?: string;
}

/**
 * One run: one cell × one repetition.
 *
 * L0 primitives are recorded and never scored. `solved` (L1) is derived, not reported by the agent:
 * it requires a normal terminal state AND a non-empty diff AND validation passing against the
 * RESTORED tree.
 *
 * Absent token/cost data is `null`, never `0` — a run whose telemetry was lost is not a free run,
 * and averaging a fabricated zero into `costPerSolve` silently understates it.
 */
export interface BenchmarkRun {
  runId: string;
  suiteId: string;
  cell: BenchmarkCell;
  repetitionIndex: number;

  /** The throwaway ticket this run executed as. */
  ticketId?: string;
  branch?: string;
  worktreePath?: string;
  sessionId?: string;

  status: BenchmarkRunStatus;
  failureClass?: BenchmarkFailureClass;
  /** Durable session outcome text, read from the run ticket's `agent_session` history entry. */
  sessionOutcome?: string;

  startedAt?: string;
  endedAt?: string;
  durationMs?: number;

  inputTokens: number | null;
  outputTokens: number | null;
  costUSD: number | null;

  /** Files changed against `baseCommit`, unioned with uncommitted work. */
  changedFileCount?: number;
  /** True when the run produced any diff at all — one of `solved`'s three clauses. */
  hasDiff?: boolean;
  /**
   * The paths the run actually changed. Persisted, not just counted: diagnosing an unsolved run
   * turns on WHAT it touched — an agent that edited the right file and got the logic wrong is a
   * different finding from one that never found the file, and a bare count cannot tell them apart.
   */
  changedPaths?: string[];

  validation?: ValidationOutcome;
  /** Outcome of the broader regression check, when the suite configures one. */
  regression?: ValidationOutcome;
  /**
   * True when the regression check is WORSE than it was at base. Compared against the recorded
   * baseline, never against zero: a repo that is already red at base would otherwise mark every
   * single run a regression and the signal would be worthless.
   */
  regressed?: boolean;
  /** True when the run modified any held-out path, whether or not it then passed. */
  tampered?: boolean;

  /** Requested-vs-applied, read from `CLI_CAPABILITIES` at run time rather than hard-coded. */
  effortRequested?: string;
  effortApplied?: string;

  /**
   * Which EventHorizon executed this run. Stamped PER RUN, not per suite, because the engine can be
   * rebuilt or restarted mid-suite — which is exactly what happened during this feature's own first
   * live runs. Without it, two reports a rebuild apart look comparable and are not, and every L2.5
   * friction number (which measures EventHorizon itself) is unattributable.
   */
  engine?: { version: string; commit?: string; dirty?: boolean; capturedAt: string };
  /**
   * Which agent CLI ran this run (`<binary> --version` at dispatch). A CLI auto-update between two
   * cells changes the thing under test as surely as an engine rebuild; `null` is recorded explicitly
   * when the probe fails so "unknown" is a value, not an absence.
   */
  cli?: { framework: string; version: string | null };
  /**
   * The ticket state the run ENDED with, frozen at collection. Friction rules evolve; with this and the
   * transcript, a run's friction can be re-derived under the current rules (POST /:id/report with
   * `recomputeFriction`) instead of staying scored by whatever rule was live when it was collected.
   * The archive that follows collection clears `needsAction`, so it cannot be read back later.
   */
  taskView?: { status: string; needsAction: string | null; swimlane: string | null; sessionCount: number; inputTokens: number | null };
  /**
   * Files preserved from the worktree at collection (see `BenchmarkSuite.artifacts`), relative to
   * the suite's artifact store: `<benchmarks dir>/artifacts/<suiteId>/<runId>/<path>`. Served by
   * `GET /api/benchmarks/:id/artifacts/:runId?p=<path>`.
   */
  artifacts?: { path: string; bytes: number }[];
  /** Set by suite cleanup once the local run branch has been deleted (recollection is no longer possible). */
  branchRemovedAt?: string;
  /**
   * How much work the run did to get its verdict. These separate configurations when the solve rate
   * saturates — three seeds at 18/18 said nothing about the models until cost, time and this were
   * lined up side by side. Recorded, never scored.
   */
  work?: RunWork;

  solved?: boolean;
  friction?: RunFriction;
}

export interface RunWork {
  /** Transcript turns (assistant/user/tool) — a proxy for how many round-trips the run took. */
  turns: number;
  /** Tool invocations across all turns. */
  toolCalls: number;
  /** `git diff --numstat` against `baseCommit`, over the agent's tree before any restore. */
  linesAdded?: number;
  linesRemoved?: number;
}

export type BenchmarkRunStatus =
  | 'pending' | 'waiting-for-slot' | 'running' | 'collecting' | 'completed' | 'failed';

// ── L2.5: platform friction ───────────────────────────────────────────────────

/**
 * Where a claim came from. EVERY friction count carries its locators — the analyst (step 13) may not
 * assert anything it cannot cite, and an uncited claim is the exact failure mode the design exists
 * to prevent.
 */
export interface FrictionEvidence {
  /** Transcript turn id, or an `agent_session` progress timestamp. */
  locator: string;
  detail?: string;
}

export interface FrictionSignal {
  count: number;
  evidence: FrictionEvidence[];
}

/**
 * What EventHorizon cost the agent, recorded for SOLVED AND UNSOLVED runs alike. Never an input to
 * `solved`, to any L2 rate, or to the Pareto frontier — a platform that annoys a successful agent
 * still annoyed it, and hiding that inside the solve rate would make both numbers unreadable.
 */
export interface RunFriction {
  /** Every tool failure observed in the run. */
  toolFailures: FrictionSignal;
  /** The `mcp__event-horizon__*` subset — the sharpest signal: EH's own tools failing the agent. */
  ehToolFailures: FrictionSignal;
  /** A refusal the platform intends (step 3's markers). A correct refusal is NOT a defect. */
  refusedByDesign: FrictionSignal;
  /** A refusal nothing in the design predicted. */
  refusedUnexpected: FrictionSignal;
  /** >= REPEAT_CALL_THRESHOLD identical tool+params calls — thrash. */
  repeatCalls: FrictionSignal;
  /** Repeat `get_ticket` on its own ticket, or repeat `Read` of one path — disorientation. */
  reReads: FrictionSignal;
  /** Calls to tools the session's own scoping denied — prompt and scoping disagree. */
  deniedToolAttempts: FrictionSignal;
  /** From the detectors already in `parked-ticket.ts`, which today raise a flag and are never counted. */
  protocolViolations: FrictionSignal;
  /** `ask-question`/`permission-request` turns, which stall an unattended run to its HITL timeout. */
  humanInterrupts: FrictionSignal;
  /** Sessions on this run's ticket beyond the first. */
  sessionRestarts: FrictionSignal;
  /** EH-injected context as a fraction of the run's input tokens. `null` when tokens are unknown. */
  orientationCost: number | null;
}

/**
 * Computed from a published rubric, never judged by a model — so it is reproducible from stored
 * records and arguable on its merits.
 */
export type FrictionGrade = 'clean' | 'noisy' | 'obstructive' | 'blocking';

export const FRICTION_GRADES: readonly FrictionGrade[] = ['clean', 'noisy', 'obstructive', 'blocking'] as const;

/** Identical tool+serialized-params calls at or above this count are thrash, not retry. */
export const REPEAT_CALL_THRESHOLD = 3;

/** One EH tool failing this many times in a run is `obstructive` on its own. */
export const OBSTRUCTIVE_REPEAT_THRESHOLD = 3;

export interface CellFriction {
  /** Aggregated over the cell's SCORED runs — the same denominator as `solveRate`. */
  scoredRuns: number;
  runsWithAnyFriction: number;
  ehToolFailureTotal: number;
  maxRepeatedEhToolFailure: number;
  protocolViolationRuns: number;
  /** A run that reached a terminal state ONLY because of EH-side friction. */
  blockedRuns: number;
  grade: FrictionGrade;
}

// ── L2/L3: scoring ────────────────────────────────────────────────────────────

export interface Interval {
  low: number;
  high: number;
}

export interface Distribution {
  median: number | null;
  p25: number | null;
  p75: number | null;
}

export interface CellReport {
  cell: BenchmarkCell;
  /** Runs that count. Excludes attrition. */
  scoredRuns: number;
  solvedRuns: number;
  /** `null` when `scoredRuns === 0` — never a fabricated 0. */
  solveRate: number | null;
  /** Wilson 95% interval on `solveRate`. `null` when there is nothing to bound. */
  solveRateInterval: Interval | null;
  /** `pass@k` for k = 1 … min(repetitions, scoredRuns). Outside `1 <= k <= n` the value is `null`, never NaN. */
  passAtK: Record<number, number | null>;
  /** `pass^k` — all-k-succeed. Same domain rule. */
  passHatK: Record<number, number | null>;
  costUSD: Distribution;
  durationMs: Distribution;
  totalTokens: Distribution;
  /**
   * Spend of the SCORED runs only, over runs solved. `null` at zero solves — never Infinity, and
   * never compared as a frontier coordinate (see {@link BenchmarkReport.zeroSolveCells}).
   */
  costPerSolve: number | null;
  /** Attrition spend is real, reported here, and enters neither side of `costPerSolve`. */
  attritionCostUSD: number;
  attritionRuns: number;
  /** Fraction of scored runs that modified a held-out path. */
  tamperRate: number | null;
  friction: CellFriction;
}

/**
 * The cross-cell output is a Pareto frontier — NOT a weighted composite and NOT a rank. The weights
 * are a value judgment that belongs to the reader, and a single number would launder that judgment
 * into something that looks objective.
 */
export interface BenchmarkReport {
  suiteId: string;
  baseCommit: string;
  generatedAt: string;
  cells: CellReport[];
  /** Indices into `cells` that are non-dominated on (solveRate ↑, costPerSolve ↓, medianDuration ↓). */
  frontier: number[];
  /**
   * Cells with zero solves. Listed BESIDE the frontier, never compared on it: `costPerSolve` is
   * `null` there, and JavaScript coerces `null < x` to `0 < x`, so a zero-solve cell would read as
   * infinitely cheap and could DOMINATE the frontier — the worst possible failure for a report whose
   * whole premise is that the reader makes the judgment.
   */
  zeroSolveCells: number[];
  totalRuns: number;
  scoredRuns: number;
  attritionRuns: number;
}

// ── The analyst's narrative (advisory, never a gate) ───────────────────────────

export interface NarrativeClaim {
  statement: string;
  /** REQUIRED. A claim without a runId is not admissible. */
  runId: string;
  locator: string;
  /** Which layer the analyst attributes this to, using the cross-cell separation. */
  attribution: 'eventhorizon' | 'adapter' | 'effort' | 'unknown';
}

export interface BenchmarkNarrative {
  suiteId: string;
  generatedAt: string;
  summary: string;
  claims: NarrativeClaim[];
  /** Ranked EventHorizon defects the analyst proposes. It does NOT file them; a human promotes. */
  proposedDefects: string[];
  /**
   * The analyst may disagree with a computed grade. Its dissent is stored BESIDE that grade and
   * never replaces it — the number stays deterministic.
   */
  dissent?: { cell: BenchmarkCell; grade: FrictionGrade; reasoning: string }[];
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/**
 * Ceiling on `concurrency`. The task-worktree pool is board-wide and shared with the Furnace and
 * every human session, so a suite must never be able to consume the last slot. Kept in sync with
 * `DEFAULT_MAX_TASK_WORKTREES` (4) by {@link benchmarkConcurrencyCeiling}.
 */
export const MAX_BENCHMARK_CONCURRENCY = 3;

/** Default value of the manifest's `concurrency` field — distinct from the ceiling above. */
export const DEFAULT_BENCHMARK_CONCURRENCY = 2;

export const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60_000;

/** Default per-run wall-clock budget; also bounds the collection guard's TTL. */
export const DEFAULT_RUN_BUDGET_MS = 60 * 60_000;

/** Ceiling derived from the live pool cap, leaving one slot for the user. */
export function benchmarkConcurrencyCeiling(poolCap: number): number {
  return Math.max(1, poolCap - 1);
}

export function resolveConcurrency(requested: number | undefined, poolCap: number): number {
  const ceiling = benchmarkConcurrencyCeiling(poolCap);
  const wanted = requested ?? DEFAULT_BENCHMARK_CONCURRENCY;
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  return Math.min(Math.floor(wanted), ceiling);
}

/** An empty friction signal — used so every field is present even on a run with no friction at all. */
export function emptySignal(): FrictionSignal {
  return { count: 0, evidence: [] };
}

export function emptyFriction(): RunFriction {
  return {
    toolFailures: emptySignal(),
    ehToolFailures: emptySignal(),
    refusedByDesign: emptySignal(),
    refusedUnexpected: emptySignal(),
    repeatCalls: emptySignal(),
    reReads: emptySignal(),
    deniedToolAttempts: emptySignal(),
    protocolViolations: emptySignal(),
    humanInterrupts: emptySignal(),
    sessionRestarts: emptySignal(),
    orientationCost: null,
  };
}

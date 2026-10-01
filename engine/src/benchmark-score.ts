// Scoring (FLUX-1739) — PURE functions over stored run records.
//
// Nothing here spawns, reads a file, or touches live session state, so a report is fully
// RECOMPUTABLE from the raw records alone: no re-run, no analyst pass, no engine restart hazard.
//
// Four rules the textbook formulas do not give you, each of which produced a wrong number in review:
//   1. `pass@k`/`pass^k` are defined only for 1 <= k <= n. Outside that they are `null`, never NaN.
//   2. `costPerSolve`'s numerator is the SCORED runs' spend only; attrition spend is reported apart.
//   3. A `null` `costPerSolve` is EXCLUDED from the frontier, never compared (JS coerces `null < x`).
//   4. `frictionGrade` aggregates over the same denominator as `solveRate`, so the two are readable
//      against each other.

import {
  isInfrastructureFailure,
  OBSTRUCTIVE_REPEAT_THRESHOLD,
  type BenchmarkCell,
  type BenchmarkReport,
  type BenchmarkRun,
  type CellFriction,
  type CellReport,
  type Distribution,
  type FrictionGrade,
  type Interval,
} from './models/benchmark.js';
import { serializeCell } from './benchmark-matrix.js';

// ── Basic statistics ──────────────────────────────────────────────────────────

const Z_95 = 1.959963984540054;

/**
 * Wilson score interval — chosen over the normal approximation because benchmark cells routinely
 * have n = 3 and p = 0 or 1, where the normal interval collapses to zero width and claims certainty
 * from three samples.
 */
export function wilsonInterval(successes: number, n: number, z = Z_95): Interval | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * HumanEval's unbiased `pass@k`: the probability that at least one of k samples drawn without
 * replacement from the run's n samples is correct.
 *
 * Computed as the product form `1 - prod (n-c-i)/(n-i)` rather than via binomial coefficients —
 * `C(n, k)` overflows and loses precision long before it needs to, and the product form is exact
 * for the small n a benchmark cell actually has.
 */
export function passAtK(n: number, c: number, k: number): number | null {
  if (!isValidDomain(n, c, k)) return null;
  if (n - c < k) return 1;
  let product = 1;
  for (let i = 0; i < k; i++) product *= (n - c - i) / (n - i);
  return 1 - product;
}

/**
 * `pass^k` — the probability that ALL k drawn samples are correct. A different question from
 * `pass@k` and frequently the one that matters: "can I trust this config unattended?"
 */
export function passHatK(n: number, c: number, k: number): number | null {
  if (!isValidDomain(n, c, k)) return null;
  if (c < k) return 0;
  let product = 1;
  for (let i = 0; i < k; i++) product *= (c - i) / (n - i);
  return product;
}

/**
 * The domain both estimators share. `k > n` is ROUTINE, not exotic: a cell configured
 * `repetitions: 5` that loses one run to a rate limit has n = 4, and `C(n, k) = 0` there would
 * divide by zero and yield NaN — which then poisons every aggregate downstream.
 */
function isValidDomain(n: number, c: number, k: number): boolean {
  return Number.isInteger(n) && Number.isInteger(c) && Number.isInteger(k)
    && n > 0 && k >= 1 && k <= n && c >= 0 && c <= n;
}

export function distribution(values: number[]): Distribution {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return { median: null, p25: null, p75: null };
  return { median: quantile(xs, 0.5), p25: quantile(xs, 0.25), p75: quantile(xs, 0.75) };
}

/** Linear interpolation between order statistics — the conventional definition. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// ── Friction grade (computed from a published rubric, never judged) ────────────

export function gradeCellFriction(scoredRuns: BenchmarkRun[]): CellFriction {
  const n = scoredRuns.length;
  let runsWithAnyFriction = 0;
  let ehToolFailureTotal = 0;
  let maxRepeatedEhToolFailure = 0;
  let protocolViolationRuns = 0;
  let blockedRuns = 0;

  for (const run of scoredRuns) {
    const f = run.friction;
    if (!f) continue;
    const eh = f.ehToolFailures.count;
    const thrash = f.repeatCalls.count;
    const violations = f.protocolViolations.count;
    ehToolFailureTotal += eh;
    maxRepeatedEhToolFailure = Math.max(maxRepeatedEhToolFailure, eh);
    if (violations > 0) protocolViolationRuns++;
    if (eh > 0 || thrash > 0 || violations > 0 || f.refusedUnexpected.count > 0 || f.deniedToolAttempts.count > 0) {
      runsWithAnyFriction++;
    }
    // `blocking` is reserved for a run whose terminal state was caused by EH-side friction ALONE —
    // not merely a failed run that also had friction. Without that distinction every unsolved cell
    // would grade `blocking` and the tier would carry no information.
    if (run.solved !== true && eh > 0 && !isInfrastructureFailure(run.failureClass) && run.validation == null) {
      blockedRuns++;
    }
  }

  const grade = deriveGrade({ n, runsWithAnyFriction, maxRepeatedEhToolFailure, blockedRuns });
  return { scoredRuns: n, runsWithAnyFriction, ehToolFailureTotal, maxRepeatedEhToolFailure, protocolViolationRuns, blockedRuns, grade };
}

export function deriveGrade(input: {
  n: number;
  runsWithAnyFriction: number;
  maxRepeatedEhToolFailure: number;
  blockedRuns: number;
}): FrictionGrade {
  const { n, runsWithAnyFriction, maxRepeatedEhToolFailure, blockedRuns } = input;
  if (blockedRuns > 0) return 'blocking';
  if (n === 0 || runsWithAnyFriction === 0) return 'clean';
  if (maxRepeatedEhToolFailure >= OBSTRUCTIVE_REPEAT_THRESHOLD) return 'obstructive';
  if (runsWithAnyFriction * 2 > n) return 'obstructive';
  return 'noisy';
}

// ── Cell and suite reports ────────────────────────────────────────────────────

export function scoreCell(cell: BenchmarkCell, runs: BenchmarkRun[], repetitions: number): CellReport {
  // Attrition leaves the denominator entirely — scoring a provider down for being rate-limited
  // measures the network, not the agent.
  const attrition = runs.filter((r) => isInfrastructureFailure(r.failureClass));
  const scored = runs.filter((r) => !isInfrastructureFailure(r.failureClass));

  const n = scored.length;
  const solvedRuns = scored.filter((r) => r.solved === true).length;
  const solveRate = n > 0 ? solvedRuns / n : null;

  const kMax = Math.min(repetitions, n);
  const atK: Record<number, number | null> = {};
  const hatK: Record<number, number | null> = {};
  for (let k = 1; k <= Math.max(kMax, repetitions); k++) {
    atK[k] = passAtK(n, solvedRuns, k);
    hatK[k] = passHatK(n, solvedRuns, k);
  }

  const scoredCost = scored.map((r) => r.costUSD).filter((v): v is number => v != null);
  const totalScoredCost = scoredCost.reduce((a, b) => a + b, 0);
  // `null` at zero solves — never Infinity, and never a fabricated 0.
  const costPerSolve = solvedRuns > 0 && scoredCost.length > 0 ? totalScoredCost / solvedRuns : null;

  const tamperable = scored.filter((r) => r.tampered != null);
  const tamperRate = tamperable.length > 0
    ? tamperable.filter((r) => r.tampered === true).length / tamperable.length
    : null;

  return {
    cell,
    scoredRuns: n,
    solvedRuns,
    solveRate,
    solveRateInterval: n > 0 ? wilsonInterval(solvedRuns, n) : null,
    passAtK: atK,
    passHatK: hatK,
    costUSD: distribution(scoredCost),
    durationMs: distribution(scored.map((r) => r.durationMs).filter((v): v is number => v != null)),
    totalTokens: distribution(
      scored
        .map((r) => (r.inputTokens != null && r.outputTokens != null ? r.inputTokens + r.outputTokens : null))
        .filter((v): v is number => v != null),
    ),
    costPerSolve,
    attritionCostUSD: attrition.map((r) => r.costUSD ?? 0).reduce((a, b) => a + b, 0),
    attritionRuns: attrition.length,
    tamperRate,
    friction: gradeCellFriction(scored),
  };
}

/**
 * Non-dominated cells on (solveRate ↑, costPerSolve ↓, medianDuration ↓).
 *
 * Cells missing ANY coordinate are excluded rather than compared — see `zeroSolveCells`. There is
 * deliberately no weighted composite and no rank: the weights are a value judgment belonging to
 * whoever reads the report, and collapsing them into one number would launder that judgment into
 * something that looks like a measurement.
 */
export function paretoFrontier(cells: CellReport[]): { frontier: number[]; excluded: number[] } {
  const comparable: number[] = [];
  const excluded: number[] = [];
  cells.forEach((c, i) => {
    if (c.solveRate == null || c.costPerSolve == null || c.durationMs.median == null) excluded.push(i);
    else comparable.push(i);
  });

  const frontier = comparable.filter((i) => {
    const a = cells[i]!;
    return !comparable.some((j) => j !== i && dominates(cells[j]!, a));
  });
  return { frontier, excluded };
}

/** `b` dominates `a` when it is at least as good on every axis and strictly better on one. */
function dominates(b: CellReport, a: CellReport): boolean {
  const betterOrEqual =
    b.solveRate! >= a.solveRate! && b.costPerSolve! <= a.costPerSolve! && b.durationMs.median! <= a.durationMs.median!;
  const strictlyBetter =
    b.solveRate! > a.solveRate! || b.costPerSolve! < a.costPerSolve! || b.durationMs.median! < a.durationMs.median!;
  return betterOrEqual && strictlyBetter;
}

export function buildReport(
  suiteId: string,
  baseCommit: string,
  matrix: BenchmarkCell[],
  repetitions: number,
  runs: BenchmarkRun[],
): BenchmarkReport {
  const byCell = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    const key = serializeCell(run.cell);
    const bucket = byCell.get(key);
    if (bucket) bucket.push(run);
    else byCell.set(key, [run]);
  }

  const cells = matrix.map((cell) => scoreCell(cell, byCell.get(serializeCell(cell)) ?? [], repetitions));
  const { frontier, excluded } = paretoFrontier(cells);

  return {
    suiteId,
    baseCommit,
    generatedAt: new Date().toISOString(),
    cells,
    frontier,
    zeroSolveCells: excluded,
    totalRuns: runs.length,
    scoredRuns: cells.reduce((a, c) => a + c.scoredRuns, 0),
    attritionRuns: cells.reduce((a, c) => a + c.attritionRuns, 0),
  };
}

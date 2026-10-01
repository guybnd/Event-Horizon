// Cross-suite comparison — one row per configuration, across every finished suite.
//
// A single suite answers "how did these configs do on THIS task". The question actually asked of the
// benchmark is "which config should I use", and that needs the same config lined up across seeds with
// the numbers that still separate configs when the solve rate saturates: pooled interval, cost per
// solve, wall clock, work done, friction.
//
// Everything here is derived from stored reports and run records. Nothing is re-scored: a cell's
// numbers are its suite's numbers, quoted; the pooled columns are computed over the union of the
// config's scored runs so the interval tightens honestly with more seeds rather than by averaging
// per-suite rates (which would weight a 1-run seed like a 9-run one).

import { wilsonInterval, distribution } from './benchmark-score.js';
import { serializeCell } from './benchmark-matrix.js';
import { isInfrastructureFailure, type BenchmarkCell, type BenchmarkRun, type Distribution, type FrictionGrade, type Interval } from './models/benchmark.js';
import type { BenchmarkRecord } from './benchmark-store.js';

const GRADE_ORDER: FrictionGrade[] = ['clean', 'noisy', 'obstructive', 'blocking'];

export interface ComparisonSeedCell {
  suiteId: string;
  seedTitle: string;
  scoredRuns: number;
  solvedRuns: number;
  costPerSolve: number | null;
  durationMedianMs: number | null;
  frictionGrade: FrictionGrade | null;
  regressedRuns: number;
}

export interface ComparisonRow {
  cell: BenchmarkCell;
  key: string;
  /** Per seed, in the order of `seeds`; null when this config did not run on that seed. */
  perSeed: (ComparisonSeedCell | null)[];
  pooled: {
    seeds: number;
    scoredRuns: number;
    solvedRuns: number;
    attritionRuns: number;
    solveRate: number | null;
    solveRateInterval: Interval | null;
    costPerSolve: number | null;
    totalCostUSD: number;
    durationMs: Distribution;
    turns: Distribution;
    toolCalls: Distribution;
    linesChanged: Distribution;
    ehToolFailureTotal: number;
    regressedRuns: number;
    worstFriction: FrictionGrade | null;
  };
}

export interface Comparison {
  generatedAt: string;
  seeds: { suiteId: string; seedTitle: string; baseCommit: string; repetitions: number }[];
  rows: ComparisonRow[];
  /** Suites left out (not finished, or no report) — named so the reader knows what the table omits. */
  excluded: { suiteId: string; reason: string }[];
}

function isScored(run: BenchmarkRun): boolean {
  return !isInfrastructureFailure(run.failureClass);
}

function worst(grades: FrictionGrade[]): FrictionGrade | null {
  if (grades.length === 0) return null;
  return grades.reduce((a, b) => (GRADE_ORDER.indexOf(b) > GRADE_ORDER.indexOf(a) ? b : a));
}

export function buildComparison(records: BenchmarkRecord[], now = new Date()): Comparison {
  const excluded: Comparison['excluded'] = [];
  const usable = records.filter((r) => {
    if (r.suite.archived) { excluded.push({ suiteId: r.suite.id, reason: 'archived' }); return false; }
    if (r.suite.status !== 'done' && r.suite.status !== 'aborted') { excluded.push({ suiteId: r.suite.id, reason: r.suite.status }); return false; }
    if (!r.report) { excluded.push({ suiteId: r.suite.id, reason: 'no report' }); return false; }
    return true;
  });

  const seeds = usable.map((r) => ({ suiteId: r.suite.id, seedTitle: r.suite.seedTitle, baseCommit: r.suite.baseCommit, repetitions: r.suite.repetitions }));

  // Configs in first-seen order across suites.
  const cells = new Map<string, BenchmarkCell>();
  for (const r of usable) for (const c of r.report!.cells) cells.set(serializeCell(c.cell), c.cell);

  const rows: ComparisonRow[] = [];
  for (const [key, cell] of cells) {
    const perSeed: (ComparisonSeedCell | null)[] = [];
    const pooledRuns: BenchmarkRun[] = [];
    const grades: FrictionGrade[] = [];
    let ehToolFailureTotal = 0;
    let seedsRun = 0;

    for (const r of usable) {
      const cr = r.report!.cells.find((c) => serializeCell(c.cell) === key);
      if (!cr) { perSeed.push(null); continue; }
      seedsRun++;
      const runs = r.runs.filter((run) => serializeCell(run.cell) === key);
      pooledRuns.push(...runs);
      grades.push(cr.friction.grade);
      ehToolFailureTotal += cr.friction.ehToolFailureTotal;
      perSeed.push({
        suiteId: r.suite.id,
        seedTitle: r.suite.seedTitle,
        scoredRuns: cr.scoredRuns,
        solvedRuns: cr.solvedRuns,
        costPerSolve: cr.costPerSolve,
        durationMedianMs: cr.durationMs.median,
        frictionGrade: cr.friction.grade,
        regressedRuns: runs.filter((run) => run.regressed).length,
      });
    }

    const scored = pooledRuns.filter(isScored);
    const solved = scored.filter((run) => run.solved === true).length;
    const scoredCost = scored.map((run) => run.costUSD).filter((v): v is number => v != null);
    const totalCost = pooledRuns.map((run) => run.costUSD ?? 0).reduce((a, b) => a + b, 0);
    const num = (xs: (number | undefined | null)[]) => xs.filter((v): v is number => typeof v === 'number');

    rows.push({
      cell,
      key,
      perSeed,
      pooled: {
        seeds: seedsRun,
        scoredRuns: scored.length,
        solvedRuns: solved,
        attritionRuns: pooledRuns.length - scored.length,
        solveRate: scored.length > 0 ? solved / scored.length : null,
        solveRateInterval: scored.length > 0 ? wilsonInterval(solved, scored.length) : null,
        costPerSolve: solved > 0 && scoredCost.length > 0 ? scoredCost.reduce((a, b) => a + b, 0) / solved : null,
        totalCostUSD: totalCost,
        durationMs: distribution(num(scored.map((run) => run.durationMs))),
        turns: distribution(num(scored.map((run) => run.work?.turns))),
        toolCalls: distribution(num(scored.map((run) => run.work?.toolCalls))),
        linesChanged: distribution(num(scored.map((run) => (run.work?.linesAdded != null && run.work?.linesRemoved != null) ? run.work.linesAdded + run.work.linesRemoved : undefined))),
        ehToolFailureTotal,
        regressedRuns: pooledRuns.filter((run) => run.regressed).length,
        worstFriction: worst(grades),
      },
    });
  }

  return { generatedAt: now.toISOString(), seeds, rows, excluded };
}

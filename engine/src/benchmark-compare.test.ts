import { describe, it, expect } from 'vitest';
import { buildComparison } from './benchmark-compare.js';
import { buildReport } from './benchmark-score.js';
import type { BenchmarkRecord } from './benchmark-store.js';
import type { BenchmarkCell, BenchmarkRun } from './models/benchmark.js';
import { CLI_CAPABILITIES } from './agents/types.js';

// The comparison pools a configuration's runs ACROSS seeds. These pin the two things that make that
// honest: the interval is computed over the union of runs (not an average of per-seed rates), and
// attrition stays out of the denominator exactly as it does inside one suite.

const FRAMEWORK = Object.keys(CLI_CAPABILITIES)[0] as BenchmarkCell['framework'];
const A: BenchmarkCell = { framework: FRAMEWORK, model: 'model-a', phase: 'implementation' };
const B: BenchmarkCell = { framework: FRAMEWORK, model: 'model-b', phase: 'implementation' };

let seq = 0;
function run(cell: BenchmarkCell, over: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    runId: `r${++seq}`,
    cell,
    repetitionIndex: 0,
    status: 'completed',
    inputTokens: null,
    outputTokens: null,
    costUSD: 1,
    solved: true,
    validation: { exitCode: 0, passed: true, timedOut: false, durationMs: 1 },
    hasDiff: true,
    ...over,
  } as BenchmarkRun;
}

/** A run with no verdict at all — attrition or still in flight. */
function noVerdict(cell: BenchmarkCell, over: Partial<BenchmarkRun>): BenchmarkRun {
  const r = run(cell, over);
  delete r.solved;
  return r;
}

function suite(id: string, cells: BenchmarkCell[], runs: BenchmarkRun[], status = 'done'): BenchmarkRecord {
  const s = { id, seedTitle: `seed ${id}`, seedPrompt: '', baseCommit: 'a'.repeat(40), matrix: cells, repetitions: 3, status, createdAt: '2026-01-01T00:00:00Z' } as BenchmarkRecord['suite'];
  return { suite: s, runs, report: buildReport(id, s.baseCommit, cells, 3, runs) };
}

describe('buildComparison', () => {
  it('pools a config over the UNION of its runs — the interval tightens with more seeds', () => {
    const s1 = suite('s1', [A], [run(A, {}), run(A, {}), run(A, {})]);
    const s2 = suite('s2', [A], [run(A, {}), run(A, {}), run(A, {})]);
    const one = buildComparison([s1]).rows[0]!.pooled;
    const two = buildComparison([s1, s2]).rows[0]!.pooled;
    expect(one.scoredRuns).toBe(3);
    expect(two.scoredRuns).toBe(6);
    expect(two.seeds).toBe(2);
    expect(two.solveRateInterval!.low).toBeGreaterThan(one.solveRateInterval!.low);
  });

  it('keeps attrition out of the pooled denominator', () => {
    const s = suite('s1', [A], [run(A, {}), noVerdict(A, { status: 'failed', failureClass: 'crash', costUSD: 2 })]);
    const p = buildComparison([s]).rows[0]!.pooled;
    expect(p.scoredRuns).toBe(1);
    expect(p.attritionRuns).toBe(1);
    expect(p.solveRate).toBe(1);
    // Attrition spend is still real money.
    expect(p.totalCostUSD).toBe(3);
    expect(p.costPerSolve).toBe(1);
  });

  it('marks a seed a config did not run as null, not zero', () => {
    const s1 = suite('s1', [A, B], [run(A, {}), run(B, {})]);
    const s2 = suite('s2', [A], [run(A, {})]);
    const rows = buildComparison([s1, s2]).rows;
    const rowB = rows.find((r) => r.cell.model === 'model-b')!;
    expect(rowB.perSeed[0]).not.toBeNull();
    expect(rowB.perSeed[1]).toBeNull();
    expect(rowB.pooled.seeds).toBe(1);
  });

  it('excludes unfinished suites and says so', () => {
    const running = suite('s-run', [A], [noVerdict(A, { status: 'running' })], 'running');
    const done = suite('s1', [A], [run(A, {})]);
    const c = buildComparison([running, done]);
    expect(c.seeds.map((s) => s.suiteId)).toEqual(['s1']);
    expect(c.excluded).toEqual([{ suiteId: 's-run', reason: 'running' }]);
  });

  it('reports the WORST friction grade across seeds and sums EH tool failures', () => {
    const s1 = suite('s1', [A], [run(A, {})]);
    const s2 = suite('s2', [A], [run(A, {})]);
    s1.report!.cells[0]!.friction.grade = 'noisy';
    s1.report!.cells[0]!.friction.ehToolFailureTotal = 2;
    s2.report!.cells[0]!.friction.grade = 'obstructive';
    s2.report!.cells[0]!.friction.ehToolFailureTotal = 3;
    const p = buildComparison([s1, s2]).rows[0]!.pooled;
    expect(p.worstFriction).toBe('obstructive');
    expect(p.ehToolFailureTotal).toBe(5);
  });

  it('carries work metrics when recorded and leaves the distribution null when not', () => {
    const withWork = suite('s1', [A], [run(A, { work: { turns: 20, toolCalls: 9, linesAdded: 10, linesRemoved: 2 } }), run(A, { work: { turns: 40, toolCalls: 11, linesAdded: 4, linesRemoved: 4 } })]);
    const p = buildComparison([withWork]).rows[0]!.pooled;
    expect(p.turns.median).toBe(30);
    expect(p.linesChanged.median).toBe(10);
    const without = buildComparison([suite('s2', [A], [run(A, {})])]).rows[0]!.pooled;
    expect(without.turns.median).toBeNull();
  });
});

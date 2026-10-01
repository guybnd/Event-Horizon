import { describe, it, expect } from 'vitest';
import { selectCleanupBranches } from './benchmark-runner.js';
import type { BenchmarkRun } from './models/benchmark.js';
import { CLI_CAPABILITIES } from './agents/types.js';

// A run branch exists after the run ends for one reason: recollection. These pin which branches a
// finished suite may drop — completed runs and scored failures — and which it must keep: crashes,
// which are exactly the runs recollection exists for.

const FRAMEWORK = Object.keys(CLI_CAPABILITIES)[0] as BenchmarkRun['cell']['framework'];

function run(overrides: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    runId: 'r',
    cell: { framework: FRAMEWORK, phase: 'implementation' },
    repetitionIndex: 0,
    status: 'completed',
    inputTokens: null,
    outputTokens: null,
    costUSD: null,
    branch: 'flux/BENCH-1',
    ...overrides,
  } as BenchmarkRun;
}

describe('selectCleanupBranches', () => {
  it('drops the branch of a completed run — its evidence is on the record', () => {
    expect(selectCleanupBranches([run({ runId: 'a', solved: true })]).map((r) => r.runId)).toEqual(['a']);
    expect(selectCleanupBranches([run({ runId: 'b', solved: false })]).map((r) => r.runId)).toEqual(['b']);
  });

  it('KEEPS a crashed run\'s branch — recollection needs it', () => {
    expect(selectCleanupBranches([run({ status: 'failed', failureClass: 'crash' })])).toEqual([]);
  });

  it('drops a scored failure (validation-failed is a verdict, not a collector fault)', () => {
    expect(selectCleanupBranches([run({ runId: 'a', status: 'failed', failureClass: 'validation-failed' })]).map((r) => r.runId)).toEqual(['a']);
  });

  it('skips runs still in flight, runs with no branch, and branches already removed', () => {
    const noBranch = run({});
    delete noBranch.branch;
    expect(selectCleanupBranches([
      run({ status: 'running' }),
      run({ status: 'collecting' }),
      noBranch,
      run({ branchRemovedAt: '2026-01-01T00:00:00Z' }),
    ])).toEqual([]);
  });
});

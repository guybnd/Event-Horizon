import { describe, it, expect } from 'vitest';
import { selectRecollectable } from './benchmark-runner.js';
import type { BenchmarkRun } from './models/benchmark.js';
import { CLI_CAPABILITIES } from './agents/types.js';

// A collector defect must never decide a run's score. These pin WHICH runs the recollect path is
// allowed to touch: only ones whose agent finished (a branch exists) and whose recorded outcome was
// a crash — the only class a collector bug produces.

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
    ...overrides,
  } as BenchmarkRun;
}

describe('selectRecollectable', () => {
  it('picks failed/crash runs that have a ticket and a branch', () => {
    const runs = [
      run({ runId: 'a', status: 'failed', failureClass: 'crash', ticketId: 'BENCH-1', branch: 'flux/BENCH-1' }),
      run({ runId: 'b', status: 'completed', solved: true, ticketId: 'BENCH-2', branch: 'flux/BENCH-2' }),
    ];
    expect(selectRecollectable(runs).map((r) => r.runId)).toEqual(['a']);
  });

  it('skips a crash with no branch — that run never got to work, there is nothing to recollect', () => {
    const runs = [run({ runId: 'a', status: 'failed', failureClass: 'crash', ticketId: 'BENCH-1' })];
    expect(selectRecollectable(runs)).toEqual([]);
  });

  it('skips scored failures — validation-failed is the run\'s verdict, not the collector\'s', () => {
    const runs = [run({ runId: 'a', status: 'failed', failureClass: 'validation-failed', ticketId: 'BENCH-1', branch: 'b' })];
    expect(selectRecollectable(runs)).toEqual([]);
  });

  it('honours an explicit runIds list, still requiring a ticket and branch', () => {
    const runs = [
      run({ runId: 'a', status: 'completed', ticketId: 'BENCH-1', branch: 'b1' }),
      run({ runId: 'b', status: 'completed', ticketId: 'BENCH-2' }),
      run({ runId: 'c', status: 'failed', failureClass: 'crash', ticketId: 'BENCH-3', branch: 'b3' }),
    ];
    expect(selectRecollectable(runs, ['a', 'b']).map((r) => r.runId)).toEqual(['a']);
  });
});

import { describe, it, expect } from 'vitest';
import { classifyRun, firstFailure } from './benchmarkRun';

// FLUX-1739: the failure view is organised entirely around this classifier, so getting it wrong
// mislabels every run on the screen. A bare "unsolved" collapses findings that call for completely
// different responses — a wrong fix, no fix at all, and a rate limit are not the same problem.

type RunLike = Parameters<typeof classifyRun>[0];
const run = (o: Partial<RunLike> = {}): RunLike => ({ status: 'completed', ...o } as RunLike);

describe('classifyRun', () => {
  it('reports a solved run', () => {
    expect(classifyRun(run({ solved: true, hasDiff: true }))).toBe('solved');
  });

  it('separates "worked but wrong" from "did nothing"', () => {
    expect(classifyRun(run({ solved: false, hasDiff: true }))).toBe('check-failed');
    expect(classifyRun(run({ solved: false, hasDiff: false }))).toBe('empty-diff');
  });

  it('routes every infrastructure class to attrition, not to a failure', () => {
    for (const failureClass of ['unavailable', 'auth', 'rate-limit', 'crash', 'cancelled']) {
      expect(classifyRun(run({ status: 'failed', failureClass }))).toBe('attrition');
    }
  });

  it('keeps non-infrastructure failures as real, scored failures', () => {
    expect(classifyRun(run({ status: 'failed', failureClass: 'validation-failed' }))).toBe('crashed');
    expect(classifyRun(run({ status: 'failed', failureClass: 'timeout' }))).toBe('crashed');
  });

  it('never reads an in-flight run as an empty diff', () => {
    // The regression this guards: `hasDiff` is absent until collection, so an in-flight run would
    // otherwise render as "changed nothing" — a false failure on the screen while it is still working.
    for (const status of ['running', 'pending', 'collecting', 'waiting-for-slot']) {
      expect(classifyRun(run({ status }))).toBe('running');
    }
  });

  it('prefers attrition over in-flight when a class is already recorded', () => {
    expect(classifyRun(run({ status: 'running', failureClass: 'rate-limit' }))).toBe('attrition');
  });

  it('treats a solved run as solved even with a failure class recorded earlier', () => {
    expect(classifyRun(run({ solved: true, failureClass: 'rate-limit' }))).toBe('solved');
  });
});

describe('firstFailure', () => {
  it('starts at the assertion rather than the run summary', () => {
    const tail = [
      'some earlier noise',
      "AssertionError: expected [ 'sess-B' ] to deeply equal []",
      ' ❯ src/holdout.test.ts:71',
      '',
      ' Test Files  1 failed (1)',
    ].join('\n');
    expect(firstFailure(tail).startsWith('AssertionError')).toBe(true);
  });

  it('falls back to the tail when nothing matches', () => {
    expect(firstFailure('all quiet\nnothing wrong here')).toContain('nothing wrong here');
  });

  it('strips carriage returns so Windows output is not double-spaced', () => {
    expect(firstFailure('Error: boom\r\n at foo')).not.toContain('\r');
  });
});

describe('classifyRun — regressions', () => {
  it('separates "solved cleanly" from "solved but broke the build"', () => {
    // Both fixed the ticket. Reporting them the same hides the finding a reviewer cares about most.
    expect(classifyRun(run({ solved: true, hasDiff: true }))).toBe('solved');
    expect(classifyRun(run({ solved: true, hasDiff: true, regressed: true }))).toBe('regressed');
  });

  it('does not mark an unsolved run as regressed', () => {
    expect(classifyRun(run({ solved: false, hasDiff: true, regressed: true }))).toBe('check-failed');
  });

  it('ignores regressed:false', () => {
    expect(classifyRun(run({ solved: true, hasDiff: true, regressed: false }))).toBe('solved');
  });
});

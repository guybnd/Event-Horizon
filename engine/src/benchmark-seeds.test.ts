import { describe, it, expect } from 'vitest';
import { manifestFromSeed, type ResolvedSeed } from './benchmark-seeds.js';
import { CLI_CAPABILITIES } from './agents/types.js';
import type { BenchmarkCell } from './models/benchmark.js';

// The seed fixes everything a comparison must hold constant; the form may vary only the
// configuration. These pin that boundary and the refusal of an unresolved base.

const FRAMEWORK = Object.keys(CLI_CAPABILITIES)[0] as BenchmarkCell['framework'];

function seed(over: Partial<ResolvedSeed> = {}): ResolvedSeed {
  return {
    id: 'seed-x',
    title: 'Seed X',
    track: 'fix',
    seedTitle: 'X',
    baseRef: 'bench/x',
    baseCommit: 'a'.repeat(40),
    prompt: 'fix it',
    validation: { command: 'node', args: ['check.js'], paths: ['check.js'], timeoutMs: 1000 },
    repetitions: 2,
    ...over,
  };
}

describe('manifestFromSeed', () => {
  it('pins the resolved commit, prompt and held-out check from the seed; takes matrix/reps from the form', () => {
    const m = manifestFromSeed(seed(), { matrix: [{ framework: FRAMEWORK, model: 'm', phase: 'implementation' }], repetitions: 5 });
    expect(m.baseCommit).toBe('a'.repeat(40));
    expect(m.seedPrompt).toBe('fix it');
    expect(m.validation?.paths).toEqual(['check.js']);
    expect(m.matrix).toHaveLength(1);
    expect(m.repetitions).toBe(5);
    expect(m.status).toBe('draft');
  });

  it('falls back to the seed defaults, then the built-in single-cell matrix', () => {
    const m = manifestFromSeed(seed());
    expect(m.repetitions).toBe(2);
    expect(m.matrix).toHaveLength(1);
    expect(m.matrix[0]?.phase).toBe('implementation');
    expect(m.matrix[0]?.framework).toBeTruthy();
  });

  it('derives a timestamped id unless one is given', () => {
    expect(manifestFromSeed(seed()).id).toMatch(/^seed-x-\d{8}-\d{4}$/);
    expect(manifestFromSeed(seed(), { suiteId: 'mine' }).id).toBe('mine');
  });

  it('refuses a seed whose base did not resolve — a suite must never be created on a guess', () => {
    expect(() => manifestFromSeed(seed({ baseCommit: null, resolveError: 'no such ref' }))).toThrow(/no such ref/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  BenchmarkManifestError,
  computeRunId,
  expandMatrix,
  resolveEffort,
  serializeCell,
  validateSuite,
} from './benchmark-matrix.js';
import { CLI_CAPABILITIES, type CliFramework } from './agents/types.js';
import type { BenchmarkCell, BenchmarkSuite } from './models/benchmark.js';

// Frameworks are DERIVED from the capability table, never written as literals: check-adapter-boundary
// forbids per-CLI literals outside engine/src/agents/, and hard-coding today's set would make these
// tests assert the roster instead of the mechanism.
const FRAMEWORKS = Object.keys(CLI_CAPABILITIES) as CliFramework[];
const FW_A = FRAMEWORKS[0]!;
const FW_B = FRAMEWORKS[1]!;
const FW_EFFORT = FRAMEWORKS.find((f) => CLI_CAPABILITIES[f].effort.supported)!;
const FW_NO_EFFORT = FRAMEWORKS.find((f) => !CLI_CAPABILITIES[f].effort.supported);

const BASE = 'a'.repeat(40);

function suite(overrides: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return {
    id: 'suite-1',
    seedTitle: 'seed',
    seedPrompt: 'do the thing',
    baseCommit: BASE,
    matrix: [{ framework: FW_A, phase: 'implementation' }],
    repetitions: 2,
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('expandMatrix', () => {
  it('is the cartesian product of the matrix and repetitions, cell-major', () => {
    const s = suite({
      matrix: [
        { framework: FW_A, phase: 'implementation' },
        { framework: FW_B, phase: 'implementation' },
      ],
      repetitions: 3,
    });
    const runs = expandMatrix(s);
    expect(runs).toHaveLength(6);
    expect(runs.slice(0, 3).every((r) => r.cell.framework === FW_A)).toBe(true);
    expect(runs.slice(3).every((r) => r.cell.framework === FW_B)).toBe(true);
    expect(runs.map((r) => r.repetitionIndex)).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('starts every run pending with null telemetry — an absent cost is never a fabricated 0', () => {
    const [run] = expandMatrix(suite());
    expect(run!.status).toBe('pending');
    expect(run!.inputTokens).toBeNull();
    expect(run!.outputTokens).toBeNull();
    expect(run!.costUSD).toBeNull();
  });
});

describe('runId identity', () => {
  it('is stable across two expansions of the same manifest', () => {
    const a = expandMatrix(suite()).map((r) => r.runId);
    const b = expandMatrix(suite()).map((r) => r.runId);
    expect(a).toEqual(b);
  });

  it('differs across cells and across repetitions', () => {
    const runs = expandMatrix(suite({
      matrix: [
        { framework: FW_A, phase: 'implementation' },
        { framework: FW_A, phase: 'grooming' },
      ],
      repetitions: 2,
    }));
    expect(new Set(runs.map((r) => r.runId)).size).toBe(4);
  });

  it('ignores everything except suite, baseCommit, cell and repetition', () => {
    const cell: BenchmarkCell = { framework: FW_A, phase: 'implementation' };
    const id1 = computeRunId('s', BASE, cell, 0);
    const id2 = computeRunId('s', BASE, { ...cell }, 0);
    expect(id1).toBe(id2);
    expect(computeRunId('s', 'b'.repeat(40), cell, 0)).not.toBe(id1);
  });

  it('serializes a cell by fixed field order, not object key order', () => {
    const a: BenchmarkCell = { framework: FW_A, model: 'm', phase: 'implementation' };
    const b = { phase: 'implementation', model: 'm', framework: FW_A } as BenchmarkCell;
    expect(serializeCell(a)).toBe(serializeCell(b));
  });
});

describe('validateSuite rejections — all before any process spawns', () => {
  const cases: [string, Partial<BenchmarkSuite>, RegExp][] = [
    ['empty matrix', { matrix: [] }, /at least one cell/],
    ['zero repetitions', { repetitions: 0 }, /positive integer/],
    ['negative repetitions', { repetitions: -1 }, /positive integer/],
    ['non-integer repetitions', { repetitions: 1.5 }, /positive integer/],
    ['unknown framework', { matrix: [{ framework: 'nope' as never, phase: 'implementation' }] }, /unknown framework/],
    ['branch name as baseCommit', { baseCommit: 'master' }, /commit SHA/],
    ['missing seedPrompt', { seedPrompt: '' }, /seedPrompt is required/],
    [
      'duplicate cells',
      {
        matrix: [
          { framework: FW_A, phase: 'implementation' },
          { framework: FW_A, phase: 'implementation' },
        ],
      },
      /duplicate cell/,
    ],
  ];

  for (const [name, overrides, pattern] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => validateSuite(suite(overrides))).toThrow(BenchmarkManifestError);
      expect(() => validateSuite(suite(overrides))).toThrow(pattern);
    });
  }

  it('rejects a validation block with no held-out paths', () => {
    const s = suite({ validation: { command: 'node', args: ['-e', ''], paths: [], timeoutMs: 1000 } });
    expect(() => validateSuite(s)).toThrow(/held-out path/);
  });

  it('accepts an abbreviated SHA', () => {
    expect(() => validateSuite(suite({ baseCommit: 'abc1234' }))).not.toThrow();
  });
});

describe('resolveEffort — read from CLI_CAPABILITIES at run time', () => {
  it('records requested and applied when the adapter supports effort', () => {
    expect(resolveEffort({ framework: FW_EFFORT, effortOverride: 'high', phase: 'implementation' }))
      .toEqual({ requested: 'high', applied: 'high' });
  });

  // Asserts the MECHANISM against whichever adapter currently reports no effort support, so the test
  // keeps its meaning as that set moves. Skipped outright if every adapter gains effort support.
  it.skipIf(!FW_NO_EFFORT)('records requested-but-not-applied when the adapter does not', () => {
    const out = resolveEffort({ framework: FW_NO_EFFORT!, effortOverride: 'high', phase: 'implementation' });
    expect(out.requested).toBe('high');
    expect(out.applied).toBeUndefined();
  });

  it('records neither when no effort was requested', () => {
    expect(resolveEffort({ framework: FW_A, phase: 'implementation' })).toEqual({});
  });
});

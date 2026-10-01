import { describe, it, expect } from 'vitest';
import {
  buildReport,
  deriveGrade,
  distribution,
  paretoFrontier,
  passAtK,
  passHatK,
  scoreCell,
  wilsonInterval,
} from './benchmark-score.js';
import { CLI_CAPABILITIES, type CliFramework } from './agents/types.js';
import { emptyFriction, type BenchmarkCell, type BenchmarkRun, type CellReport } from './models/benchmark.js';

// Derived, not literal — see benchmark-matrix.test.ts.
const FRAMEWORKS = Object.keys(CLI_CAPABILITIES) as CliFramework[];

const CELL: BenchmarkCell = { framework: FRAMEWORKS[0]!, phase: 'implementation' };

function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    runId: Math.random().toString(36).slice(2),
    suiteId: 's',
    cell: CELL,
    repetitionIndex: 0,
    status: 'completed',
    inputTokens: 100,
    outputTokens: 10,
    costUSD: 1,
    ...overrides,
  };
}

// Brute-force reference: the exact fraction of k-subsets of n runs (c correct) that are all-correct.
function bruteForcePassHatK(n: number, c: number, k: number): number {
  const items = Array.from({ length: n }, (_, i) => i < c);
  let total = 0;
  let allCorrect = 0;
  const choose = (start: number, picked: boolean[]) => {
    if (picked.length === k) {
      total++;
      if (picked.every(Boolean)) allCorrect++;
      return;
    }
    for (let i = start; i < n; i++) choose(i + 1, [...picked, items[i]!]);
  };
  choose(0, []);
  return total === 0 ? 0 : allCorrect / total;
}

describe('passAtK', () => {
  it('is 0 when nothing solved and 1 when everything solved', () => {
    expect(passAtK(5, 0, 1)).toBe(0);
    expect(passAtK(5, 5, 1)).toBe(1);
    expect(passAtK(5, 5, 5)).toBe(1);
  });

  it('matches the closed form on a known case', () => {
    // n=4, c=1, k=2 → 1 - C(3,2)/C(4,2) = 1 - 3/6 = 0.5
    expect(passAtK(4, 1, 2)).toBeCloseTo(0.5, 12);
  });

  it('increases with k', () => {
    const a = passAtK(6, 2, 1)!;
    const b = passAtK(6, 2, 3)!;
    expect(b).toBeGreaterThan(a);
  });

  it('returns null — NOT NaN — for k > n, the routine attrition case', () => {
    // A cell configured repetitions:5 that loses one run to a rate limit has n=4.
    expect(passAtK(4, 2, 5)).toBeNull();
    expect(Number.isNaN(passAtK(4, 2, 5) as number)).toBe(false);
  });

  it('returns null outside the domain', () => {
    expect(passAtK(0, 0, 1)).toBeNull();
    expect(passAtK(3, 1, 0)).toBeNull();
    expect(passAtK(3, 4, 1)).toBeNull();
  });
});

describe('passHatK', () => {
  it('agrees with brute-force subset enumeration at small n', () => {
    for (let n = 1; n <= 6; n++) {
      for (let c = 0; c <= n; c++) {
        for (let k = 1; k <= n; k++) {
          expect(passHatK(n, c, k)!).toBeCloseTo(bruteForcePassHatK(n, c, k), 12);
        }
      }
    }
  });

  it('returns null for k > n rather than NaN', () => {
    expect(passHatK(3, 3, 4)).toBeNull();
  });

  it('disagrees with passAtK where it should — the whole reason both exist', () => {
    // 1 of 3 solved: at least one of 3 is certain; all 3 correct is impossible.
    expect(passAtK(3, 1, 3)).toBe(1);
    expect(passHatK(3, 1, 3)).toBe(0);
  });
});

describe('wilsonInterval', () => {
  it('does not claim certainty from a single sample', () => {
    const i = wilsonInterval(1, 1)!;
    expect(i.low).toBeLessThan(1);
    expect(i.high).toBe(1);
  });

  it('narrows as n grows for the same proportion', () => {
    const w3 = wilsonInterval(3, 3)!;
    const w10 = wilsonInterval(10, 10)!;
    expect(w10.high - w10.low).toBeLessThan(w3.high - w3.low);
  });

  it('stays inside [0,1] at the extremes', () => {
    const zero = wilsonInterval(0, 10)!;
    expect(zero.low).toBeGreaterThanOrEqual(0);
    expect(zero.high).toBeLessThanOrEqual(1);
  });

  it('is null with no samples', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('distribution', () => {
  it('reports median and quartiles', () => {
    expect(distribution([1, 2, 3, 4])).toEqual({ median: 2.5, p25: 1.75, p75: 3.25 });
  });

  it('is all-null on no data rather than 0', () => {
    expect(distribution([])).toEqual({ median: null, p25: null, p75: null });
  });
});

describe('scoreCell', () => {
  it('excludes infrastructure failures from the denominator and reports them as attrition', () => {
    const runs = [
      run({ solved: true }),
      run({ solved: false }),
      run({ failureClass: 'rate-limit', costUSD: 5 }),
      run({ failureClass: 'auth', costUSD: 2 }),
    ];
    const r = scoreCell(CELL, runs, 2);
    expect(r.scoredRuns).toBe(2);
    expect(r.solveRate).toBe(0.5);
    expect(r.attritionRuns).toBe(2);
    expect(r.attritionCostUSD).toBe(7);
  });

  it('keeps non-infrastructure failures in the denominator', () => {
    const r = scoreCell(CELL, [run({ solved: true }), run({ solved: false, failureClass: 'validation-failed' })], 2);
    expect(r.scoredRuns).toBe(2);
    expect(r.solveRate).toBe(0.5);
  });

  it('computes costPerSolve from scored spend only, unaffected by attrition spend', () => {
    const runs = [
      run({ solved: true, costUSD: 2 }),
      run({ solved: false, costUSD: 2 }),
      run({ failureClass: 'crash', costUSD: 100 }),
    ];
    const r = scoreCell(CELL, runs, 2);
    expect(r.costPerSolve).toBe(4); // (2+2)/1 — the 100 never enters either side
    expect(r.attritionCostUSD).toBe(100);
  });

  it('leaves costPerSolve null at zero solves — never Infinity', () => {
    const r = scoreCell(CELL, [run({ solved: false }), run({ solved: false })], 2);
    expect(r.costPerSolve).toBeNull();
    expect(r.solveRate).toBe(0);
  });

  it('reports null rates for a cell with no scored runs', () => {
    const r = scoreCell(CELL, [run({ failureClass: 'unavailable' })], 2);
    expect(r.scoredRuns).toBe(0);
    expect(r.solveRate).toBeNull();
    expect(r.solveRateInterval).toBeNull();
  });

  it('computes tamperRate over runs where tampering was observable', () => {
    const r = scoreCell(CELL, [run({ solved: false, tampered: true }), run({ solved: true, tampered: false })], 2);
    expect(r.tamperRate).toBe(0.5);
  });

  it('returns null pass@k beyond n while still reporting it up to n', () => {
    const r = scoreCell(CELL, [run({ solved: true }), run({ solved: false })], 5);
    expect(r.passAtK[1]).toBeCloseTo(0.5, 12);
    expect(r.passAtK[2]).toBe(1);
    expect(r.passAtK[5]).toBeNull();
  });
});

describe('frictionGrade rubric', () => {
  it('is clean with no friction at all', () => {
    expect(deriveGrade({ n: 3, runsWithAnyFriction: 0, maxRepeatedEhToolFailure: 0, blockedRuns: 0 })).toBe('clean');
  });

  it('is noisy for a minority of runs', () => {
    expect(deriveGrade({ n: 5, runsWithAnyFriction: 2, maxRepeatedEhToolFailure: 1, blockedRuns: 0 })).toBe('noisy');
  });

  it('is obstructive for a majority of runs', () => {
    expect(deriveGrade({ n: 5, runsWithAnyFriction: 3, maxRepeatedEhToolFailure: 1, blockedRuns: 0 })).toBe('obstructive');
  });

  it('is obstructive when one EH tool failed 3+ times, even in a minority of runs', () => {
    expect(deriveGrade({ n: 10, runsWithAnyFriction: 1, maxRepeatedEhToolFailure: 3, blockedRuns: 0 })).toBe('obstructive');
  });

  it('is blocking only when EH-side friction was the sole terminal cause', () => {
    expect(deriveGrade({ n: 5, runsWithAnyFriction: 1, maxRepeatedEhToolFailure: 1, blockedRuns: 1 })).toBe('blocking');
  });

  it('records friction on solved runs and never lets it change solved', () => {
    const friction = { ...emptyFriction(), ehToolFailures: { count: 2, evidence: [] } };
    const r = scoreCell(CELL, [run({ solved: true, friction }), run({ solved: true, friction })], 2);
    expect(r.solveRate).toBe(1);
    expect(r.friction.ehToolFailureTotal).toBe(4);
    expect(r.friction.grade).not.toBe('clean');
  });

  it('aggregates friction over the same denominator as solveRate', () => {
    const friction = { ...emptyFriction(), ehToolFailures: { count: 1, evidence: [] } };
    const runs = [run({ solved: true, friction }), run({ failureClass: 'rate-limit', friction })];
    const r = scoreCell(CELL, runs, 2);
    expect(r.friction.scoredRuns).toBe(r.scoredRuns);
    expect(r.friction.scoredRuns).toBe(1);
  });
});

describe('paretoFrontier', () => {
  function cellReport(solveRate: number | null, costPerSolve: number | null, median: number | null): CellReport {
    return {
      cell: CELL,
      scoredRuns: 3,
      solvedRuns: 1,
      solveRate,
      solveRateInterval: null,
      passAtK: {},
      passHatK: {},
      costUSD: { median: null, p25: null, p75: null },
      durationMs: { median, p25: null, p75: null },
      totalTokens: { median: null, p25: null, p75: null },
      costPerSolve,
      attritionCostUSD: 0,
      attritionRuns: 0,
      tamperRate: null,
      friction: {
        scoredRuns: 3, runsWithAnyFriction: 0, ehToolFailureTotal: 0,
        maxRepeatedEhToolFailure: 0, protocolViolationRuns: 0, blockedRuns: 0, grade: 'clean',
      },
    };
  }

  it('drops a strictly dominated cell', () => {
    const cells = [
      cellReport(0.9, 1, 100),  // dominates
      cellReport(0.5, 5, 500),  // dominated on every axis
    ];
    const { frontier } = paretoFrontier(cells);
    expect(frontier).toEqual([0]);
  });

  it('keeps cells that trade off against each other', () => {
    const cells = [
      cellReport(0.9, 10, 100), // best solve rate
      cellReport(0.5, 1, 100),  // cheapest
    ];
    const { frontier } = paretoFrontier(cells);
    expect(frontier.sort()).toEqual([0, 1]);
  });

  it('EXCLUDES a zero-solve cell rather than letting its null cost dominate the frontier', () => {
    // The regression this test exists for: JS coerces `null < x` to `0 < x`, so a zero-solve cell
    // with costPerSolve = null would read as infinitely cheap and dominate everything.
    const cells = [
      cellReport(0.9, 5, 100),
      cellReport(0, null, 10), // zero solves: no cost coordinate
    ];
    const { frontier, excluded } = paretoFrontier(cells);
    expect(excluded).toEqual([1]);
    expect(frontier).toEqual([0]);
  });

  it('excludes a cell with no scored runs at all', () => {
    const { frontier, excluded } = paretoFrontier([cellReport(null, null, null), cellReport(1, 1, 1)]);
    expect(excluded).toEqual([0]);
    expect(frontier).toEqual([1]);
  });
});

describe('buildReport', () => {
  it('is recomputable from raw records alone and groups runs by cell', () => {
    const other: BenchmarkCell = { framework: FRAMEWORKS[1]!, phase: 'implementation' };
    const runs = [
      run({ cell: CELL, solved: true }),
      run({ cell: CELL, solved: false }),
      run({ cell: other, solved: true, costUSD: 3 }),
    ];
    const report = buildReport('s', 'abc1234', [CELL, other], 2, runs);
    expect(report.cells).toHaveLength(2);
    expect(report.cells[0]!.scoredRuns).toBe(2);
    expect(report.cells[1]!.scoredRuns).toBe(1);
    expect(report.totalRuns).toBe(3);
  });
});

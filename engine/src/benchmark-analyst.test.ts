import { describe, it, expect } from 'vitest';
import { buildAnalystBrief, parseNarrative } from './benchmark-analyst.js';
import type { BenchmarkRecord } from './benchmark-store.js';
import type { BenchmarkCell, BenchmarkRun } from './models/benchmark.js';
import { emptyFriction } from './models/benchmark.js';
import { CLI_CAPABILITIES } from './agents/types.js';

// The analyst is advisory, so these tests pin the two places its output could contaminate the
// record: the brief must carry the computed numbers AS GIVEN (so there is nothing to recompute
// from), and the parser must refuse a claim that names no run.

// Derived, not a literal — the adapter-boundary guard forbids naming a CLI outside agents/.
const FRAMEWORK = Object.keys(CLI_CAPABILITIES)[0] as BenchmarkCell['framework'];
const CELL: BenchmarkCell = { framework: FRAMEWORK, model: 'model-x', effortOverride: 'high', phase: 'implementation' };

function run(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    runId: 'r1',
    cell: CELL,
    repetitionIndex: 0,
    status: 'done',
    inputTokens: null,
    outputTokens: null,
    costUSD: 2.6,
    solved: true,
    ticketId: 'BENCH-7',
    ...overrides,
  } as BenchmarkRun;
}

function record(runs: BenchmarkRun[]): BenchmarkRecord {
  return {
    suite: {
      id: 's1',
      seedTitle: 'seed',
      seedPrompt: 'do the thing',
      baseCommit: 'a'.repeat(40),
      matrix: [CELL],
      repetitions: runs.length,
      status: 'done',
      createdAt: '2026-01-01T00:00:00Z',
    },
    runs,
    report: {
      suiteId: 's1',
      baseCommit: 'a'.repeat(40),
      generatedAt: '2026-01-01T00:00:00Z',
      cells: [{
        cell: CELL,
        scoredRuns: runs.length,
        solvedRuns: runs.filter((r) => r.solved).length,
        solveRate: 0.5,
        solveRateInterval: { low: 0.0946, high: 0.9054 },
        passAtK: {},
        passHatK: {},
        costUSD: { median: 2.6, p25: 2.6, p75: 2.6 },
        durationMs: { median: null, p25: null, p75: null },
        totalTokens: { median: null, p25: null, p75: null },
        costPerSolve: 5.2,
        attritionCostUSD: 0,
        attritionRuns: 0,
        tamperRate: 0,
        friction: { scoredRuns: runs.length, runsWithAnyFriction: 0, ehToolFailureTotal: 0, maxRepeatedEhToolFailure: 0, protocolViolationRuns: 0, blockedRuns: 0, grade: 'clean' },
      }],
      frontier: [0],
      zeroSolveCells: [],
    } as unknown as NonNullable<BenchmarkRecord['report']>,
  };
}

describe('buildAnalystBrief', () => {
  it('quotes the computed cell numbers verbatim so the analyst has nothing to recompute from', () => {
    const brief = buildAnalystBrief(record([run(), run({ runId: 'r2', solved: false })]));
    expect(brief).toContain('solveRate 0.50');
    expect(brief).toContain('Wilson 9–91%');
    expect(brief).toContain('costPerSolve $5.20');
    expect(brief).toContain('frictionGrade **clean**');
  });

  it('names every run id and its ticket, because those are the only admissible citations', () => {
    const brief = buildAnalystBrief(record([run(), run({ runId: 'r2', ticketId: 'BENCH-8' })]));
    expect(brief).toContain('run `r1`');
    expect(brief).toContain('run `r2`');
    expect(brief).toContain('BENCH-8');
  });

  it('surfaces friction evidence locators, not just counts', () => {
    const friction = emptyFriction();
    friction.ehToolFailures = { count: 2, evidence: [{ locator: 's:14', detail: 'get_ticket not found' }, { locator: 's:40' }] };
    const brief = buildAnalystBrief(record([run({ friction })]));
    expect(brief).toContain('ehToolFailures: 2 — s:14 (get_ticket not found); s:40');
  });

  it('tells the analyst how to answer and what is discarded', () => {
    const brief = buildAnalystBrief(record([run()]));
    expect(brief).toMatch(/change_status.*Ready/);
    expect(brief).toContain('discarded at parse time');
  });
});

describe('parseNarrative', () => {
  const known = new Set(['r1', 'r2']);

  it('returns null when there is no json block — free text is not promoted to a narrative', () => {
    expect(parseNarrative('I looked and it seemed fine.', 's1', known, [CELL])).toBeNull();
  });

  it('takes the LAST json block, so a quoted schema before the answer does not win', () => {
    const text = 'Schema:\n```json\n{"summary":"template"}\n```\nAnswer:\n```json\n{"summary":"real","claims":[]}\n```';
    expect(parseNarrative(text, 's1', known, [CELL])?.narrative.summary).toBe('real');
  });

  it('DROPS a claim whose runId is not a run in this suite, and counts the drop', () => {
    const text = '```json\n' + JSON.stringify({
      summary: 's',
      claims: [
        { statement: 'cited', runId: 'r1', locator: 's:3', attribution: 'eventhorizon' },
        { statement: 'uncited', locator: 's:3', attribution: 'eventhorizon' },
        { statement: 'wrong suite', runId: 'zzz', locator: 's:3', attribution: 'adapter' },
      ],
    }) + '\n```';
    const parsed = parseNarrative(text, 's1', known, [CELL])!;
    expect(parsed.narrative.claims.map((c) => c.statement)).toEqual(['cited']);
    expect(parsed.droppedClaims).toBe(2);
  });

  it('coerces an unknown attribution to unknown rather than inventing a layer', () => {
    const text = '```json\n' + JSON.stringify({ summary: 's', claims: [{ statement: 'x', runId: 'r1', locator: 'l', attribution: 'vibes' }] }) + '\n```';
    expect(parseNarrative(text, 's1', known, [CELL])!.narrative.claims[0]!.attribution).toBe('unknown');
  });

  it('keeps dissent only when it names a real cell and a real grade', () => {
    const text = '```json\n' + JSON.stringify({
      summary: 's',
      claims: [],
      dissent: [
        { cellIndex: 0, grade: 'noisy', reasoning: 'the refusals were by design' },
        { cellIndex: 5, grade: 'noisy', reasoning: 'no such cell' },
        { cellIndex: 0, grade: 'terrible', reasoning: 'not a grade' },
      ],
    }) + '\n```';
    const parsed = parseNarrative(text, 's1', known, [CELL])!;
    expect(parsed.narrative.dissent).toHaveLength(1);
    expect(parsed.narrative.dissent![0]!.cell).toEqual(CELL);
  });

  it('returns null for a block that is not an object', () => {
    expect(parseNarrative('```json\n[1,2]\n```', 's1', known, [CELL])).toBeNull();
    expect(parseNarrative('```json\nnot json\n```', 's1', known, [CELL])).toBeNull();
  });
});

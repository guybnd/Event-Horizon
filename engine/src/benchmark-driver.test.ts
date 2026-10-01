// FLUX-1739: the suite driver — the piece that actually executes runs.
//
// The scheduling rules here are the ones that keep a rate honest. A worktree-cap requeue must
// produce NO run record, NO failure class and NO friction record: the pool is shared with the
// Furnace and every human session, so if a cap hit counted as an outcome, a cell's effective `n`
// would become a function of unrelated board activity and every rate would silently drift.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitDurableOutcome, awaitRunTerminal, dispatchWithRetry, isTransientDispatchRefusal, concurrencyFor, driveSuite, isDriving, isRunSessionTerminal } from './benchmark-runner.js';
import { cliSessionsById } from './session-store.js';
import { CLI_CAPABILITIES, type CliFramework, type CliSessionRecord } from './agents/types.js';
import type { BenchmarkRun, BenchmarkSuite } from './models/benchmark.js';

const FW = (Object.keys(CLI_CAPABILITIES) as CliFramework[])[0]!;

function suite(overrides: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    seedTitle: 'seed',
    seedPrompt: 'do it',
    baseCommit: 'a'.repeat(40),
    matrix: [{ framework: FW, phase: 'implementation' }],
    repetitions: 1,
    status: 'calibrated',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function run(i: number, s: BenchmarkSuite): BenchmarkRun {
  return {
    runId: `r${i}`, suiteId: s.id, cell: s.matrix[0]!, repetitionIndex: i,
    status: 'pending', inputTokens: null, outputTokens: null, costUSD: null,
  };
}

afterEach(() => { cliSessionsById.clear(); vi.useRealTimers(); });

describe('driveSuite', () => {
  it('executes every pending run', async () => {
    const s = suite();
    const runs = [run(0, s), run(1, s), run(2, s)];
    const execute = vi.fn(async (_s, r: BenchmarkRun) => { r.status = 'completed'; return r; });

    await driveSuite(s, runs, 'C:/board', { execute });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
  });

  it('never exceeds the concurrency ceiling', async () => {
    const s = suite({ concurrency: 2 });
    const runs = [0, 1, 2, 3, 4].map((i) => run(i, s));
    let inFlight = 0;
    let peak = 0;
    const execute = vi.fn(async (_s, r: BenchmarkRun) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 5));
      inFlight--; r.status = 'completed'; return r;
    });

    await driveSuite(s, runs, 'C:/board', { execute });
    expect(peak).toBeLessThanOrEqual(concurrencyFor(s));
  });

  it('leaves a slot free — the pool is shared with the Furnace and human sessions', () => {
    expect(concurrencyFor(suite({ concurrency: 99 }))).toBeLessThanOrEqual(3);
  });

  it('REQUEUES a worktree-cap rejection and records nothing for it', async () => {
    const s = suite();
    const runs = [run(0, s)];
    let attempts = 0;
    const execute = vi.fn(async (_s, r: BenchmarkRun) => {
      attempts++;
      if (attempts === 1) throw new Error('Task worktree limit reached (4/4)');
      r.status = 'completed';
      return r;
    });

    await driveSuite(s, runs, 'C:/board', { execute, requeueDelayMs: 1 });

    expect(attempts).toBe(2);
    expect(runs[0]!.status).toBe('completed');
    // The cap hit is a scheduler wait state, not an outcome — nothing about it may reach the record.
    expect(runs[0]!.failureClass).toBeUndefined();
    expect(runs[0]!.friction).toBeUndefined();
  });

  it('gives up after the requeue cap rather than spinning on a permanently full pool', async () => {
    const s = suite();
    const runs = [run(0, s)];
    const execute = vi.fn(async () => { throw new Error('Task worktree limit reached (4/4)'); });

    await driveSuite(s, runs, 'C:/board', { execute, maxRequeues: 2, requeueDelayMs: 1 });

    expect(execute).toHaveBeenCalledTimes(3); // initial + 2 requeues
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.failureClass).toBe('unavailable');
  });

  it('records a non-cap failure as a crash and keeps going', async () => {
    const s = suite();
    const runs = [run(0, s), run(1, s)];
    const execute = vi.fn(async (_s, r: BenchmarkRun) => {
      if (r.runId === 'r0') throw new Error('adapter exploded');
      r.status = 'completed';
      return r;
    });

    await driveSuite(s, runs, 'C:/board', { execute });

    expect(runs[0]!.failureClass).toBe('crash');
    expect(runs[1]!.status).toBe('completed'); // one bad run does not abort the suite
  });

  it('refuses to double-drive one suite', async () => {
    const s = suite();
    const runs = [run(0, s)];
    let started = 0;
    const execute = vi.fn(async (_s, r: BenchmarkRun) => {
      started++;
      await new Promise((res) => setTimeout(res, 20));
      r.status = 'completed';
      return r;
    });

    const first = driveSuite(s, runs, 'C:/board', { execute });
    await new Promise((res) => setTimeout(res, 5));
    expect(isDriving(s.id)).toBe(true);
    await driveSuite(s, runs, 'C:/board', { execute }); // second call is a no-op
    await first;

    expect(started).toBe(1);
    expect(isDriving(s.id)).toBe(false);
  });

  it('skips runs that are not pending', async () => {
    const s = suite();
    const runs = [run(0, s), run(1, s)];
    runs[0]!.status = 'completed';
    const execute = vi.fn(async (_s, r: BenchmarkRun) => { r.status = 'completed'; return r; });

    await driveSuite(s, runs, 'C:/board', { execute });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('awaitRunTerminal', () => {
  function session(id: string, status: CliSessionRecord['status']): void {
    cliSessionsById.set(id, { id, status } as CliSessionRecord);
  }

  it('treats waiting-input as terminal — an unattended run has nobody to answer it', () => {
    expect(isRunSessionTerminal('waiting-input')).toBe(true);
    expect(isRunSessionTerminal('completed')).toBe(true);
    expect(isRunSessionTerminal('failed')).toBe(true);
    expect(isRunSessionTerminal('cancelled')).toBe(true);
    expect(isRunSessionTerminal('running')).toBe(false);
    expect(isRunSessionTerminal('pending')).toBe(false);
  });

  it('returns as soon as the session is terminal', async () => {
    session('sess-1', 'completed');
    await expect(awaitRunTerminal('T-1', 'sess-1', 10_000, 1)).resolves.toBe('terminal');
  });

  it('returns terminal immediately when there is no session to wait for', async () => {
    await expect(awaitRunTerminal('T-1', null, 10_000, 1)).resolves.toBe('terminal');
  });

  it('times out rather than hanging when a session never finishes', async () => {
    session('sess-2', 'running');
    await expect(awaitRunTerminal('T-2', 'sess-2', 20, 1)).resolves.toBe('timeout');
  });

  it('picks up a session that becomes terminal mid-wait', async () => {
    session('sess-3', 'running');
    setTimeout(() => session('sess-3', 'completed'), 10);
    await expect(awaitRunTerminal('T-3', 'sess-3', 5_000, 2)).resolves.toBe('terminal');
  });
});

describe('awaitDurableOutcome', () => {
  // The bug this fixes was a FALSE NEGATIVE: a run whose validation passed 7/7 was scored
  // `solved:false, failureClass:'crash'` because collection read the ticket's agent_session entry
  // while it was still `active`. The in-memory session going terminal and the durable entry being
  // written are two different events, and only the second one is safe to collect on.
  const tasks: Record<string, { history: unknown[] }> = {};
  vi.mock('./workspace-context.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./workspace-context.js')>();
    return actual;
  });

  it('returns immediately when there is no session to wait for', async () => {
    await expect(awaitDurableOutcome('T-1', undefined, 50, 5)).resolves.toBeUndefined();
  });

  it('gives up after the timeout rather than hanging the suite', async () => {
    // A durable entry that never finalizes is itself a terminal condition; blocking forever on it
    // would be worse than recording it.
    const started = Date.now();
    await awaitDurableOutcome('T-missing', 'sess-x', 60, 10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  void tasks;
});

describe('dispatchWithRetry', () => {
  // A freshly-minted ticket is not instantly visible to the start route, and a workspace that is
  // still activating refuses outright. Both look permanent and resolve in seconds. Recording one as
  // a crash puts a scored failure in the denominator against a config that never ran.
  const cell = { framework: FW, phase: 'implementation' } as const;
  const r = { runId: 'x', suiteId: 's', cell, repetitionIndex: 0, status: 'pending', inputTokens: null, outputTokens: null, costUSD: null } as never;

  it('retries a transient refusal and succeeds', async () => {
    let n = 0;
    const dispatch = vi.fn(async () => (++n < 3 ? { sessionId: null, error: 'Task not found' } : { sessionId: 'sess-1' }));
    const out = await dispatchWithRetry('BENCH-1', r, 'C:/board', dispatch as never);
    expect(out.sessionId).toBe('sess-1');
    expect(dispatch).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('does NOT retry a genuine refusal', async () => {
    const dispatch = vi.fn(async () => ({ sessionId: null, error: 'no adapter for framework' }));
    const out = await dispatchWithRetry('BENCH-2', r, 'C:/board', dispatch as never);
    expect(out.sessionId).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('recognises the transient refusals seen live', () => {
    for (const e of ['Task not found', 'Workspace "X" is activating, please retry', 'Workspace "X" is not open']) {
      expect(isTransientDispatchRefusal(e)).toBe(true);
    }
    expect(isTransientDispatchRefusal('no adapter')).toBe(false);
    expect(isTransientDispatchRefusal(undefined)).toBe(false);
  });
});

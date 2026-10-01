// FLUX-1739: evidence collection and the L1 verdict.
//
// The attrition split is the load-bearing part: infrastructure failures leave every rate's
// denominator, because scoring a provider down for being rate-limited measures the network, not the
// agent. Everything else stays in.
import { describe, it, expect, vi } from 'vitest';
import { classifyFailure, collectEvidence, deriveSolved, sessionEntries } from './benchmark-evidence.js';
import type { EvidenceTaskView } from './benchmark-evidence.js';

function session(overrides: Record<string, unknown> = {}) {
  return {
    type: 'agent_session',
    sessionId: 's1',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    status: 'completed',
    progress: [],
    user: 'Claude Code',
    date: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(overrides: Partial<EvidenceTaskView> = {}): EvidenceTaskView {
  return { id: 'BENCH-1', status: 'Ready', branch: 'flux/BENCH-1', history: [session()], ...overrides };
}

const noDiff = vi.fn(async () => ({ branch: 'b', worktree: null, base: null, files: [] }));

describe('classifyFailure — the attrition split', () => {
  it.each([
    ['rate limited by the provider', 'rate-limit'],
    ['usage limit reached', 'rate-limit'],
    ['not authenticated — run /login', 'auth'],
    ['agy: command not found', 'unavailable'],
    ['session timed out after 60m', 'timeout'],
  ])('classifies %j as %s', (outcome, expected) => {
    expect(classifyFailure('failed', outcome)).toBe(expected);
  });

  it('distinguishes a rate-limited failure from a genuine crash — same status, different class', () => {
    expect(classifyFailure('failed', 'rate limited')).toBe('rate-limit'); // attrition
    expect(classifyFailure('failed', 'agent exited with code 1')).toBe('crash'); // also attrition
    expect(classifyFailure('completed', undefined)).toBeUndefined(); // stays in the denominator
  });

  it('treats a still-active session as a crash rather than scoring an unfinished run', () => {
    expect(classifyFailure('active', undefined)).toBe('crash');
  });

  it('classifies a cancellation', () => {
    expect(classifyFailure('cancelled', undefined)).toBe('cancelled');
  });
});

describe('collectEvidence', () => {
  it('reads durable session state, tokens and duration', async () => {
    const e = await collectEvidence({
      task: task({ tokenMetadata: { inputTokens: 100, outputTokens: 20, costUSD: 1.5 } }),
      workspaceRoot: 'C:/board',
      baseCommit: 'abc1234',
      diff: noDiff as never,
    });
    expect(e.status).toBe('completed');
    expect(e.inputTokens).toBe(100);
    expect(e.costUSD).toBe(1.5);
    expect(e.durationMs).toBe(60_000);
    expect(e.sessionCount).toBe(1);
  });

  it('records absent telemetry as null, never 0', async () => {
    const e = await collectEvidence({ task: task(), workspaceRoot: 'C:/b', baseCommit: 'a', diff: noDiff as never });
    expect(e.inputTokens).toBeNull();
    expect(e.outputTokens).toBeNull();
    expect(e.costUSD).toBeNull();
  });

  it('measures the diff against the PINNED baseCommit, not the moving default branch', async () => {
    const diff = vi.fn(async () => ({ branch: 'b', worktree: null, base: null, files: [{ file: 'src/a.ts', additions: 1, deletions: 0, status: 'M' }] }));
    const e = await collectEvidence({ task: task(), workspaceRoot: 'C:/b', baseCommit: 'abc1234', diff: diff as never });
    expect(diff).toHaveBeenCalledWith('C:/b', 'flux/BENCH-1', { baseBranch: 'abc1234' });
    expect(e.hasDiff).toBe(true);
    expect(e.changedPaths).toEqual(['src/a.ts']);
  });

  it('survives a diff failure without failing the whole collection', async () => {
    const diff = vi.fn(async () => { throw new Error('git exploded'); });
    const e = await collectEvidence({ task: task(), workspaceRoot: 'C:/b', baseCommit: 'a', diff: diff as never });
    expect(e.hasDiff).toBe(false);
    expect(e.status).toBe('completed');
  });

  it('counts every session on the ticket, so restarts are visible to the friction layer', async () => {
    const t = task({ history: [session({ sessionId: 's1' }), session({ sessionId: 's2' })] });
    const e = await collectEvidence({ task: t, workspaceRoot: 'C:/b', baseCommit: 'a', diff: noDiff as never });
    expect(e.sessionCount).toBe(2);
  });

  it('picks up the durable outcome and classifies it', async () => {
    const t = task({ history: [session({ status: 'failed', outcome: 'rate limited by provider' })] });
    const e = await collectEvidence({ task: t, workspaceRoot: 'C:/b', baseCommit: 'a', diff: noDiff as never });
    expect(e.failureClass).toBe('rate-limit');
    expect(e.status).toBe('failed');
    expect(e.sessionOutcome).toBe('rate limited by provider');
  });
});

describe('sessionEntries', () => {
  it('returns only agent_session entries, in order', () => {
    const t = task({ history: [{ type: 'comment' }, session({ sessionId: 's1' }), session({ sessionId: 's2' })] });
    expect(sessionEntries(t).map((e) => e.sessionId)).toEqual(['s1', 's2']);
  });

  it('is empty for a ticket with no history', () => {
    expect(sessionEntries({})).toEqual([]);
  });
});

describe('deriveSolved — all three clauses required', () => {
  const pass = { exitCode: 0, passed: true, timedOut: false, durationMs: 1 };

  it('is true only with a normal terminal state AND a diff AND a passing validation', () => {
    expect(deriveSolved({ hasDiff: true, validation: pass })).toBe(true);
  });

  it('is false without a diff, even when validation passed', () => {
    // Guards against a run that changed nothing while the check happened to pass at base.
    expect(deriveSolved({ hasDiff: false, validation: pass })).toBe(false);
  });

  it('is false when validation failed', () => {
    expect(deriveSolved({ hasDiff: true, validation: { ...pass, passed: false } })).toBe(false);
  });

  it('is UNDEFINED (attrition), not false, when the harness could not judge the work', () => {
    // A held-out restore that did not apply is infrastructure. Scoring it unsolved would charge the
    // agent for the harness's failure — observed live on a worktree husk left by a failed teardown.
    expect(deriveSolved({
      hasDiff: true,
      validation: { exitCode: null, passed: false, timedOut: false, durationMs: 0, harnessError: 'held-out restore failed: x' },
    })).toBeUndefined();
  });

  it('is false when the run hit any failure class', () => {
    expect(deriveSolved({ failureClass: 'crash', hasDiff: true, validation: pass })).toBe(false);
  });

  it('is UNDEFINED with no validation block — "we did not check" is not "it failed"', () => {
    expect(deriveSolved({ hasDiff: true })).toBeUndefined();
  });
});

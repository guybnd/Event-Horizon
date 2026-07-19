import { describe, it, expect } from 'vitest';
import { computeAgentPayloadMetrics, computeDigestSavings, computeOversizedFlags } from './agent-payload-metrics.js';

const task = {
  id: 'FLUX-1',
  title: 'A ticket',
  status: 'Todo',
  tags: ['alpha', 'beta'],
  body: 'x'.repeat(400),
  history: [
    { type: 'comment', user: 'Guy', comment: 'hello there' },
    { type: 'agent_session', sessionId: 's1', progress: Array.from({ length: 50 }, (_, i) => ({ msg: `step ${i}` })) },
    { type: 'status_change', from: 'Grooming', to: 'Todo' },
  ],
};

describe('computeAgentPayloadMetrics', () => {
  it('reports total size and a section breakdown sorted by weight', () => {
    const m = computeAgentPayloadMetrics(task);
    expect(m.id).toBe('FLUX-1');
    expect(m.totalBytes).toBeGreaterThan(0);
    expect(m.totalTokensEst).toBeGreaterThan(0);

    const body = m.sections.find((s) => s.name === 'body');
    expect(body?.bytes).toBeGreaterThan(300);

    // sections are sorted descending by bytes
    const bytes = m.sections.map((s) => s.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a));

    // section percentages account for ~100% of the payload
    const sumPct = m.sections.reduce((sum, s) => sum + s.pct, 0);
    expect(sumPct).toBeGreaterThan(95);
    expect(sumPct).toBeLessThan(105);
  });

  it('breaks history into session/comment/other buckets and digests session progress', () => {
    const m = computeAgentPayloadMetrics(task);
    const sessions = m.historyBreakdown.find((h) => h.name === 'agent_session digests');
    const comments = m.historyBreakdown.find((h) => h.name === 'comments');
    expect(sessions?.count).toBe(1);
    expect(comments?.count).toBe(1);
    // progress[] is dropped by the agent digest, so the session bucket stays small
    // despite 50 raw progress entries on the source task.
    expect(sessions!.bytes).toBeLessThan(400);
  });
});

// Long comment text so summary-collapse actually shrinks the payload meaningfully.
const longComment = 'lorem ipsum dolor sit amet '.repeat(20);

// 30-entry history: [0-9] older full comments (no id/summary — dropped by windowing to the
// default 20-entry cap), [10-26] 17 comments WITH id+summary (fall inside the window but
// outside the last-3 "recent" band, so digestHistoryForAgent's summary-collapse actually
// replaces them with just their summary), [27-29] 3 recent comments with no summary (kept
// full because they're within `keepRecent`). This engages BOTH windowing and collapse.
const longHistoryTask = {
  id: 'FLUX-2',
  title: 'A heavily-worked ticket',
  status: 'Todo',
  tags: ['alpha'],
  body: 'short body',
  history: [
    ...Array.from({ length: 10 }, (_, i) => ({
      type: 'comment',
      user: 'Guy',
      date: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      comment: `${longComment} (old #${i})`,
    })),
    ...Array.from({ length: 17 }, (_, i) => ({
      type: 'comment',
      user: 'Agent',
      id: `c-mid-${i}`,
      date: `2026-01-01T00:01:${String(i).padStart(2, '0')}Z`,
      comment: `${longComment} (mid #${i})`,
      summary: `Mid comment #${i} summarized.`,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      type: 'comment',
      user: 'Guy',
      date: `2026-01-01T00:02:${String(i).padStart(2, '0')}Z`,
      comment: `${longComment} (recent #${i})`,
    })),
  ],
};

describe('computeDigestSavings', () => {
  it('reports positive savings when windowing + summary-collapse both engage', () => {
    const savings = computeDigestSavings(longHistoryTask);
    expect(savings.tokensSaved).toBeGreaterThan(0);
    expect(savings.undigestedTokensEst).toBeGreaterThan(savings.actualTokensEst);
    expect(savings.pctSaved).toBeGreaterThan(0);
    expect(savings.pctSaved).toBeLessThanOrEqual(100);
  });

  it('reports zero (never negative/NaN) savings for empty or near-empty history', () => {
    const emptyHistoryTask = { ...longHistoryTask, id: 'FLUX-3', history: [] };
    const emptySavings = computeDigestSavings(emptyHistoryTask);
    expect(emptySavings.tokensSaved).toBe(0);
    expect(emptySavings.pctSaved).toBe(0);
    expect(Number.isNaN(emptySavings.pctSaved)).toBe(false);
    expect(Number.isNaN(emptySavings.tokensSaved)).toBe(false);

    const oneEntryTask = {
      ...longHistoryTask,
      id: 'FLUX-4',
      history: [{ type: 'comment', user: 'Guy', comment: 'only one' }],
    };
    const oneSavings = computeDigestSavings(oneEntryTask);
    expect(oneSavings.tokensSaved).toBe(0);
    expect(oneSavings.pctSaved).toBe(0);
    expect(oneSavings.pctSaved).toBeGreaterThanOrEqual(0);
    expect(oneSavings.tokensSaved).toBeGreaterThanOrEqual(0);
  });
});

describe('computeOversizedFlags', () => {
  it('flags an oversized body and leaves a short one unflagged', () => {
    const bigBodyTask = { ...task, id: 'FLUX-5', body: 'y'.repeat(15_000) };
    const bigMetrics = computeAgentPayloadMetrics(bigBodyTask);
    expect(computeOversizedFlags(bigMetrics).bodyOversized).toBe(true);

    const smallMetrics = computeAgentPayloadMetrics(task);
    expect(computeOversizedFlags(smallMetrics).bodyOversized).toBe(false);
  });
});

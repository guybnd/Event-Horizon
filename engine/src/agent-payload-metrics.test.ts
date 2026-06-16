import { describe, it, expect } from 'vitest';
import { computeAgentPayloadMetrics } from './agent-payload-metrics.js';

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

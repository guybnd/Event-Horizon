import { describe, it, expect } from 'vitest';
import { digestHistoryForAgent, digestTerminalSessionProgress, compactSessionProgress } from './history.js';

function sessionEntry(sessionId: string, progressEntries: number) {
  return {
    type: 'agent_session',
    sessionId,
    startedAt: '2026-06-01T10:00:00.000Z',
    endedAt: '2026-06-01T10:30:00.000Z',
    status: 'completed',
    outcome: 'Implemented the thing',
    progress: Array.from({ length: progressEntries }, (_, i) => ({
      timestamp: `2026-06-01T10:0${i % 10}:00.000Z`,
      message: `chunk ${i} `.repeat(50),
      type: 'text',
    })),
    user: 'Claude Code',
    date: '2026-06-01T10:00:00.000Z',
  };
}

function comment(text: string, date: string) {
  return { type: 'comment', user: 'guybnd', comment: text, date, id: `c-${date}` };
}

describe('digestHistoryForAgent', () => {
  it('drops progress arrays from agent_session entries and adds progressCount', () => {
    const { history } = digestHistoryForAgent([sessionEntry('s1', 500)], 20);
    expect(history).toHaveLength(1);
    expect(history[0].progress).toBeUndefined();
    expect(history[0].progressCount).toBe(500);
    expect(history[0].sessionId).toBe('s1');
    expect(history[0].outcome).toBe('Implemented the thing');
  });

  it('drops status_change entries but keeps comments and activity (FLUX-499)', () => {
    const entries = [
      comment('please also handle X', '2026-06-01T09:00:00.000Z'),
      { type: 'status_change', from: 'Todo', to: 'In Progress', user: 'Agent', date: '2026-06-01T09:01:00.000Z' },
      { type: 'activity', user: 'Agent', comment: 'Validation passed', date: '2026-06-01T09:02:00.000Z' },
    ];
    const { history, olderHistoryEntries } = digestHistoryForAgent(entries, 20);
    expect(history).toEqual([entries[0], entries[2]]); // status_change filtered out
    expect(olderHistoryEntries).toBe(0);
  });

  it('windows to the most recent entries and counts the omitted older ones', () => {
    const entries = Array.from({ length: 30 }, (_, i) => comment(`c${i}`, `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
    const { history, olderHistoryEntries } = digestHistoryForAgent(entries, 20);
    expect(history).toHaveLength(20);
    expect(history[0].comment).toBe('c10');
    expect(history[19].comment).toBe('c29');
    expect(olderHistoryEntries).toBe(10);
  });

  it('shrinks a heavily-worked ticket by orders of magnitude', () => {
    const entries = [
      sessionEntry('s1', 800),
      comment('review feedback', '2026-06-02T00:00:00.000Z'),
      sessionEntry('s2', 600),
      sessionEntry('s3', 900),
    ];
    const before = JSON.stringify(entries).length;
    const { history } = digestHistoryForAgent(entries, 20);
    const after = JSON.stringify(history).length;
    expect(before).toBeGreaterThan(500_000);
    expect(after).toBeLessThan(2_000);
  });

  it('tolerates malformed entries and missing progress', () => {
    const entries = [null, 'garbage', { type: 'agent_session', sessionId: 's1', user: 'X', date: 'd' }];
    const { history } = digestHistoryForAgent(entries as any[], 20);
    expect(history[0]).toBeNull();
    expect(history[1]).toBe('garbage');
    expect(history[2].progressCount).toBe(0);
  });

  it('enforces a minimum window of 1', () => {
    const entries = [comment('a', '2026-06-01T00:00:00.000Z'), comment('b', '2026-06-02T00:00:00.000Z')];
    const { history, olderHistoryEntries } = digestHistoryForAgent(entries, 0);
    expect(history).toHaveLength(1);
    expect(history[0].comment).toBe('b');
    expect(olderHistoryEntries).toBe(1);
  });
});

describe('digestHistoryForAgent — summary-gated collapse (FLUX-503)', () => {
  const c = (text: string, date: string, extra: Record<string, any> = {}) =>
    ({ type: 'comment', user: 'Agent', comment: text, date, id: `c-${date}`, ...extra });

  it('collapses older agent comments that have a summary, keeps last keepRecent full', () => {
    const entries = [
      c('old long body '.repeat(20), '2026-06-01T00:00:00.000Z', { summary: 'old: did X' }),
      c('mid long body '.repeat(20), '2026-06-02T00:00:00.000Z', { summary: 'mid: did Y' }),
      c('r1', '2026-06-03T00:00:00.000Z'),
      c('r2', '2026-06-04T00:00:00.000Z'),
      c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBe(2);
    expect(history[0]).toMatchObject({ collapsed: true, summary: 'old: did X', id: 'c-2026-06-01T00:00:00.000Z' });
    expect(history[0].comment).toBeUndefined(); // full body dropped
    expect(history[2].comment).toBe('r1'); // last 3 kept full
    expect(history[4].comment).toBe('r3');
  });

  it('never collapses an entry without a summary (no forced truncation)', () => {
    const entries = [
      c('old, no summary', '2026-06-01T00:00:00.000Z'),
      c('a', '2026-06-02T00:00:00.000Z'), c('b', '2026-06-03T00:00:00.000Z'), c('d', '2026-06-04T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined();
    expect(history[0].comment).toBe('old, no summary');
  });

  it('never collapses a pinned entry even when old', () => {
    const entries = [
      c('pinned old', '2026-06-01T00:00:00.000Z', { summary: 's', pin: true }),
      c('a', '2026-06-02T00:00:00.000Z'), c('b', '2026-06-03T00:00:00.000Z'), c('d', '2026-06-04T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined();
    expect(history[0].comment).toBe('pinned old');
    expect(history[0].pin).toBe(true);
  });

  it('keepRecent=0 collapses every summarized entry', () => {
    const entries = [
      c('x', '2026-06-01T00:00:00.000Z', { summary: 'sx' }),
      c('y', '2026-06-02T00:00:00.000Z', { summary: 'sy' }),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 0);
    expect(collapsedCount).toBe(2);
    expect(history.every((e: any) => e.collapsed)).toBe(true);
  });

  it('expand un-collapses only the named ids (FLUX-504)', () => {
    const entries = [
      c('old A body '.repeat(20), '2026-06-01T00:00:00.000Z', { summary: 'A' }),
      c('old B body '.repeat(20), '2026-06-02T00:00:00.000Z', { summary: 'B' }),
      c('r1', '2026-06-03T00:00:00.000Z'), c('r2', '2026-06-04T00:00:00.000Z'), c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history } = digestHistoryForAgent(entries, 20, 3, { expand: ['c-2026-06-01T00:00:00.000Z'] });
    expect(history[0].comment).toContain('old A body'); // expanded → full
    expect(history[0].collapsed).toBeUndefined();
    expect(history[1].collapsed).toBe(true); // still collapsed
  });

  it('fullHistory returns everything uncollapsed (FLUX-504)', () => {
    const entries = [
      c('old A body '.repeat(20), '2026-06-01T00:00:00.000Z', { summary: 'A' }),
      c('old B body '.repeat(20), '2026-06-02T00:00:00.000Z', { summary: 'B' }),
      c('r1', '2026-06-03T00:00:00.000Z'), c('r2', '2026-06-04T00:00:00.000Z'), c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3, { fullHistory: true });
    expect(collapsedCount).toBeUndefined();
    expect(history.every((e: any) => !e.collapsed)).toBe(true);
    expect(history[0].comment).toContain('old A body');
  });

  it('does not collapse a summarized entry that has no id (FLUX-504 safety)', () => {
    const noId = { type: 'activity', user: 'Agent', comment: 'long body '.repeat(50), date: '2026-06-01T00:00:00.000Z', summary: 'act sum' };
    const entries = [noId, c('a', '2026-06-02T00:00:00.000Z'), c('b', '2026-06-03T00:00:00.000Z'), c('d', '2026-06-04T00:00:00.000Z')];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined(); // id-less entry never collapses
    expect(history[0].comment).toContain('long body'); // kept full
    expect(history[0].collapsed).toBeUndefined();
  });

  it('collapses old agent_session entries to their outcome, keeping sessionId (FLUX-507)', () => {
    const entries = [
      sessionEntry('s-old', 500), // old → collapse to outcome
      c('r1', '2026-06-03T00:00:00.000Z'), c('r2', '2026-06-04T00:00:00.000Z'), c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBe(1);
    expect(history[0]).toMatchObject({ type: 'agent_session', sessionId: 's-old', summary: 'Implemented the thing', collapsed: true });
    expect(history[0].progress).toBeUndefined();
  });
});

describe('digestTerminalSessionProgress', () => {
  it('strips progress from terminal sessions but keeps active sessions streaming', () => {
    const active = { ...sessionEntry('s-active', 40), status: 'active' };
    const done = sessionEntry('s-done', 700); // status: completed
    const failed = { ...sessionEntry('s-failed', 300), status: 'failed' };

    const result = digestTerminalSessionProgress([active, done, failed]);

    expect(result[0].progress).toHaveLength(40); // untouched — SSE appends into it
    expect(result[0].progressCount).toBeUndefined();
    expect(result[1].progress).toBeUndefined();
    expect(result[1].progressCount).toBe(700);
    expect(result[1].outcome).toBe('Implemented the thing');
    expect(result[2].progress).toBeUndefined();
    expect(result[2].progressCount).toBe(300);
  });

  it('passes comments, status changes, and malformed entries through untouched', () => {
    const entries = [
      comment('hi', '2026-06-01T00:00:00.000Z'),
      { type: 'status_change', from: 'Todo', to: 'Done', user: 'X', date: 'd' },
      null,
    ];
    expect(digestTerminalSessionProgress(entries as any[])).toEqual(entries);
  });
});

describe('compactSessionProgress', () => {
  const prog = (message: string, type?: string, data?: any) => ({ timestamp: '2026-06-01T10:00:00.000Z', message, ...(type ? { type } : {}), ...(data ? { data } : {}) });

  it('keeps milestones and the text tail, promotes the last text chunk to finalMessage', () => {
    const entry: any = {
      type: 'agent_session',
      sessionId: 's1',
      status: 'completed',
      progress: [
        prog('chunk 1', 'text'),
        prog('Running tests', 'tool', { tool: 'bash' }),
        prog('chunk 2', 'text'),
        prog('New topic: validation', 'topic'),
        prog('chunk 3', 'text'),
        prog('chunk 4 — the final summary', 'text'),
      ],
    };
    compactSessionProgress(entry);

    expect(entry.progress.map((p: any) => p.message)).toEqual([
      'Running tests',
      'New topic: validation',
      'chunk 3',
      'chunk 4 — the final summary',
    ]);
    expect(entry.originalProgressCount).toBe(6);
    expect(entry.finalMessage).toBe('chunk 4 — the final summary');
  });

  it('keeps error-looking entries and untyped chunks count as text', () => {
    const entry: any = {
      type: 'agent_session',
      sessionId: 's1',
      status: 'failed',
      progress: [
        prog('untyped chunk'),
        prog('Error: build failed', 'text'),
        prog('another'),
        prog('tail-1'),
        prog('tail-2'),
      ],
    };
    compactSessionProgress(entry);
    const messages = entry.progress.map((p: any) => p.message);
    expect(messages).toContain('Error: build failed');
    expect(messages).toContain('tail-1');
    expect(messages).toContain('tail-2');
    expect(messages).not.toContain('untyped chunk');
    expect(entry.finalMessage).toBe('tail-2');
  });

  it('is a no-op on active sessions and stable when re-run on compacted entries', () => {
    const active: any = { type: 'agent_session', sessionId: 's1', status: 'active', progress: [prog('a', 'text')] };
    compactSessionProgress(active);
    expect(active.progress).toHaveLength(1);
    expect(active.originalProgressCount).toBeUndefined();

    const compacted: any = { type: 'agent_session', sessionId: 's2', status: 'completed', progress: [prog('kept', 'tool')], originalProgressCount: 50, finalMessage: 'done' };
    compactSessionProgress(compacted);
    expect(compacted.originalProgressCount).toBe(50); // max(50, 1)
    expect(compacted.progress).toHaveLength(1);
    expect(compacted.finalMessage).toBe('done');
  });

  it('compacts progress that arrives after an early terminal write (stop path)', () => {
    // Stop flow: terminal status persisted with empty progress first…
    const entry: any = { type: 'agent_session', sessionId: 's1', status: 'cancelled', progress: [] };
    compactSessionProgress(entry);
    expect(entry.originalProgressCount).toBe(0);

    // …then the exit handler re-assigns the accumulated progress.
    entry.progress = [
      prog('chunk 1', 'text'),
      prog('chunk 2', 'text'),
      prog('chunk 3', 'text'),
      prog('Running tests', 'tool'),
      prog('the last words', 'text'),
    ];
    compactSessionProgress(entry);
    expect(entry.progress.map((p: any) => p.message)).toEqual(['chunk 3', 'Running tests', 'the last words']);
    expect(entry.originalProgressCount).toBe(5);
    expect(entry.finalMessage).toBe('the last words');
  });

  it('handles empty or missing progress gracefully', () => {
    const entry: any = { type: 'agent_session', sessionId: 's1', status: 'completed', progress: [] };
    compactSessionProgress(entry);
    expect(entry.progress).toEqual([]);
    expect(entry.originalProgressCount).toBe(0);
    expect(entry.finalMessage).toBeUndefined();

    const noProgress: any = { type: 'agent_session', sessionId: 's2', status: 'completed' };
    compactSessionProgress(noProgress);
    expect(noProgress.originalProgressCount).toBeUndefined();
  });
});

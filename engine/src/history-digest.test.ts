import { describe, it, expect } from 'vitest';
import {
  digestHistoryForAgent, digestTerminalSessionProgress, compactSessionProgress, normalizeHistoryEntries, buildHistoryDigest,
  type HistoryEntryLike, type AgentSessionProgress,
} from './history.js';

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
    expect(history[0]!.progress).toBeUndefined();
    expect(history[0]!.progressCount).toBe(500);
    expect(history[0]!.sessionId).toBe('s1');
    expect(history[0]!.outcome).toBe('Implemented the thing');
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
    expect(history[0]!.comment).toBe('c10');
    expect(history[19]!.comment).toBe('c29');
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
    const { history } = digestHistoryForAgent(entries, 20);
    expect(history[0]).toBeNull();
    expect(history[1]).toBe('garbage');
    expect(history[2]!.progressCount).toBe(0);
  });

  it('enforces a minimum window of 1', () => {
    const entries = [comment('a', '2026-06-01T00:00:00.000Z'), comment('b', '2026-06-02T00:00:00.000Z')];
    const { history, olderHistoryEntries } = digestHistoryForAgent(entries, 0);
    expect(history).toHaveLength(1);
    expect(history[0]!.comment).toBe('b');
    expect(olderHistoryEntries).toBe(1);
  });
});

describe('digestHistoryForAgent — summary-gated collapse (FLUX-503)', () => {
  const c = (text: string, date: string, extra: Record<string, unknown> = {}) =>
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
    expect(history[0]!.comment).toBeUndefined(); // full body dropped
    expect(history[2]!.comment).toBe('r1'); // last 3 kept full
    expect(history[4]!.comment).toBe('r3');
  });

  it('never collapses an entry without a summary (no forced truncation)', () => {
    const entries = [
      c('old, no summary', '2026-06-01T00:00:00.000Z'),
      c('a', '2026-06-02T00:00:00.000Z'), c('b', '2026-06-03T00:00:00.000Z'), c('d', '2026-06-04T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined();
    expect(history[0]!.comment).toBe('old, no summary');
  });

  it('never collapses a pinned entry even when old', () => {
    const entries = [
      c('pinned old', '2026-06-01T00:00:00.000Z', { summary: 's', pin: true }),
      c('a', '2026-06-02T00:00:00.000Z'), c('b', '2026-06-03T00:00:00.000Z'), c('d', '2026-06-04T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined();
    expect(history[0]!.comment).toBe('pinned old');
    expect(history[0]!.pin).toBe(true);
  });

  it('keepRecent=0 collapses every summarized entry', () => {
    const entries = [
      c('x', '2026-06-01T00:00:00.000Z', { summary: 'sx' }),
      c('y', '2026-06-02T00:00:00.000Z', { summary: 'sy' }),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 0);
    expect(collapsedCount).toBe(2);
    expect(history.every((e: HistoryEntryLike) => e.collapsed)).toBe(true);
  });

  it('expand un-collapses only the named ids (FLUX-504)', () => {
    const entries = [
      c('old A body '.repeat(20), '2026-06-01T00:00:00.000Z', { summary: 'A' }),
      c('old B body '.repeat(20), '2026-06-02T00:00:00.000Z', { summary: 'B' }),
      c('r1', '2026-06-03T00:00:00.000Z'), c('r2', '2026-06-04T00:00:00.000Z'), c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history } = digestHistoryForAgent(entries, 20, 3, { expand: ['c-2026-06-01T00:00:00.000Z'] });
    expect(history[0]!.comment).toContain('old A body'); // expanded → full
    expect(history[0]!.collapsed).toBeUndefined();
    expect(history[1]!.collapsed).toBe(true); // still collapsed
  });

  it('fullHistory returns everything uncollapsed (FLUX-504)', () => {
    const entries = [
      c('old A body '.repeat(20), '2026-06-01T00:00:00.000Z', { summary: 'A' }),
      c('old B body '.repeat(20), '2026-06-02T00:00:00.000Z', { summary: 'B' }),
      c('r1', '2026-06-03T00:00:00.000Z'), c('r2', '2026-06-04T00:00:00.000Z'), c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3, { fullHistory: true });
    expect(collapsedCount).toBeUndefined();
    expect(history.every((e: HistoryEntryLike) => !e.collapsed)).toBe(true);
    expect(history[0]!.comment).toContain('old A body');
  });

  it('does not collapse a summarized entry that has no id (FLUX-504 safety)', () => {
    const noId = { type: 'activity', user: 'Agent', comment: 'long body '.repeat(50), date: '2026-06-01T00:00:00.000Z', summary: 'act sum' };
    const entries = [noId, c('a', '2026-06-02T00:00:00.000Z'), c('b', '2026-06-03T00:00:00.000Z'), c('d', '2026-06-04T00:00:00.000Z')];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined(); // id-less entry never collapses
    expect(history[0]!.comment).toContain('long body'); // kept full
    expect(history[0]!.collapsed).toBeUndefined();
  });

  it('collapses old agent_session entries to their outcome, keeping sessionId (FLUX-507)', () => {
    const entries = [
      sessionEntry('s-old', 500), // old → collapse to outcome
      c('r1', '2026-06-03T00:00:00.000Z'), c('r2', '2026-06-04T00:00:00.000Z'), c('r3', '2026-06-05T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBe(1);
    expect(history[0]).toMatchObject({ type: 'agent_session', sessionId: 's-old', summary: 'Implemented the thing', collapsed: true });
    expect(history[0]!.progress).toBeUndefined();
  });
});

describe('activity entry ids + collapse (FLUX-526)', () => {
  it('normalizeHistoryEntries assigns a stable id to activity entries', () => {
    const { history } = normalizeHistoryEntries([
      { type: 'activity', user: 'Agent', date: '2026-06-01T10:00:00.000Z', comment: 'note' },
    ]);
    expect(typeof history[0]!.id).toBe('string');
    expect(history[0]!.id).toMatch(/^a-/);
  });

  it('collapses an old summarized activity entry and round-trips via expand', () => {
    const id = 'a-2026-06-01t10-00-00-000z';
    const history = [
      { type: 'activity', user: 'Agent', date: '2026-06-01T10:00:00.000Z', comment: 'full long progress note '.repeat(20), summary: 'did the thing', id },
      { type: 'comment', user: 'guybnd', date: '2026-06-01T11:00:00.000Z', comment: 'recent', id: 'c-1' },
      { type: 'comment', user: 'guybnd', date: '2026-06-01T11:30:00.000Z', comment: 'recent2', id: 'c-2' },
    ];
    // keepRecent=1 → indices 0 and 1 are "old"; the summarized activity at 0 collapses.
    const { history: digested } = digestHistoryForAgent(history, 20, 1);
    expect(digested[0]).toMatchObject({ type: 'activity', summary: 'did the thing', id, collapsed: true });
    expect(digested[0]!.comment).toBeUndefined();

    // expand:[id] recovers the full text.
    const { history: expanded } = digestHistoryForAgent(history, 20, 1, { expand: [id] });
    expect(expanded[0]!.comment).toContain('full long progress note');
    expect(expanded[0]!.collapsed).toBeUndefined();
  });

  it('keeps a summary-less activity entry full even though it now has an id', () => {
    const id = 'a-2026-06-01t09-00-00-000z';
    const history = [
      { type: 'activity', user: 'Agent', date: '2026-06-01T09:00:00.000Z', comment: 'Created ticket.', id },
      { type: 'comment', user: 'guybnd', date: '2026-06-01T11:00:00.000Z', comment: 'r1', id: 'c-1' },
      { type: 'comment', user: 'guybnd', date: '2026-06-01T11:30:00.000Z', comment: 'r2', id: 'c-2' },
    ];
    const { history: digested } = digestHistoryForAgent(history, 20, 1);
    expect(digested[0]!.collapsed).toBeUndefined();
    expect(digested[0]!.comment).toBe('Created ticket.');
  });
});

describe('temporal supersession (FLUX-811)', () => {
  const agentC = (text: string, date: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'comment', user: 'Agent', comment: text, date, id: `c-${date}`, ...extra });
  const userC = (text: string, date: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'comment', user: 'guybnd', comment: text, date, id: `c-${date}`, ...extra });

  it('collapses a superseded agent entry to a marker even when recent (window-independent)', () => {
    const entries = [
      agentC('use approach A', '2026-06-01T00:00:00.000Z'),
      agentC('abandoned A, going with B', '2026-06-02T00:00:00.000Z', { supersedes: ['c-2026-06-01T00:00:00.000Z'] }),
    ];
    // keepRecent=3 ⇒ both entries are "recent"; supersession still collapses the dead one.
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBe(1);
    expect(history[0]).toMatchObject({ supersededBy: 'c-2026-06-02T00:00:00.000Z', collapsed: true, id: 'c-2026-06-01T00:00:00.000Z' });
    expect(history[0]!.comment).toBeUndefined(); // dead body dropped
    expect(history[1]!.comment).toBe('abandoned A, going with B'); // live entry full
  });

  it('keeps the marker carrying the superseded entry summary when present', () => {
    const entries = [
      agentC('long dead plan '.repeat(20), '2026-06-01T00:00:00.000Z', { summary: 'plan A' }),
      agentC('replacing it', '2026-06-02T00:00:00.000Z', { supersedes: ['c-2026-06-01T00:00:00.000Z'] }),
    ];
    const { history } = digestHistoryForAgent(entries, 20, 3);
    expect(history[0]).toMatchObject({ collapsed: true, summary: 'plan A' });
    expect(history[0]!.comment).toBeUndefined();
  });

  it('keeps a superseded USER comment full with an advisory (authority before recency)', () => {
    const entries = [
      userC('do it this way', '2026-06-01T00:00:00.000Z'),
      agentC('I think this is now wrong', '2026-06-02T00:00:00.000Z', { supersedes: ['c-2026-06-01T00:00:00.000Z'] }),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined(); // user target not collapsed
    expect(history[0]!.comment).toBe('do it this way');
    expect(history[0]!.collapsed).toBeUndefined();
    expect(history[0]!.supersededByAdvisory).toBe('c-2026-06-02T00:00:00.000Z');
  });

  it('keeps a superseded PINNED agent entry full with an advisory', () => {
    const entries = [
      agentC('pinned key decision', '2026-06-01T00:00:00.000Z', { pin: true }),
      agentC('trying to supersede the pin', '2026-06-02T00:00:00.000Z', { supersedes: ['c-2026-06-01T00:00:00.000Z'] }),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined();
    expect(history[0]!.comment).toBe('pinned key decision');
    expect(history[0]!.collapsed).toBeUndefined();
    expect(history[0]!.supersededByAdvisory).toBe('c-2026-06-02T00:00:00.000Z');
  });

  it('expand:[id] recovers a superseded entry full text', () => {
    const entries = [
      agentC('the original detailed plan', '2026-06-01T00:00:00.000Z'),
      agentC('replaced', '2026-06-02T00:00:00.000Z', { supersedes: ['c-2026-06-01T00:00:00.000Z'] }),
    ];
    const { history } = digestHistoryForAgent(entries, 20, 3, { expand: ['c-2026-06-01T00:00:00.000Z'] });
    expect(history[0]!.comment).toBe('the original detailed plan');
    expect(history[0]!.collapsed).toBeUndefined();
  });

  it('ignores a supersedes link that points forward (not yet superseded)', () => {
    // entry references a LATER id — never collapses the future entry.
    const entries = [
      agentC('first', '2026-06-01T00:00:00.000Z', { supersedes: ['c-2026-06-02T00:00:00.000Z'] }),
      agentC('second', '2026-06-02T00:00:00.000Z'),
    ];
    const { history, collapsedCount } = digestHistoryForAgent(entries, 20, 3);
    expect(collapsedCount).toBeUndefined();
    expect(history[1]!.comment).toBe('second');
  });

  it('normalizeHistoryEntries coerces a string supersedes and drops dangling ids', () => {
    const { history, changed } = normalizeHistoryEntries([
      { type: 'comment', user: 'Agent', comment: 'x', date: '2026-06-01T00:00:00.000Z', id: 'c-a' },
      { type: 'comment', user: 'Agent', comment: 'y', date: '2026-06-02T00:00:00.000Z', id: 'c-b', supersedes: 'c-a' },
      { type: 'comment', user: 'Agent', comment: 'z', date: '2026-06-03T00:00:00.000Z', id: 'c-c', supersedes: ['c-a', 'ghost', 'c-c'] },
    ]);
    expect(changed).toBe(true);
    expect(history[1]!.supersedes).toEqual(['c-a']);      // string coerced to array
    expect(history[2]!.supersedes).toEqual(['c-a']);      // 'ghost' (dangling) + self-ref dropped
  });

  it('normalizeHistoryEntries removes supersedes entirely when no id matches', () => {
    const { history } = normalizeHistoryEntries([
      { type: 'comment', user: 'Agent', comment: 'y', date: '2026-06-02T00:00:00.000Z', id: 'c-b', supersedes: ['ghost'] },
    ]);
    expect(history[0]!.supersedes).toBeUndefined();
  });
});

describe('digestTerminalSessionProgress', () => {
  it('strips progress from terminal sessions but keeps active sessions streaming', () => {
    const active = { ...sessionEntry('s-active', 40), status: 'active' };
    const done = sessionEntry('s-done', 700); // status: completed
    const failed = { ...sessionEntry('s-failed', 300), status: 'failed' };

    const result = digestTerminalSessionProgress([active, done, failed]);

    expect(result[0]!.progress).toHaveLength(40); // untouched — SSE appends into it
    expect(result[0]!.progressCount).toBeUndefined();
    expect(result[1]!.progress).toBeUndefined();
    expect(result[1]!.progressCount).toBe(700);
    expect(result[1]!.outcome).toBe('Implemented the thing');
    expect(result[2]!.progress).toBeUndefined();
    expect(result[2]!.progressCount).toBe(300);
  });

  it('passes comments, status changes, and malformed entries through untouched', () => {
    const entries = [
      comment('hi', '2026-06-01T00:00:00.000Z'),
      { type: 'status_change', from: 'Todo', to: 'Done', user: 'X', date: 'd' },
      null,
    ];
    expect(digestTerminalSessionProgress(entries)).toEqual(entries);
  });
});

describe('buildHistoryDigest (FLUX-725)', () => {
  const NOW = Date.parse('2026-06-10T12:00:00.000Z');
  const sc = (from: string, to: string, date: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'status_change', from, to, user: 'Agent', date, ...extra });

  it('derives length, lastEntry, and lastActivityAt (max date, even when unsorted)', () => {
    const entries = [
      comment('first', '2026-06-09T00:00:00.000Z'),
      sc('Todo', 'In Progress', '2026-06-10T11:00:00.000Z'),
      // an out-of-order older entry as the array tail: lastEntry is the tail, lastActivityAt is the max
      { type: 'activity', user: 'Agent', comment: 'note', date: '2026-06-09T06:00:00.000Z' },
    ];
    const d = buildHistoryDigest(entries, 'In Progress', null, NOW);
    expect(d.length).toBe(3);
    expect(d.lastEntry).toEqual({ date: '2026-06-09T06:00:00.000Z', type: 'activity' });
    expect(d.lastActivityAt).toBe('2026-06-10T11:00:00.000Z');
  });

  it('records the most recent status_change into the current status (time-in-column)', () => {
    const entries = [
      sc('Todo', 'In Progress', '2026-06-09T00:00:00.000Z'),
      sc('In Progress', 'Ready', '2026-06-09T06:00:00.000Z'),
      sc('Ready', 'In Progress', '2026-06-10T09:00:00.000Z'), // moved back in
    ];
    const d = buildHistoryDigest(entries, 'In Progress', null, NOW);
    expect(d.enteredCurrentStatusAt).toBe('2026-06-10T09:00:00.000Z');
  });

  it('enteredCurrentStatusAt is null when never moved into the current status', () => {
    const d = buildHistoryDigest([sc('Todo', 'In Progress', '2026-06-09T00:00:00.000Z')], 'Todo', null, NOW);
    expect(d.enteredCurrentStatusAt).toBeNull();
  });

  it('windows statusChanges24h and keeps both from/to (flow arrows + done streak)', () => {
    const entries = [
      sc('Todo', 'In Progress', '2026-06-08T00:00:00.000Z'), // > 24h ago → excluded
      sc('In Progress', 'Ready', '2026-06-10T01:00:00.000Z'),
      sc('Ready', 'Done', '2026-06-10T11:30:00.000Z'),
    ];
    const d = buildHistoryDigest(entries, 'Done', null, NOW);
    expect(d.statusChanges24h).toEqual([
      { from: 'In Progress', to: 'Ready', date: '2026-06-10T01:00:00.000Z' },
      { from: 'Ready', to: 'Done', date: '2026-06-10T11:30:00.000Z' },
    ]);
  });

  it('flags a speed demon from FULL history even when the in-progress move is older than 24h', () => {
    const entries = [
      sc('Todo', 'In Progress', '2026-06-01T10:00:00.000Z'),
      sc('In Progress', 'Done', '2026-06-01T11:30:00.000Z'), // 1.5h later, both > 24h ago
    ];
    expect(buildHistoryDigest(entries, 'Done', null, NOW).isSpeedDemon).toBe(true);
    const slow = [
      sc('Todo', 'In Progress', '2026-06-01T10:00:00.000Z'),
      sc('In Progress', 'Done', '2026-06-01T13:00:00.000Z'), // 3h later
    ];
    expect(buildHistoryDigest(slow, 'Done', null, NOW).isSpeedDemon).toBe(false);
  });

  it('carries comment {id,user,date} without text, skipping id-less comments', () => {
    const entries = [
      comment('the secret plan', '2026-06-09T00:00:00.000Z'), // has id c-<date>
      { type: 'comment', user: 'guybnd', comment: 'no id here', date: '2026-06-09T01:00:00.000Z' },
    ];
    const d = buildHistoryDigest(entries, 'Todo', null, NOW);
    expect(d.comments).toEqual([{ id: 'c-2026-06-09T00:00:00.000Z', user: 'guybnd', date: '2026-06-09T00:00:00.000Z' }]);
    expect(JSON.stringify(d)).not.toContain('the secret plan'); // no comment text shipped
  });

  it('pre-computes requireInput only for a require-input ticket', () => {
    const entries = [
      comment('please clarify the scope', '2026-06-09T00:00:00.000Z'),
      { type: 'swimlane_change', action: 'set', swimlane: 'require-input', user: 'Agent', comment: 'Which API should I target?', date: '2026-06-10T09:00:00.000Z' },
    ];
    expect(buildHistoryDigest(entries, 'In Progress', 'require-input', NOW).requireInput)
      .toEqual({ question: 'Which API should I target?', setDate: '2026-06-10T09:00:00.000Z' });
    // not in the swimlane ⇒ null (question text not shipped board-wide)
    expect(buildHistoryDigest(entries, 'In Progress', null, NOW).requireInput).toBeNull();
  });

  it('tolerates malformed entries and empty history', () => {
    const empty = buildHistoryDigest([], 'Todo', null, NOW);
    expect(empty).toMatchObject({ length: 0, lastEntry: null, lastActivityAt: '', enteredCurrentStatusAt: null, isSpeedDemon: false, statusChanges24h: [], comments: [], requireInput: null });
    const d = buildHistoryDigest([null, 'garbage', { type: 'status_change' }], 'Todo', null, NOW);
    expect(d.length).toBe(3);
    expect(d.statusChanges24h).toEqual([]); // status_change with no from/to/date dropped
  });

  it('FLUX-1289: pre-computes planReviewComment only when planReviewState is set (the trailing param)', () => {
    const entries = [
      comment('unrelated earlier comment', '2026-07-01T00:00:00.000Z'),
      { type: 'comment', user: 'Plan Gate', comment: 'CHANGES NEEDED: the plan cites a symbol that no longer exists.', date: '2026-07-08T00:00:00.000Z' },
    ];
    expect(buildHistoryDigest(entries, 'Grooming', null, NOW, undefined, 'changes-requested').planReviewComment)
      .toEqual({ text: 'CHANGES NEEDED: the plan cites a symbol that no longer exists.', date: '2026-07-08T00:00:00.000Z', user: 'Plan Gate' });
    // planReviewState omitted/null ⇒ null (comment text not shipped board-wide otherwise)
    expect(buildHistoryDigest(entries, 'Grooming', null, NOW).planReviewComment).toBeNull();
    expect(buildHistoryDigest(entries, 'Grooming', null, NOW, undefined, null).planReviewComment).toBeNull();
  });
});

describe('compactSessionProgress', () => {
  const prog = (message: string, type?: AgentSessionProgress['type'], data?: unknown): AgentSessionProgress =>
    ({ timestamp: '2026-06-01T10:00:00.000Z', message, ...(type ? { type } : {}), ...(data ? { data } : {}) });

  it('keeps milestones and the text tail, promotes the last text chunk to finalMessage', () => {
    const entry: HistoryEntryLike = {
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

    expect(entry.progress!.map((p) => p.message)).toEqual([
      'Running tests',
      'New topic: validation',
      'chunk 3',
      'chunk 4 — the final summary',
    ]);
    expect(entry.originalProgressCount).toBe(6);
    expect(entry.finalMessage).toBe('chunk 4 — the final summary');
  });

  it('keeps error-looking entries and untyped chunks count as text', () => {
    const entry: HistoryEntryLike = {
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
    const messages = entry.progress!.map((p) => p.message);
    expect(messages).toContain('Error: build failed');
    expect(messages).toContain('tail-1');
    expect(messages).toContain('tail-2');
    expect(messages).not.toContain('untyped chunk');
    expect(entry.finalMessage).toBe('tail-2');
  });

  it('is a no-op on active sessions and stable when re-run on compacted entries', () => {
    const active: HistoryEntryLike = { type: 'agent_session', sessionId: 's1', status: 'active', progress: [prog('a', 'text')] };
    compactSessionProgress(active);
    expect(active.progress).toHaveLength(1);
    expect(active.originalProgressCount).toBeUndefined();

    const compacted: HistoryEntryLike = { type: 'agent_session', sessionId: 's2', status: 'completed', progress: [prog('kept', 'tool')], originalProgressCount: 50, finalMessage: 'done' };
    compactSessionProgress(compacted);
    expect(compacted.originalProgressCount).toBe(50); // max(50, 1)
    expect(compacted.progress).toHaveLength(1);
    expect(compacted.finalMessage).toBe('done');
  });

  it('returns true when it mutates the entry, false on an idempotent re-run (FLUX-1287)', () => {
    const active: HistoryEntryLike = { type: 'agent_session', sessionId: 's1', status: 'active', progress: [prog('a', 'text')] };
    expect(compactSessionProgress(active)).toBe(false);

    const bloated: HistoryEntryLike = {
      type: 'agent_session',
      sessionId: 's2',
      status: 'completed',
      progress: [prog('chunk 1', 'text'), prog('Running tests', 'tool'), prog('chunk 2', 'text'), prog('chunk 3', 'text')],
    };
    expect(compactSessionProgress(bloated)).toBe(true);
    expect(compactSessionProgress(bloated)).toBe(false); // already compacted — idempotent re-run is a no-op
  });

  it('compacts progress that arrives after an early terminal write (stop path)', () => {
    // Stop flow: terminal status persisted with empty progress first…
    const entry: HistoryEntryLike = { type: 'agent_session', sessionId: 's1', status: 'cancelled', progress: [] };
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
    expect(entry.progress.map((p) => p.message)).toEqual(['chunk 3', 'Running tests', 'the last words']);
    expect(entry.originalProgressCount).toBe(5);
    expect(entry.finalMessage).toBe('the last words');
  });

  it('handles empty or missing progress gracefully', () => {
    const entry: HistoryEntryLike = { type: 'agent_session', sessionId: 's1', status: 'completed', progress: [] };
    compactSessionProgress(entry);
    expect(entry.progress).toEqual([]);
    expect(entry.originalProgressCount).toBe(0);
    expect(entry.finalMessage).toBeUndefined();

    const noProgress: HistoryEntryLike = { type: 'agent_session', sessionId: 's2', status: 'completed' };
    compactSessionProgress(noProgress);
    expect(noProgress.originalProgressCount).toBeUndefined();
  });

  // FLUX-1202: a long session's `tool` milestones were kept in full forever, `data` payload
  // (raw tool-call parameters, e.g. a full Edit's old_string/new_string) included — on one live
  // ticket this alone accounted for ~60% of a 1.3MB persisted history and made its loadTask()
  // call a multi-second synchronous outlier.
  it('drops the data payload from tool entries beyond the most recent 20, keeping their message', () => {
    const progress: AgentSessionProgress[] = Array.from({ length: 25 }, (_, i) =>
      prog(`tool call ${i}`, 'tool', { toolName: 'Edit', parameters: { old_string: 'x'.repeat(1000) } }),
    );
    const entry: HistoryEntryLike = { type: 'agent_session', sessionId: 's1', status: 'completed', progress };
    compactSessionProgress(entry);

    expect(entry.progress).toHaveLength(25); // no entries dropped, just their `data`
    const withData = entry.progress!.filter((p) => p.data !== undefined);
    expect(withData).toHaveLength(20);
    expect(withData.map((p) => p.message)).toEqual(
      Array.from({ length: 20 }, (_, i) => `tool call ${i + 5}`), // last 20 of 25
    );
    // Older entries keep their message — only the heavy `data` is stripped.
    expect(entry.progress![0]!.message).toBe('tool call 0');
    expect(entry.progress![0]!.data).toBeUndefined();
  });

  it('never strips data from a tool entry that looks like an error, even outside the tail', () => {
    const progress: AgentSessionProgress[] = [
      prog('early failing call', 'tool', { error: 'boom' }),
      ...Array.from({ length: 25 }, (_, i) => prog(`call ${i}`, 'tool', { toolName: 'Bash' })),
    ];
    const entry: HistoryEntryLike = { type: 'agent_session', sessionId: 's1', status: 'completed', progress };
    compactSessionProgress(entry);

    const early = entry.progress!.find((p) => p.message === 'early failing call');
    expect(early?.data).toEqual({ error: 'boom' });
  });
});

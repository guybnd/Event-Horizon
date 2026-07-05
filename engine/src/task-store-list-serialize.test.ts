import { describe, it, expect } from 'vitest';
import { serializeTaskForList, type TaskRecord } from './task-store.js';
import { configCache } from './config.js';

function comment(id: string, text: string, date: string) {
  return { type: 'comment', user: 'guybnd', comment: text, date, id };
}

function activeSession(sessionId: string, date: string) {
  return { type: 'agent_session', sessionId, status: 'active', startedAt: date, date };
}

function baseTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'FLUX-9001',
    title: 'Test ticket',
    status: 'In Progress',
    body: 'body text',
    _path: '/tmp/FLUX-9001.md',
    ...overrides,
  } as TaskRecord;
}

/**
 * FLUX-1144: the `/api/tasks` list payload used to inline EVERY `comment` history entry (full
 * text) so the card hover popover could render them — on a heavily-commented ticket that's the
 * single largest field in a full-board response. These guard the cap added to
 * `serializeTaskForList` and the invariant it depends on: `historyDigest.comments` (which every
 * unread/mark-all-read surface reads) must stay a FULL, uncapped accounting regardless.
 */
describe('serializeTaskForList comment capping (FLUX-1144)', () => {
  it('caps full-text inline comments to the most recent `commentDigest.keepRecent` (default 3)', () => {
    const comments = Array.from({ length: 6 }, (_, i) =>
      comment(`c${i}`, `comment ${i}`, `2026-06-0${i + 1}T00:00:00.000Z`));
    const task = baseTask({ history: comments });

    const result = serializeTaskForList(task) as { history: Array<{ id?: string }>; historyDigest: { comments: Array<{ id: string }> } };

    expect(result.history.map((e) => e.id)).toEqual(['c3', 'c4', 'c5']);
    // Full accounting is preserved on the digest even though the inline array is capped — this is
    // what board-wide unread badges / "mark all read" read from, so capping must never affect them.
    expect(result.historyDigest.comments.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('always keeps active agent_session entries regardless of the comment cap, in original order', () => {
    const entries = [
      comment('c0', 'first', '2026-06-01T00:00:00.000Z'),
      activeSession('s1', '2026-06-01T00:00:30.000Z'),
      comment('c1', 'second', '2026-06-01T00:01:00.000Z'),
      comment('c2', 'third', '2026-06-01T00:02:00.000Z'),
      comment('c3', 'fourth', '2026-06-01T00:03:00.000Z'),
    ];
    const task = baseTask({ history: entries });

    const result = serializeTaskForList(task) as { history: Array<{ id?: string; sessionId?: string }> };

    // Comments capped to the most recent 3 (c1,c2,c3); the active session is kept regardless of
    // the cap and its original chronological position relative to the comments is preserved.
    expect(result.history.map((e) => e.id ?? e.sessionId)).toEqual(['s1', 'c1', 'c2', 'c3']);
  });

  it('respects a configured commentDigest.keepRecent', () => {
    const original = configCache.commentDigest;
    configCache.commentDigest = { keepRecent: 1 };
    try {
      const comments = [comment('c0', 'a', '2026-06-01T00:00:00.000Z'), comment('c1', 'b', '2026-06-02T00:00:00.000Z')];
      const result = serializeTaskForList(baseTask({ history: comments })) as { history: Array<{ id?: string }> };
      expect(result.history.map((e) => e.id)).toEqual(['c1']);
    } finally {
      configCache.commentDigest = original;
    }
  });

  it('drops comments entirely when keepRecent is configured to 0', () => {
    const original = configCache.commentDigest;
    configCache.commentDigest = { keepRecent: 0 };
    try {
      const comments = [comment('c0', 'a', '2026-06-01T00:00:00.000Z')];
      const result = serializeTaskForList(baseTask({ history: comments })) as { history: unknown[] };
      expect(result.history).toEqual([]);
    } finally {
      configCache.commentDigest = original;
    }
  });

  it('leaves cliSession/cliSessions undefined for a task with no registered sessions', () => {
    const result = serializeTaskForList(baseTask({ history: [] })) as { cliSession?: unknown; cliSessions?: unknown };
    expect(result.cliSession).toBeUndefined();
    expect(result.cliSessions).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { serializeTaskForList, serializeTaskForApi, type TaskRecord } from './task-store.js';
import { getConfig } from './config.js';
import { cliSessionsById, cliSessionsByTaskId, registerSession } from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

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
    const original = getConfig().commentDigest;
    getConfig().commentDigest = { keepRecent: 1 };
    try {
      const comments = [comment('c0', 'a', '2026-06-01T00:00:00.000Z'), comment('c1', 'b', '2026-06-02T00:00:00.000Z')];
      const result = serializeTaskForList(baseTask({ history: comments })) as { history: Array<{ id?: string }> };
      expect(result.history.map((e) => e.id)).toEqual(['c1']);
    } finally {
      getConfig().commentDigest = original;
    }
  });

  it('drops comments entirely when keepRecent is configured to 0', () => {
    const original = getConfig().commentDigest;
    getConfig().commentDigest = { keepRecent: 0 };
    try {
      const comments = [comment('c0', 'a', '2026-06-01T00:00:00.000Z')];
      const result = serializeTaskForList(baseTask({ history: comments })) as { history: unknown[] };
      expect(result.history).toEqual([]);
    } finally {
      getConfig().commentDigest = original;
    }
  });

  it('leaves cliSession/cliSessions undefined for a task with no registered sessions', () => {
    const result = serializeTaskForList(baseTask({ history: [] })) as { cliSession?: unknown; cliSessions?: unknown };
    expect(result.cliSession).toBeUndefined();
    expect(result.cliSessions).toBeUndefined();
  });
});

/**
 * FLUX-1685: `serializeTaskForApi` (the `GET /api/tasks/:id` detail payload) used to ship every
 * session's FULL `liveOutput`, including long-finished terminal sessions — measured at 910KB of a
 * 973KB response on a real ticket with a few completed sessions. These guard the terminal-only
 * truncation added to close that gap, mirroring the FLUX-1144 list-endpoint cap but scoped to
 * non-active sessions only (an active session's detail view IS the live console).
 */
describe('serializeTaskForApi terminal liveOutput truncation (FLUX-1685)', () => {
  const TASK_ID = 'FLUX-9002';
  const TAIL = 2048;
  // adapter-boundary: keep the framework value out of a `framework: 'claude'` literal (see
  // check-adapter-boundary.mjs's framework-literal-assign pattern) — this fixture doesn't
  // exercise per-CLI behavior, it just needs a valid CliFramework value.
  const TEST_FRAMEWORK = 'claude';

  beforeEach(() => {
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
  });

  function mockSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
    return {
      id: 'sess-' + Math.random().toString(36).slice(2, 8),
      taskId: TASK_ID,
      framework: TEST_FRAMEWORK,
      status: 'completed',
      command: 'claude',
      args: [],
      startedAt: '2026-08-21T00:00:00.000Z',
      label: 'Claude Code',
      outputBuffer: '',
      liveOutputBuffer: '',
      pendingAssistantText: '',
      skipPermissions: true,
      requestedStop: false,
      writeQueue: Promise.resolve(),
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      ...overrides,
    } as CliSessionRecord;
  }

  function register(session: CliSessionRecord) {
    cliSessionsById.set(session.id, session);
    registerSession(TASK_ID, session.id);
  }

  it('truncates a terminal session over the cap and records liveOutputChars, in both cliSession and cliSessions[]', () => {
    const bigOutput = 'x'.repeat(TAIL + 500);
    register(mockSession({ status: 'completed', liveOutputBuffer: bigOutput }));

    const result = serializeTaskForApi(baseTask({ id: TASK_ID, history: [] })) as {
      cliSession?: { liveOutput?: string; liveOutputChars?: number };
      cliSessions?: Array<{ liveOutput?: string; liveOutputChars?: number }>;
    };

    expect(result.cliSession?.liveOutput).toHaveLength(TAIL);
    expect(result.cliSession?.liveOutput).toBe(bigOutput.slice(-TAIL));
    expect(result.cliSession?.liveOutputChars).toBe(bigOutput.length);

    expect(result.cliSessions).toHaveLength(1);
    expect(result.cliSessions?.[0]?.liveOutput).toHaveLength(TAIL);
    expect(result.cliSessions?.[0]?.liveOutputChars).toBe(bigOutput.length);
  });

  it('leaves a terminal session under the cap untouched, with no liveOutputChars field', () => {
    const smallOutput = 'y'.repeat(100);
    register(mockSession({ status: 'completed', liveOutputBuffer: smallOutput }));

    const result = serializeTaskForApi(baseTask({ id: TASK_ID, history: [] })) as {
      cliSession?: { liveOutput?: string; liveOutputChars?: number };
      cliSessions?: Array<{ liveOutput?: string; liveOutputChars?: number }>;
    };

    expect(result.cliSession?.liveOutput).toBe(smallOutput);
    expect(result.cliSession?.liveOutputChars).toBeUndefined();
    expect(result.cliSessions?.[0]?.liveOutput).toBe(smallOutput);
    expect(result.cliSessions?.[0]?.liveOutputChars).toBeUndefined();
  });

  it.each(['pending', 'running', 'waiting-input', 'scheduled'] as const)(
    'leaves an active session (%s) byte-for-byte unchanged with no liveOutputChars field',
    (status) => {
      const bigOutput = 'z'.repeat(TAIL + 500);
      register(mockSession({ status, liveOutputBuffer: bigOutput }));

      const result = serializeTaskForApi(baseTask({ id: TASK_ID, history: [] })) as {
        cliSession?: { liveOutput?: string; liveOutputChars?: number };
        cliSessions?: Array<{ liveOutput?: string; liveOutputChars?: number }>;
      };

      expect(result.cliSession?.liveOutput).toBe(bigOutput);
      expect(result.cliSession?.liveOutputChars).toBeUndefined();
      expect(result.cliSessions?.[0]?.liveOutput).toBe(bigOutput);
      expect(result.cliSessions?.[0]?.liveOutputChars).toBeUndefined();
    },
  );

  it('serializes a FLUX-1683-shaped fixture (several large terminal sessions) to well under 100KB', () => {
    register(mockSession({ status: 'completed', endedAt: '2026-08-21T01:00:00.000Z', liveOutputBuffer: 'a'.repeat(380_000) }));
    register(mockSession({ status: 'completed', endedAt: '2026-08-21T02:00:00.000Z', liveOutputBuffer: 'b'.repeat(247_000) }));
    register(mockSession({ status: 'completed', endedAt: '2026-08-21T03:00:00.000Z', liveOutputBuffer: 'c'.repeat(197_000) }));
    register(mockSession({ status: 'completed', endedAt: '2026-08-21T04:00:00.000Z', liveOutputBuffer: 'd'.repeat(11_000) }));

    const result = serializeTaskForApi(baseTask({ id: TASK_ID, history: [] }));
    const sizeBytes = Buffer.byteLength(JSON.stringify(result), 'utf-8');

    expect(sizeBytes).toBeLessThan(100 * 1024);
  });
});

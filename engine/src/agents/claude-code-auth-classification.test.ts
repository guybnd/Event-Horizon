import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { isRateLimitError, isContextExhaustionError, isAuthError, attachStdoutProcessing } from './claude-code.js';
import type { CliSessionRecord } from './types.js';

// attachStdoutProcessing's result/is_error branch (claude-code.ts, ~L675-705) is the ONLY place that
// stamps session.terminalReason off a raw error string. Its two real I/O touch points — the durable
// transcript tee (appendTranscriptLine) and the SSE broadcast (broadcastEvent) — are mocked here so
// exercising that REAL path below doesn't write to disk or fan out events; everything else it touches
// (appendSessionOutput/flushSessionOutput/enqueueSessionWrite) is in-memory session bookkeeping only.
vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));

/** A bare EventEmitter stands in for the spawned CLI's ChildProcess — attachStdoutProcessing only
 *  ever calls `proc.stdout!.on('data', ...)`, so this is a faithful, dependency-free stand-in
 *  (same technique as adapter-contract.test.ts's A.1 fixtures). */
function fakeProc(): ChildProcessWithoutNullStreams {
  return { stdout: new EventEmitter() } as ChildProcessWithoutNullStreams;
}

/** Minimal CliSessionRecord — only the fields the result/is_error branch actually touches. */
function fakeSession(): CliSessionRecord {
  return {
    id: 'test-session',
    taskId: 'FLUX-1396',
    pendingAssistantText: '',
    liveOutputBuffer: '',
    outputBuffer: '',
    cumulativeOutput: '',
    currentActivity: undefined,
    lastProgressLog: undefined,
    resumeSessionId: undefined,
    sessionHistoryEntry: { sessionId: 'sess-1', progress: [] },
    status: 'running',
    label: 'Test',
    writeQueue: Promise.resolve(),
    flushTimer: undefined,
  } as unknown as CliSessionRecord;
}

// FLUX-1396 group C pinned the boundary that auth-style messages are NOT rate-limit/context-exhaustion.
// FLUX-1397 fills in the other side: auth failures now get their OWN distinct classification
// (`terminalReason: 'auth-expired'`) instead of falling through to an opaque unset reason — a bad/revoked
// key or expired OAuth token needs a human to re-authenticate, not a cooldown or a fresh session.
//
// FLUX-1406: `isAuthError` matches only unambiguous auth PHRASINGS. A bare `401`/`403`/`unauthorized`/
// `forbidden` in free text is deliberately NOT matched (see AUTH_LOOKALIKES below) — the numeric provider
// signal comes from the structured `api_error_status` field, checked in attachStdoutProcessing.
const AUTH_MESSAGES = [
  'authentication_error: invalid API key provided',
  'invalid x-api-key',
  'OAuth token has expired',
  'invalid credentials',
];

// FLUX-1406: bare HTTP 401/403 / unauthorized / forbidden in free text must NOT classify as auth on their
// own — a mid-task tool call (WebFetch, gh/curl against a scoped endpoint) can die with one of these and
// bubble it up as the terminal error, which is not a credential problem and must not halt the batch.
const AUTH_LOOKALIKES = [
  'API Error: 401 Unauthorized',
  'API Error: 403 Forbidden',
  'WebFetch failed: 403 Forbidden',
  'gh: HTTP 403: Resource not accessible by integration',
];

describe('isAuthError — auth/credential-expiry classifier (FLUX-1397)', () => {
  it('matches known auth/credential-failure signatures', () => {
    for (const msg of AUTH_MESSAGES) {
      expect(isAuthError(msg), msg).toBe(true);
    }
  });

  it('does NOT match unrelated failures (conservative — anything else parks)', () => {
    const negatives = [
      'permission denied',
      'tool not allowed',
      'API Error: 500 Internal Server Error',
      'invalid request: missing field',
      'ECONNRESET',
      'unknown',
      '',
      undefined,
      null,
    ];
    for (const msg of negatives) {
      expect(isAuthError(msg), String(msg)).toBe(false);
    }
  });

  // FLUX-1406: a bare 401/403/unauthorized/forbidden in free text is NOT enough on its own — otherwise a
  // tool-originated HTTP 403 (WebFetch, gh, curl) surfacing as the terminal error would spuriously halt
  // the whole batch for re-auth. The numeric provider signal must come from `api_error_status` instead.
  it('does NOT match a bare HTTP 401/403 / unauthorized / forbidden in free text (avoids false batch-halts)', () => {
    for (const msg of AUTH_LOOKALIKES) {
      expect(isAuthError(msg), msg).toBe(false);
    }
  });

  it('is disjoint from rate-limit / context-exhaustion (auth is neither a cooldown nor a fresh-session case)', () => {
    for (const msg of AUTH_MESSAGES) {
      expect(isRateLimitError(msg), msg).toBe(false);
      expect(isContextExhaustionError(msg), msg).toBe(false);
    }
    const rateLimited = ['API Error: 429 Too Many Requests', "You've hit your session limit"];
    const contextOverflow = ['prompt is too long: 250000 tokens > 200000 maximum', 'context_length_exceeded'];
    for (const msg of [...rateLimited, ...contextOverflow]) {
      expect(isAuthError(msg), msg).toBe(false);
    }
  });
});

describe('auth errors are classified distinctly from rate-limit / context-exhaustion (FLUX-1396 group C / FLUX-1397)', () => {
  it('isRateLimitError / isContextExhaustionError both reject every auth-style message', () => {
    for (const msg of AUTH_MESSAGES) {
      expect(isRateLimitError(msg), msg).toBe(false);
      expect(isContextExhaustionError(msg), msg).toBe(false);
    }
  });

  for (const msg of AUTH_MESSAGES) {
    it(`real classification path: a result/is_error event carrying "${msg}" sets terminalReason to 'auth-expired'`, async () => {
      const session = fakeSession();
      const proc = fakeProc();
      attachStdoutProcessing(proc, session, 'FLUX-1396');

      // Mirrors the real CLI's terminal-error payload shape (`result` + `is_error:true` + `error`),
      // same shape claude-code-rate-limit.test.ts's sibling context-exhaustion/rate-limit fixtures
      // exercise via the predicates directly — this instead drives the full onEvent handler.
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        is_error: true,
        subtype: 'error_during_execution',
        error: msg,
      }) + '\n'));

      await session.writeQueue;
      expect(session.terminalReason).toBe('auth-expired');
    });
  }

  for (const status of [401, 403]) {
    it(`an explicit ${status} api_error_status classifies as auth-expired even with an opaque message`, async () => {
      const session = fakeSession();
      const proc = fakeProc();
      attachStdoutProcessing(proc, session, 'FLUX-1396');
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'result',
        is_error: true,
        subtype: 'success',
        api_error_status: status,
        result: 'request failed',
      }) + '\n'));
      await session.writeQueue;
      expect(session.terminalReason).toBe('auth-expired');
    });
  }

  // FLUX-1406: the negative counterpart — a terminal error whose text merely CONTAINS "403 Forbidden"
  // (a tool-originated HTTP failure) but carries NO `api_error_status` must NOT be classified as
  // auth-expired, so it parks that one ticket normally instead of halting the whole batch for re-auth.
  it('a bare "403 Forbidden" terminal error with no api_error_status does NOT classify as auth-expired', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(proc, session, 'FLUX-1396');
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'error_during_execution',
      error: 'WebFetch failed: 403 Forbidden',
    }) + '\n'));
    await session.writeQueue;
    expect(session.terminalReason).toBeUndefined();
  });
});

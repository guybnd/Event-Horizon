import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { isRateLimitError, isContextExhaustionError, attachStdoutProcessing } from './claude-code.js';
import type { CliSessionRecord } from './types.js';

// attachStdoutProcessing's result/is_error branch (claude-code.ts, ~L675-696) is the ONLY place that
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

// FLUX-1396 group C: pin the auth-vs-rate-limit/context-exhaustion classification boundary. An
// authentication failure (bad/revoked key, expired OAuth token) is neither a transient rate limit
// nor a context overflow — it needs neither a cooldown-and-retry nor a fresh session, it needs a
// human to fix the credential. Today NEITHER classifier claims these messages, so they fall through
// to a hard `failed` -> park with terminalReason left unset. This locks that boundary so a future
// loosening of either regex (e.g. widening isRateLimitError's `\b429\b` or a "denied" phrasing) can't
// silently start auto-retrying/cooling-down what is really a broken credential.
const AUTH_MESSAGES = [
  'authentication_error: invalid API key provided',
  'API Error: 401 Unauthorized',
  'API Error: 403 Forbidden',
  'invalid x-api-key',
  'OAuth token has expired',
];

describe('auth errors are NOT classified as rate-limit or context-exhaustion (FLUX-1396 group C)', () => {
  it('isRateLimitError / isContextExhaustionError both reject every auth-style message', () => {
    for (const msg of AUTH_MESSAGES) {
      expect(isRateLimitError(msg), msg).toBe(false);
      expect(isContextExhaustionError(msg), msg).toBe(false);
    }
  });

  for (const msg of AUTH_MESSAGES) {
    it(`real classification path: a result/is_error event carrying "${msg}" leaves terminalReason undefined`, async () => {
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
      expect(session.terminalReason).toBeUndefined();
    });
  }
});

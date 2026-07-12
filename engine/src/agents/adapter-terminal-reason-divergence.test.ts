import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { CliSessionRecord } from './types.js';

// Same rationale as claude-code-auth-classification.test.ts: mock the two real I/O touch points
// (durable transcript tee + SSE broadcast) so exercising the REAL attachStdoutProcessing path below
// doesn't write to disk or fan out events.
vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));

function fakeProc(): ChildProcessWithoutNullStreams {
  return { stdout: new EventEmitter() } as ChildProcessWithoutNullStreams;
}

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

function emitResultError(proc: ChildProcessWithoutNullStreams, message: string) {
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: true, error: message }) + '\n'));
}

// FLUX-1396 group C: claude-code.ts's attachStdoutProcessing stamps a structured
// `session.terminalReason` ('context-exhausted' | 'rate-limited') off a `result`+is_error event's
// text (see claude-code-auth-classification.test.ts / claude-code-rate-limit.test.ts /
// claude-code-context-exhaustion.test.ts) so the Furnace stoker can retry (fresh session) or cool
// down (auto-retry on a cadence) instead of parking on the first strike. copilot.ts and gemini.ts
// both surface the SAME `result`+is_error shape inline via appendErrorToSession (FLUX-981) but
// NEITHER ever calls isRateLimitError/isContextExhaustionError nor touches terminalReason at all —
// confirmed by grep below. This pins that as CURRENT, divergent behavior (not a bug to fix here):
// on Copilot/Gemini, an auth failure, a rate limit, a context overflow, or a plain crash all fall
// through identically to a hard `failed` exit with terminalReason left unset, so the Furnace parks
// the ticket immediately rather than cooling down or retrying the way it does for Claude.
describe('copilot/gemini terminal-error handling diverges from claude-code (FLUX-1396 group C)', () => {
  // One of each flavor claude-code.ts DOES special-case (auth, rate-limit, context-exhaustion) plus
  // a plain crash — on Claude the middle two would set terminalReason; here none of the four should.
  const MESSAGES = [
    'authentication_error: invalid API key provided',
    'Rate limited: rejected [five_hour] (resets at 2026-07-02T18:10:00.000Z)',
    'context_length_exceeded',
    'API Error: 500 Internal Server Error',
  ];

  it('copilot: a result/turn_end is_error event never sets terminalReason (no cooldown/retry routing)', async () => {
    const { attachStdoutProcessing } = await import('./copilot.js');
    for (const msg of MESSAGES) {
      const session = fakeSession();
      const proc = fakeProc();
      attachStdoutProcessing(proc, session, 'FLUX-1396');
      emitResultError(proc, msg);
      await session.writeQueue;
      expect(session.terminalReason, msg).toBeUndefined();
    }
  });

  it('gemini: a result is_error event never sets terminalReason (no cooldown/retry routing)', async () => {
    const { attachStdoutProcessing } = await import('./gemini.js');
    for (const msg of MESSAGES) {
      const session = fakeSession();
      const proc = fakeProc();
      attachStdoutProcessing(proc, session, 'FLUX-1396');
      emitResultError(proc, msg);
      await session.writeQueue;
      expect(session.terminalReason, msg).toBeUndefined();
    }
  });

  // Source-level ratchet (same style as adapter-contract.test.ts's FLUX-985 delegation-resolution
  // guard) — fails the moment either adapter starts touching terminalReason, forcing this file's
  // documented divergence to be updated deliberately rather than silently going stale.
  it('neither copilot.ts nor gemini.ts references terminalReason today', () => {
    const agentsDir = dirname(fileURLToPath(import.meta.url));
    for (const file of ['copilot.ts', 'gemini.ts']) {
      const src = readFileSync(join(agentsDir, file), 'utf8');
      expect(src, `${file} should not reference terminalReason (update this FLUX-1396 divergence pin if it now does)`).not.toMatch(/terminalReason/);
    }
  });
});

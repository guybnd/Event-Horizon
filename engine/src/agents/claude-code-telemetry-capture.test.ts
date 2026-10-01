import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { getWorkspace } from '../workspace-context.js';
import { attachStdoutProcessing, buildTokenMetadataUpdate } from './claude-code.js';
import { appendTranscriptEvent } from '../transcript.js';
import type { CliSessionRecord } from './types.js';

// FLUX-1744: `rate_limit_event` and `compact_boundary` frames used to be either flattened into a
// human-readable error line (rate limit) or dropped entirely (compaction). This drives the real
// onVendorEvent handler (claude-code.ts) with captured real JSONL frame shapes and asserts the
// structured fields it now stamps onto the session record. Co-located in agents/ (like
// claude-code-auth-classification.test.ts) because it deep-imports a concrete adapter file, which the
// adapter-boundary guard forbids outside agents/.
//
// Deliberately avoids importing the node child-process module's type (unlike
// claude-code-auth-classification.test.ts) — the fake proc below is a bare EventEmitter, no real
// subprocess or git fixture, so this stays out of the `check:classify` integration signal (a static
// import of that module) and runs in the fast `unit` vitest project, per the ticket's plan.
vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));

/** A bare EventEmitter stands in for the spawned CLI's child process — attachStdoutProcessing only
 *  ever calls `proc.stdout!.on('data', ...)`, same technique as claude-code-auth-classification.
 *  test.ts's fakeProc, but without importing that module's type (see note above). Typed with a
 *  concrete non-null `stdout` here (rather than the real, nullable `ChildProcess['stdout']`) so
 *  call sites below can `.emit(...)` on it directly; cast to the real param type only where passed
 *  into `attachStdoutProcessing`. */
function fakeProc(): { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  return { stdout: new EventEmitter(), kill: vi.fn() };
}

function asProc(proc: { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }): Parameters<typeof attachStdoutProcessing>[0] {
  return proc as unknown as Parameters<typeof attachStdoutProcessing>[0];
}

function fakeSession(): CliSessionRecord {
  return {
    id: 'test-session',
    taskId: 'FLUX-1744',
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

describe('rate_limit_event -> session.lastRateLimit (FLUX-1744)', () => {
  it('populates lastRateLimit with an ISO resetsAt, and still emits the existing human-readable line', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, 'FLUX-1744');

    const resetsAtEpoch = 1798822200; // 2026-12-31T23:30:00.000Z
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAtEpoch },
    }) + '\n'));

    await session.writeQueue;
    expect(session.lastRateLimit).toEqual({
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: new Date(resetsAtEpoch * 1000).toISOString(),
      observedAt: expect.any(String),
    });
    expect(session.liveOutputBuffer).toContain('Rate limited: rejected [five_hour]');
  });

  it('refreshes observedAt on a repeated status/rateLimitType even though the dedupe key suppresses the chat line', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, 'FLUX-1744');

    const t0 = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    try {
      const frame = JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1798822200 },
      }) + '\n';
      proc.stdout.emit('data', Buffer.from(frame));
      await session.writeQueue;
      expect(session.lastRateLimit?.observedAt).toBe(new Date(t0).toISOString());
      const linesAfterFirst = session.liveOutputBuffer.split('Rate limited:').length - 1;

      vi.setSystemTime(t0 + 60_000);
      proc.stdout.emit('data', Buffer.from(frame));
      await session.writeQueue;
      // This is the assertion that actually pins the FLUX-1744 ordering requirement: recordRateLimit
      // runs BEFORE the dedupe check, so observedAt must have moved even on a repeated status/rateLimitType.
      expect(session.lastRateLimit?.observedAt).toBe(new Date(t0 + 60_000).toISOString());
      // The dedupe key (lastRateLimitKey) is unchanged, so no SECOND "Rate limited:" chat line lands.
      const linesAfterSecond = session.liveOutputBuffer.split('Rate limited:').length - 1;
      expect(linesAfterSecond).toBe(linesAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not populate lastRateLimit for an "allowed" status, and does not clear a prior one', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, 'FLUX-1744');

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1798822200 },
    }) + '\n'));
    await session.writeQueue;
    expect(session.lastRateLimit?.status).toBe('rejected');

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
    }) + '\n'));
    await session.writeQueue;
    // FLUX-1744: "last observed wall" — an allowed event must not erase the prior rejection.
    expect(session.lastRateLimit?.status).toBe('rejected');
  });
});

describe('compact_boundary -> session compaction fields (FLUX-1744)', () => {
  it('two frames (auto then manual) yield compactionCount:2, summed cumulativeDroppedTokens, and the most recent trigger/duration', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, 'FLUX-1744');

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 40000, duration_ms: 1200 },
    }) + '\n'));
    await session.writeQueue;
    expect(session.compactionCount).toBe(1);
    expect(session.cumulativeDroppedTokens).toBe(140000);
    expect(session.lastCompactTrigger).toBe('auto');
    expect(session.lastCompactDurationMs).toBe(1200);
    expect(session.lastCompactionAt).toEqual(expect.any(String));
    // FLUX-1746: this is the only place the emitted transcript-marker event's SHAPE is asserted —
    // substrate-projection.test.ts drives the projector off a hand-built event and never touches
    // the emitter, so a field rename here would compile clean and silently strip the marker.
    expect(appendTranscriptEvent).toHaveBeenCalledWith('FLUX-1744', expect.objectContaining({
      type: 'compaction', trigger: 'auto', preTokens: 180000, postTokens: 40000, durationMs: 1200,
    }));

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 90000, post_tokens: 20000, duration_ms: 800 },
    }) + '\n'));
    await session.writeQueue;
    expect(session.compactionCount).toBe(2);
    expect(session.cumulativeDroppedTokens).toBe(140000 + 70000);
    expect(session.lastCompactTrigger).toBe('manual');
    expect(session.lastCompactDurationMs).toBe(800);
  });

  it('a frame with post_tokens omitted (the CLI schema marks it optional) does not inflate cumulativeDroppedTokens', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, 'FLUX-1744');

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000, duration_ms: 1200 },
    }) + '\n'));
    await session.writeQueue;
    expect(session.compactionCount).toBe(1);
    expect(session.cumulativeDroppedTokens).toBeUndefined();
    expect(session.lastCompactTrigger).toBe('auto');
  });
});

describe('buildTokenMetadataUpdate is unaffected by a compact_boundary in between (FLUX-1744)', () => {
  const TICKET = 'FLUX-1744';

  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getWorkspace().tasks[TICKET] = { id: TICKET };
  });

  it('produces the same token/cost delta whether or not a compaction happened between usage frames', async () => {
    const session = fakeSession();
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, 'FLUX-1744');

    const usageFrame = (input: number, output: number, cost: number) => JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      total_cost_usd: cost,
    }) + '\n';

    proc.stdout.emit('data', Buffer.from(usageFrame(1000, 200, 0.01)));
    await session.writeQueue;
    const firstUpdate = buildTokenMetadataUpdate(TICKET, session);
    expect(firstUpdate).not.toBeNull();
    // Persist the first flush into the ticket, exactly as the real exit handler does — the second
    // flush's delta below is computed against THIS baseline (buildTokenMetadataUpdate's `prev`).
    getWorkspace().tasks[TICKET].tokenMetadata = firstUpdate!;

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 40000, duration_ms: 1200 },
    }) + '\n'));
    await session.writeQueue;

    // A fresh usage frame carries THAT TURN's own usage (session.inputTokens/etc accumulate across
    // turns) — 500/100/0.005 new, not a cumulative 1500/300/0.015.
    proc.stdout.emit('data', Buffer.from(usageFrame(500, 100, 0.005)));
    await session.writeQueue;
    const secondUpdate = buildTokenMetadataUpdate(TICKET, session);
    expect(secondUpdate).not.toBeNull();

    // The delta from the second flush is exactly the SECOND usage frame's contribution — the
    // compact_boundary in between must not have touched the flushed-baseline bookkeeping.
    expect(secondUpdate!.inputTokens - firstUpdate!.inputTokens).toBe(500);
    expect(secondUpdate!.outputTokens - firstUpdate!.outputTokens).toBe(100);
    expect(session.compactionCount).toBe(1);
  });
});

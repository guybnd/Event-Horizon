import { describe, it, expect, vi } from 'vitest';
import { checkBinaryInstalled, resolveClaudeExePath, isDefinitiveNotInstalled, surfaceResumeFailure } from './shared.js';
import type { CliSessionRecord } from './types.js';

// ─── Mocks for the surfaceResumeFailure tests below (FLUX-1120) ───────────────
// surfaceResumeFailure persists through task-store/parked-ticket — mocked here so it
// never touches the filesystem or a real ticket store (paths are relative to THIS file).
const updateAgentSession = vi.fn().mockResolvedValue(undefined);
const updateTaskWithHistory = vi.fn().mockResolvedValue(undefined);
const raiseNeedsAction = vi.fn().mockResolvedValue(undefined);
const buildActivityEntry = vi.fn((comment: string, user: string, date: string) => ({ type: 'activity', comment, user, date }));
vi.mock('../task-store.js', () => ({
  updateAgentSession: (...args: unknown[]) => updateAgentSession(...args),
  updateTaskWithHistory: (...args: unknown[]) => updateTaskWithHistory(...args),
}));
vi.mock('../parked-ticket.js', () => ({
  raiseNeedsAction: (...args: unknown[]) => raiseNeedsAction(...args),
}));
vi.mock('../history.js', () => ({
  buildActivityEntry: (...args: [string, string, string]) => buildActivityEntry(...args),
}));

function fakeSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'test-session',
    taskId: 'FLUX-1120',
    status: 'running',
    label: 'Test',
    liveOutputBuffer: '',
    outputBuffer: '',
    cumulativeOutput: '',
    writeQueue: Promise.resolve(),
    ...overrides,
  } as CliSessionRecord;
}

// FLUX-1003 (epic FLUX-996): checkBinaryInstalled/resolveClaudeExePath were converted from
// execFileSync/execSync (SYNCHRONOUS — blocking the whole event loop on every spawn/reply) to
// async equivalents, plus caching. Tested against real subprocesses (mirrors the existing
// "tested against real git" pattern in task-worktree.test.ts) rather than mocking child_process,
// since the caching wraps `promisify(execFile)` at module-load time — a post-hoc child_process
// spy wouldn't intercept the already-captured reference, making that style of test unreliable.
describe('checkBinaryInstalled (async, cached)', () => {
  it('is a Promise-returning function (never blocks the event loop)', () => {
    // The historical bug: execFileSync's synchronous nature. Asserting the return type is a
    // Promise is the structural guarantee that this can no longer stall the shared event loop.
    const result = checkBinaryInstalled('node');
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('resolves for a binary genuinely on PATH', async () => {
    // 'node' is guaranteed present — this process is running under it.
    await expect(checkBinaryInstalled('node')).resolves.toBeUndefined();
  });

  it('resolves again immediately from the positive cache (no re-spawn needed to pass)', async () => {
    await checkBinaryInstalled('node');
    await expect(checkBinaryInstalled('node')).resolves.toBeUndefined();
  });

  it('rejects with an actionable message for a binary that is not installed', async () => {
    await expect(checkBinaryInstalled('eh-definitely-not-a-real-binary-xyz123'))
      .rejects.toThrow(/not installed or not on PATH/);
  });

  it('rejects consistently on a second call within the negative-cache TTL', async () => {
    const binary = 'eh-definitely-not-a-real-binary-abc789';
    await expect(checkBinaryInstalled(binary)).rejects.toThrow(/not installed or not on PATH/);
    // Second call must still reject (served from the negative cache, not a fluke PATH change).
    await expect(checkBinaryInstalled(binary)).rejects.toThrow(/not installed or not on PATH/);
  });
});

// FLUX-1016: checkBinaryInstalled must only negative-cache a DEFINITIVE "not installed" (clean
// non-zero exit of which/where) — a transient checker failure (10s timeout, or which/where itself
// failing to spawn) must NOT poison the 30s negative cache, mirroring resolveClaudeExePath's
// transient-not-cached rule (FLUX-985). A real 10s timeout can't be triggered deterministically in
// a unit test, so the cache-or-not decision is factored into this pure predicate and tested here.
describe('isDefinitiveNotInstalled (cache-decision predicate)', () => {
  it('treats a clean non-zero exit (numeric code, not killed, no signal) as definitive', () => {
    // `which`/`where` exiting 1 because the binary is genuinely absent → safe to negative-cache.
    expect(isDefinitiveNotInstalled({ code: 1, killed: false, signal: null })).toBe(true);
  });

  it('treats a timeout (killed by our 10s cap) as transient — not cached', () => {
    // Node kills a timed-out child: killed=true, signal set, code null.
    expect(isDefinitiveNotInstalled({ code: null, killed: true, signal: 'SIGTERM' })).toBe(false);
  });

  it('treats a signal-terminated checker as transient even if not flagged killed', () => {
    expect(isDefinitiveNotInstalled({ code: null, killed: false, signal: 'SIGKILL' })).toBe(false);
  });

  it('treats a checker spawn error (string code like ENOENT) as transient — not cached', () => {
    expect(isDefinitiveNotInstalled({ code: 'ENOENT', killed: false, signal: null })).toBe(false);
  });
});

describe('resolveClaudeExePath (async, cached)', () => {
  it('is a Promise-returning function (never blocks the event loop)', () => {
    const result = resolveClaudeExePath();
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('resolves to null immediately on non-Windows platforms', async () => {
    if (process.platform === 'win32') return; // this test's guarantee only holds off-Windows
    await expect(resolveClaudeExePath()).resolves.toBeNull();
  });
});

// FLUX-1120: a resume-turn pre-spawn failure (e.g. resolveResumeExecutionRoot refusing to run on a
// reclaimed worktree) throws BEFORE any child process spawns, so there is no proc.on('error') to hang
// the FLUX-981 surfacing off of. surfaceResumeFailure gives it the same clear, durable treatment.
describe('surfaceResumeFailure (FLUX-1120)', () => {
  it('marks the session failed, surfaces the error inline, and updates the EXISTING agent_session entry in place', async () => {
    updateAgentSession.mockClear();
    updateTaskWithHistory.mockClear();
    raiseNeedsAction.mockClear();
    const session = fakeSession({ sessionHistoryEntry: { sessionId: 'sess-1', progress: [] } as never });

    await expect(surfaceResumeFailure(session, 'FLUX-1120', new Error('worktree reclaimed'))).rejects.toThrow(
      'worktree reclaimed',
    );

    expect(session.status).toBe('failed');
    expect(session.endedAt).toBeTruthy();
    // Inline chat-visible error (FLUX-981 pipeline): flushed into the session's own progress list.
    expect(session.sessionHistoryEntry?.progress.some((p) => p.message.includes('worktree reclaimed'))).toBe(true);
    // Board-visible Needs Action, not just a silent HTTP 500.
    expect(raiseNeedsAction).toHaveBeenCalledWith('FLUX-1120', 'worktree reclaimed');
    // Updates the SAME agent_session entry (no duplicate entry minted).
    expect(updateAgentSession).toHaveBeenCalledTimes(1);
    expect(updateAgentSession).toHaveBeenCalledWith('FLUX-1120', 'sess-1', expect.any(Function));
    expect(updateTaskWithHistory).not.toHaveBeenCalled();
  });

  it('falls back to a plain activity entry when the session has no existing agent_session entry', async () => {
    updateAgentSession.mockClear();
    updateTaskWithHistory.mockClear();
    raiseNeedsAction.mockClear();
    const session = fakeSession();

    await expect(surfaceResumeFailure(session, 'FLUX-1120', new Error('boom'))).rejects.toThrow('boom');

    expect(updateAgentSession).not.toHaveBeenCalled();
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-Error value wrapped in an Error', async () => {
    const session = fakeSession();
    await expect(surfaceResumeFailure(session, 'FLUX-1120', 'plain string failure')).rejects.toThrow(
      'plain string failure',
    );
  });

  // FLUX-1120 review: a Stop already in flight owns this session's terminal state — must not be
  // clobbered back to 'failed' by a resume failure racing it.
  it('does not clobber a concurrent user-initiated stop', async () => {
    updateAgentSession.mockClear();
    updateTaskWithHistory.mockClear();
    raiseNeedsAction.mockClear();
    const session = fakeSession({
      status: 'cancelled',
      requestedStop: true,
      sessionHistoryEntry: { sessionId: 'sess-1', progress: [] } as never,
    });

    await expect(surfaceResumeFailure(session, 'FLUX-1120', new Error('worktree reclaimed'))).rejects.toThrow(
      'worktree reclaimed',
    );

    // Status is left exactly as the stop route set it — not overwritten to 'failed'.
    expect(session.status).toBe('cancelled');
    expect(session.sessionHistoryEntry?.progress).toHaveLength(0);
    expect(raiseNeedsAction).not.toHaveBeenCalled();
    expect(updateAgentSession).not.toHaveBeenCalled();
    expect(updateTaskWithHistory).not.toHaveBeenCalled();
  });

  // FLUX-1120 review: best-effort surfacing must never mask the ORIGINAL error with a
  // store-layer one (mirrors the "surfacing is best-effort" precedent in cli-session.ts).
  it('still rejects with the ORIGINAL error when persisting the failure itself throws', async () => {
    updateAgentSession.mockClear();
    updateAgentSession.mockRejectedValueOnce(new Error('disk full'));
    const session = fakeSession({ sessionHistoryEntry: { sessionId: 'sess-1', progress: [] } as never });

    await expect(surfaceResumeFailure(session, 'FLUX-1120', new Error('worktree reclaimed'))).rejects.toThrow(
      'worktree reclaimed',
    );
    updateAgentSession.mockResolvedValue(undefined);
  });
});

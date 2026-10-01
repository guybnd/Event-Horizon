import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitForSessionLiveness, type SessionLivenessSnapshot } from './mcp-server.js';

/**
 * FLUX-1772: `start_session` returns as soon as the spawn is dispatched (FLUX-1002) — a session
 * that dies seconds later (e.g. `auth-expired` from duplicate Claude installs) previously looked
 * identical to a healthy dispatch. `waitForSessionLiveness` is the pure polling loop the tool
 * handler drives; these tests inject a fake `poll`/`sleep`/`Date.now` so no real timers or network
 * are involved (mirrors the `nextStepForStatus` pure-function test idiom).
 *
 * All tests drive a fake clock via `Date.now` so the loop's deadline check never depends on real
 * wall-clock time — `afterEach` restores it so no stub leaks between tests (FLUX-1772 review Minor 2).
 */
describe('waitForSessionLiveness (FLUX-1772 early-exit liveness probe)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Fake clock + sleep: `sleep(ms)` advances the fake `now` instead of waiting for real time. */
  function fakeClock(startAt = 0) {
    let now = startAt;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const sleep = vi.fn((ms: number) => { now += ms; return Promise.resolve(); });
    return sleep;
  }

  it('confirms liveness once the session is running with output, and keeps polling to the deadline', async () => {
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'running' }) // running but no output yet — not confirmed
      .mockResolvedValue({ status: 'running', lastOutputAt: '2026-01-01T00:00:01.000Z' });

    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { timeoutMs: 2000, intervalMs: 500, sleep });

    expect(outcome).toEqual({ liveness: 'confirmed' });
    // Must keep polling all the way to the deadline (not stop at first output) so a later
    // 'failed' still has a chance to win — this is the FLUX-1772 review blocker fix.
    expect(poll.mock.calls.length).toBe(5);
  });

  it('reports failed even after output was already seen — the real auth-expired timeline (FLUX-1772 Blocker)', async () => {
    // This is the ordering that actually happens in production: `lastOutputAt` is stamped on the
    // `system/init` stdout frame seconds before the `api_retry` frame drives the auth-expired kill.
    // A probe that returned 'confirmed' as soon as it saw output would win this race and never see
    // the failure below — asserting 'failed' here is what catches that regression.
    const authDiagnosis: NonNullable<SessionLivenessSnapshot['authDiagnosis']> = {
      verdict: 'duplicate-installs',
      spawnedBinary: { path: '/a/claude' },
      duplicates: ['/a/claude', '/b/claude'],
      shadowing: { settingsKey: false, settingsHelper: false, envKey: false, baseUrl: false },
    };
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'running', lastOutputAt: '2026-01-01T00:00:01.000Z' })
      .mockResolvedValueOnce({ status: 'failed', terminalReason: 'auth-expired', authDiagnosis });

    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { timeoutMs: 5000, intervalMs: 500, sleep });

    expect(outcome).toEqual({ liveness: 'failed', terminalReason: 'auth-expired', authDiagnosis });
  });

  it('reports failed even when the classification has not landed yet (authDiagnosis is async)', async () => {
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>()
      .mockResolvedValueOnce({ status: 'failed' });

    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { sleep });

    expect(outcome).toEqual({ liveness: 'failed', terminalReason: undefined, authDiagnosis: undefined });
  });

  it('reports failed when the session is user-stopped inside the window (FLUX-1772 Minor 3)', async () => {
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>()
      .mockResolvedValueOnce({ status: 'running', lastOutputAt: '2026-01-01T00:00:01.000Z' })
      .mockResolvedValueOnce({ status: 'cancelled' });

    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { sleep });

    expect(outcome).toEqual({ liveness: 'failed', terminalReason: undefined, authDiagnosis: undefined });
  });

  it('times out to unconfirmed (not an error) when the session is still pending/silent', async () => {
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>().mockResolvedValue({ status: 'pending' });
    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { timeoutMs: 2000, intervalMs: 500, sleep });
    expect(outcome).toEqual({ liveness: 'unconfirmed' });
    expect(poll.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats a session never yet visible to the poll (undefined) the same as pending', async () => {
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>().mockResolvedValue(undefined);
    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { timeoutMs: 1000, intervalMs: 500, sleep });
    expect(outcome).toEqual({ liveness: 'unconfirmed' });
  });

  it('times out to confirmed (not unconfirmed) when output was seen but the session never fails', async () => {
    const poll = vi.fn<() => Promise<SessionLivenessSnapshot | undefined>>()
      .mockResolvedValueOnce({ status: 'running', lastOutputAt: '2026-01-01T00:00:01.000Z' })
      .mockResolvedValue({ status: 'running', lastOutputAt: '2026-01-01T00:00:01.000Z' });
    const sleep = fakeClock();
    const outcome = await waitForSessionLiveness(poll, { timeoutMs: 1000, intervalMs: 500, sleep });
    expect(outcome).toEqual({ liveness: 'confirmed' });
  });
});

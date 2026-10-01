// FLUX-1713: getCiRunnerInfo() is routed through runGh() (git-exec.ts) — mock git-exec's runGh
// directly, mirroring git-remote-host.test.ts's approach for resolveRemoteHost().

import { describe, it, expect, beforeEach, vi } from 'vitest';

const runGhMock = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGh: (...args: unknown[]) => runGhMock(...args),
}));

import { getCiRunnerInfo, invalidateCiRunnerCache } from './ci-runner.js';

const RUNS_RESPONSE = { workflow_runs: [{ id: 42 }] };

function jobsResponse(jobs: Array<{ name: string; labels: string[]; runner_name?: string }>) {
  return { jobs };
}

function mockRunsThenJobs(jobs: Array<{ name: string; labels: string[]; runner_name?: string }>) {
  runGhMock.mockImplementation((args: string[]) => {
    if (args[1] === 'repos/{owner}/{repo}/actions/runs') {
      return Promise.resolve({ stdout: JSON.stringify(RUNS_RESPONSE), stderr: '' });
    }
    return Promise.resolve({ stdout: JSON.stringify(jobsResponse(jobs)), stderr: '' });
  });
}

describe('getCiRunnerInfo (FLUX-1713)', () => {
  beforeEach(() => {
    runGhMock.mockReset();
    invalidateCiRunnerCache();
  });

  it('returns undefined immediately for a falsy head sha, without calling gh', async () => {
    expect(await getCiRunnerInfo(null, '/repo')).toBeUndefined();
    expect(await getCiRunnerInfo(undefined, '/repo')).toBeUndefined();
    expect(await getCiRunnerInfo('', '/repo')).toBeUndefined();
    expect(runGhMock).not.toHaveBeenCalled();
  });

  it('classifies a job carrying the self-hosted label as self-hosted, surfacing runner name', async () => {
    mockRunsThenJobs([{ name: 'check', labels: ['self-hosted', 'Linux', 'X64'], runner_name: 'guy-cachyos-x8664-linux' }]);
    const info = await getCiRunnerInfo('sha1', '/repo');
    expect(info?.origin).toBe('self-hosted');
    expect(info?.runnerName).toBe('guy-cachyos-x8664-linux');
    expect(info?.jobs).toEqual([{ name: 'check', origin: 'self-hosted', runnerName: 'guy-cachyos-x8664-linux', labels: ['self-hosted', 'Linux', 'X64'] }]);
  });

  it('classifies an ubuntu-latest-only job as hosted', async () => {
    mockRunsThenJobs([{ name: 'check', labels: ['ubuntu-latest'] }]);
    const info = await getCiRunnerInfo('sha2', '/repo');
    expect(info?.origin).toBe('hosted');
    expect(info?.runnerName).toBeUndefined();
  });

  it('classifies mixed job origins as mixed and omits a single runnerName', async () => {
    mockRunsThenJobs([
      { name: 'check-hosted', labels: ['ubuntu-latest'] },
      { name: 'check-self', labels: ['self-hosted', 'Linux'], runner_name: 'box-1' },
    ]);
    const info = await getCiRunnerInfo('sha3', '/repo');
    expect(info?.origin).toBe('mixed');
    expect(info?.runnerName).toBeUndefined();
    expect(info?.jobs).toHaveLength(2);
  });

  it('returns undefined when runGh throws (no gh / unauthed / network hiccup)', async () => {
    runGhMock.mockRejectedValue(new Error('gh: command not found'));
    expect(await getCiRunnerInfo('sha4', '/repo')).toBeUndefined();
  });

  it('returns undefined when there are no workflow_runs for the sha', async () => {
    runGhMock.mockResolvedValue({ stdout: JSON.stringify({ workflow_runs: [] }), stderr: '' });
    expect(await getCiRunnerInfo('sha5', '/repo')).toBeUndefined();
  });

  it('returns undefined when the run has no jobs', async () => {
    runGhMock.mockImplementation((args: string[]) => {
      if (args[1] === 'repos/{owner}/{repo}/actions/runs') {
        return Promise.resolve({ stdout: JSON.stringify(RUNS_RESPONSE), stderr: '' });
      }
      return Promise.resolve({ stdout: JSON.stringify({ jobs: [] }), stderr: '' });
    });
    expect(await getCiRunnerInfo('sha6', '/repo')).toBeUndefined();
  });

  it('caches by head sha within the TTL, avoiding a second gh round-trip', async () => {
    mockRunsThenJobs([{ name: 'check', labels: ['ubuntu-latest'] }]);
    await getCiRunnerInfo('sha7', '/repo');
    const callsAfterFirst = runGhMock.mock.calls.length;
    await getCiRunnerInfo('sha7', '/repo');
    expect(runGhMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-fetches after invalidateCiRunnerCache', async () => {
    mockRunsThenJobs([{ name: 'check', labels: ['ubuntu-latest'] }]);
    await getCiRunnerInfo('sha8', '/repo');
    const callsAfterFirst = runGhMock.mock.calls.length;
    invalidateCiRunnerCache();
    await getCiRunnerInfo('sha8', '/repo');
    expect(runGhMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  // FLUX-1713 review (Major 1): misses used to go uncached, so a repo with `gh` but no Actions
  // workflows at all re-probed on every 90s reconcile tick, forever. A miss must be cached too
  // (on a shorter TTL than a resolved hit) so it stops re-firing `gh api` calls that can never
  // succeed, while still picking up a real run shortly after one appears.
  it('caches a miss (no workflow_runs for the sha) within the miss TTL, avoiding a second gh round-trip', async () => {
    runGhMock.mockResolvedValue({ stdout: JSON.stringify({ workflow_runs: [] }), stderr: '' });
    expect(await getCiRunnerInfo('sha9', '/repo')).toBeUndefined();
    const callsAfterFirst = runGhMock.mock.calls.length;
    expect(await getCiRunnerInfo('sha9', '/repo')).toBeUndefined();
    expect(runGhMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('caches a miss from a run with no jobs yet within the miss TTL', async () => {
    runGhMock.mockImplementation((args: string[]) => {
      if (args[1] === 'repos/{owner}/{repo}/actions/runs') {
        return Promise.resolve({ stdout: JSON.stringify(RUNS_RESPONSE), stderr: '' });
      }
      return Promise.resolve({ stdout: JSON.stringify({ jobs: [] }), stderr: '' });
    });
    expect(await getCiRunnerInfo('sha10', '/repo')).toBeUndefined();
    const callsAfterFirst = runGhMock.mock.calls.length;
    expect(await getCiRunnerInfo('sha10', '/repo')).toBeUndefined();
    expect(runGhMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('caches a miss from a runGh throw within the miss TTL', async () => {
    runGhMock.mockRejectedValue(new Error('gh: command not found'));
    expect(await getCiRunnerInfo('sha11', '/repo')).toBeUndefined();
    const callsAfterFirst = runGhMock.mock.calls.length;
    expect(await getCiRunnerInfo('sha11', '/repo')).toBeUndefined();
    expect(runGhMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('re-probes a cached miss once the (shorter) miss TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      runGhMock.mockResolvedValue({ stdout: JSON.stringify({ workflow_runs: [] }), stderr: '' });
      expect(await getCiRunnerInfo('sha12', '/repo')).toBeUndefined();
      const callsAfterFirst = runGhMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(61_000); // just past the 60s miss TTL
      expect(await getCiRunnerInfo('sha12', '/repo')).toBeUndefined();
      expect(runGhMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  // FLUX-1713 review (Minor 2): a self-hosted run with multiple jobs on the same runner used to
  // drop runnerName entirely (only surfaced when exactly one job reported one). Two jobs sharing
  // one non-mixed origin should still surface the runner name.
  it('surfaces a shared runnerName across multiple jobs on the same origin', async () => {
    mockRunsThenJobs([
      { name: 'check', labels: ['self-hosted', 'Linux'], runner_name: 'guy-cachyos-x8664-linux' },
      { name: 'lint', labels: ['self-hosted', 'Linux'], runner_name: 'guy-cachyos-x8664-linux' },
    ]);
    const info = await getCiRunnerInfo('sha13', '/repo');
    expect(info?.origin).toBe('self-hosted');
    expect(info?.runnerName).toBe('guy-cachyos-x8664-linux');
  });

  it('joins distinct runner names when several self-hosted boxes ran different jobs', async () => {
    mockRunsThenJobs([
      { name: 'check', labels: ['self-hosted', 'Linux'], runner_name: 'box-a' },
      { name: 'lint', labels: ['self-hosted', 'Linux'], runner_name: 'box-b' },
    ]);
    const info = await getCiRunnerInfo('sha14', '/repo');
    expect(info?.origin).toBe('self-hosted');
    expect(info?.runnerName).toBe('box-a, box-b');
  });
});

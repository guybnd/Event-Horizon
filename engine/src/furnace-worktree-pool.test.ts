// The Furnace — refreshWorktreePool() dedupe (FLUX-1069).
//
// GET /api/furnace, GET /api/furnace/slots, GET /api/furnace/:id, furnace_get, and the 5s drive-cycle
// tick all call refreshWorktreePool() independently, each shelling out to `git worktree list`. A single
// portal poll round-trip (the drawer fires two of those reads via Promise.all) used to spawn that
// subprocess twice for the same observed state. This verifies the fix: concurrent callers share one
// in-flight `git worktree list`, and a call landing within the freshness window is skipped outright.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import { refreshWorktreePool } from './furnace-stoker.js';

const runGit = vi.fn(async () => ({ stdout: '', stderr: '' }));
vi.mock('./git-exec.js', () => ({
  runGit: (...args: unknown[]) => runGit(...(args as [])),
  runGh: vi.fn(),
}));

describe('refreshWorktreePool dedupe (FLUX-1069)', () => {
  let root: string;
  // The last-refreshed timestamp is module-level state that outlives a single test, so each test starts
  // on its own fake-time epoch, far enough apart that the freshness window from a prior test can never
  // bleed into the next one.
  let epoch = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-wtpool-'));
    setWorkspaceRoot(root);
    runGit.mockClear();
    vi.useFakeTimers();
    epoch += 10_000_000;
    vi.setSystemTime(epoch);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces concurrent calls into a single git worktree list shell-out', async () => {
    // Neither call awaits before the other starts, so both land while the first is still in flight.
    const a = refreshWorktreePool();
    const b = refreshWorktreePool();
    await Promise.all([a, b]);
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('skips a call that lands within the freshness window of the last completed refresh', async () => {
    await refreshWorktreePool();
    expect(runGit).toHaveBeenCalledTimes(1);

    await refreshWorktreePool(); // immediately after — still fresh, no new shell-out
    expect(runGit).toHaveBeenCalledTimes(1);
  });

  it('refreshes again once the freshness window has elapsed', async () => {
    await refreshWorktreePool();
    expect(runGit).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await refreshWorktreePool();
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  // FLUX-1158: force must guarantee a read that starts AFTER a concurrent non-forced refresh already in
  // flight — not just await that (potentially pre-reclaim) in-flight promise. Locks the fix: a forced
  // call waits out the in-flight read, then always issues its OWN fresh shell-out.
  it('force issues its own fresh read instead of just awaiting a stale in-flight refresh', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    runGit.mockImplementationOnce(async () => {
      await gate; // hang the first (non-forced) call open so the forced call lands while it's in flight
      return { stdout: '', stderr: '' };
    });

    const nonForced = refreshWorktreePool(); // starts the hung read, sets worktreePoolInFlight
    await Promise.resolve(); // let it actually start before the forced call lands
    const forced = refreshWorktreePool({ force: true });

    expect(runGit).toHaveBeenCalledTimes(1); // forced call hasn't shelled out yet — it's waiting

    resolveFirst();
    await nonForced;
    await forced;

    // The forced call issued its OWN read after the in-flight one finished, rather than just reusing it.
    expect(runGit).toHaveBeenCalledTimes(2);
  });
});

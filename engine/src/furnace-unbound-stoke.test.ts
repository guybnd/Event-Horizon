// FLUX-1710: on a fresh install with no workspace bound, `driveStokeTick` used to throw through
// `requireWorkspaceRoot()` (via `refreshWorktreePool`, then `driveBurningBatches` -> `ensureFurnaceLoaded`)
// every 5s tick, surfacing as a `CRITICAL: Unhandled Rejection` in the log — the worst possible
// first-run signal on an otherwise perfectly healthy engine. This locks the fix: an unbound tick is a
// quiet no-op, announced once (not per tick), and no `git worktree list` (or any git) shell-out is
// issued while unbound. No real temp-dir git fixture or subprocess here — proving the tick never
// reaches a path-resolving step needs neither — so this stays in the fast `unit` vitest tier.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const runGit = vi.fn();
const runGh = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGit: (...args: unknown[]) => runGit(...args),
  runGh: (...args: unknown[]) => runGh(...args),
}));

import { log } from './log.js';
import { getDefaultWorkspace } from './workspace-context.js';
import { driveStokeTick, __resetUnboundStokeNoticeForTests } from './furnace-stoker.js';

describe('driveStokeTick on an unbound engine (FLUX-1710)', () => {
  let previousRoot: string | null;

  beforeEach(() => {
    // Same pattern as furnace-store.test.ts's "null-root edge" test: simulate the pre-first-activation
    // state directly on the singleton rather than standing up a real unbound engine.
    previousRoot = getDefaultWorkspace().root;
    getDefaultWorkspace().root = null;
    runGit.mockReset();
    runGh.mockReset();
    __resetUnboundStokeNoticeForTests();
    vi.spyOn(log, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    getDefaultWorkspace().root = previousRoot;
    vi.restoreAllMocks();
  });

  it('resolves quietly and never shells out to git while unbound', async () => {
    await expect(driveStokeTick()).resolves.toBeUndefined();
    expect(runGit).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it('announces the unbound state exactly once across consecutive ticks', async () => {
    await driveStokeTick();
    await driveStokeTick();
    await driveStokeTick();
    const idleLogs = (log.info as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
      String(call[0]).includes('stoker idle'),
    );
    expect(idleLogs).toHaveLength(1);
  });
});

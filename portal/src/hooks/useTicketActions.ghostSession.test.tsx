// @vitest-environment jsdom
// FLUX-1506: ghost session on launch — `beginGhostLaunch` (useTicketActions.tsx) patches a synthetic
// 'pending' cliSession onto the store the instant a launch is dispatched, so CardSessionRow's
// existing 'starting' presentation renders before the server round trip ever returns. Drives it via
// `tryLaunchPhaseDefault` (the retry-button / one-click-launch entry point), mocking `agentActions`
// so no real network call happens — mirrors useTicketActions.optimistic.test.tsx's harness.
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useTicketActions, type UseTicketActions } from './useTicketActions';
import { AppActionsContext } from '../store/useAppSelector';
import { appStore } from '../store/appStore';
import type { AppActions } from '../store/appStore';
import type { CliSessionSummary, Config, Task } from '../types';

vi.mock('../agentActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agentActions')>();
  return {
    ...actual,
    launchPhaseDefault: vi.fn(),
  };
});

import { launchPhaseDefault } from '../agentActions';

const CONFIG: Config = {
  columns: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' }],
  hiddenStatuses: [],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: false,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  archiveStatus: 'Archived',
  animationsEnabled: false,
} as Config;

const TASK: Task = {
  id: 'FLUX-1',
  status: 'In Progress',
  title: 'Test ticket',
  order: 0,
};

const capturedRef: { current: UseTicketActions | null } = { current: null };
function Harness({ task }: { task: Task }) {
  const ctl = useTicketActions(task);
  useEffect(() => { capturedRef.current = ctl; });
  return null;
}

function renderHarness(actions: AppActions) {
  return render(
    <AppActionsContext.Provider value={actions}>
      <Harness task={TASK} />
    </AppActionsContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ghost session on launch (FLUX-1506)', () => {
  it('patches a pending ghost immediately, then leaves it for the real session to overwrite on success', async () => {
    appStore.patch({ config: CONFIG, currentUser: 'tester' });
    const patchTaskLocal = vi.fn();
    const triggerRefresh = vi.fn().mockResolvedValue(undefined);
    const actions = new Proxy({} as AppActions, {
      get: (_t, prop) => {
        if (prop === 'patchTaskLocal') return patchTaskLocal;
        if (prop === 'triggerRefresh') return triggerRefresh;
        return vi.fn();
      },
    });
    vi.mocked(launchPhaseDefault).mockResolvedValueOnce({ id: 'real-1' } as CliSessionSummary);

    renderHarness(actions);

    await act(async () => {
      await capturedRef.current!.tryLaunchPhaseDefault('implementation');
    });

    expect(patchTaskLocal).toHaveBeenCalledTimes(1);
    const [taskId, patch] = patchTaskLocal.mock.calls[0];
    expect(taskId).toBe('FLUX-1');
    expect(patch.cliSession).toMatchObject({ taskId: 'FLUX-1', status: 'pending', label: 'Agent' });
    expect(triggerRefresh).toHaveBeenCalledTimes(1);
  });

  it('reverts the ghost silently when no persona resolves (no session was actually created)', async () => {
    appStore.patch({ config: CONFIG, currentUser: 'tester' });
    const patchTaskLocal = vi.fn();
    const actions = new Proxy({} as AppActions, {
      get: (_t, prop) => {
        if (prop === 'patchTaskLocal') return patchTaskLocal;
        return vi.fn();
      },
    });
    vi.mocked(launchPhaseDefault).mockResolvedValueOnce(null);

    renderHarness(actions);

    let launched: boolean | undefined;
    await act(async () => {
      launched = await capturedRef.current!.tryLaunchPhaseDefault('implementation');
    });

    expect(launched).toBe(false);
    expect(patchTaskLocal.mock.calls[0][1].cliSession).toMatchObject({ status: 'pending' });
    // Reverted back to the pre-click snapshot (no prior session on this task).
    expect(patchTaskLocal.mock.calls[1]).toEqual(['FLUX-1', { cliSession: null }]);
  });

  it('flips the ghost to failed then dissolves it after a launch rejection', async () => {
    vi.useFakeTimers();
    appStore.patch({ config: CONFIG, currentUser: 'tester' });
    const patchTaskLocal = vi.fn();
    const actions = new Proxy({} as AppActions, {
      get: (_t, prop) => {
        if (prop === 'patchTaskLocal') return patchTaskLocal;
        return vi.fn();
      },
    });
    vi.mocked(launchPhaseDefault).mockRejectedValueOnce(new Error('engine unreachable'));

    renderHarness(actions);

    await act(async () => {
      await expect(capturedRef.current!.tryLaunchPhaseDefault('implementation')).rejects.toThrow('engine unreachable');
    });

    expect(patchTaskLocal.mock.calls[0][1].cliSession).toMatchObject({ status: 'pending' });
    expect(patchTaskLocal.mock.calls[1][1].cliSession).toMatchObject({ status: 'failed' });
    expect(patchTaskLocal).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2200);
    });

    expect(patchTaskLocal).toHaveBeenCalledTimes(3);
    const failedGhost = patchTaskLocal.mock.calls[1][1].cliSession;
    const [dissolveTaskId, dissolvePatch] = patchTaskLocal.mock.calls[2];
    expect(dissolveTaskId).toBe('FLUX-1');
    expect(typeof dissolvePatch).toBe('function');
    // The failed ghost is still showing (no retry landed) — the guard lets the revert through.
    expect(dissolvePatch({ ...TASK, cliSession: failedGhost })).toEqual({ cliSession: null });
  });

  it('FLUX-1528: the failed-dissolve timer does not wipe a real session that landed during the retry window', async () => {
    vi.useFakeTimers();
    appStore.patch({ config: CONFIG, currentUser: 'tester' });
    const patchTaskLocal = vi.fn();
    const actions = new Proxy({} as AppActions, {
      get: (_t, prop) => {
        if (prop === 'patchTaskLocal') return patchTaskLocal;
        return vi.fn();
      },
    });
    vi.mocked(launchPhaseDefault).mockRejectedValueOnce(new Error('engine unreachable'));

    renderHarness(actions);

    await act(async () => {
      await expect(capturedRef.current!.tryLaunchPhaseDefault('implementation')).rejects.toThrow('engine unreachable');
    });

    await act(async () => {
      vi.advanceTimersByTime(2200);
    });

    const [, dissolvePatch] = patchTaskLocal.mock.calls[2];
    expect(typeof dissolvePatch).toBe('function');
    // A retry within the dissolve window landed a real, live session (a DIFFERENT id than the failed
    // ghost's) — the guard must leave it alone instead of reverting to the stale pre-launch snapshot.
    const liveSession = { id: 'real-retry-1', taskId: 'FLUX-1', status: 'running' } as CliSessionSummary;
    expect(dissolvePatch({ ...TASK, cliSession: liveSession })).toEqual({});
  });
});

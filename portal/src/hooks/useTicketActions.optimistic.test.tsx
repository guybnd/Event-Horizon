// @vitest-environment jsdom
// FLUX-1505: commit-first data — `ops.archive`/`ops.moveToStatus`/etc. route through a shared
// `commitOptimistic` helper (useTicketActions.tsx) that patches the store immediately, then either
// reconciles with the mutation's response or reverts + shakes on failure. This drives that helper
// directly via `ops`, bypassing the action registry/prompt-modal plumbing already covered by
// TicketActions.promptModal.test.tsx.
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useTicketActions, type UseTicketActions } from './useTicketActions';
import { AppActionsContext } from '../store/useAppSelector';
import { appStore } from '../store/appStore';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    updateTask: vi.fn(),
  };
});

import { updateTask } from '../api';

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

afterEach(() => cleanup());

describe('commitOptimistic (FLUX-1505)', () => {
  it('patches the store immediately, then reconciles with the mutation response on success', async () => {
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
    const resolvedTask: Task = { ...TASK, status: 'Archived', order: 3 };
    vi.mocked(updateTask).mockResolvedValueOnce(resolvedTask);

    renderHarness(actions);

    await act(async () => {
      await capturedRef.current!.ops.archive();
    });

    // First call: the optimistic patch, applied before the POST resolves.
    expect(patchTaskLocal.mock.calls[0]).toEqual(['FLUX-1', { status: 'Archived' }]);
    // Second call: reconciled with the mutation's own response — no extra fetch needed.
    expect(patchTaskLocal.mock.calls[1]).toEqual(['FLUX-1', resolvedTask]);
    // Backgrounded, not awaited inline — but still fired for the other derived state it owns.
    expect(triggerRefresh).toHaveBeenCalledTimes(1);
  });

  it('reverts the optimistic patch and shakes the card when the mutation fails', async () => {
    appStore.patch({ config: CONFIG, currentUser: 'tester' });
    const patchTaskLocal = vi.fn();
    const emitTaskRollback = vi.fn();
    const actions = new Proxy({} as AppActions, {
      get: (_t, prop) => {
        if (prop === 'patchTaskLocal') return patchTaskLocal;
        if (prop === 'emitTaskRollback') return emitTaskRollback;
        return vi.fn();
      },
    });
    vi.mocked(updateTask).mockRejectedValueOnce(new Error('engine unreachable'));

    renderHarness(actions);

    await act(async () => {
      await expect(capturedRef.current!.ops.archive()).rejects.toThrow('engine unreachable');
    });

    // Optimistic patch, then reverted back to the exact pre-mutation task snapshot.
    expect(patchTaskLocal.mock.calls[0]).toEqual(['FLUX-1', { status: 'Archived' }]);
    expect(patchTaskLocal.mock.calls[1]).toEqual(['FLUX-1', TASK]);
    expect(emitTaskRollback).toHaveBeenCalledWith('FLUX-1');
  });
});

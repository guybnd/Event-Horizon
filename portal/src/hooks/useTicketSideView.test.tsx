// @vitest-environment jsdom
// FLUX-1568: test coverage for the chat-window sideview's instant-save-with-rollback (`saveField`,
// FLUX-979) and the whole-form `save()`'s `stale_body` 409 recovery (FLUX-1550) — previously
// untested. Drives `useTicketSideView` itself (not a leaf helper) via the render+Harness pattern
// used by useTicketActions.optimistic.test.tsx, so the assertions exercise the real controller
// wiring (form state, AppActionsContext, the store) rather than a hand-rolled stand-in.
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useTicketSideView, type TicketSideViewController } from './useTicketSideView';
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
vi.mock('../taskPrefetch', () => ({
  peekTask: vi.fn(() => undefined),
  fetchTaskCached: vi.fn(),
}));

import { updateTask } from '../api';
import { fetchTaskCached } from '../taskPrefetch';

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
  title: 'Original title',
  body: 'Original body',
  implementationLink: 'https://github.com/example/pr/1',
  bodyVersion: 'v1',
  order: 0,
  history: [],
};

function noopActions(overrides: Partial<AppActions> = {}): AppActions {
  return new Proxy({} as AppActions, {
    get: (_t, prop) => {
      if (prop in overrides) return (overrides as Record<string, unknown>)[prop as string];
      return vi.fn();
    },
  });
}

const capturedRef: { current: TicketSideViewController | null } = { current: null };
function Harness({ task }: { task: Task }) {
  const ctl = useTicketSideView(task);
  useEffect(() => { capturedRef.current = ctl; });
  return null;
}

function renderHarness(actions: AppActions, task: Task = TASK) {
  return render(
    <AppActionsContext.Provider value={actions}>
      <Harness task={task} />
    </AppActionsContext.Provider>,
  );
}

beforeEach(() => {
  appStore.patch({ config: CONFIG, currentUser: 'tester', tasks: [] });
  capturedRef.current = null;
  vi.mocked(fetchTaskCached).mockResolvedValue(TASK);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useTicketSideView.saveField (FLUX-979 instant-save-with-rollback)', () => {
  it('rolls back to the previous value and surfaces the error when updateTask rejects', async () => {
    const triggerRefresh = vi.fn();
    vi.mocked(updateTask).mockRejectedValueOnce(new Error('engine unreachable'));

    renderHarness(noopActions({ triggerRefresh }));
    await waitFor(() => expect(capturedRef.current?.implementationLink).toBe('https://github.com/example/pr/1'));

    await act(async () => {
      await capturedRef.current!.saveField('implementationLink', 'https://github.com/example/pr/2');
    });

    expect(capturedRef.current!.implementationLink).toBe('https://github.com/example/pr/1');
    expect(capturedRef.current!.saveError).toBe('engine unreachable');
  });

  it('trims implementationLink before persisting, matching the manual Save-button path', async () => {
    const updatedTask: Task = { ...TASK, implementationLink: 'https://github.com/example/pr/2' };
    vi.mocked(updateTask).mockResolvedValueOnce(updatedTask);

    renderHarness(noopActions());
    await waitFor(() => expect(capturedRef.current?.implementationLink).toBe('https://github.com/example/pr/1'));

    await act(async () => {
      await capturedRef.current!.saveField('implementationLink', '  https://github.com/example/pr/2  ');
    });

    expect(updateTask).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({ implementationLink: 'https://github.com/example/pr/2' }));
  });

  it('skips the network round trip entirely when the (trimmed) value matches what is already persisted', async () => {
    renderHarness(noopActions());
    await waitFor(() => expect(capturedRef.current?.implementationLink).toBe('https://github.com/example/pr/1'));

    await act(async () => {
      // Same value, just with incidental whitespace — e.g. clicking into the field and blurring
      // straight back out.
      await capturedRef.current!.saveField('implementationLink', '  https://github.com/example/pr/1  ');
    });

    expect(updateTask).not.toHaveBeenCalled();
    // The live form still normalizes to the trimmed value so it never appears dirty.
    expect(capturedRef.current!.implementationLink).toBe('https://github.com/example/pr/1');
    expect(capturedRef.current!.isDirty).toBe(false);
  });
});

describe('useTicketSideView.save (FLUX-1550 stale_body 409 recovery)', () => {
  it('reloads the ticket and preserves the in-progress body edit on a stale_body conflict', async () => {
    const triggerRefresh = vi.fn();
    renderHarness(noopActions({ triggerRefresh }));
    await waitFor(() => expect(capturedRef.current?.body).toBe('Original body'));

    // User is mid-edit on the body when a concurrent update lands server-side.
    act(() => capturedRef.current!.setBody('User is drafting a new description'));
    expect(capturedRef.current!.dirtyFields.has('body')).toBe(true);

    const staleBodyError = Object.assign(new Error('stale body'), { code: 'stale_body' });
    vi.mocked(updateTask).mockRejectedValueOnce(staleBodyError);
    const reloadedTask: Task = {
      ...TASK,
      title: 'Title changed by someone else',
      bodyVersion: 'v2',
      body: 'Original body', // server's body is unchanged — only bumped by the conflicting write
    };
    vi.mocked(fetchTaskCached).mockResolvedValueOnce(reloadedTask);

    await act(async () => {
      await capturedRef.current!.save();
    });

    await waitFor(() => expect(capturedRef.current!.task.bodyVersion).toBe('v2'));

    // The conflict-recovery reload picked up the fresh (previously un-synced) title...
    expect(capturedRef.current!.title).toBe('Title changed by someone else');
    // ...while the user's in-progress body draft survived the reload, still marked dirty.
    expect(capturedRef.current!.body).toBe('User is drafting a new description');
    expect(capturedRef.current!.dirtyFields.has('body')).toBe(true);
    expect(capturedRef.current!.saveError).toContain('changed since you opened it');
  });
});

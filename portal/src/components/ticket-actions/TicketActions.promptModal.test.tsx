// @vitest-environment jsdom
// FLUX-1359 regression: the first review pass on this ticket found that `promptBusy` derived from
// `busyKey` (`busyKey !== null`) instead of a dedicated in-modal state. `fire()` sets `busyKey`
// *before* the awaited action reaches its `await prompt(...)` call, so `busyKey` is already set for
// the ENTIRE time the PromptModal is open waiting for input — which fed `busy={true}` into
// PromptModal, permanently disabling its Submit button ("Working…") and Cancel/backdrop-dismiss,
// with no Enter-to-submit handler on the multiline textarea used for Ready/Require-Input comments.
// Net effect: every comment-gated status move was unsubmittable. This test drives the exact same
// path (`fire()` → `changeStatus` → `runChangeStatus` → `prompt(...)`) and asserts the modal is
// actually usable while `busyKey` is held.
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { TicketActionsLaunchers } from './TicketActions';
import { useTicketActions, type UseTicketActions } from '../../hooks/useTicketActions';
import { AppActionsContext } from '../../store/useAppSelector';
import { appStore } from '../../store/appStore';
import type { AppActions } from '../../store/appStore';
import type { Config, Task } from '../../types';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    updateTask: vi.fn().mockResolvedValue({}),
  };
});

import { updateTask } from '../../api';

function stubActions<T extends object>(): T {
  return new Proxy({}, { get: () => vi.fn() }) as T;
}

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
  animationsEnabled: false,
};

const TASK: Task = {
  id: 'FLUX-1',
  status: 'In Progress',
  title: 'Test ticket',
  order: 0,
};

// Test-only imperative escape hatch: `.current` is mutated from an effect (a commit-phase side
// effect, not a render-phase one), so the test body can read the latest controller between acts.
const capturedRef: { current: UseTicketActions | null } = { current: null };
function Harness({ task }: { task: Task }) {
  const ctl = useTicketActions(task);
  useEffect(() => { capturedRef.current = ctl; });
  return <TicketActionsLaunchers ctl={ctl} />;
}

afterEach(() => cleanup());

describe('PromptModal wiring through useTicketActions (FLUX-1359)', () => {
  it('stays submittable while fire() holds busyKey for the whole prompt wait', async () => {
    appStore.patch({ config: CONFIG, currentUser: 'tester' });
    const actions = stubActions<AppActions>();
    render(
      <AppActionsContext.Provider value={actions}>
        <Harness task={TASK} />
      </AppActionsContext.Provider>,
    );

    const toReady = capturedRef.current!.actions.find((a) => a.key === 'to-ready');
    expect(toReady).toBeDefined();

    // Fire the action synchronously: fire() sets busyKey, then runs changeStatus → runChangeStatus,
    // which synchronously constructs the pending `prompt(...)` Promise (setting promptState) before
    // yielding — so by the time this act() call returns, both busyKey AND promptState are set.
    act(() => {
      void capturedRef.current!.fire(toReady!.key, toReady!.run);
    });

    expect(capturedRef.current!.busyKey).toBe('to-ready');
    expect(capturedRef.current!.promptState).not.toBeNull();

    const dialog = screen.getByRole('dialog');
    const textarea = dialog.querySelector('textarea');
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea!, { target: { value: 'Ready for review' } });

    const submitButton = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    // The regression: these were permanently `disabled` while busyKey was set (i.e. always, since
    // the modal only appears once busyKey is set).
    expect(submitButton.disabled).toBe(false);
    expect(cancelButton.disabled).toBe(false);
    expect(capturedRef.current!.busyKey).toBe('to-ready'); // still held — the fix isn't "don't set busyKey"

    await act(async () => {
      fireEvent.click(submitButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateTask).toHaveBeenCalledWith(
      'FLUX-1',
      expect.objectContaining({ status: 'Ready' }),
    );
    expect(capturedRef.current!.busyKey).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BacklogScreen } from './BacklogScreen';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';
import { updateTask } from '../api';

// These children pull in TipTap/search-dropdown machinery that's irrelevant to the
// status-change routing under test — stub them so the test isolates BacklogScreen's
// own handleStatusChange wiring (the FLUX-1102 regression) rather than their internals.
vi.mock('./TaskDescriptionSurface', () => ({ TaskDescriptionSurface: () => null }));
vi.mock('./TaskViewControls', () => ({ TaskViewControls: () => null }));
vi.mock('./ParseErrorButton', () => ({ ParseErrorButton: () => null }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, updateTask: vi.fn().mockResolvedValue({}) };
});

const mockedUpdateTask = vi.mocked(updateTask);

const CONFIG: Config = {
  columns: [
    { name: 'Backlog' },
    { name: 'Todo' },
    { name: 'In Progress' },
    { name: 'Ready' },
  ],
  hiddenStatuses: [{ name: 'Require Input' }, { name: 'Archived' }],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
};

const TASK: Task = {
  id: 'FLUX-1',
  status: 'Backlog',
  title: 'Sample backlog task',
};

function renderBacklogScreen(actionOverrides: Partial<AppActions> = {}) {
  const actions = { openTaskModal: vi.fn(), triggerRefresh: vi.fn(), ...actionOverrides } as unknown as AppActions;

  appStore.patch({ tasks: [TASK], config: CONFIG, tasksLoading: false });

  render(
    <AppActionsContext.Provider value={actions}>
      <BacklogScreen />
    </AppActionsContext.Provider>,
  );

  return actions;
}

async function selectTaskAndChangeStatus(newStatus: string) {
  fireEvent.click(screen.getByText(TASK.title!));
  const select = await screen.findByRole('combobox');
  fireEvent.change(select, { target: { value: newStatus } });
}

describe('BacklogScreen.handleStatusChange (FLUX-1102 regression)', () => {
  afterEach(() => {
    cleanup();
    mockedUpdateTask.mockClear();
  });

  it('routes a promptable status (Ready) through openTaskModal, not updateTask', async () => {
    const actions = renderBacklogScreen();

    await selectTaskAndChangeStatus('Ready');

    expect(actions.openTaskModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'FLUX-1' }));
    expect(mockedUpdateTask).not.toHaveBeenCalled();
  });

  it('routes a promptable status (Require Input) through openTaskModal, not updateTask', async () => {
    const actions = renderBacklogScreen();

    await selectTaskAndChangeStatus('Require Input');

    expect(actions.openTaskModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'FLUX-1' }));
    expect(mockedUpdateTask).not.toHaveBeenCalled();
  });

  it('routes a non-promptable status (In Progress) through updateTask directly, without opening the modal', async () => {
    const actions = renderBacklogScreen();

    await selectTaskAndChangeStatus('In Progress');

    await waitFor(() => expect(mockedUpdateTask).toHaveBeenCalledWith('FLUX-1', expect.objectContaining({ status: 'In Progress' })));
    expect(actions.openTaskModal).not.toHaveBeenCalled();
  });
});

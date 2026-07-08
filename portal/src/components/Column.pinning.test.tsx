// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Board } from './Board';
import { DockProvider } from './DockProvider';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';

// FLUX-1300 review gap: `filterAndSortTasks` bubbles a pinned task to the front of a column's flat
// task list, but Column.tsx re-partitions that list into fixed buckets (running / awaiting-input /
// plan-approval / needs-action / open-PR) that always render ABOVE `restTasks` regardless of the
// incoming sort order. A freshly created ticket has none of those flags, so it always landed in
// `restTasks` — last — on exactly the busy/swimlane-stacked board the pin exists to fix. This test
// renders the real Board → Column tree (not just the sort function) so it fails if the pin doesn't
// escape those buckets.

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

function stubActions<T extends object>(): T {
  return new Proxy({}, { get: () => () => {} }) as T;
}

const CONFIG: Config = {
  columns: [{ name: 'In Progress' }],
  hiddenStatuses: [{ name: 'Require Input' }, { name: 'Archived' }],
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

describe('Column pin escapes swimlane buckets (FLUX-1300)', () => {
  afterEach(() => cleanup());

  it('renders a still-pinned task above running/awaiting-input cards, not after them', async () => {
    const runningTask: Task = {
      id: 'FLUX-3000',
      status: 'In Progress',
      title: 'Running agent session',
      order: 0,
      cliSession: { status: 'running', label: 'agent' } as Task['cliSession'],
    };
    const swimlaneTask: Task = {
      id: 'FLUX-3001',
      status: 'In Progress',
      title: 'Awaiting input',
      order: 1,
      swimlane: 'require-input',
    };
    // The plain, freshly-created ticket: no cliSession, no swimlane, no PR/needs-action flag — the
    // exact shape that falls into `restTasks` (the last-rendered bucket) absent the pin.
    const pinnedTask: Task = {
      id: 'FLUX-3002',
      status: 'In Progress',
      title: 'Freshly created ticket',
      order: 2,
    };

    appStore.patch({
      tasks: [runningTask, swimlaneTask, pinnedTask],
      config: CONFIG,
      tasksLoading: false,
      currentProject: 'test-project',
      pinnedTasks: { [pinnedTask.id]: Date.now() + 15_000 },
    });

    const actions = stubActions<AppActions>();
    const { container } = render(
      <AppActionsContext.Provider value={actions}>
        <DockProvider>
          <Board furnaceOpen={false} onCloseFurnace={() => {}} />
        </DockProvider>
      </AppActionsContext.Provider>,
    );

    await act(async () => {});

    const order = Array.from(container.querySelectorAll<HTMLElement>('[data-task-id]'))
      .map((el) => el.getAttribute('data-task-id'));

    expect(order.indexOf(pinnedTask.id)).toBe(0);
    expect(order.indexOf(pinnedTask.id)).toBeLessThan(order.indexOf(runningTask.id));
    expect(order.indexOf(pinnedTask.id)).toBeLessThan(order.indexOf(swimlaneTask.id));
  });
});

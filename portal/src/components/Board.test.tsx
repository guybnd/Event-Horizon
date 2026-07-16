// @vitest-environment jsdom
import { Profiler, useCallback, useState, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Board } from './Board';
import { DockProvider } from './DockProvider';
import { ToastProvider } from '../hooks/useNotify';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

// FLUX-1141: regression test for the AppContent → Board cascade found while profiling
// interaction latency (FLUX-1141/FLUX-1135). Board sits directly under AppContent alongside
// ChatDock/TaskModal (App.tsx); before this fix none of the three were React.memo'd, so an
// unrelated sibling state change (terminal panel toggle, furnace drawer toggle, the 5s
// furnace-status poll) re-invoked Board's full ~700-line body — and reconciled every Column/
// TaskCard — even though Board's own props never changed. This test reproduces that exact
// shape (a parent with local state re-rendering a stable-props child) with the real Board.

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    appendFurnaceTicket: vi.fn().mockResolvedValue({}),
    createFurnaceBatch: vi.fn().mockResolvedValue({}),
    sendTaskCliInput: vi.fn().mockResolvedValue({}),
    detachWorktree: vi.fn().mockResolvedValue({}),
  };
});

// Any action any descendant (Board, TaskCard's controller, DockProvider consumers) might pull
// off useAppActions()/useDockActions() — a Proxy avoids hand-enumerating both hooks' full shape.
function stubActions<T extends object>(): T {
  return new Proxy({}, { get: () => vi.fn() }) as T;
}

const CONFIG: Config = {
  columns: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' }],
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

// A board-sized task list (~80 cards across 4 columns) — big enough that a full unmemoized
// re-render of Board's column/card tree is measurable, in the neighborhood of the ~127-card
// board this fix was profiled against (see the FLUX-1141 completion comment).
const STATUSES = ['Todo', 'In Progress', 'Ready', 'Done'];
const TASKS: Task[] = Array.from({ length: 80 }, (_, i) => ({
  id: `FLUX-${1000 + i}`,
  status: STATUSES[i % STATUSES.length]!,
  title: `Synthetic task ${i}`,
  order: i,
}));

function Harness({ children }: { children: (toggle: () => void) => ReactNode }) {
  const [unrelatedToggle, setUnrelatedToggle] = useState(false);
  // Mirrors AppContent's handleToggleTerminal (App.tsx) — a stable useCallback-wrapped setter.
  const toggle = useCallback(() => setUnrelatedToggle((o) => !o), []);
  return (
    <>
      <div data-testid="unrelated-flag">{String(unrelatedToggle)}</div>
      {children(toggle)}
    </>
  );
}

function renderBoard(onRender: ProfilerOnRenderCallback) {
  const actions = stubActions<AppActions>();
  appStore.patch({ tasks: TASKS, config: CONFIG, tasksLoading: false, currentProject: 'test-project' });

  const onCloseFurnace = () => {}; // stable across renders — Board never receives a fresh one from App.tsx either

  render(
    <ToastProvider>
      <AppActionsContext.Provider value={actions}>
        <DockProvider>
          <Harness>
            {(toggleUnrelated) => (
              <>
                <button onClick={toggleUnrelated}>toggle unrelated</button>
                <Profiler id="board" onRender={onRender}>
                  <Board furnaceOpen={false} onCloseFurnace={onCloseFurnace} />
                </Profiler>
              </>
            )}
          </Harness>
        </DockProvider>
      </AppActionsContext.Provider>
    </ToastProvider>,
  );
}

describe('Board memoization (FLUX-1141)', () => {
  afterEach(() => cleanup());

  it(
    'does not re-render when an unrelated sibling state toggles (stable props)',
    async () => {
      const commits: Array<{ phase: string; actualDuration: number }> = [];
      renderBoard((_id, phase, actualDuration) => commits.push({ phase, actualDuration }));

      // Data is already in the store before render (no async loading state), so the initial mount
      // is synchronous — assert on it directly rather than via `findBy*`, whose internal polling
      // would otherwise burn enough wall-clock for unrelated per-second timers deeper in the tree
      // (e.g. Column's live-session clock) to tick and add noise unrelated to the bug under test.
      expect(screen.getByText('Synthetic task 0')).toBeTruthy();

      // Board defers several filter/search values via useDeferredValue (FLUX-1200); flush any
      // low-priority catch-up render those schedule on mount before counting commits, so mount
      // settling isn't misattributed to the toggle below (FLUX-1220).
      await act(async () => {});

      const commitsBeforeToggle = commits.length;
      expect(commitsBeforeToggle).toBeGreaterThan(0);

      fireEvent.click(screen.getByText('toggle unrelated'));
      expect(screen.getByTestId('unrelated-flag').textContent).toBe('true');

      // The whole point of the fix: Board's memo comparator bails on the unrelated update. In
      // practice React's Profiler still fires once more for bookkeeping even on a full bailout, but
      // its actualDuration is now negligible — nothing like the ~hundreds-of-ms mount/settle commits
      // above, which reconcile all 80 synthetic cards. Assert on cost, not raw commit count.
      // Threshold has some headroom above the sub-millisecond steady state to absorb JIT/CI-runner
      // noise on the bail-out render itself (FLUX-1220).
      const newCommits = commits.slice(commitsBeforeToggle);
      for (const c of newCommits) {
        expect(c.actualDuration).toBeLessThan(15);
      }
    },
    10000,
  );
});

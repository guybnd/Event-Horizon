// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';

// FLUX-1189: a fully idle board (no chat/task-modal/terminal windows open, no live sessions)
// was found scheduling a continuous ~80fps requestAnimationFrame pipeline. This mounts the same
// always-present component tree App.tsx keeps mounted (Header, Board, ChatDock, TaskModal,
// TerminalPanel) with everything closed/idle and asserts nothing keeps re-scheduling rAF — a
// regression guard against a future JS-driven animation loop leaking into the idle board.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchPendingApprovals: vi.fn().mockResolvedValue([]),
    fetchPendingQuestions: vi.fn().mockResolvedValue([]),
    fetchPendingBoardRebases: vi.fn().mockResolvedValue([]),
    fetchTaskCliSession: vi.fn().mockResolvedValue(null),
    fetchFurnaceBatches: vi.fn().mockResolvedValue([]),
    fetchTaskTranscript: vi.fn().mockResolvedValue([]),
    fetchBranchStatus: vi.fn().mockResolvedValue(null),
  };
});

import { Header } from './Header';
import { Board } from './Board';
import { ChatDock } from './ChatDock';
import { TaskModal } from './TaskModal';
import { TerminalPanel } from './TerminalPanel';
import { DockProvider } from './DockProvider';
import { PendingInteractionsProvider } from './pendingInteractions';

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FakeResizeObserver;

// jsdom in this environment doesn't provide localStorage unless launched with
// --localstorage-file; a couple of always-mounted hooks read it unguarded on mount.
if (!window.localStorage) {
  const backing = new Map<string, string>();
  // @ts-expect-error minimal in-memory localStorage polyfill for this environment
  window.localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); },
    clear: () => backing.clear(),
  };
}

const CONFIG: Config = {
  columns: [
    { name: 'Backlog' }, { name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' },
  ],
  hiddenStatuses: [{ name: 'Require Input' }, { name: 'Archived' }],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
} as unknown as Config;

const TASKS: Task[] = [
  { id: 'FLUX-1', status: 'Todo', title: 'Sample task 1' },
  { id: 'FLUX-2', status: 'In Progress', title: 'Sample task 2' },
  { id: 'FLUX-3', status: 'Done', title: 'Sample task 3' },
] as Task[];

function renderIdleBoard() {
  const actions = {
    openTaskModal: vi.fn(),
    triggerRefresh: vi.fn(),
    setView: vi.fn(),
    ensureReadStateLoaded: vi.fn(),
    subscribeToEvent: vi.fn(() => () => {}),
    markCommentRead: vi.fn(),
    markAllCommentsRead: vi.fn(),
    refreshWorktrees: vi.fn(),
    refreshNotifications: vi.fn(),
  } as unknown as AppActions;

  appStore.patch({
    tasks: TASKS,
    taskById: new Map(TASKS.map((t) => [t.id, t])),
    config: CONFIG,
    tasksLoading: false,
    isConnected: true,
    workspaceConfigured: true,
    liveSessions: {},
    theme: 'matrix',
  });
  document.documentElement.setAttribute('data-theme', 'matrix');

  return render(
    <AppActionsContext.Provider value={actions}>
      <DockProvider>
        <PendingInteractionsProvider>
          <Header />
          <Board />
          <ChatDock />
          <TaskModal />
          <TerminalPanel isOpen={false} onClose={() => {}} />
        </PendingInteractionsProvider>
      </DockProvider>
    </AppActionsContext.Provider>,
  );
}

describe('idle board does not schedule a continuous rAF loop (FLUX-1189)', () => {
  afterEach(() => {
    cleanup();
  });

  it('schedules zero requestAnimationFrame calls once mount settles, over 1.5s of idle time', async () => {
    let count = 0;
    const realRaf = window.requestAnimationFrame.bind(window);
    const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      count++;
      return realRaf(cb);
    });

    renderIdleBoard();

    // Let mount-time effects/microtasks settle before sampling the baseline.
    await new Promise((r) => setTimeout(r, 50));
    const afterMount = count;

    // Simulate ~1.5s of untouched idle wall-clock time — no interaction, no store updates.
    await new Promise((r) => setTimeout(r, 1500));
    const afterIdle = count;

    spy.mockRestore();

    expect(afterIdle - afterMount).toBe(0);
  });
});

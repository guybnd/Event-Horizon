// @vitest-environment jsdom
// FLUX-1505: patch-first SSE — a `taskUpdated` event fetches just the changed task and merges it
// into the store instead of paying for a full-list `fetchTasks()` refetch on the hot path. A
// debounced `loadTasks()` still runs shortly after as background truth-sync. Mirrors
// AppContext.launchFailureToast.test.tsx's real-AppProvider + FakeEventSource harness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppProvider } from './AppContext';
import { ConfirmProvider } from './hooks/useConfirm';
import { ToastProvider } from './hooks/useNotify';
import { useAppSelector } from './store/useAppSelector';
import type { Config, Task } from './types';

const TASK: Task = { id: 'FLUX-1', title: 'Test ticket', status: 'Todo', order: 0 };

// `vi.mock` factories are hoisted above the file's own top-level consts, so the mocks it closes
// over must be created via `vi.hoisted` to exist by the time the factory runs.
const { fetchTasksMock, fetchTaskListShapeMock } = vi.hoisted(() => ({
  fetchTasksMock: vi.fn(),
  fetchTaskListShapeMock: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({
      columns: [], hiddenStatuses: [], users: [], tags: [], priorities: [], projects: [],
    } as unknown as Config),
    fetchTasks: fetchTasksMock,
    // FLUX-1505 review fix: the SSE handler now fetches the LIST shape (?view=list), not the
    // detail shape — see fetchTaskListShape's doc comment in api.ts for why the two must never
    // be conflated in the `tasks` store.
    fetchTaskListShape: fetchTaskListShapeMock,
    fetchWorktrees: vi.fn().mockResolvedValue([]),
    fetchHealth: vi.fn().mockResolvedValue({ status: 'ok', workspace: null, ghAuthAvailable: null }),
    fetchReadState: vi.fn().mockResolvedValue({}),
    fetchWorkspace: vi.fn().mockResolvedValue({ configured: false, path: null }),
    fetchParseErrors: vi.fn().mockResolvedValue([]),
    fetchNotifications: vi.fn().mockResolvedValue({ notifications: [], unreadCount: 0 }),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
  };
});

type Listener = (e: MessageEvent) => void;

// jsdom has no EventSource implementation; this stand-in captures addEventListener registrations
// so the test can dispatch a fake `taskUpdated` SSE event straight into AppProvider's handler.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Listener[]>();
  constructor() {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  close() { this.readyState = FakeEventSource.CLOSED; }
  dispatch(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

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

function lastFakeEventSource(): FakeEventSource {
  const instance = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!instance) throw new Error('no FakeEventSource instance was constructed');
  return instance;
}

function StatusProbe() {
  const status = useAppSelector((s) => s.tasks.find((t) => t.id === 'FLUX-1')?.status ?? 'missing');
  return <div data-testid="status">{status}</div>;
}

describe('patch-first taskUpdated SSE (FLUX-1505)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    // @ts-expect-error FakeEventSource covers only what AppContext's SSE effect touches
    window.EventSource = FakeEventSource;
    fetchTasksMock.mockReset().mockResolvedValue([TASK]);
    fetchTaskListShapeMock.mockReset().mockResolvedValue({ ...TASK, status: 'In Progress' });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('patches the single task instantly, then background-syncs the full list after a debounce', async () => {
    render(<ConfirmProvider><ToastProvider><AppProvider><StatusProbe /></AppProvider></ToastProvider></ConfirmProvider>);
    expect(await screen.findByText('Todo')).toBeTruthy();
    const fetchTasksCallsAfterInitialLoad = fetchTasksMock.mock.calls.length;

    // Fake timers from here on so the debounced background sync (`window.setTimeout`) is under the
    // test's control instead of racing the real clock. `shouldAdvanceTime` keeps real promise/microtask
    // resolution (the mocked fetches) working normally.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await act(async () => {
      lastFakeEventSource().dispatch('taskUpdated', { id: 'FLUX-1' });
      // Flush the fetchTaskListShape(id).then(patchTaskLocal) microtask chain.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchTaskListShapeMock).toHaveBeenCalledWith('FLUX-1');
    // The card updates immediately from the single-task patch — no extra full-list fetch yet.
    expect(screen.getByTestId('status').textContent).toBe('In Progress');
    expect(fetchTasksMock.mock.calls.length).toBe(fetchTasksCallsAfterInitialLoad);

    // Past the debounce window, the background truth-sync fires a real full-list refetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(fetchTasksMock.mock.calls.length).toBeGreaterThan(fetchTasksCallsAfterInitialLoad);
  });
});

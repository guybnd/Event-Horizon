// @vitest-environment jsdom
// FLUX-1748: the capacity-usage slice must load on boot, refetch on the `usageChanged` SSE event
// and on reconnect (`open`), and NEVER poll on a timer. Mirrors AppContext.taskUpdatedPatch.test.tsx's
// real-AppProvider + FakeEventSource harness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppProvider } from './AppContext';
import { ConfirmProvider } from './hooks/useConfirm';
import { ToastProvider } from './hooks/useNotify';
import { useAppSelector } from './store/useAppSelector';
import type { Config, UsageSnapshot } from './types';

const { fetchUsageMock } = vi.hoisted(() => ({ fetchUsageMock: vi.fn() }));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({
      columns: [], hiddenStatuses: [], users: [], tags: [], priorities: [], projects: [],
    } as unknown as Config),
    fetchTasks: vi.fn().mockResolvedValue([]),
    fetchTaskListShape: vi.fn(),
    fetchWorktrees: vi.fn().mockResolvedValue([]),
    fetchHealth: vi.fn().mockResolvedValue({ status: 'ok', workspace: null, ghAuthAvailable: null }),
    fetchReadState: vi.fn().mockResolvedValue({}),
    fetchWorkspace: vi.fn().mockResolvedValue({ configured: false, path: null }),
    fetchParseErrors: vi.fn().mockResolvedValue([]),
    fetchNotifications: vi.fn().mockResolvedValue({ notifications: [], unreadCount: 0 }),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchUsage: fetchUsageMock,
  };
});

type Listener = (e: MessageEvent) => void;

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

function snapshotAt(generatedAt: string): UsageSnapshot {
  return { providers: [], generatedAt };
}

function UsageProbe() {
  const generatedAt = useAppSelector((s) => s.usage?.generatedAt ?? 'none');
  return <div data-testid="usage-generated-at">{generatedAt}</div>;
}

describe('capacity usage slice (FLUX-1748)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    // @ts-expect-error FakeEventSource covers only what AppContext's SSE effect touches
    window.EventSource = FakeEventSource;
    fetchUsageMock.mockReset().mockResolvedValue(snapshotAt('t0'));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fetches usage once on boot', async () => {
    render(<ConfirmProvider><ToastProvider><AppProvider><UsageProbe /></AppProvider></ToastProvider></ConfirmProvider>);
    expect(await screen.findByText('t0')).toBeTruthy();
    expect(fetchUsageMock).toHaveBeenCalledTimes(1);
  });

  it('refetches exactly once per `usageChanged` SSE event', async () => {
    render(<ConfirmProvider><ToastProvider><AppProvider><UsageProbe /></AppProvider></ToastProvider></ConfirmProvider>);
    await screen.findByText('t0');
    const callsAfterBoot = fetchUsageMock.mock.calls.length;

    fetchUsageMock.mockResolvedValueOnce(snapshotAt('t1'));
    await act(async () => {
      lastFakeEventSource().dispatch('usageChanged', { generatedAt: 't1' });
      await Promise.resolve();
    });

    expect(await screen.findByText('t1')).toBeTruthy();
    expect(fetchUsageMock.mock.calls.length).toBe(callsAfterBoot + 1);
  });

  it('refetches on SSE `open` (reconnect)', async () => {
    render(<ConfirmProvider><ToastProvider><AppProvider><UsageProbe /></AppProvider></ToastProvider></ConfirmProvider>);
    await screen.findByText('t0');
    const callsAfterBoot = fetchUsageMock.mock.calls.length;

    fetchUsageMock.mockResolvedValueOnce(snapshotAt('t2'));
    await act(async () => {
      lastFakeEventSource().dispatch('open', {});
      await Promise.resolve();
    });

    expect(await screen.findByText('t2')).toBeTruthy();
    expect(fetchUsageMock.mock.calls.length).toBe(callsAfterBoot + 1);
  });

  it('never polls — no further fetch occurs from a timer alone', async () => {
    // Fake timers must be installed BEFORE render so any interval created during boot (e.g. a
    // regression that adds one) is itself fake — installing after render would let a real timer
    // slip past `advanceTimersByTimeAsync` and make this assertion pass unconditionally.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ConfirmProvider><ToastProvider><AppProvider><UsageProbe /></AppProvider></ToastProvider></ConfirmProvider>);
    await screen.findByText('t0');
    const callsAfterBoot = fetchUsageMock.mock.calls.length;

    await act(async () => {
      // Comfortably past any plausible poll interval in this codebase.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });

    expect(fetchUsageMock.mock.calls.length).toBe(callsAfterBoot);
  });
});

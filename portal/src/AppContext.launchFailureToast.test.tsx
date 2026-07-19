// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { AppProvider } from './AppContext';
import { ConfirmProvider } from './hooks/useConfirm';
import { ToastProvider } from './hooks/useNotify';
import type { Config } from './types';

// FLUX-1486: pre-spawn session-launch failures must surface an in-portal toast even while the
// portal window is focused (unlike ordinary `prompt`/`error` notifications, which stay
// badge-only per FLUX-796). This mounts the real AppProvider SSE listener and drives a
// `notification` event through it, the way AppContext.idle.test.tsx drives the idle timer.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({
      columns: [], hiddenStatuses: [], users: [], tags: [], priorities: [], projects: [],
    } as unknown as Config),
    fetchTasks: vi.fn().mockResolvedValue([]),
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
// so the test can dispatch a fake `notification` SSE event straight into AppProvider's handler.
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

describe('in-portal toast for launch-failure notifications (FLUX-1486)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    // @ts-expect-error FakeEventSource covers only what AppContext's SSE effect touches
    window.EventSource = FakeEventSource;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a toast for a launch-failure prompt while the window is focused', async () => {
    render(<ConfirmProvider><ToastProvider><AppProvider><div /></AppProvider></ToastProvider></ConfirmProvider>);

    await act(async () => {
      lastFakeEventSource().dispatch('notification', {
        notification: {
          id: 'n1',
          type: 'prompt',
          title: 'Needs action',
          message: 'Claude Code session failed to start: worktree already exists',
          actions: [],
          createdAt: new Date(0).toISOString(),
          read: false,
          dismissed: false,
        },
        unreadCount: 1,
      });
    });

    expect(await screen.findByText(/session failed to start: worktree already exists/)).toBeTruthy();
  });

  it('does not show a toast for a plain prompt notification', async () => {
    render(<ConfirmProvider><ToastProvider><AppProvider><div /></AppProvider></ToastProvider></ConfirmProvider>);

    await act(async () => {
      lastFakeEventSource().dispatch('notification', {
        notification: {
          id: 'n2',
          type: 'prompt',
          title: 'Needs action',
          message: 'Ticket FLUX-1 needs your input',
          actions: [],
          createdAt: new Date(0).toISOString(),
          read: false,
          dismissed: false,
        },
        unreadCount: 1,
      });
    });

    expect(screen.queryByText(/needs your input/)).toBeNull();
  });
});

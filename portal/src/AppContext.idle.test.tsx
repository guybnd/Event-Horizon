// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AppProvider } from './AppContext';
import type { Config } from './types';

// FLUX-1191: FLUX-1189 added the `.eh-idle` idle-detection effect in AppContext.tsx (a 20s
// no-input timer toggling `.eh-idle` on <html>, paused by matching CSS in index.css) but shipped
// without a test that actually mounts AppProvider and exercises the timer/listener mechanism —
// `IdleBoardAnimation.test.tsx` only re-confirms the board schedules no rAF loop while idle. This
// closes that gap directly against the real effect.
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

// jsdom has no EventSource implementation; AppProvider's SSE effect opens one unconditionally on
// mount, so it needs a minimal stand-in to avoid a ReferenceError before idle detection can be tested.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = FakeEventSource.CLOSED; }
}

// jsdom in this environment doesn't provide localStorage unless launched with
// --localstorage-file; AppProvider reads it directly during its initial theme/user state.
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

describe('.eh-idle toggling on <html> (FLUX-1189)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // @ts-expect-error FakeEventSource covers only what AppContext's SSE effect touches
    window.EventSource = FakeEventSource;
    document.documentElement.classList.remove('eh-idle');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('adds .eh-idle after 20s of no input, and removes it on the next interaction', async () => {
    render(<AppProvider><div /></AppProvider>);

    expect(document.documentElement.classList.contains('eh-idle')).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(document.documentElement.classList.contains('eh-idle')).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event('mousemove'));
    });
    expect(document.documentElement.classList.contains('eh-idle')).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(document.documentElement.classList.contains('eh-idle')).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown'));
    });
    expect(document.documentElement.classList.contains('eh-idle')).toBe(false);
  });
});

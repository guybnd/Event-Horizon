// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PerfPanel } from './PerfPanel';
import { fetchEnginePerf, type EnginePerfSnapshot } from '../api';
import { incr, recordDuration, resetForTest } from '../perfClient';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, fetchEnginePerf: vi.fn() };
});

const mockedFetchEnginePerf = vi.mocked(fetchEnginePerf);

const EMPTY_SNAPSHOT: EnginePerfSnapshot = { counters: {}, histograms: {}, uptimeSeconds: 12, rss: 50 * 1024 * 1024 };

function setQueryParam(search: string) {
  window.history.pushState({}, '', search);
}

describe('PerfPanel', () => {
  beforeEach(() => {
    resetForTest();
    mockedFetchEnginePerf.mockResolvedValue(EMPTY_SNAPSHOT);
  });

  afterEach(() => {
    cleanup();
    setQueryParam('/');
    vi.restoreAllMocks();
  });

  it('renders nothing by default (hidden debug tool, no query param)', () => {
    const { container } = render(<PerfPanel />);
    expect(container.firstChild).toBeNull();
    expect(mockedFetchEnginePerf).not.toHaveBeenCalled();
  });

  it('opens when the URL carries ?perf=1', async () => {
    setQueryParam('/?perf=1');
    render(<PerfPanel />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(mockedFetchEnginePerf).toHaveBeenCalled());
  });

  it('toggles open and closed with Alt+Shift+P', async () => {
    render(<PerfPanel />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { key: 'p', altKey: true, shiftKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'P', altKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('polls the engine snapshot every 3s while open', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    setQueryParam('/?perf=1');
    render(<PerfPanel />);
    await waitFor(() => expect(mockedFetchEnginePerf).toHaveBeenCalled());
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 3000);
  });

  it('renders engine sections and highlights a breach over the documented HTTP threshold', async () => {
    mockedFetchEnginePerf.mockResolvedValue({
      counters: {},
      histograms: {
        'http.GET /api/tasks': { count: 10, sum: 3000, max: 500, p50: 100, p95: 250 },
      },
      uptimeSeconds: 100,
      rss: 10 * 1024 * 1024,
    });
    setQueryParam('/?perf=1');
    render(<PerfPanel />);

    const row = await screen.findByText('GET /api/tasks');
    const tr = row.closest('tr');
    expect(tr?.className ?? '').toContain('text-rose-600');

    // Git/Store-SSE sit on registry keys FLUX-1131/1132 haven't landed yet — must degrade gracefully.
    expect(screen.getAllByText('No data yet.').length).toBeGreaterThan(0);
  });

  it('does not flag an HTTP row under threshold', async () => {
    mockedFetchEnginePerf.mockResolvedValue({
      counters: {},
      histograms: {
        'http.GET /api/tasks': { count: 10, sum: 300, max: 80, p50: 40, p95: 60 },
      },
      uptimeSeconds: 100,
      rss: 10 * 1024 * 1024,
    });
    setQueryParam('/?perf=1');
    render(<PerfPanel />);

    const row = await screen.findByText('GET /api/tasks');
    const tr = row.closest('tr');
    expect(tr?.className ?? '').not.toContain('text-rose-600');
  });

  it('shows the perfClient client-side snapshot alongside the engine one', async () => {
    incr('refresh.trigger.poll', 3);
    recordDuration('refresh.fetchTasks', 42);
    setQueryParam('/?perf=1');
    render(<PerfPanel />);

    const nameEl = await screen.findByText('refresh.trigger.poll');
    expect(nameEl.closest('li')?.textContent ?? '').toContain('3');
  });

  it('shows a fetch error without crashing the panel', async () => {
    mockedFetchEnginePerf.mockRejectedValue(new Error('boom'));
    setQueryParam('/?perf=1');
    render(<PerfPanel />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

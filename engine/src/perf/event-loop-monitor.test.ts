import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startEventLoopMonitor, stopEventLoopMonitor, type EventLoopHistogramLike } from './event-loop-monitor.js';
import { snapshot, resetForTest } from './registry.js';
import { log } from '../log.js';

const NS_PER_MS = 1e6;

/** A fixed-distribution stand-in for Node's IntervalHistogram — no real event loop involved. */
function fakeHistogram(opts: { count?: number; maxMs?: number; p50Ms?: number; p99Ms?: number } = {}): EventLoopHistogramLike {
  const count = opts.count ?? 10;
  const max = (opts.maxMs ?? 5) * NS_PER_MS;
  const p50 = (opts.p50Ms ?? (opts.maxMs ?? 5) / 2) * NS_PER_MS;
  const p99 = (opts.p99Ms ?? opts.maxMs ?? 5) * NS_PER_MS;
  return {
    count,
    max,
    percentile: (p: number) => (p === 99 ? p99 : p50),
    reset: vi.fn(),
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
  };
}

describe('event loop monitor', () => {
  beforeEach(() => {
    resetForTest();
    vi.useFakeTimers();
    delete process.env.EH_PERF_LOOP_STALL_MS;
  });

  afterEach(() => {
    stopEventLoopMonitor();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records p50/p99/max into the registry each window', () => {
    const h = fakeHistogram({ count: 20, maxMs: 30, p99Ms: 25 });
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);

    const { histograms } = snapshot();
    expect(histograms['eventloop.p50']?.count).toBe(1);
    expect(histograms['eventloop.p99']?.max).toBeCloseTo(25, 1);
    expect(histograms['eventloop.max']?.max).toBeCloseTo(30, 1);
  });

  it('resets the histogram after sampling each window', () => {
    const h = fakeHistogram();
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it('warns when the window max exceeds the stall threshold', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = fakeHistogram({ maxMs: 200 });
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/event loop stalled/i);
  });

  it('does not warn when the window max is under the stall threshold', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = fakeHistogram({ maxMs: 50 });
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('respects the EH_PERF_LOOP_STALL_MS override', () => {
    process.env.EH_PERF_LOOP_STALL_MS = '10';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = fakeHistogram({ maxMs: 20 });
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('emits at most one warning per window', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const h = fakeHistogram({ maxMs: 300 });
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(3000); // three windows elapse
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('skips recording when a window has no samples', () => {
    const h = fakeHistogram({ count: 0 });
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    const { histograms } = snapshot();
    expect(histograms['eventloop.p50']).toBeUndefined();
  });

  it('is idempotent — a second start() call while running is a no-op', () => {
    const h1 = fakeHistogram();
    const h2 = fakeHistogram();
    startEventLoopMonitor({ histogram: h1, intervalMs: 1000 });
    startEventLoopMonitor({ histogram: h2, intervalMs: 1000 });
    expect(h2.enable).not.toHaveBeenCalled();
  });

  it('stop() clears the timer and disables the histogram, so no further recording occurs', () => {
    const h = fakeHistogram();
    startEventLoopMonitor({ histogram: h, intervalMs: 1000 });
    stopEventLoopMonitor();
    expect(h.disable).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    const { histograms } = snapshot();
    expect(histograms['eventloop.p50']).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));

import { recordWatchEvent, resetWatchStormForTest } from './watch-storm.js';
import { snapshot, resetForTest } from './registry.js';
import { log } from '../log.js';
import { broadcastEvent } from '../events.js';

describe('watcher storm detection', () => {
  beforeEach(() => {
    resetForTest();
    resetWatchStormForTest();
    delete process.env.EH_PERF_WATCH_STORM;
    vi.mocked(broadcastEvent).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('increments store.watchEvents on every call', () => {
    recordWatchEvent(0);
    recordWatchEvent(1);
    recordWatchEvent(2);
    expect(snapshot().counters['store.watchEvents']).toBe(3);
  });

  it('does not warn under the storm threshold (default 50/10s)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 50; i++) recordWatchEvent(i);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once the window exceeds the storm threshold', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 51; i++) recordWatchEvent(i);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/watcher storm: 51 fs events in 10s/i);
  });

  it('broadcasts a perf SSE event alongside the warning', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 51; i++) recordWatchEvent(i);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent).toHaveBeenCalledWith(
      'perf',
      expect.objectContaining({ kind: 'watch-storm', message: expect.stringMatching(/watcher storm: 51 fs events in 10s/i) }),
    );
  });

  it('respects the throttle — no second broadcast within the same storm window', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 80; i++) recordWatchEvent(i);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
  });

  it('emits at most one warning per window even as events keep coming', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 80; i++) recordWatchEvent(i);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the window (and the warn-once guard) after 10s of no new events', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 60; i++) recordWatchEvent(i); // storm at t=[0..59]ms, warns once
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Next event arrives well past the 10s window — starts a fresh window.
    recordWatchEvent(20_000);
    expect(warnSpy).toHaveBeenCalledTimes(1); // still just the one, fresh window has 1 event

    for (let i = 1; i <= 51; i++) recordWatchEvent(20_000 + i); // re-storm the fresh window
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('respects the EH_PERF_WATCH_STORM override', () => {
    process.env.EH_PERF_WATCH_STORM = '3';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    recordWatchEvent(0);
    recordWatchEvent(1);
    recordWatchEvent(2);
    recordWatchEvent(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults to Date.now() when no timestamp is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      recordWatchEvent();
      expect(snapshot().counters['store.watchEvents']).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

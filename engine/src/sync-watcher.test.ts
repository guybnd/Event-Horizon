import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler } from './sync-watcher.js';

describe('createScheduler — debounce + max-wait', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires after debounce when activity stops', () => {
    const onSync = vi.fn();
    const { schedule } = createScheduler(() => 30_000, () => 300_000, onSync);

    schedule();
    vi.advanceTimersByTime(29_999);
    expect(onSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('resets the debounce timer on each new change', () => {
    const onSync = vi.fn();
    const { schedule } = createScheduler(() => 30_000, () => 300_000, onSync);

    schedule();
    vi.advanceTimersByTime(20_000);
    schedule(); // resets debounce
    vi.advanceTimersByTime(20_000); // only 20s since last change
    expect(onSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000); // now 30s since last change
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('fires at max-wait even if changes keep arriving', () => {
    const onSync = vi.fn();
    const DEBOUNCE = 30_000;
    const MAX_WAIT = 300_000;
    const { schedule } = createScheduler(() => DEBOUNCE, () => MAX_WAIT, onSync);

    // Simulate a change every second for 6 minutes
    for (let i = 0; i < 360; i++) {
      schedule();
      vi.advanceTimersByTime(1_000);
    }

    // Should have fired once at the 5-minute mark, not deferred the whole time
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('fires again after max-wait resets on the next batch of changes', () => {
    const onSync = vi.fn();
    const { schedule } = createScheduler(() => 30_000, () => 300_000, onSync);

    // First burst: triggers at max-wait
    for (let i = 0; i < 310; i++) {
      schedule();
      vi.advanceTimersByTime(1_000);
    }
    expect(onSync).toHaveBeenCalledTimes(1);

    // Second burst: deadline resets after sync
    for (let i = 0; i < 310; i++) {
      schedule();
      vi.advanceTimersByTime(1_000);
    }
    expect(onSync).toHaveBeenCalledTimes(2);
  });

  it('reset cancels the pending sync', () => {
    const onSync = vi.fn();
    const { schedule, reset } = createScheduler(() => 30_000, () => 300_000, onSync);

    schedule();
    vi.advanceTimersByTime(20_000);
    reset();
    vi.advanceTimersByTime(60_000);
    expect(onSync).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { incr, recordDuration, recordSseEvent, snapshot, resetForTest } from './perfClient';

describe('perfClient', () => {
  beforeEach(() => {
    resetForTest();
  });

  describe('incr', () => {
    it('accumulates a single counter across calls', () => {
      incr('foo');
      incr('foo');
      incr('foo');
      expect(snapshot().counters.foo).toBe(3);
    });

    it('tracks multiple counters independently', () => {
      incr('foo');
      incr('bar');
      incr('bar');
      const { counters } = snapshot();
      expect(counters.foo).toBe(1);
      expect(counters.bar).toBe(2);
    });

    it('honors a custom `by` amount', () => {
      incr('foo', 5);
      incr('foo', 10);
      expect(snapshot().counters.foo).toBe(15);
    });
  });

  describe('recordDuration', () => {
    it('tracks count, sum, and max for a single name', () => {
      recordDuration('op', 10);
      recordDuration('op', 20);
      recordDuration('op', 5);
      const h = snapshot().histograms.op!;
      expect(h.count).toBe(3);
      expect(h.sum).toBe(35);
      expect(h.max).toBe(20);
    });

    it('keeps separate histograms per name', () => {
      recordDuration('a', 100);
      recordDuration('b', 1);
      const { histograms } = snapshot();
      expect(histograms.a!.count).toBe(1);
      expect(histograms.b!.count).toBe(1);
    });

    it('estimates p50/p95 reasonably for a known uniform distribution (1..100ms)', () => {
      for (let ms = 1; ms <= 100; ms++) recordDuration('dist', ms);
      const h = snapshot().histograms.dist!;
      expect(h.count).toBe(100);
      expect(h.p50).toBeGreaterThanOrEqual(40);
      expect(h.p50).toBeLessThanOrEqual(60);
      expect(h.p95).toBeGreaterThanOrEqual(90);
    });

    describe('slow-event ring buffer', () => {
      it('records events over the slow threshold, not under it', () => {
        recordDuration('fast', 50);
        recordDuration('slow', 301);
        const { slowEvents } = snapshot();
        expect(slowEvents).toHaveLength(1);
        expect(slowEvents[0]).toMatchObject({ name: 'slow', ms: 301 });
      });

      it('caps the ring buffer at 100, dropping the oldest', () => {
        for (let i = 0; i < 105; i++) recordDuration('slow', 400 + i);
        const { slowEvents } = snapshot();
        expect(slowEvents).toHaveLength(100);
        // The first 5 (400..404) should have been dropped; the oldest surviving is 405.
        expect(slowEvents[0]!.ms).toBe(405);
        expect(slowEvents[slowEvents.length - 1]!.ms).toBe(504);
      });
    });

    describe('dev console warnings', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('warns when a duration exceeds the slow threshold', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        recordDuration('refresh.fetchTasks', 350);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]![0]).toContain('refresh.fetchTasks');
      });

      it('does not warn for a duration under the slow threshold', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        recordDuration('refresh.fetchTasks', 100);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('recordSseEvent', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('counts events per type under sse.event.<type>', () => {
      recordSseEvent('taskUpdated');
      recordSseEvent('taskUpdated');
      recordSseEvent('ping');
      const { counters } = snapshot();
      expect(counters['sse.event.taskUpdated']).toBe(2);
      expect(counters['sse.event.ping']).toBe(1);
    });

    it('warns once when more than the burst threshold lands within the window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (let i = 0; i < 31; i++) recordSseEvent('activity');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('SSE burst');
    });

    it('does not warn again inside the same burst window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (let i = 0; i < 40; i++) recordSseEvent('activity');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when events are spread outside the burst window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (let i = 0; i < 31; i++) {
        vi.setSystemTime(i * 1000);
        recordSseEvent('activity');
      }
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('snapshot', () => {
    it('includes uptimeMs as a number', () => {
      const s = snapshot();
      expect(typeof s.uptimeMs).toBe('number');
      expect(s.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it('is JSON-serializable', () => {
      incr('foo');
      recordDuration('op', 12);
      const s = snapshot();
      expect(() => JSON.stringify(s)).not.toThrow();
    });
  });

  describe('resetForTest', () => {
    it('clears counters, histograms, and slow events', () => {
      incr('foo');
      recordDuration('op', 400);
      resetForTest();
      const s = snapshot();
      expect(s.counters).toEqual({});
      expect(s.histograms).toEqual({});
      expect(s.slowEvents).toEqual([]);
    });
  });

  describe('window.__ehPerf', () => {
    it('is attached and exposes snapshot/recordDuration/incr', () => {
      expect(window.__ehPerf).toBeDefined();
      incr('via-window');
      expect(window.__ehPerf!.snapshot().counters['via-window']).toBe(1);
    });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { incr, recordDuration, snapshot, resetForTest } from './registry.js';

describe('perf registry', () => {
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
      expect(histograms.a!.max).toBe(100);
      expect(histograms.b!.count).toBe(1);
      expect(histograms.b!.max).toBe(1);
    });

    it('buckets a value beyond the largest boundary into the overflow bucket without throwing', () => {
      recordDuration('slow', 999_999);
      const h = snapshot().histograms.slow!;
      expect(h.count).toBe(1);
      expect(h.max).toBe(999_999);
    });

    it('estimates p50/p95 reasonably for a known uniform distribution (1..100ms)', () => {
      for (let ms = 1; ms <= 100; ms++) recordDuration('dist', ms);
      const h = snapshot().histograms.dist!;
      expect(h.count).toBe(100);
      expect(h.sum).toBe(5050);
      expect(h.max).toBe(100);
      // Bucket-boundary approximation, not exact percentiles — assert a reasonable range.
      expect(h.p50).toBeGreaterThanOrEqual(40);
      expect(h.p50).toBeLessThanOrEqual(60);
      expect(h.p95).toBeGreaterThanOrEqual(90);
      expect(h.p95).toBeLessThanOrEqual(100);
    });

    it('reports p50 = 0 for a name with no recorded durations (not present in snapshot at all)', () => {
      expect(snapshot().histograms.nope).toBeUndefined();
    });
  });

  describe('snapshot', () => {
    it('includes process uptime and rss as numbers', () => {
      const s = snapshot();
      expect(typeof s.uptimeSeconds).toBe('number');
      expect(s.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(typeof s.rss).toBe('number');
      expect(s.rss).toBeGreaterThan(0);
    });

    it('is JSON-serializable', () => {
      incr('foo');
      recordDuration('op', 12);
      const s = snapshot();
      expect(() => JSON.stringify(s)).not.toThrow();
    });
  });

  describe('resetForTest', () => {
    it('clears counters and histograms', () => {
      incr('foo');
      recordDuration('op', 10);
      resetForTest();
      const s = snapshot();
      expect(s.counters).toEqual({});
      expect(s.histograms).toEqual({});
    });
  });
});

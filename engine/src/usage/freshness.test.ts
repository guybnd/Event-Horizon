import { describe, it, expect } from 'vitest';
import { computeFreshness, finalizeGauge } from './freshness.js';

const NOW = new Date('2026-09-05T00:00:00.000Z');

describe('computeFreshness', () => {
  it('is expired when resetsAt is in the past', () => {
    expect(computeFreshness({
      resetsAt: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-09-04T23:59:00.000Z',
      windowMinutes: 300,
      now: NOW,
    })).toBe('expired');
  });

  it('is expired at the exact boundary (resetsAt === now)', () => {
    expect(computeFreshness({
      resetsAt: NOW.toISOString(),
      observedAt: NOW.toISOString(),
      now: NOW,
    })).toBe('expired');
  });

  it('is live when resetsAt is in the future and the observation is fresh', () => {
    expect(computeFreshness({
      resetsAt: '2026-09-05T05:00:00.000Z',
      observedAt: '2026-09-04T23:59:00.000Z',
      windowMinutes: 300,
      now: NOW,
    })).toBe('live');
  });

  it('is stale when resetsAt is in the future but the observation predates min(half-window, 6h)', () => {
    // windowMinutes: 300 (5h) -> half-window is 2.5h; observation is 3h old.
    expect(computeFreshness({
      resetsAt: '2026-09-05T05:00:00.000Z',
      observedAt: '2026-09-04T21:00:00.000Z',
      windowMinutes: 300,
      now: NOW,
    })).toBe('stale');
  });

  it('caps the stale threshold at 6h for a long window', () => {
    // windowMinutes: 10080 (7d) -> half-window is 3.5d, capped to 6h. Observation is 7h old -> stale.
    expect(computeFreshness({
      resetsAt: '2026-09-10T00:00:00.000Z',
      observedAt: '2026-09-04T17:00:00.000Z',
      windowMinutes: 10080,
      now: NOW,
    })).toBe('stale');
  });

  it('mixed case: one expired gauge and one live gauge from the same source, evaluated independently', () => {
    // Same shape as a real Codex rollout line: primary window rolled over, secondary is still live.
    const primary = computeFreshness({ resetsAt: '2026-08-31T18:16:31.000Z', observedAt: '2026-09-05T00:00:00.000Z', windowMinutes: 300, now: NOW });
    const secondary = computeFreshness({ resetsAt: '2026-09-07T13:16:31.000Z', observedAt: '2026-09-05T00:00:00.000Z', windowMinutes: 10080, now: NOW });
    expect(primary).toBe('expired');
    expect(secondary).toBe('live');
  });

  it('no resetsAt: live when the observation is fresh', () => {
    expect(computeFreshness({ observedAt: '2026-09-04T23:00:00.000Z', now: NOW })).toBe('live');
  });

  it('no resetsAt: stale when the observation is older than 6h (closes the fall-through hole)', () => {
    expect(computeFreshness({ observedAt: '2026-08-29T00:00:00.000Z', now: NOW })).toBe('stale');
  });
});

describe('finalizeGauge', () => {
  it('drops percent/used/percentFloor when expired, keeps resetsAt/observedAt', () => {
    const gauge = finalizeGauge({
      id: 'g1',
      label: '5 h',
      unit: 'requests',
      percent: 90,
      used: 100,
      percentFloor: 50,
      resetsAt: '2026-08-31T18:16:31.000Z',
      observedAt: '2026-09-05T00:00:00.000Z',
      provenance: 'exact',
    }, NOW);

    expect(gauge.freshness).toBe('expired');
    expect(gauge.percent).toBeUndefined();
    expect(gauge.used).toBeUndefined();
    expect(gauge.percentFloor).toBeUndefined();
    expect(gauge.resetsAt).toBe('2026-08-31T18:16:31.000Z');
    expect(gauge.observedAt).toBe('2026-09-05T00:00:00.000Z');
  });

  it('retains percent/used when live', () => {
    const gauge = finalizeGauge({
      id: 'g2',
      label: '7 d',
      unit: 'requests',
      percent: 14,
      resetsAt: '2026-09-07T13:16:31.000Z',
      observedAt: '2026-09-05T00:00:00.000Z',
      provenance: 'exact',
    }, NOW);

    expect(gauge.freshness).toBe('live');
    expect(gauge.percent).toBe(14);
  });
});

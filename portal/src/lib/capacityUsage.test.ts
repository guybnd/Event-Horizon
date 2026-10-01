import { describe, expect, it } from 'vitest';
import { barPercent, firstUnrankableProvider, fullness, worstRankableGauge } from './capacityUsage';
import type { ProviderUsage, UsageGauge } from '../types';

function gauge(overrides: Partial<UsageGauge>): UsageGauge {
  return {
    id: 'g',
    label: 'gauge',
    unit: 'tokens',
    observedAt: '2026-01-01T00:00:00.000Z',
    provenance: 'exact',
    freshness: 'live',
    ...overrides,
  };
}

describe('fullness (FLUX-1748)', () => {
  it('prefers percent, then percentFloor, then used/limit', () => {
    expect(fullness(gauge({ percent: 40 }))).toBe(40);
    expect(fullness(gauge({ percentFloor: 41 }))).toBe(41);
    expect(fullness(gauge({ used: 195, limit: 200, unit: 'requests' }))).toBe(97.5);
  });

  it('is undefined (unrankable), never 0, when nothing resolves', () => {
    expect(fullness(gauge({}))).toBeUndefined();
    expect(fullness(gauge({ used: 5, limit: 0 }))).toBeUndefined();
  });

  it('is undefined for an unlimited gauge even when used exceeds limit', () => {
    expect(fullness(gauge({ unlimited: true, used: 900, limit: 300, unit: 'requests' }))).toBeUndefined();
  });
});

describe('barPercent (FLUX-1748 B1)', () => {
  it('derives a percent from used/limit when the gauge has no percent of its own', () => {
    expect(barPercent(gauge({ used: 195, limit: 200, unit: 'requests' }))).toBe(97.5);
  });

  it('prefers an explicit percent over used/limit', () => {
    expect(barPercent(gauge({ percent: 40, used: 195, limit: 200 }))).toBe(40);
  });

  it('is undefined for an unlimited gauge — there is no fraction of a wall to draw', () => {
    expect(barPercent(gauge({ unlimited: true, used: 900, limit: 300, unit: 'requests' }))).toBeUndefined();
  });
});

describe('worstRankableGauge', () => {
  it('a percent-less request gauge at 97.5% outranks an exact token gauge at 40%', () => {
    const providers: ProviderUsage[] = [
      {
        provider: 'codex',
        provenance: 'exact',
        gauges: [gauge({ id: 'codex-5h', percent: 40, unit: 'tokens' })],
        history: [],
      },
      {
        provider: 'copilot',
        provenance: 'exact',
        gauges: [gauge({ id: 'copilot-month', used: 195, limit: 200, unit: 'requests' })],
        history: [],
      },
    ];
    const worst = worstRankableGauge(providers);
    expect(worst?.provider).toBe('copilot');
    expect(worst?.gauge.id).toBe('copilot-month');
    expect(worst?.fullness).toBe(97.5);
  });

  it('picks the single max, never an average, across many gauges', () => {
    const providers: ProviderUsage[] = [
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'a', percent: 10 }), gauge({ id: 'b', percent: 90 })], history: [] },
    ];
    expect(worstRankableGauge(providers)?.gauge.id).toBe('b');
  });

  it('excludes unrankable gauges rather than ranking them as 0', () => {
    const providers: ProviderUsage[] = [
      { provider: 'claude', provenance: 'floor', gauges: [gauge({ id: 'claude-floor', provenance: 'floor', used: 1_200_000 })], history: [] },
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 40 })], history: [] },
    ];
    const worst = worstRankableGauge(providers);
    expect(worst?.gauge.id).toBe('codex-5h');
  });

  it('returns undefined when every gauge is unknown or unrankable', () => {
    const providers: ProviderUsage[] = [
      { provider: 'gemini', provenance: 'unknown', gauges: [], reason: 'no local capacity probe', history: [] },
    ];
    expect(worstRankableGauge(providers)).toBeUndefined();
  });

  it('an unlimited gauge never wins the chip, even reporting used > limit', () => {
    const providers: ProviderUsage[] = [
      {
        provider: 'copilot',
        provenance: 'exact',
        gauges: [gauge({ id: 'copilot-month', unlimited: true, used: 900, limit: 300, unit: 'requests' })],
        history: [],
      },
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 85 })], history: [] },
    ];
    const worst = worstRankableGauge(providers);
    expect(worst?.gauge.id).toBe('codex-5h');
  });
});

describe('firstUnrankableProvider', () => {
  it('finds a non-unknown provider whose only gauge has no computable fullness', () => {
    const providers: ProviderUsage[] = [
      { provider: 'claude', provenance: 'floor', gauges: [gauge({ id: 'claude-floor', provenance: 'floor', used: 1_200_000 })], history: [] },
    ];
    expect(firstUnrankableProvider(providers)?.provider).toBe('claude');
  });

  it('is undefined when no unrankable gauge exists', () => {
    const providers: ProviderUsage[] = [
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 40 })], history: [] },
    ];
    expect(firstUnrankableProvider(providers)).toBeUndefined();
  });

  it('still finds the unrankable provider when a rankable gauge exists on another provider', () => {
    const providers: ProviderUsage[] = [
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 40 })], history: [] },
      { provider: 'claude', provenance: 'floor', gauges: [gauge({ id: 'claude-floor', provenance: 'floor', used: 1_200_000 })], history: [] },
    ];
    expect(firstUnrankableProvider(providers)?.provider).toBe('claude');
  });
});

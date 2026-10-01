import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getUsageSnapshot, checkAndBroadcast, resetUsageBroadcastStateForTest, type UsageProbes } from './usage-store.js';
import type { ProviderUsage } from './types.js';

function providerUsage(provider: ProviderUsage['provider'], overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return { provider, gauges: [], provenance: 'unknown', history: [], ...overrides };
}

describe('getUsageSnapshot', () => {
  it('one probe throwing leaves the others intact, and reports the failed one as unknown with a reason', () => {
    const probes: UsageProbes = {
      claude: () => providerUsage('claude', { provenance: 'floor', gauges: [{ id: 'g', label: 'l', unit: 'tokens', used: 5, observedAt: new Date().toISOString(), provenance: 'floor', freshness: 'live' }] }),
      codex: () => { throw new Error('boom'); },
      copilot: () => providerUsage('copilot', { provenance: 'exact' }),
    };

    // Indexed, not matched by a per-provider literal — getUsageSnapshot's fixed provider order
    // (claude, codex, copilot, ...unprobed) is what's under test here, and adapter-boundary
    // forbids a `=== 'claude'`-shaped literal outside engine/src/agents/.
    const snapshot = getUsageSnapshot(probes);
    const [claude, codex, copilot] = snapshot.providers;

    expect(codex!.provenance).toBe('unknown');
    expect(codex!.reason).toMatch(/probe threw: boom/);
    expect(claude!.provenance).toBe('floor');
    expect(copilot!.provenance).toBe('exact');
  });

  it('lists every CliFramework, including providers with no local probe, as unknown', () => {
    const probes: UsageProbes = {
      claude: () => providerUsage('claude'),
      codex: () => providerUsage('codex'),
      copilot: () => providerUsage('copilot'),
    };
    const snapshot = getUsageSnapshot(probes);
    const names = snapshot.providers.map((p) => p.provider).sort();
    expect(names).toEqual(['antigravity', 'claude', 'codex', 'copilot', 'gemini', 'grok'].sort());
    expect(snapshot.providers.find((p) => p.provider === 'gemini')?.provenance).toBe('unknown');
  });
});

describe('checkAndBroadcast', () => {
  beforeEach(() => {
    resetUsageBroadcastStateForTest();
  });

  it('does not broadcast on an identical re-read', () => {
    const broadcast = vi.fn();
    const snapshot = { providers: [providerUsage('codex', { provenance: 'exact', gauges: [{ id: 'g', label: 'l', unit: 'requests' as const, percent: 10, observedAt: 't', provenance: 'exact' as const, freshness: 'live' as const }] })], generatedAt: 'a' };
    const snapshot2 = { ...snapshot, generatedAt: 'b' }; // generatedAt changes every call; must not defeat the compare

    expect(checkAndBroadcast(snapshot, broadcast)).toBe(true);
    expect(checkAndBroadcast(snapshot2, broadcast)).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('usageChanged', { generatedAt: 'a' });
  });

  it('DOES broadcast on a freshness transition with no other change (live -> expired)', () => {
    const broadcast = vi.fn();
    const base: ProviderUsage = providerUsage('codex', {
      provenance: 'exact',
      gauges: [{ id: 'g', label: 'l', unit: 'requests', percent: 90, observedAt: 't', provenance: 'exact', freshness: 'live' }],
    });
    const expired: ProviderUsage = providerUsage('codex', {
      provenance: 'exact',
      gauges: [{ id: 'g', label: 'l', unit: 'requests', observedAt: 't', provenance: 'exact', freshness: 'expired' }],
    });

    expect(checkAndBroadcast({ providers: [base], generatedAt: 'a' }, broadcast)).toBe(true);
    expect(checkAndBroadcast({ providers: [expired], generatedAt: 'b' }, broadcast)).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});

describe('history ring (recordHistory via getUsageSnapshot)', () => {
  beforeEach(() => {
    resetUsageBroadcastStateForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function gaugeProbes(percent: number): UsageProbes {
    return {
      claude: () => providerUsage('claude'),
      codex: () => providerUsage('codex', {
        provenance: 'exact',
        gauges: [{ id: 'codex-primary', label: 'l', unit: 'requests', percent, observedAt: new Date().toISOString(), provenance: 'exact', freshness: 'live' }],
      }),
      copilot: () => providerUsage('copilot'),
    };
  }

  it('buckets history to 5-minute resolution — repeated calls within the window do not each append', () => {
    getUsageSnapshot(gaugeProbes(10));
    vi.advanceTimersByTime(60_000); // +1 min, still inside the 5-min bucket
    getUsageSnapshot(gaugeProbes(20));
    vi.advanceTimersByTime(60_000); // +2 min total
    const snapshot = getUsageSnapshot(gaugeProbes(30));

    const codex = snapshot.providers.find((p) => p.provider === 'codex')!;
    expect(codex.history.filter((e) => e.gaugeId === 'codex-primary')).toHaveLength(1);
  });

  it('appends a new bucket once 5 minutes have elapsed', () => {
    getUsageSnapshot(gaugeProbes(10));
    vi.advanceTimersByTime(6 * 60_000); // past the 5-min bucket
    const snapshot = getUsageSnapshot(gaugeProbes(20));

    const codex = snapshot.providers.find((p) => p.provider === 'codex')!;
    expect(codex.history.filter((e) => e.gaugeId === 'codex-primary')).toHaveLength(2);
  });

  it('caps the ring at 24h — an entry older than the window is pruned', () => {
    getUsageSnapshot(gaugeProbes(10));
    vi.advanceTimersByTime(25 * 60 * 60_000); // +25h, past the 24h window
    const snapshot = getUsageSnapshot(gaugeProbes(20));

    const codex = snapshot.providers.find((p) => p.provider === 'codex')!;
    const entries = codex.history.filter((e) => e.gaugeId === 'codex-primary');
    expect(entries).toHaveLength(1); // only the just-recorded entry; the 25h-old one has been pruned
    expect(entries[0]!.value).toBe(20);
  });
});

describe('getUsageSnapshot caching (production/default-probes path)', () => {
  beforeEach(() => {
    resetUsageBroadcastStateForTest();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-05T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the default-probes path from cache within SNAPSHOT_TTL_MS', () => {
    const first = getUsageSnapshot();
    vi.advanceTimersByTime(1000);
    const second = getUsageSnapshot();
    expect(second.generatedAt).toBe(first.generatedAt); // same cached snapshot, not recomputed
  });

  it('recomputes the default-probes snapshot once SNAPSHOT_TTL_MS has elapsed', () => {
    const first = getUsageSnapshot();
    vi.advanceTimersByTime(5000); // past the 4s TTL
    const second = getUsageSnapshot();
    expect(second.generatedAt).not.toBe(first.generatedAt);
  });

  it('an explicit-probes call always invokes the probes fresh, never served from the production cache', () => {
    let calls = 0;
    const probes: UsageProbes = {
      claude: () => providerUsage('claude'),
      codex: () => { calls++; return providerUsage('codex'); },
      copilot: () => providerUsage('copilot'),
    };
    getUsageSnapshot(probes);
    getUsageSnapshot(probes);
    expect(calls).toBe(2);
  });
});

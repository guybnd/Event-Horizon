// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CapacityChip } from './CapacityChip';
import { appStore } from '../store/appStore';
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

function setUsage(providers: ProviderUsage[]) {
  appStore.patch({ usage: { providers, generatedAt: '2026-01-01T00:00:00.000Z' } });
}

describe('CapacityChip (FLUX-1748)', () => {
  afterEach(() => {
    cleanup();
    appStore.patch({ usage: null });
  });

  it('picks the max-fullness gauge — a percent-less request gauge beats an exact token gauge', () => {
    setUsage([
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 40, unit: 'tokens' })], history: [] },
      { provider: 'copilot', provenance: 'exact', gauges: [gauge({ id: 'copilot-month', used: 195, limit: 200, unit: 'requests' })], history: [] },
    ]);
    render(<CapacityChip />);
    expect(screen.getByText(/Copilot/)).toBeTruthy();
  });

  it('M1 regression: an unlimited gauge never hijacks the chip even reporting used > limit', () => {
    setUsage([
      {
        provider: 'copilot',
        provenance: 'exact',
        gauges: [gauge({ id: 'copilot-month', unlimited: true, used: 900, limit: 300, unit: 'requests' })],
        history: [],
      },
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 85 })], history: [] },
    ]);
    render(<CapacityChip />);
    expect(screen.getByText(/Codex/)).toBeTruthy();
  });

  it('shows a dash plus the provider when non-unknown gauges exist but none are rankable', () => {
    setUsage([
      { provider: 'claude', provenance: 'floor', gauges: [gauge({ id: 'claude-floor', provenance: 'floor', used: 1_200_000 })], history: [] },
    ]);
    render(<CapacityChip />);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('—');
    expect(button.title).toContain('Claude Code');
  });

  it('shows a dash and "capacity not exposed" when every provider is unknown', () => {
    setUsage([
      { provider: 'gemini', provenance: 'unknown', gauges: [], reason: 'no local capacity probe for this provider', history: [] },
    ]);
    render(<CapacityChip />);
    const button = screen.getByRole('button');
    expect(button.textContent).toContain('—');
    expect(button.title).toBe('Capacity not exposed');
  });
});

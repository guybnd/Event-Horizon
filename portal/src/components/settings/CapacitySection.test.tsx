// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CapacitySection } from './CapacitySection';
import { appStore } from '../../store/appStore';
import type { ProviderUsage, UsageGauge } from '../../types';

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

describe('CapacitySection (FLUX-1748)', () => {
  afterEach(() => {
    cleanup();
    appStore.patch({ usage: null });
  });

  it('renders one dimmed row carrying `reason` for an unknown provider, never dropping it', () => {
    setUsage([
      { provider: 'gemini', provenance: 'unknown', gauges: [], reason: 'no local usage file found', history: [] },
    ]);
    render(<CapacitySection />);
    expect(screen.getByText('no local usage file found')).toBeTruthy();
  });

  it('renders the placeholder (no sparkline path) under 3 history samples', () => {
    setUsage([
      {
        provider: 'codex',
        provenance: 'exact',
        gauges: [gauge({ id: 'codex-5h', percent: 40, windowMinutes: 300 })],
        history: [
          { at: '2026-01-01T00:00:00.000Z', gaugeId: 'codex-5h', value: 10 },
          { at: '2026-01-01T00:05:00.000Z', gaugeId: 'codex-5h', value: 20 },
        ],
      },
    ]);
    const { container } = render(<CapacitySection />);
    expect(screen.getByText(/history since engine start/)).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws a sparkline path at 3+ history samples', () => {
    setUsage([
      {
        provider: 'codex',
        provenance: 'exact',
        gauges: [gauge({ id: 'codex-5h', percent: 40, windowMinutes: 300 })],
        history: [
          { at: '2026-01-01T00:00:00.000Z', gaugeId: 'codex-5h', value: 10 },
          { at: '2026-01-01T00:05:00.000Z', gaugeId: 'codex-5h', value: 20 },
          { at: '2026-01-01T00:10:00.000Z', gaugeId: 'codex-5h', value: 40 },
        ],
      },
    ]);
    const { container } = render(<CapacitySection />);
    expect(screen.queryByText(/history since engine start/)).toBeNull();
    expect(container.querySelector('svg path')).not.toBeNull();
  });

  it('shows an unlimited gauge as a count with no fraction bar', () => {
    setUsage([
      {
        provider: 'copilot',
        provenance: 'exact',
        gauges: [gauge({ id: 'copilot-month', unit: 'requests', unlimited: true, used: 900, limit: 300 })],
        history: [],
      },
    ]);
    render(<CapacitySection />);
    expect(screen.getByText('900 requests (unlimited)')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows source path and parse age for a gauge that carries `source`', () => {
    setUsage([
      {
        provider: 'codex',
        provenance: 'exact',
        gauges: [gauge({ id: 'codex-5h', percent: 40, source: { path: '/home/user/.codex/sessions/rollout-1.jsonl', ageMs: 4200 } })],
        history: [],
      },
    ]);
    render(<CapacitySection />);
    expect(screen.getByText(/rollout-1\.jsonl/)).toBeTruthy();
    expect(screen.getByText(/4s ago/)).toBeTruthy();
  });
});

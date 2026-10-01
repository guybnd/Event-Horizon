// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapacityPopover } from './CapacityPopover';
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

describe('CapacityPopover (FLUX-1748)', () => {
  it('shows the Copilot row as "used / entitlement requests", never a bare percent', () => {
    const providers: ProviderUsage[] = [
      { provider: 'copilot', provenance: 'exact', gauges: [gauge({ id: 'copilot-month', unit: 'requests', used: 5, limit: 200 })], history: [] },
    ];
    render(<CapacityPopover providers={providers} onClose={() => {}} />);
    expect(screen.getByText('5 / 200 requests')).toBeTruthy();
  });

  it('B1 regression: a Copilot gauge 5 requests from its wall renders a near-full bar, not an empty one', () => {
    const providers: ProviderUsage[] = [
      { provider: 'copilot', provenance: 'exact', gauges: [gauge({ id: 'copilot-month', unit: 'requests', used: 195, limit: 200 })], history: [] },
    ];
    render(<CapacityPopover providers={providers} onClose={() => {}} />);
    expect(screen.getByText('195 / 200 requests')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('97.5');
    const fill = bar.querySelector('.eh-provenance-bar__fill') as HTMLElement;
    expect(fill.style.width).toBe('97.5%');
  });

  it('an unlimited gauge shows a count with no fraction bar', () => {
    const providers: ProviderUsage[] = [
      {
        provider: 'copilot',
        provenance: 'exact',
        gauges: [gauge({ id: 'copilot-month', unit: 'requests', unlimited: true, used: 900, limit: 300 })],
        history: [],
      },
    ];
    render(<CapacityPopover providers={providers} onClose={() => {}} />);
    expect(screen.getByText('900 requests (unlimited)')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('derives the window label from windowMinutes: 300 -> "5 h", 10080 -> "7 d"', () => {
    const providers: ProviderUsage[] = [
      {
        provider: 'codex',
        provenance: 'exact',
        gauges: [
          gauge({ id: 'codex-primary', label: 'Primary', windowMinutes: 300, percent: 40 }),
          gauge({ id: 'codex-secondary', label: 'Secondary', windowMinutes: 10080, percent: 10 }),
        ],
        history: [],
      },
    ];
    render(<CapacityPopover providers={providers} onClose={() => {}} />);
    expect(screen.getByText('Primary (5 h)')).toBeTruthy();
    expect(screen.getByText('Secondary (7 d)')).toBeTruthy();
  });

  it('groups by provider — sections never merge gauges across providers', () => {
    const providers: ProviderUsage[] = [
      { provider: 'codex', provenance: 'exact', gauges: [gauge({ id: 'codex-5h', percent: 40 })], history: [] },
      { provider: 'copilot', provenance: 'exact', gauges: [gauge({ id: 'copilot-month', unit: 'requests', used: 5, limit: 200 })], history: [] },
    ];
    render(<CapacityPopover providers={providers} onClose={() => {}} />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Copilot')).toBeTruthy();
  });
});

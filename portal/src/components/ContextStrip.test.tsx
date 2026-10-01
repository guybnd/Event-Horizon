// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextStrip } from './ContextStrip';
import type { CliSessionSummary } from '../types';

function session(overrides: Partial<CliSessionSummary>): CliSessionSummary {
  return {
    id: 's1',
    taskId: 'FLUX-1',
    framework: 'codex',
    status: 'running',
    command: 'claude',
    args: [],
    ...overrides,
  } as CliSessionSummary;
}

describe('ContextStrip (FLUX-1748)', () => {
  it('renders one compaction marker per compactionCount', () => {
    render(<ContextStrip session={session({ lastTurnContextTokens: 50_000, contextWindow: 200_000, compactionCount: 3 })} />);
    expect(screen.getAllByTestId('compaction-marker')).toHaveLength(3);
  });

  it('shows a ratio percent when contextWindow is present', () => {
    render(<ContextStrip session={session({ lastTurnContextTokens: 100_000, contextWindow: 200_000 })} />);
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('shows the raw token count with no ratio when contextWindow is absent', () => {
    render(<ContextStrip session={session({ lastTurnContextTokens: 50_000, contextWindow: undefined })} />);
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText(/tok/)).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('data-provenance')).toBe('unknown');
  });

  it('renders nothing when neither a token count nor a context window is known', () => {
    const { container } = render(
      <ContextStrip session={session({ lastTurnContextTokens: undefined, contextWindow: undefined })} />
    );
    expect(container.firstChild).toBeNull();
  });
});

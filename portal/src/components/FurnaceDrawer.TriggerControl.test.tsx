// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TriggerControl } from './FurnaceDrawer';
import { updateFurnaceBatch } from '../api';
import type { FurnaceBatch } from '../furnaceTypes';

// FLUX-1199 follow-up (FLUX-1240): a batch that left draft with an armed trigger still needs a
// way to clear the now-inert badge — the popover degrades to Clear-only instead of disappearing.

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, updateFurnaceBatch: vi.fn().mockResolvedValue({}) };
});

const mockedUpdateFurnaceBatch = vi.mocked(updateFurnaceBatch);

function mkBatch(overrides: Partial<FurnaceBatch>): FurnaceBatch {
  return {
    id: 'b1',
    title: 'Test batch',
    kind: 'parallel',
    branch: 'flux/test',
    status: 'draft',
    tickets: [],
    burnRate: 1,
    retryCap: 2,
    exhaustionRetryCap: 2,
    rateLimitRetryIntervalMs: 0,
    rateLimitMaxWaitMs: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    reviewDepth: 'single',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    prs: [],
    ...overrides,
  };
}

function renderControl(batch: FurnaceBatch, disabled: boolean) {
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(<TriggerControl batch={batch} allBatches={[batch]} disabled={disabled} onChanged={onChanged} />);
  return { onChanged };
}

describe('TriggerControl', () => {
  afterEach(() => {
    cleanup();
    mockedUpdateFurnaceBatch.mockClear();
  });

  it('non-draft + armed trigger: badge is clickable and popover shows only Clear + Cancel', () => {
    const batch = mkBatch({ status: 'burning', trigger: { type: 'pr', ref: '#123' } });
    renderControl(batch, true);

    const badge = screen.getByText(/after: #123/);
    expect(badge).toBeTruthy();
    fireEvent.click(badge);

    expect(screen.getByText('Clear')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.queryByText('Save')).toBeNull();
    expect(screen.queryByText('a batch')).toBeNull();
    expect(screen.queryByText('a PR')).toBeNull();
    expect(screen.queryByPlaceholderText('PR url or #123')).toBeNull();
  });

  it('clicking Clear calls updateFurnaceBatch(id, { trigger: null })', async () => {
    const batch = mkBatch({ status: 'burning', trigger: { type: 'pr', ref: '#123' } });
    renderControl(batch, true);

    fireEvent.click(screen.getByText(/after: #123/));
    fireEvent.click(screen.getByText('Clear'));

    await vi.waitFor(() => expect(mockedUpdateFurnaceBatch).toHaveBeenCalledWith('b1', { trigger: null }));
  });

  it('non-draft + no trigger: nothing rendered, no way to open a popover', () => {
    const batch = mkBatch({ status: 'burning', trigger: undefined });
    const { container } = render(
      <TriggerControl batch={batch} allBatches={[batch]} disabled={true} onChanged={vi.fn()} />,
    );

    expect(container.querySelector('[data-trigger-toggle]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('draft + trigger: full editor renders (regression guard)', () => {
    const batch = mkBatch({ status: 'draft', trigger: { type: 'pr', ref: '#123' } });
    renderControl(batch, false);

    fireEvent.click(screen.getByText(/after: #123/));

    expect(screen.getByText('a batch')).toBeTruthy();
    expect(screen.getByText('a PR')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.getByText('Clear')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });
});

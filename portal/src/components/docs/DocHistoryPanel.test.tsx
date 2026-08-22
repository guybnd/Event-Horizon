// @vitest-environment jsdom
// FLUX-1671 (AC4): revision rows previously showed the commit date only via a `title` hover
// tooltip -- no visible timestamp. Verify a relative time now renders next to the author, with
// the absolute date still available on hover.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DocHistoryPanel } from './DocHistoryPanel';

const { REVISION_DATE } = vi.hoisted(() => ({
  REVISION_DATE: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
}));

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchDocRevisions: vi.fn().mockResolvedValue([
      { hash: 'abc1234567', author: 'Guy', date: REVISION_DATE, message: 'Update doc' },
    ]),
  };
});

describe('DocHistoryPanel revision timestamp (FLUX-1671)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a visible relative timestamp next to the author, with the absolute date on hover', async () => {
    render(<DocHistoryPanel docPath="guide/overview" docs={[]} canRestore={false} onRestore={() => {}} />);

    const meta = await screen.findByTitle(REVISION_DATE);
    expect(meta.textContent).toContain('Guy');
    expect(meta.textContent).toContain('3h');
  });
});

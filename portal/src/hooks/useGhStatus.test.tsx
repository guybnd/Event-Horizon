// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, it, vi, expect } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useGhStatus } from './useGhStatus';
import * as api from '../api';

afterEach(cleanup);

function Harness() {
  const { gh, checking, recheck } = useGhStatus(true);
  return (
    <div>
      <span>state:{gh === null ? (checking ? 'checking' : 'unknown') : gh.ok ? 'ok' : 'bad'}</span>
      <button onClick={recheck}>Re-check</button>
    </div>
  );
}

describe('useGhStatus', () => {
  it('recheck() updates state after StrictMode double-mount (FLUX-1686 regression)', async () => {
    vi.spyOn(api, 'fetchGhStatus').mockResolvedValue({ ok: false, platform: 'linux', linuxPackageManager: null, lastCheckedAt: null });
    vi.spyOn(api, 'recheckGh').mockResolvedValue({ ok: true, platform: 'linux', linuxPackageManager: null, lastCheckedAt: 123 });

    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );

    await screen.findByText('state:bad');
    fireEvent.click(screen.getByText('Re-check'));
    await screen.findByText('state:ok');
  });

  it('never commits gh===null && settled===true across an enabled false -> true transition (FLUX-1693)', async () => {
    let resolveProbe: (result: api.GhRecheckResult) => void = () => {};
    vi.spyOn(api, 'fetchGhStatus').mockImplementation(
      () => new Promise((resolve) => { resolveProbe = resolve; }),
    );

    const commits: Array<{ enabled: boolean; gh: unknown; settled: boolean }> = [];
    function TransitionHarness({ enabled }: { enabled: boolean }) {
      const { gh, settled } = useGhStatus(enabled);
      // Record via useEffect, not inline in the render body: an effect only runs for a render
      // that actually commits, matching what a real consumer (BranchSection) observes — a render
      // discarded by React's "adjust state during render" bail-out never reaches this point.
      useEffect(() => { commits.push({ enabled, gh, settled }); });
      return null;
    }

    const { rerender } = render(<TransitionHarness enabled={false} />);
    rerender(<TransitionHarness enabled={true} />);

    // `enabled:false` commits legitimately have gh===null && settled===true (nothing to check).
    // The bug this test guards is that combination surviving into an `enabled:true` commit.
    const badWhileEnabled = () => commits.some((c) => c.enabled && c.gh === null && c.settled === true);
    expect(badWhileEnabled()).toBe(false);

    await act(async () => {
      resolveProbe({ ok: true, platform: 'linux', linuxPackageManager: null, lastCheckedAt: 1 });
      await Promise.resolve();
    });

    expect(badWhileEnabled()).toBe(false);
    expect(commits.at(-1)).toEqual({
      enabled: true,
      gh: { ok: true, platform: 'linux', linuxPackageManager: null, lastCheckedAt: 1 },
      settled: true,
    });
  });
});

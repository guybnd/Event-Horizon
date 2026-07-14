import { describe, it, expect, vi, beforeEach } from 'vitest';

// FLUX-1402: getGhAvailability() must distinguish "gh not on PATH" (spawn ENOENT — a *string*
// `.code`) from "gh present but `gh auth status` exited non-zero" (a *numeric* `.code`). Mock
// runGh directly so both error shapes are exercised deterministically, without a real `gh`.
const runGh = vi.fn();
vi.mock('./git-exec.js', () => ({ runGh: (...args: unknown[]) => runGh(...args) }));

import { getGhAvailability, checkGhAuth, ghUnavailableMessage } from './branch-manager.js';

describe('getGhAvailability (FLUX-1402)', () => {
  beforeEach(() => {
    runGh.mockReset();
  });

  it('resolves ok:true when `gh auth status` succeeds', async () => {
    runGh.mockResolvedValue({ stdout: '', stderr: '' });
    await expect(getGhAvailability()).resolves.toEqual({ ok: true });
  });

  it('maps a spawn ENOENT rejection (gh not on PATH) to reason "not-found"', async () => {
    const err = new Error('spawn gh ENOENT') as Error & { code?: string };
    err.code = 'ENOENT';
    runGh.mockRejectedValue(err);
    await expect(getGhAvailability()).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('maps a non-zero exit rejection (gh present but unauthenticated) to reason "not-authenticated"', async () => {
    const err = new Error('Command failed: gh auth status') as Error & { code?: number };
    err.code = 1;
    runGh.mockRejectedValue(err);
    await expect(getGhAvailability()).resolves.toEqual({ ok: false, reason: 'not-authenticated' });
  });

  it('checkGhAuth() still returns a plain boolean derived from availability', async () => {
    runGh.mockResolvedValue({ stdout: '', stderr: '' });
    await expect(checkGhAuth()).resolves.toBe(true);

    const err = new Error('Command failed: gh auth status') as Error & { code?: number };
    err.code = 1;
    runGh.mockRejectedValue(err);
    await expect(checkGhAuth()).resolves.toBe(false);
  });
});

describe('ghUnavailableMessage (FLUX-1402)', () => {
  it('gives an install/PATH remedy for "not-found"', () => {
    expect(ghUnavailableMessage('not-found')).toMatch(/PATH/);
    expect(ghUnavailableMessage('not-found')).not.toMatch(/authenticated/);
  });

  it('gives a `gh auth login` remedy for "not-authenticated"', () => {
    expect(ghUnavailableMessage('not-authenticated')).toMatch(/gh auth login/);
  });
});

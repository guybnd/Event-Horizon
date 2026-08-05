// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConflictResolutionModal } from './ConflictResolutionModal';
import type { ConflictInfo, ResetToRemoteResult } from '../api';

// FLUX-1643: the "discard all local & take remote" escape hatch in this modal now goes through
// forceResetToRemote(), which retains endangered local sidecar bytes outside the worktree before
// discarding them and reports their recovery path/count back through ResetToRemoteResult. This
// guards the portal half of that contract: the notice must render (with working copy/dismiss) when
// the engine reports a non-empty recovery, and the modal must close straight through when it
// reports nothing was endangered.
const { resetToRemote } = vi.hoisted(() => ({ resetToRemote: vi.fn<() => Promise<ResetToRemoteResult>>() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    resetToRemote,
  };
});

const CONFLICTS: ConflictInfo[] = [
  { ticketId: 'FLUX-1', localContent: '---\nid: FLUX-1\n---\nlocal', remoteContent: '---\nid: FLUX-1\n---\nremote' },
];

async function discardAllViaEscapeHatch(onClose: () => void) {
  render(<ConflictResolutionModal conflicts={CONFLICTS} onResolve={vi.fn()} onClose={onClose} />);

  fireEvent.click(screen.getByRole('button', { name: /Discard all local & take remote/ }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard everything' }));
  });
}

describe('ConflictResolutionModal discard-all recovery notice (FLUX-1643)', () => {
  beforeEach(() => {
    resetToRemote.mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a dismissible, copyable notice when the reset retained sidecar versions', async () => {
    resetToRemote.mockResolvedValue({
      ok: true, backupRef: 'refs/flux-backup/aaa', oldHead: 'aaa', newHead: 'bbb', changedFiles: [],
      recoveryPath: '/tmp/.flux-recovery-xyz789', recoveryCount: 2,
    });
    const onClose = vi.fn();

    await discardAllViaEscapeHatch(onClose);

    expect(await screen.findByText(/Sidecar recovery:/)).toBeTruthy();
    expect(screen.getByText('/tmp/.flux-recovery-xyz789')).toBeTruthy();
    // Retaining a recovery keeps the modal open — the user must see the path before it's gone.
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/.flux-recovery-xyz789');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes straight through when the reset had nothing endangered to retain', async () => {
    resetToRemote.mockResolvedValue({
      ok: true, backupRef: 'refs/flux-backup/aaa', oldHead: 'aaa', newHead: 'bbb', changedFiles: [], recoveryPath: null, recoveryCount: 0,
    });
    const onClose = vi.fn();

    await discardAllViaEscapeHatch(onClose);

    expect(screen.queryByText(/Sidecar recovery:/)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

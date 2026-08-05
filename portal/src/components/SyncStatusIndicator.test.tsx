// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SyncStatusIndicator } from './SyncStatusIndicator';
import type { ResetToRemoteResult } from '../api';

// FLUX-1643: forceResetToRemote() now retains endangered local sidecar bytes outside the
// worktree before discarding them, and reports their recovery path/count back through
// ResetToRemoteResult. This guards the portal half of that contract — the dismissible,
// copyable recovery notice must actually render (and clear) when the engine reports a
// non-empty recovery, and must stay silent when there was nothing to retain.
// vi.mock factories are hoisted above imports, so the mock fn itself must be created via
// vi.hoisted rather than a plain top-level const (which would be a use-before-init otherwise).
const { resetToRemote } = vi.hoisted(() => ({ resetToRemote: vi.fn<() => Promise<ResetToRemoteResult>>() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    resetToRemote,
  };
});

// jsdom has no EventSource implementation; SyncStatusIndicator opens one unconditionally once
// its initial `/sync-status` fetch succeeds. This stand-in is enough for the SSE connect() call
// to not throw — the tests below drive state through the initial fetch response, not SSE pushes.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = FakeEventSource.CLOSED; }
}

function mockSyncStatusFetch(status: unknown) {
  vi.spyOn(window, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => status,
  } as Response);
}

describe('SyncStatusIndicator recovery notice (FLUX-1643)', () => {
  beforeEach(() => {
    resetToRemote.mockReset();
    // @ts-expect-error FakeEventSource covers only what connect() touches
    window.EventSource = FakeEventSource;
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function resetToRemoteViaDivergedPanel() {
    render(<SyncStatusIndicator />);
    await screen.findByText('Diverged');

    fireEvent.click(screen.getByRole('button', { name: /Sync status: local board diverged/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Reset board to remote/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yes, discard local & reset to remote/ }));
    });
  }

  it('shows a dismissible, copyable notice when the reset retained sidecar versions', async () => {
    mockSyncStatusFetch({ state: 'diverged', ahead: 1, behind: 2 });
    resetToRemote.mockResolvedValue({
      ok: true, backupRef: 'refs/flux-backup/aaa', oldHead: 'aaa', newHead: 'bbb', changedFiles: [],
      recoveryPath: '/tmp/.flux-recovery-abc123', recoveryCount: 3,
    });

    await resetToRemoteViaDivergedPanel();

    expect(await screen.findByText(/Local sidecars were saved before reset/)).toBeTruthy();
    expect(screen.getByText(/3 version references/)).toBeTruthy();
    expect(screen.getByText('/tmp/.flux-recovery-abc123')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/.flux-recovery-abc123');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Local sidecars were saved before reset/)).toBeNull();
  });

  it('stays silent when the reset had nothing endangered to retain', async () => {
    mockSyncStatusFetch({ state: 'diverged', ahead: 1, behind: 2 });
    resetToRemote.mockResolvedValue({
      ok: true, backupRef: 'refs/flux-backup/aaa', oldHead: 'aaa', newHead: 'bbb', changedFiles: [], recoveryPath: null, recoveryCount: 0,
    });

    await resetToRemoteViaDivergedPanel();

    expect(screen.queryByText(/Local sidecars were saved before reset/)).toBeNull();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { WorktreesPanel } from './WorktreesPanel';
import { AppActionsContext } from '../../store/useAppSelector';
import type { AppActions } from '../../store/appStore';
import type { WorktreeInfo } from '../../api';

// FLUX-1259: follow-up from PR #427 (FLUX-1254) — handleDetach calls refreshWorktrees()
// after a successful detach so the global worktree state (badges elsewhere in the portal)
// clears without a manual reload, matching useTaskCardController/useTicketActions/
// MetadataPanel. Nothing previously asserted that call actually happens.
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    fetchWorktrees: vi.fn().mockResolvedValue([
      {
        path: '/repo/.eh-worktrees/repo-FLUX-1',
        branch: 'flux/FLUX-1-sample',
        ticketId: 'FLUX-1',
        ticketTitle: 'Sample ticket',
      } satisfies WorktreeInfo,
    ]),
    detachWorktree: vi.fn().mockResolvedValue({ outcome: 'clean', message: 'Detached.' }),
  };
});

import { detachWorktree } from '../../api';

function renderPanel(actions: Partial<AppActions>) {
  return render(
    <AppActionsContext.Provider value={actions as AppActions}>
      <WorktreesPanel />
    </AppActionsContext.Provider>,
  );
}

describe('WorktreesPanel handleDetach (FLUX-1259)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('calls refreshWorktrees() after a successful detach', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const refreshWorktrees = vi.fn();
    renderPanel({ refreshWorktrees });

    const detachButton = await screen.findByRole('button', { name: /detach/i });
    await act(async () => {
      detachButton.click();
    });

    await waitFor(() => expect(detachWorktree).toHaveBeenCalledWith('FLUX-1'));
    await waitFor(() => expect(refreshWorktrees).toHaveBeenCalledTimes(1));
  });

  it('does not call refreshWorktrees() when the confirm dialog is dismissed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const refreshWorktrees = vi.fn();
    renderPanel({ refreshWorktrees });

    const detachButton = await screen.findByRole('button', { name: /detach/i });
    await act(async () => {
      detachButton.click();
    });

    expect(detachWorktree).not.toHaveBeenCalled();
    expect(refreshWorktrees).not.toHaveBeenCalled();
  });
});

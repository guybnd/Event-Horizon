// @vitest-environment jsdom
// FLUX-1592: covers the create-surface trim — Assignee demoted into a collapsed "Advanced" group
// and Implementation Link hidden when `isNew`, while Effort Override stays inline (per the mockup
// annotation) and the existing-ticket render (`isNew` false/omitted) is unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MetadataPanel } from './MetadataPanel';
import { AppActionsContext } from '../../store/useAppSelector';
import { ConfirmProvider } from '../../hooks/useConfirm';
import type { AppActions } from '../../store/appStore';

afterEach(() => cleanup());

function renderPanel(props: Partial<React.ComponentProps<typeof MetadataPanel>> = {}) {
  const actions = { triggerRefresh: vi.fn(), refreshWorktrees: vi.fn() } as unknown as AppActions;
  return render(
    <AppActionsContext.Provider value={actions}>
      <ConfirmProvider>
        <MetadataPanel
          status="Grooming" setStatus={vi.fn()}
          assignee="unassigned" setAssignee={vi.fn()}
          priority="None" setPriority={vi.fn()}
          effort="None" setEffort={vi.fn()}
          effortLevel="" setEffortLevel={vi.fn()}
          implementationLink="" setImplementationLink={vi.fn()}
          tags={[]} setTags={vi.fn()}
          allStatuses={['Grooming', 'Todo']}
          allUsers={['alice']}
          allTags={[]}
          configTags={[]}
          availablePriorities={[{ name: 'None', color: 'text-gray-400' }]}
          {...props}
        />
      </ConfirmProvider>
    </AppActionsContext.Provider>,
  );
}

describe('MetadataPanel — popup variant', () => {
  it('shows Assignee inline and no Advanced group for an existing ticket', () => {
    renderPanel({ variant: 'popup', isNew: false });
    expect(screen.getByText('Assignee')).toBeTruthy();
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('demotes Assignee into a collapsed Advanced group for a new ticket', () => {
    renderPanel({ variant: 'popup', isNew: true });
    expect(screen.getByText('Advanced')).toBeTruthy();
    // Assignee still exists in the DOM (inside <details>), just not in the main row.
    expect(screen.getAllByText('Assignee')).toHaveLength(1);
  });
});

describe('MetadataPanel — full (sidebar) variant', () => {
  it('shows Assignee and Implementation Link inline for an existing ticket, no Advanced group', () => {
    renderPanel({ isNew: false });
    expect(screen.getByText('Assignee')).toBeTruthy();
    expect(screen.getByText('Implementation Link')).toBeTruthy();
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('hides Implementation Link and collapses Assignee for a new ticket, keeping Effort Override inline', () => {
    renderPanel({ isNew: true });
    expect(screen.queryByText('Implementation Link')).toBeNull();
    expect(screen.getByText('Advanced')).toBeTruthy();
    expect(screen.getByText('Effort Override')).toBeTruthy();
  });
});

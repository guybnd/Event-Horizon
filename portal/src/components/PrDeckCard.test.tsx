// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TaskCard } from './TaskCard';
import { DockProvider } from './DockProvider';
import { appStore } from '../store/appStore';
import { AppActionsContext } from '../store/useAppSelector';
import type { AppActions } from '../store/appStore';
import type { Config, Task } from '../types';

// FLUX-1322 (FLUX-1316 follow-up): a PR card renders each folded/unwound member as a full
// nested <TaskCard compact> (PrDeckCard.tsx's PrDeckSection -> TaskDeck). Because the member is
// nested INSIDE the PR card's own DOM, two review rounds were needed to nail down the bubbling
// fix — hovering/clicking the member's non-interactive body was racing/leaking into the parent
// PR's own hover popup and click-to-open handler. This guards useTaskCardController.tsx's
// handleMouseOverSurface and PrDeckCard.tsx's PrDeckSection click guard against regressing.

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    updateTask: vi.fn().mockResolvedValue({}),
    mergePr: vi.fn().mockResolvedValue({}),
    retryPr: vi.fn().mockResolvedValue({}),
    adoptPr: vi.fn().mockResolvedValue({}),
    sendTaskCliInput: vi.fn().mockResolvedValue({}),
    detachWorktree: vi.fn().mockResolvedValue({}),
  };
});

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

const CONFIG: Config = {
  columns: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' }],
  hiddenStatuses: [{ name: 'Require Input' }, { name: 'Archived' }],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: false,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  animationsEnabled: false,
  hoverPopupsEnabled: true,
  hoverPopupDelay: 0,
  boardCardOpenMode: 'popup',
};

// Two-line bodies: the always-visible card snippet only ever shows the FIRST line (c.snippet in
// useTaskCardController.tsx), so the second line is a marker that appears ONLY inside the
// hover popup (CardDescriptionPopup renders the full body) — avoiding ambiguous duplicate-text
// matches between a card's own snippet and its popup when both are present in the DOM at once.
const PR_TASK: Task = {
  id: 'FLUX-100',
  kind: 'pr',
  status: 'In Progress',
  title: 'PR ticket',
  body: 'PR own snippet line\n\nPR popup only marker',
  members: ['FLUX-101'],
};

const MEMBER_TASK: Task = {
  id: 'FLUX-101',
  status: 'Todo',
  title: 'Folded member ticket',
  body: 'Member own snippet line\n\nMember popup only marker',
};

function stubActions(overrides: Partial<AppActions> = {}): AppActions {
  return new Proxy({ ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string, unknown>)[prop as string] : vi.fn()),
  }) as AppActions;
}

function renderPrCard(actions: AppActions) {
  appStore.patch({
    tasks: [PR_TASK, MEMBER_TASK],
    taskById: new Map([[PR_TASK.id, PR_TASK], [MEMBER_TASK.id, MEMBER_TASK]]),
    config: CONFIG,
    currentUser: 'tester',
    tasksLoading: false,
  });

  render(
    <AppActionsContext.Provider value={actions}>
      <DockProvider>
        <TaskCard task={PR_TASK} />
      </DockProvider>
    </AppActionsContext.Provider>,
  );

  // FLUX-1503: a queued member (no live/actionable state) hides behind the deck's "N more…"
  // toggle — unwind it, then click the resulting collapsed `MemberLine` to expand it to the full
  // nested `TaskCard` this test's bubbling guard needs.
  fireEvent.click(screen.getByText('1 more ticket in this PR'));
  fireEvent.click(screen.getByText('Folded member ticket'));
}

describe('PR card nested-member bubbling (FLUX-1316/FLUX-1322 regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('hovering a nested member card cancels/hides the parent PR popup instead of racing it', async () => {
    renderPrCard(stubActions());

    // Pointer enters the PR card's own content first (its title) — starts the PR's own hover
    // timer, same as any ordinary (non-PR) card.
    const prTitle = screen.getByText('PR ticket');
    fireEvent.mouseOver(prTitle);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('PR popup only marker')).toBeTruthy();

    // Pointer drifts onto the nested member's non-interactive body (its description snippet)
    // WITHOUT ever leaving the PR card's outer box (relatedTarget stays inside it) — this is
    // exactly the case plain onMouseEnter/onMouseLeave can't detect on their own.
    // handleMouseOverSurface's bubbling onMouseOver must cancel/hide the PR's own popup
    // immediately, regardless of the nested member's own hover timer.
    const memberSnippet = screen.getByText('Member own snippet line');
    fireEvent.mouseOver(memberSnippet, { relatedTarget: prTitle });

    // The popup unmounts via a framer-motion AnimatePresence exit transition (150ms), not
    // instantly — advance past it before asserting the node is actually gone.
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.queryByText('PR popup only marker')).toBeNull();
  });

  it('clicking a nested member card opens only the member, not the parent PR', () => {
    const openTaskModal = vi.fn();
    renderPrCard(stubActions({ openTaskModal }));

    fireEvent.click(screen.getByText('Member own snippet line'));

    expect(openTaskModal).toHaveBeenCalledTimes(1);
    expect(openTaskModal).toHaveBeenCalledWith(expect.objectContaining({ id: MEMBER_TASK.id }));
  });
});

// FLUX-1713 review (Major 2): ciRunnerChip's four branches (absent/unknown, hosted, self-hosted,
// mixed) had zero test coverage — this exercises each via the real PrDeckCard render, not a unit
// test of the (unexported) chip function.
describe('CI runner chip (FLUX-1713)', () => {
  afterEach(() => cleanup());

  function renderWithRunner(ciRunner?: Task['ciRunner']) {
    const task: Task = { ...PR_TASK, members: [], ciRunner };
    appStore.patch({
      tasks: [task],
      taskById: new Map([[task.id, task]]),
      config: CONFIG,
      currentUser: 'tester',
      tasksLoading: false,
    });
    render(
      <AppActionsContext.Provider value={stubActions()}>
        <DockProvider>
          <TaskCard task={task} />
        </DockProvider>
      </AppActionsContext.Provider>,
    );
  }

  it('renders no runner chip when ciRunner is absent', () => {
    renderWithRunner(undefined);
    expect(screen.queryByText('Hosted')).toBeNull();
    expect(screen.queryByText('Self-hosted')).toBeNull();
    expect(screen.queryByText('Mixed')).toBeNull();
  });

  it('renders no runner chip when origin is unknown', () => {
    renderWithRunner({ origin: 'unknown', jobs: [] });
    expect(screen.queryByText('Hosted')).toBeNull();
    expect(screen.queryByText('Self-hosted')).toBeNull();
    expect(screen.queryByText('Mixed')).toBeNull();
  });

  it('renders the hosted chip', () => {
    renderWithRunner({ origin: 'hosted', jobs: [] });
    expect(screen.getByText('Hosted')).toBeTruthy();
  });

  it('renders the self-hosted chip with the runner name in the tooltip', () => {
    renderWithRunner({ origin: 'self-hosted', runnerName: 'guy-cachyos-x8664-linux', jobs: [] });
    const chip = screen.getByText('Self-hosted');
    expect(chip.closest('span')?.getAttribute('title')).toBe('Ran on self-hosted runner: guy-cachyos-x8664-linux');
  });

  it('falls back to a generic tooltip when a self-hosted chip has no runner name', () => {
    renderWithRunner({ origin: 'self-hosted', jobs: [] });
    const chip = screen.getByText('Self-hosted');
    expect(chip.closest('span')?.getAttribute('title')).toBe('Ran on a self-hosted runner');
  });

  it('renders the mixed chip with a per-job origin tooltip', () => {
    renderWithRunner({
      origin: 'mixed',
      jobs: [
        { name: 'check', origin: 'hosted', labels: [] },
        { name: 'lint', origin: 'self-hosted', labels: [] },
      ],
    });
    const chip = screen.getByText('Mixed');
    expect(chip.closest('span')?.getAttribute('title')).toBe('check: hosted, lint: self-hosted');
  });
});

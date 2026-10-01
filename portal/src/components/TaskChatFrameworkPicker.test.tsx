// @vitest-environment jsdom
// FLUX-1706: the task-chat CLI picker (ChatWindowHeader's compact FrameworkSelector) must (1)
// only ever offer the workspace's RUNTIME frameworks, (2) switch immediately when the chat is
// idle, (3) require confirmation and stop the live session first when a turn is active, (4) never
// apply the switch if that stop fails, and (5) never touch the workspace default. These tests
// drive the extracted `TaskChatFrameworkPicker` directly against a mocked `stopTaskCliSession`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TaskChatFrameworkPicker } from './TaskChatFrameworkPicker';
import { ConfirmProvider } from '../hooks/useConfirm';
import { appStore } from '../store/appStore';
import type { CliSessionSummary, Config } from '../types';

const { stopTaskCliSessionMock } = vi.hoisted(() => ({ stopTaskCliSessionMock: vi.fn() }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, stopTaskCliSession: stopTaskCliSessionMock };
});

const CONFIG: Config = {
  columns: [{ name: 'Todo' }],
  hiddenStatuses: [],
  users: [],
  tags: [],
  priorities: [],
  projects: [],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: false,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  animationsEnabled: false,
  // FLUX-907 split: only these two are launchable — cursor/cline/windsurf/etc are install-only.
  runtimeFrameworks: ['claude', 'codex'],
} as Config;

function activeSession(overrides: Partial<CliSessionSummary> = {}): CliSessionSummary {
  return {
    id: 'sess-1',
    taskId: 'FLUX-1706',
    framework: 'gemini',
    status: 'running',
    command: 'claude',
    args: [],
    startedAt: new Date(0).toISOString(),
    label: 'Claude Code',
    ...overrides,
  } as CliSessionSummary;
}

function renderPicker(props: Partial<Parameters<typeof TaskChatFrameworkPicker>[0]> = {}) {
  const onSelectionsChange = vi.fn();
  render(
    <ConfirmProvider>
      <TaskChatFrameworkPicker
        taskId="FLUX-1706"
        config={CONFIG}
        session={null}
        selections={undefined}
        onSelectionsChange={onSelectionsChange}
        defaultFramework="claude"
        {...props}
      />
    </ConfirmProvider>,
  );
  return { onSelectionsChange };
}

function openDropdown() {
  fireEvent.click(screen.getByRole('button'));
}

describe('TaskChatFrameworkPicker (FLUX-1706)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    appStore.patch({ config: undefined });
  });

  it('only lists the configured runtime frameworks, never install-only ones', () => {
    renderPicker();
    openDropdown();
    expect(screen.getByText('Codex CLI')).toBeTruthy();
    // 'Claude Code' appears twice (closed-button label + list option) once the list is open.
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(screen.queryByText('Cursor')).toBeNull();
    expect(screen.queryByText('Generic')).toBeNull();
    expect(screen.queryByText('Copilot CLI')).toBeNull();
  });

  it('switches immediately with no confirmation when the chat is idle', () => {
    const { onSelectionsChange } = renderPicker({ session: null });
    openDropdown();
    fireEvent.click(screen.getByText('Codex CLI'));
    expect(onSelectionsChange).toHaveBeenCalledWith(expect.objectContaining({ framework: 'codex' }));
    expect(stopTaskCliSessionMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires confirmation for an active session, and cancelling leaves the selection untouched', async () => {
    const { onSelectionsChange } = renderPicker({ session: activeSession({ status: 'running' }) });
    openDropdown();
    fireEvent.click(screen.getByText('Codex CLI'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(stopTaskCliSessionMock).not.toHaveBeenCalled();
    expect(onSelectionsChange).not.toHaveBeenCalled();
  });

  it('stops the active session before applying the switch on confirmation', async () => {
    stopTaskCliSessionMock.mockResolvedValueOnce(activeSession({ status: 'cancelled' }));
    const { onSelectionsChange } = renderPicker({ session: activeSession({ status: 'waiting-input' }) });
    openDropdown();
    fireEvent.click(screen.getByText('Codex CLI'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText(/stop.*switch/i));
    await waitFor(() => expect(onSelectionsChange).toHaveBeenCalledWith(expect.objectContaining({ framework: 'codex' })));
    expect(stopTaskCliSessionMock).toHaveBeenCalledWith('FLUX-1706');
    // Ordering: the stop call must land before the selection actually changes.
    const stopOrder = stopTaskCliSessionMock.mock.invocationCallOrder[0]!;
    const selectOrder = onSelectionsChange.mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(selectOrder);
  });

  it('leaves the displayed selection unchanged when the stop fails', async () => {
    stopTaskCliSessionMock.mockRejectedValueOnce(new Error('stop failed'));
    const { onSelectionsChange } = renderPicker({ session: activeSession({ status: 'pending' }) });
    openDropdown();
    fireEvent.click(screen.getByText('Codex CLI'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText(/stop.*switch/i));
    await waitFor(() => expect(stopTaskCliSessionMock).toHaveBeenCalled());
    expect(onSelectionsChange).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GateParkedBody } from './AttentionDock';
import { updateTask } from '../../api';
import type { Task } from '../../types';

// FLUX-1297: a Furnace/Temper-authored park (gate-parked) is a stalled auto-loop, not a question a
// human must answer — so it needs a real dismiss affordance, not just "open the ticket". This is the
// ONLY surface that can clear a Temper park at all: Temper's synthetic tickets never belong to a
// Furnace batch, so FurnaceDrawer's per-batch Dismiss can never reach them (see FurnaceDrawer.TicketRow
// tests for the batch-ticket-side half of this fix).

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, updateTask: vi.fn().mockResolvedValue({}) };
});

vi.mock('../../store/useAppSelector', () => ({
  useTaskById: () => mockTask,
  useAppSelector: () => 'Test User',
}));

const mockedUpdateTask = vi.mocked(updateTask);

let mockTask: Task | undefined;

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 'FLUX-1', status: 'In Progress', swimlane: 'require-input', ...overrides } as Task;
}

describe('GateParkedBody dismiss (FLUX-1297)', () => {
  afterEach(() => {
    cleanup();
    mockedUpdateTask.mockClear();
  });

  it('renders both Open to resolve and Dismiss', () => {
    mockTask = makeTask();
    render(<GateParkedBody ticketId="FLUX-1" onOpen={vi.fn()} />);
    expect(screen.getByText('Open to resolve')).toBeTruthy();
    expect(screen.getByText('Dismiss')).toBeTruthy();
  });

  it('Dismiss clears the swimlane via updateTask — no batch/Furnace state involved', async () => {
    mockTask = makeTask();
    render(<GateParkedBody ticketId="FLUX-1" onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('Dismiss'));
    await vi.waitFor(() => expect(mockedUpdateTask).toHaveBeenCalledWith('FLUX-1', { swimlane: null, updatedBy: 'Test User' }));
  });

  it('Open to resolve calls onOpen with the ticket id', () => {
    mockTask = makeTask();
    const onOpen = vi.fn();
    render(<GateParkedBody ticketId="FLUX-1" onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Open to resolve'));
    expect(onOpen).toHaveBeenCalledWith('FLUX-1');
  });
});

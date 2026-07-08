// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TicketRow } from './FurnaceDrawer';
import type { BatchTicket } from '../furnaceTypes';

// FLUX-1297: FurnaceDrawer's recovery-action gating used to hide Dismiss entirely for a human-owned
// row (`!isHuman && isParkedOrFailed`) — the exact case a taken-over, still-parked ticket hits, since
// `settleAsHumanOwned` sets `owner: 'human'` but leaves `state: 'parked'`. Dismiss must be reachable
// regardless of ownership; Retry/Takeover stay Furnace-only (they don't make sense once a human owns it).

vi.mock('../store/useAppSelector', () => ({
  useConfig: () => null,
  useTaskById: () => undefined,
}));

vi.mock('./TicketRefChip', () => ({
  TicketRefChip: ({ ticketId }: { ticketId: string | null }) => <span>{ticketId}</span>,
}));

vi.mock('../api', () => ({
  retryFurnaceTicket: vi.fn().mockResolvedValue({}),
  takeoverFurnaceTicket: vi.fn().mockResolvedValue({}),
  dismissFurnaceTicket: vi.fn().mockResolvedValue({}),
  handBackFurnaceTicket: vi.fn().mockResolvedValue({}),
}));

function mkTicket(overrides: Partial<BatchTicket> = {}): BatchTicket {
  return {
    ticketId: 'FLUX-1', order: 0, state: 'parked', attempts: 0, sessionIds: [], title: 'Test ticket',
    ...overrides,
  } as BatchTicket;
}

function renderRow(ticket: BatchTicket) {
  render(
    <TicketRow
      ticket={ticket}
      batchId="batch-1"
      batchStatus="burning"
      onChanged={vi.fn().mockResolvedValue(undefined)}
      onRemove={vi.fn()}
    />,
  );
}

describe('FurnaceDrawer TicketRow — recovery-action gating (FLUX-1297)', () => {
  afterEach(() => cleanup());

  it('a Furnace-owned parked row shows Retry, Take over, and Dismiss', () => {
    renderRow(mkTicket({ state: 'parked', failureClass: 'hard-fail' }));
    expect(screen.getByTitle('Retry — fresh attempt')).toBeTruthy();
    expect(screen.getByTitle('Take over — you drive it')).toBeTruthy();
    expect(screen.getByTitle("Dismiss flag — I've got this")).toBeTruthy();
  });

  it('a human-owned parked row (post-takeover) still shows Dismiss, not Retry/Take over', () => {
    renderRow(mkTicket({ state: 'parked', failureClass: 'hard-fail', owner: 'human' }));
    expect(screen.queryByTitle('Retry — fresh attempt')).toBeNull();
    expect(screen.queryByTitle('Take over — you drive it')).toBeNull();
    expect(screen.getByTitle('Hand back to the Furnace')).toBeTruthy();
    expect(screen.getByTitle("Dismiss flag — I've got this")).toBeTruthy();
  });

  it('an already-dismissed row hides Dismiss', () => {
    renderRow(mkTicket({ state: 'parked', owner: 'human', flagDismissed: true }));
    expect(screen.queryByTitle("Dismiss flag — I've got this")).toBeNull();
  });

  it('a non-parked, non-failed row shows no recovery actions', () => {
    renderRow(mkTicket({ state: 'implementing' }));
    expect(screen.queryByTitle('Retry — fresh attempt')).toBeNull();
    expect(screen.queryByTitle('Take over — you drive it')).toBeNull();
    expect(screen.queryByTitle("Dismiss flag — I've got this")).toBeNull();
  });
});

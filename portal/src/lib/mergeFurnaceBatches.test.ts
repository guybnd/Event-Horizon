import { describe, it, expect } from 'vitest';
import { mergeFurnaceBatches } from './mergeFurnaceBatches';
import type { FurnaceBatch, BatchTicket } from '../furnaceTypes';

function makeTicket(overrides: Partial<BatchTicket> = {}): BatchTicket {
  return {
    ticketId: 'FLUX-1',
    order: 0,
    state: 'queued',
    attempts: 0,
    sessionIds: [],
    ...overrides,
  };
}

function makeBatch(overrides: Partial<FurnaceBatch> = {}): FurnaceBatch {
  return {
    id: 'batch-1',
    title: 'A batch',
    kind: 'parallel',
    branch: 'furnace/batch-1',
    status: 'burning',
    tickets: [],
    burnRate: 2,
    retryCap: 2,
    exhaustionRetryCap: 2,
    rateLimitRetryIntervalMs: 1_200_000,
    rateLimitMaxWaitMs: 18_000_000,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    reviewDepth: 'single',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    prs: [],
    ...overrides,
  } as FurnaceBatch;
}

describe('mergeFurnaceBatches', () => {
  it('returns the previous array reference when nothing changed', () => {
    const prev = [makeBatch({ id: 'a' }), makeBatch({ id: 'b' })];
    // A fresh fetch always produces new object references, even when nothing changed.
    const next = prev.map((b) => ({ ...b }));
    expect(mergeFurnaceBatches(prev, next)).toBe(prev);
  });

  it('reuses the previous object for a batch whose updatedAt is unchanged', () => {
    const a = makeBatch({ id: 'a' });
    const b = makeBatch({ id: 'b' });
    const prev = [a, b];
    const nextB = { ...b, updatedAt: '2026-07-05T00:00:05.000Z' };
    const merged = mergeFurnaceBatches(prev, [{ ...a }, nextB]);
    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toBe(nextB);
  });

  it('drops a batch that no longer exists and picks up a new one', () => {
    const a = makeBatch({ id: 'a' });
    const prev = [a, makeBatch({ id: 'b' })];
    const c = makeBatch({ id: 'c' });
    const merged = mergeFurnaceBatches(prev, [{ ...a }, c]);
    expect(merged).toEqual([a, c]);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toBe(c);
  });

  it('detects a pure reorder even when no individual batch changed', () => {
    const a = makeBatch({ id: 'a' });
    const b = makeBatch({ id: 'b' });
    const prev = [a, b];
    const merged = mergeFurnaceBatches(prev, [{ ...b }, { ...a }]);
    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(b);
    expect(merged[1]).toBe(a);
  });

  // FLUX-1203: within a changed batch, only the ticket that actually changed gets a fresh reference.
  it('reuses unchanged ticket references when one ticket in a changed batch transitions', () => {
    const t1 = makeTicket({ ticketId: 'FLUX-1', state: 'queued' });
    const t2 = makeTicket({ ticketId: 'FLUX-2', state: 'implementing', sessionIds: ['s1'] });
    const prev = [makeBatch({ tickets: [t1, t2] })];
    // A fresh poll: the whole batch is structuredClone'd, so every ticket is a new object,
    // and only FLUX-2 actually transitioned (implementing -> reviewing).
    const next = [makeBatch({
      updatedAt: '2026-07-05T00:00:05.000Z',
      tickets: [{ ...t1, sessionIds: [...t1.sessionIds] }, { ...t2, state: 'reviewing', sessionIds: [...t2.sessionIds] }],
    })];
    const merged = mergeFurnaceBatches(prev, next);
    expect(merged).not.toBe(prev);
    expect(merged[0]).not.toBe(prev[0]);
    // Unchanged sibling keeps its old reference; the transitioned ticket does not.
    expect(merged[0].tickets[0]).toBe(t1);
    expect(merged[0].tickets[1]).not.toBe(t2);
    expect(merged[0].tickets[1].state).toBe('reviewing');
  });

  it('reuses the whole tickets array when only batch-level fields changed', () => {
    const t1 = makeTicket({ ticketId: 'FLUX-1' });
    const t2 = makeTicket({ ticketId: 'FLUX-2' });
    const original = makeBatch({ tickets: [t1, t2] });
    const prev = [original];
    // burnRate changed, but no ticket did — even though the poll cloned every ticket object.
    const next = [makeBatch({
      updatedAt: '2026-07-05T00:00:05.000Z',
      burnRate: 3,
      tickets: [{ ...t1, sessionIds: [...t1.sessionIds] }, { ...t2, sessionIds: [...t2.sessionIds] }],
    })];
    const merged = mergeFurnaceBatches(prev, next);
    expect(merged[0].burnRate).toBe(3);
    expect(merged[0].tickets).toBe(original.tickets);
  });

  it('picks up an added ticket while keeping existing ticket references', () => {
    const t1 = makeTicket({ ticketId: 'FLUX-1' });
    const original = makeBatch({ tickets: [t1] });
    const prev = [original];
    const t2 = makeTicket({ ticketId: 'FLUX-2' });
    const next = [makeBatch({
      updatedAt: '2026-07-05T00:00:05.000Z',
      tickets: [{ ...t1, sessionIds: [...t1.sessionIds] }, t2],
    })];
    const merged = mergeFurnaceBatches(prev, next);
    expect(merged[0].tickets).toHaveLength(2);
    expect(merged[0].tickets[0]).toBe(t1);
    expect(merged[0].tickets[1]).toBe(t2);
  });
});

import { describe, it, expect } from 'vitest';
import { mergeFurnaceBatches } from './mergeFurnaceBatches';
import type { FurnaceBatch } from '../furnaceTypes';

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
});

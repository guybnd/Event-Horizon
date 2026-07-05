import { describe, it, expect } from 'vitest';
import type { OperationEvent } from '../types';
import { mergeOperations } from './mergeOperations';

function op(overrides: Partial<OperationEvent> & { opId: string }): OperationEvent {
  return {
    kind: 'git',
    ticketId: undefined,
    sessionId: undefined,
    cmd: 'git status',
    startedAt: 0,
    endedAt: 0,
    durationMs: 1,
    outcome: 'ok',
    ...overrides,
  };
}

describe('mergeOperations', () => {
  it('returns an empty array when both sources are empty', () => {
    expect(mergeOperations([], [])).toEqual([]);
  });

  it('passes through a single source untouched (already-sorted case)', () => {
    const backfill = [op({ opId: 'a', endedAt: 1 }), op({ opId: 'b', endedAt: 2 })];
    expect(mergeOperations(backfill, [])).toEqual(backfill);
  });

  it('sorts the merged result by endedAt ascending regardless of input order', () => {
    // fetchRecentOperations returns newest-first; live events arrive in real-time order —
    // neither source is sorted the way the panel wants to render.
    const backfill = [op({ opId: 'c', endedAt: 30 }), op({ opId: 'a', endedAt: 10 })];
    const live = [op({ opId: 'b', endedAt: 20 })];
    expect(mergeOperations(backfill, live).map(o => o.opId)).toEqual(['a', 'b', 'c']);
  });

  it('dedupes an opId shared by backfill and live, keeping the backfill copy', () => {
    const backfill = [op({ opId: 'shared', endedAt: 5, cmd: 'from backfill' })];
    const live = [op({ opId: 'shared', endedAt: 5, cmd: 'from live' })];
    const merged = mergeOperations(backfill, live);
    expect(merged).toHaveLength(1);
    expect(merged[0].cmd).toBe('from backfill');
  });

  it('dedupes a repeated opId within backfill itself, keeping the oldest (first after reverse)', () => {
    // fetchRecentOperations is newest-first, so index 0 is the newer duplicate.
    const backfill = [
      op({ opId: 'dup', endedAt: 5, cmd: 'newer' }),
      op({ opId: 'dup', endedAt: 5, cmd: 'older' }),
    ];
    const merged = mergeOperations(backfill, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].cmd).toBe('older');
  });

  it('dedupes a repeated opId within live, keeping the first occurrence', () => {
    const live = [
      op({ opId: 'dup', endedAt: 5, cmd: 'first' }),
      op({ opId: 'dup', endedAt: 5, cmd: 'second' }),
    ];
    const merged = mergeOperations([], live);
    expect(merged).toHaveLength(1);
    expect(merged[0].cmd).toBe('first');
  });

  it('does not mutate the input arrays', () => {
    const backfill = [op({ opId: 'c', endedAt: 30 }), op({ opId: 'a', endedAt: 10 })];
    const live = [op({ opId: 'b', endedAt: 20 })];
    const backfillCopy = [...backfill];
    const liveCopy = [...live];
    mergeOperations(backfill, live);
    expect(backfill).toEqual(backfillCopy);
    expect(live).toEqual(liveCopy);
  });
});

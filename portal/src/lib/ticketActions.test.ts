import { describe, it, expect } from 'vitest';
import { applyOptimisticStatusChange } from './ticketActions';
import type { HistoryDigest } from '../types';

function makeDigest(overrides: Partial<HistoryDigest> = {}): HistoryDigest {
  return {
    length: 3,
    lastEntry: { date: '2026-06-18T00:00:00.000Z', type: 'comment' },
    lastActivityAt: '2026-06-18T00:00:00.000Z',
    enteredCurrentStatusAt: '2026-06-17T00:00:00.000Z',
    isSpeedDemon: false,
    statusChanges24h: [{ from: 'Todo', to: 'In Progress', date: '2026-06-18T00:00:00.000Z' }],
    comments: [{ id: 'c1', user: 'Guy', date: '2026-06-18T00:00:00.000Z' }],
    requireInput: null,
    ...overrides,
  };
}

describe('applyOptimisticStatusChange', () => {
  it('bumps length by 1 when there is no comment', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');
    expect(result.length).toBe(base.length + 1);
  });

  it('bumps length by 2 when a comment is included', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', 'Done, ship it', 'Guy');
    expect(result.length).toBe(base.length + 2);
  });

  it('treats a whitespace-only comment as no comment (bumps by 1)', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', '   ', 'Guy');
    expect(result.length).toBe(base.length + 1);
  });

  it('sets lastEntry, lastActivityAt, and enteredCurrentStatusAt to now', () => {
    const base = makeDigest();
    const before = Date.now();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');
    const after = Date.now();

    expect(result.lastEntry).toEqual({ date: result.lastActivityAt, type: 'status_change' });
    expect(result.enteredCurrentStatusAt).toBe(result.lastActivityAt);

    const stamped = new Date(result.lastActivityAt).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('appends a from/to/date entry to statusChanges24h without dropping prior entries', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');

    expect(result.statusChanges24h).toHaveLength(base.statusChanges24h.length + 1);
    expect(result.statusChanges24h[0]).toEqual(base.statusChanges24h[0]);
    const appended = result.statusChanges24h[result.statusChanges24h.length - 1];
    expect(appended.from).toBe('In Progress');
    expect(appended.to).toBe('Ready');
    expect(appended.date).toBe(result.lastActivityAt);
  });

  it('leaves comments and requireInput untouched', () => {
    const base = makeDigest();
    const result = applyOptimisticStatusChange(base, 'In Progress', 'Ready', undefined, 'Guy');
    expect(result.comments).toBe(base.comments);
    expect(result.requireInput).toBe(base.requireInput);
  });

  it('falls back to an empty digest when base is undefined', () => {
    const result = applyOptimisticStatusChange(undefined, 'Todo', 'In Progress', undefined, 'Guy');
    expect(result.length).toBe(1);
    expect(result.statusChanges24h).toEqual([{ from: 'Todo', to: 'In Progress', date: result.lastActivityAt }]);
    expect(result.comments).toEqual([]);
    expect(result.requireInput).toBeNull();
  });
});

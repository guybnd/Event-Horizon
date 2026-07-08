// FLUX-1308: unit coverage for reconcileNovelHistoryEntries — the identity-based replacement for
// the old `nextHistory.slice(existingHistory.length)` reconciliation in the PUT /:id route. A
// client submitting a full `history` array from a snapshot stale by N entries used to have its
// first N genuinely-novel entries silently dropped, because the slice point was computed from the
// SERVER's length against the CLIENT's (shorter) array. See engine/src/history.ts for the fix.

import { describe, it, expect } from 'vitest';
import { reconcileNovelHistoryEntries } from './history.js';

describe('reconcileNovelHistoryEntries (FLUX-1308)', () => {
  it('finds no novel entries when the client submits exactly the existing history', () => {
    const existing = [
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:00:00.000Z', comment: 'hi' },
    ];
    expect(reconcileNovelHistoryEntries(existing, existing)).toEqual([]);
  });

  it('detects a novel entry appended after the existing history (the common case)', () => {
    const existing = [
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:00:00.000Z', comment: 'hi' },
    ];
    const novelEntry = { type: 'comment', user: 'bob', date: '2026-07-08T00:01:00.000Z', comment: 'reply' };
    const next = [...existing, novelEntry];
    expect(reconcileNovelHistoryEntries(existing, next)).toEqual([novelEntry]);
  });

  it('a client snapshot stale by one entry no longer loses its first novel entry', () => {
    // Server has 3 entries; the client only ever saw the first 2 (its snapshot predates entry c-2).
    const existing = [
      { type: 'activity', id: 'a-1', user: 'Agent', date: '2026-07-08T00:00:00.000Z', comment: 'Created ticket.' },
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:01:00.000Z', comment: 'first' },
      { type: 'comment', id: 'c-2', user: 'bob', date: '2026-07-08T00:02:00.000Z', comment: 'second (client never saw this)' },
    ];
    const newA = { type: 'comment', user: 'carol', date: '2026-07-08T00:03:00.000Z', comment: 'new A' };
    const newB = { type: 'comment', user: 'dave', date: '2026-07-08T00:04:00.000Z', comment: 'new B' };
    // Client's rebuilt array: its stale 2-entry base + both of its own new entries (length 4,
    // one SHORTER than the server's 3 existing + would-be 2 novel = 5).
    const staleSubmission = [existing[0], existing[1], newA, newB];

    // Old behavior: nextHistory.slice(existingHistory.length=3) on a 4-length array only
    // returns [newB] — newA is silently dropped. The fix must return BOTH.
    const novel = reconcileNovelHistoryEntries(existing, staleSubmission);
    expect(novel).toEqual([newA, newB]);
  });

  it('keeps an existing entry the client omitted entirely — never deleted by omission', () => {
    const existing = [
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:00:00.000Z', comment: 'keep me' },
      { type: 'comment', id: 'c-2', user: 'bob', date: '2026-07-08T00:01:00.000Z', comment: 'also keep me' },
    ];
    // Client's array omits c-1 (e.g. a stale fetch that raced a compaction) but still adds a new entry.
    const newEntry = { type: 'comment', user: 'carol', date: '2026-07-08T00:02:00.000Z', comment: 'new' };
    const submission = [existing[1], newEntry];
    expect(reconcileNovelHistoryEntries(existing, submission)).toEqual([newEntry]);
    // The route layer is responsible for re-prepending `existing` — this helper only reports what's
    // novel — but the key guarantee this test pins is that c-1 is NOT reported as novel/duplicated.
  });

  it('matches id-less entries (status_change, swimlane_change) by content signature, independent of key order', () => {
    const existing = [
      { type: 'status_change', from: 'Todo', to: 'In Progress', user: 'alice', date: '2026-07-08T00:00:00.000Z' },
    ];
    // Same entry, re-serialized with keys in a different order (as a round-tripped client copy might be).
    const sameEntryReordered = { date: '2026-07-08T00:00:00.000Z', to: 'In Progress', from: 'Todo', user: 'alice', type: 'status_change' };
    expect(reconcileNovelHistoryEntries(existing, [sameEntryReordered])).toEqual([]);
  });

  it('treats a genuinely different id-less entry as novel even when same type/user/date', () => {
    const existing = [
      { type: 'status_change', from: 'Todo', to: 'In Progress', user: 'alice', date: '2026-07-08T00:00:00.000Z' },
    ];
    const differentTransition = { type: 'status_change', from: 'In Progress', to: 'Ready', user: 'alice', date: '2026-07-08T00:00:00.000Z' };
    expect(reconcileNovelHistoryEntries(existing, [differentTransition])).toEqual([differentTransition]);
  });

  it('tolerates malformed non-object entries by passing them through as novel', () => {
    const existing: unknown[] = [];
    const submission = [null, 'not-an-object', 42];
    expect(reconcileNovelHistoryEntries(existing, submission)).toEqual(submission);
  });
});

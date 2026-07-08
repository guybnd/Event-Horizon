// FLUX-1311: unit coverage for hasAppendedStatusChange's switch from exact-prefix matching to
// reconcileNovelHistoryEntries' identity-based reconciliation. The old `historyPrefixMatches`
// required the submitted `nextHistory` to start with EXACTLY `existingHistory`'s entries; a stale
// full-history writer whose submission already contained its own status_change entry would fail
// that check and cause the caller (PUT /:id) to append a second, duplicate status_change. See
// engine/src/history.ts for the fix.

import { describe, it, expect } from 'vitest';
import { hasAppendedStatusChange } from './history.js';

describe('hasAppendedStatusChange (FLUX-1311)', () => {
  it('finds the status_change even when the submission is a stale full history that no longer prefix-matches', () => {
    const existing = [
      { type: 'activity', id: 'a-1', user: 'Agent', date: '2026-07-08T00:00:00.000Z', comment: 'Created ticket.' },
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:01:00.000Z', comment: 'first' },
    ];
    // A stale writer's full-history submission: its snapshot already has the status_change baked
    // in, but it diverges from `existing` at index 0 (different comment id), so the old exact
    // prefix check would fail even though the status_change itself is genuinely present.
    const staleSubmission = [
      { type: 'activity', id: 'a-1', user: 'Agent', date: '2026-07-08T00:00:00.000Z', comment: 'Created ticket. (stale copy)' },
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:01:00.000Z', comment: 'first' },
      { type: 'status_change', from: 'Todo', to: 'In Progress', user: 'alice', date: '2026-07-08T00:02:00.000Z' },
    ];
    expect(hasAppendedStatusChange(existing, staleSubmission, 'Todo', 'In Progress')).toBe(true);
  });

  it('returns false when no matching status_change is present anywhere in nextHistory', () => {
    const existing = [
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:01:00.000Z', comment: 'first' },
    ];
    const next = [...existing, { type: 'comment', user: 'bob', date: '2026-07-08T00:02:00.000Z', comment: 'reply' }];
    expect(hasAppendedStatusChange(existing, next, 'Todo', 'In Progress')).toBe(false);
  });

  it('returns false without a from/to pair regardless of history contents', () => {
    const existing: unknown[] = [];
    const next = [{ type: 'status_change', from: 'Todo', to: 'In Progress', user: 'alice', date: '2026-07-08T00:00:00.000Z' }];
    expect(hasAppendedStatusChange(existing, next, undefined, 'In Progress')).toBe(false);
    expect(hasAppendedStatusChange(existing, next, 'Todo', undefined)).toBe(false);
  });

  it('still detects the common case: status_change appended after an exactly-matching prefix', () => {
    const existing = [
      { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:01:00.000Z', comment: 'first' },
    ];
    const next = [...existing, { type: 'status_change', from: 'Todo', to: 'In Progress', user: 'alice', date: '2026-07-08T00:02:00.000Z' }];
    expect(hasAppendedStatusChange(existing, next, 'Todo', 'In Progress')).toBe(true);
  });
});

// FLUX-1739: the reclaim guard that keeps a finished benchmark run's worktree alive while its
// evidence is being collected.
//
// The failure this prevents is silent and score-corrupting: a run reaches Ready, its session ends,
// and it becomes reclaimable by every existing rule — during exactly the window in which the runner
// reads its diff, restores held-out paths, runs validation and extracts friction. Delete the tree
// there and a genuinely solved run scores `unsolved` or empty-diff, with nothing in the record to
// say why.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  beginCollection,
  endCollection,
  isCollecting,
  listCollecting,
  refreshCollection,
  resetCollectionGuard,
} from './benchmark-collection-guard.js';

beforeEach(() => resetCollectionGuard());
afterEach(() => vi.useRealTimers());

describe('collection window', () => {
  it('protects a ticket between begin and end', () => {
    expect(isCollecting('BENCH-1')).toBe(false);
    beginCollection('BENCH-1');
    expect(isCollecting('BENCH-1')).toBe(true);
    endCollection('BENCH-1');
    expect(isCollecting('BENCH-1')).toBe(false);
  });

  it('scopes protection to the ticket that opened it', () => {
    beginCollection('BENCH-1');
    expect(isCollecting('BENCH-2')).toBe(false);
  });

  it('is idempotent — a second begin refreshes rather than duplicating', () => {
    beginCollection('BENCH-1');
    beginCollection('BENCH-1');
    expect(listCollecting()).toEqual(['BENCH-1']);
  });

  it('tolerates endCollection on a ticket that never began', () => {
    expect(() => endCollection('NOPE-1')).not.toThrow();
  });

  it('ignores an empty ticket id rather than protecting everything', () => {
    beginCollection('');
    expect(listCollecting()).toEqual([]);
  });
});

describe('TTL — a crashed runner must not protect a slot forever', () => {
  it('expires the window once the TTL lapses', () => {
    vi.useFakeTimers();
    beginCollection('BENCH-1', 1000);
    expect(isCollecting('BENCH-1')).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(isCollecting('BENCH-1')).toBe(false);
  });

  it('evicts the expired entry rather than leaking it', () => {
    vi.useFakeTimers();
    beginCollection('BENCH-1', 1000);
    vi.advanceTimersByTime(1001);
    isCollecting('BENCH-1');
    expect(listCollecting()).toEqual([]);
  });

  it('refresh extends a live window — a long but healthy run is never evicted mid-flight', () => {
    vi.useFakeTimers();
    beginCollection('BENCH-1', 1000);
    vi.advanceTimersByTime(900);
    refreshCollection('BENCH-1', 1000);
    vi.advanceTimersByTime(500);
    expect(isCollecting('BENCH-1')).toBe(true);
  });

  it('refresh does NOT resurrect a window that already closed', () => {
    vi.useFakeTimers();
    beginCollection('BENCH-1', 1000);
    endCollection('BENCH-1');
    refreshCollection('BENCH-1', 1000);
    expect(isCollecting('BENCH-1')).toBe(false);
  });
});

describe('module shape', () => {
  it('imports nothing — pr-cleanup.ts queries this module, so an import here could cycle back through task-store', async () => {
    // Asserted on the source rather than by construction: the constraint is the whole reason this
    // module exists separately, and a future edit adding a convenience import would silently
    // reintroduce the cycle `background-process-holds.ts` documents in its own header.
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'benchmark-collection-guard.ts'), 'utf-8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});

// FLUX-1185: stale-while-revalidate memo for the hot-poll endpoints (`/api/tasks/worktrees`,
// `/api/tasks/uncommitted-count`). FLUX-1126's `memoAsync` deduped concurrent callers within a 4s TTL
// window but was expire-then-recompute-inline: any call landing after expiry blocked on the full
// compute — and since the portal polls these every 30s against a 4s TTL, that was EVERY poll. These
// tests exercise `swrAsync` directly (not the HTTP routes) with fake timers and a hand-controlled
// `compute` so background-refresh timing is deterministic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from '../workspace.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('swrAsync — stale-while-revalidate memo (FLUX-1185)', () => {
  let swrAsync: <T>(ttlMs: number, compute: () => Promise<T>) => () => Promise<T>;
  // Fake "now" is shared module-level-ish state across a suite's lifetime in the real routes, but each
  // `swrAsync(...)` call here builds a fresh closure, so a shared fake-time epoch across tests is fine.

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-swr-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    ({ swrAsync } = await import('./tasks.js'));
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks the very first call — there is no stale value yet to serve', async () => {
    const compute = vi.fn(async () => 'v1');
    const get = swrAsync(1000, compute);
    await expect(get()).resolves.toBe('v1');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('serves the cached value without recomputing while within the TTL', async () => {
    const compute = vi.fn(async () => 'v1');
    const get = swrAsync(1000, compute);
    await get();

    await vi.advanceTimersByTimeAsync(500);
    await expect(get()).resolves.toBe('v1');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('serves the stale value INSTANTLY once past the TTL, refreshing in the background', async () => {
    const gate = deferred<string>();
    let calls = 0;
    const compute = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve('v1') : gate.promise;
    });
    const get = swrAsync(1000, compute);
    await expect(get()).resolves.toBe('v1');

    await vi.advanceTimersByTimeAsync(1100); // past the TTL
    // This call must resolve with the STALE value right away, even though the background
    // recompute (gated on `gate`) hasn't settled yet — that's the whole point of SWR.
    await expect(get()).resolves.toBe('v1');
    expect(calls).toBe(2);

    // A further call while the background refresh is still in flight must not kick a second one.
    await expect(get()).resolves.toBe('v1');
    expect(calls).toBe(2);

    gate.resolve('v2');
    await gate.promise;
    await Promise.resolve();
    await Promise.resolve();

    await expect(get()).resolves.toBe('v2');
  });

  it('single-flights concurrent calls that land past the TTL', async () => {
    let calls = 0;
    const compute = vi.fn(async () => { calls += 1; return `v${calls}`; });
    const get = swrAsync(1000, compute);
    await get();
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1100);
    // Neither call awaits before the other starts, so both land while the background refresh
    // triggered by the first is still in flight.
    const p1 = get();
    const p2 = get();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('v1'); // both still see the stale value synchronously
    expect(r2).toBe('v1');
    expect(calls).toBe(2); // exactly one background recompute, not two
  });

  it('keeps the stale value when a background refresh fails, and retries on the next stale trigger', async () => {
    let calls = 0;
    const compute = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return `v${calls}`;
    });
    const get = swrAsync(1000, compute);
    await expect(get()).resolves.toBe('v1');

    await vi.advanceTimersByTimeAsync(1100);
    await expect(get()).resolves.toBe('v1'); // stale served instantly; background refresh #2 will reject
    expect(calls).toBe(2);
    // Let the rejected background refresh settle without it surfacing anywhere.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // A failed refresh must NOT be cached as fresh — the value is still exactly as stale as before,
    // so the very next call retries immediately rather than going quiet for the rest of what would
    // have been the TTL window (mirrors the furnace reconcile-cache gate's failure semantics, FLUX-1145).
    // It still serves the old value synchronously while call #3 (which succeeds) runs in the background.
    await expect(get()).resolves.toBe('v1');
    expect(calls).toBe(3);
    await Promise.resolve();
    await Promise.resolve();

    // Once a refresh actually succeeds, the fresh value is served and the TTL gate resumes normally.
    await expect(get()).resolves.toBe('v3');
    expect(calls).toBe(3);
  });

  it('propagates a rejection from the very first call directly (nothing stale to fall back to)', async () => {
    const compute = vi.fn(async () => { throw new Error('first call failed'); });
    const get = swrAsync(1000, compute);
    await expect(get()).rejects.toThrow('first call failed');
    expect(compute).toHaveBeenCalledTimes(1);
    // Flush the internal `.then(...).finally(...)` cleanup (clears the in-flight guard) before
    // the next call — otherwise it could race and observe the just-rejected promise as still in flight.
    await Promise.resolve();
    await Promise.resolve();

    // A retry after the failure must attempt a fresh compute — no stale value was ever cached.
    await expect(get()).rejects.toThrow('first call failed');
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

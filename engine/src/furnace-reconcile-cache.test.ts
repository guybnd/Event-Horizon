// The Furnace — reconcile-on-read TTL + single-flight gating (FLUX-1145).
//
// GET /api/furnace and furnace_get used to run reconcileBatch for EVERY batch on EVERY read — the portal
// polls the route every ~3s (FurnaceDrawer.tsx POLL_MS), measured at 1.1s avg / 3.4s worst-case in
// production. `reconcileBatch` calls `getActiveSessionsForTask` once per non-active ticket it visits on
// EVERY pass, whether or not anything actually changed (FLUX-1066), so mocking that import gives an
// observable count of how many real reconcile passes ran — this proves the TTL/single-flight gate without
// needing to spy on `reconcileBatch` itself (a same-module internal call `vi.mock` can't intercept).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';

const getActiveSessionsForTask = vi.fn((_ticketId: string) => []);
vi.mock('./session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-store.js')>();
  return { ...actual, getActiveSessionsForTask: (ticketId: string) => getActiveSessionsForTask(ticketId) };
});

import { createFurnaceBatch, mutateFurnaceBatch, __resetFurnaceStoreForTests } from './furnace-store.js';
import { newBatchTicket } from './models/furnace.js';
import { tasksCache } from './task-store.js';
import { reconcileBatch, reconcileBatchCached, reconcileAllBatchesCached, evictReconcileReadCache } from './furnace-stoker.js';

describe('Furnace reconcile-on-read TTL + single-flight (FLUX-1145)', () => {
  let root: string;
  // Module-level TTL state outlives a single test, so each test starts on its own fake-time epoch, far
  // enough apart that the freshness window from a prior test can never bleed into the next one.
  let epoch = 0;

  async function makeBatch(ticketId: string): Promise<string> {
    const batch = await createFurnaceBatch({ title: 'test', tickets: [newBatchTicket(ticketId, 0, ticketId)] });
    // reconcileBatch no-ops on a draft batch — park it so the reconcile loop actually visits its tickets.
    await mutateFurnaceBatch(batch.id, (b) => { b.status = 'parked'; });
    tasksCache[ticketId] = { status: 'In Progress', title: ticketId };
    return batch.id;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-reconcile-cache-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    getActiveSessionsForTask.mockClear();
    vi.useFakeTimers();
    epoch += 10_000_000;
    vi.setSystemTime(epoch);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the cache within the TTL and reconciles again once it elapses (reconcileAllBatchesCached)', async () => {
    await makeBatch('R-1');

    await reconcileAllBatchesCached();
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    await reconcileAllBatchesCached(); // immediately after — still fresh, no rerun
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_100);
    await reconcileAllBatchesCached();
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);
  });

  it('gates a single batch the same way (reconcileBatchCached)', async () => {
    const id = await makeBatch('R-2');

    await reconcileBatchCached(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    await reconcileBatchCached(id); // immediately after — still fresh, no rerun
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_100);
    await reconcileBatchCached(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);
  });

  it('keys the per-batch cache independently, so one batch never starves another', async () => {
    const a = await makeBatch('R-3a');
    const b = await makeBatch('R-3b');

    await reconcileBatchCached(a);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    await reconcileBatchCached(b); // a different batch id — must still run despite `a`'s fresh TTL
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent polls past an expired TTL instead of double-reconciling', async () => {
    await makeBatch('R-4');

    // Neither call awaits before the other starts, so both land while the first is still in flight.
    const p1 = reconcileAllBatchesCached();
    const p2 = reconcileAllBatchesCached();
    await Promise.all([p1, p2]);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);
  });

  it('does not mask a failed reconcile as fresh for the rest of the TTL window', async () => {
    const id = await makeBatch('R-6');

    getActiveSessionsForTask.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(reconcileBatchCached(id)).rejects.toThrow('boom');
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    // Immediately after the failure, within what would have been the TTL window — must NOT be treated
    // as a completed pass; the next call has to actually attempt a reconcile again rather than silently
    // no-op for the rest of the window (FLUX-1145 review fix).
    await reconcileBatchCached(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);

    // And now that a call has actually succeeded, the TTL gate resumes normal behavior.
    await reconcileBatchCached(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);
  });

  it('evicting a deleted batch id forces the next read to reconcile instead of serving a stale fresh-TTL skip (FLUX-1166)', async () => {
    const id = await makeBatch('R-7');

    await reconcileBatchCached(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(1);

    // Simulate the batch being deleted and its id later reused — without eviction this would still be
    // "fresh" and skip the reconcile below, even for what is really a brand-new batch entry.
    evictReconcileReadCache(id);
    await reconcileBatchCached(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);
  });

  it('never TTL-gates the raw reconcileBatch the drive-cycle tick relies on', async () => {
    const id = await makeBatch('R-5');

    // stokerTick/driveBurningBatches call reconcileBatch directly, every tick — it must keep observing
    // ground truth on every call regardless of how recently a READ path's cache was refreshed.
    await reconcileBatch(id);
    await reconcileBatch(id);
    expect(getActiveSessionsForTask).toHaveBeenCalledTimes(2);
  });
});

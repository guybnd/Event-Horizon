// The Furnace — store persistence + patch semantics (FLUX-1053 batch redesign).
//
// FLUX-1057: the batch-redesign consolidation (furnace-batch.test.ts) only covers the pure model; no
// test exercises the store's real read-modify-write I/O. This locks:
//   - a batch round-trips through the on-disk sidecar (create -> reload-from-disk).
//   - `updateFurnaceBatch`'s title-rename branch recompute (FLUX-1062 #3): a draft rename recomputes
//     `branch`; a burning/terminal rename changes only the display title; an explicit `patch.branch`
//     on a draft still wins over the title-derived recompute (ordering).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import {
  createFurnaceBatch,
  updateFurnaceBatch,
  getFurnaceBatch,
  getFurnaceDir,
  loadFurnaceBatches,
  globalSlotsInUse,
  setObservedWorktrees,
  mutateFurnaceBatch,
  __resetFurnaceStoreForTests,
} from './furnace-store.js';
import { batchBranchName, newBatchTicket } from './models/furnace.js';

describe('furnace-store persistence + rename-recompute (FLUX-1057)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-store-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('creates a batch, writes a sidecar under furnace-batches/, and round-trips from disk', async () => {
    const batch = await createFurnaceBatch({ title: 'Nightly sweep' });
    const sidecar = path.join(getFurnaceDir(), `${batch.id}.json`);
    expect(existsSync(sidecar)).toBe(true);

    __resetFurnaceStoreForTests();
    expect(getFurnaceBatch(batch.id)).toBeUndefined();
    await loadFurnaceBatches();
    expect(getFurnaceBatch(batch.id)?.title).toBe('Nightly sweep');
  });

  describe('updateFurnaceBatch title-rename branch recompute (FLUX-1062 #3)', () => {
    it('draft rename recomputes the branch to match the new title', async () => {
      const batch = await createFurnaceBatch({ title: 'Old title' });
      const expectedBranch = batchBranchName(batch.id, 'New title');
      const updated = await updateFurnaceBatch(batch.id, { title: 'New title' });
      expect(updated?.title).toBe('New title');
      expect(updated?.branch).toBe(expectedBranch);
      expect(updated?.branch).not.toBe(batch.branch);
    });

    it('a burning rename changes the title but leaves the branch untouched', async () => {
      const batch = await createFurnaceBatch({ title: 'Old title' });
      await updateFurnaceBatch(batch.id, { status: 'burning' });
      const originalBranch = getFurnaceBatch(batch.id)?.branch;

      const updated = await updateFurnaceBatch(batch.id, { title: 'Renamed while burning' });
      expect(updated?.title).toBe('Renamed while burning');
      expect(updated?.branch).toBe(originalBranch);
    });

    it('a terminal (done/parked) rename changes the title but leaves the branch untouched', async () => {
      for (const status of ['done', 'parked'] as const) {
        const batch = await createFurnaceBatch({ title: `Old ${status}` });
        await updateFurnaceBatch(batch.id, { status });
        const originalBranch = getFurnaceBatch(batch.id)?.branch;

        const updated = await updateFurnaceBatch(batch.id, { title: `Renamed ${status}` });
        expect(updated?.title).toBe(`Renamed ${status}`);
        expect(updated?.branch).toBe(originalBranch);
      }
    });

    it('an explicit patch.branch on a draft still wins over the title-derived recompute (ordering)', async () => {
      const batch = await createFurnaceBatch({ title: 'Old title' });
      const updated = await updateFurnaceBatch(batch.id, { title: 'New title', branch: 'custom/explicit-branch' });
      expect(updated?.title).toBe('New title');
      expect(updated?.branch).toBe('custom/explicit-branch');
      expect(updated?.branch).not.toBe(batchBranchName(batch.id, 'New title'));
    });
  });

  describe('globalSlotsInUse (FLUX-1157: physical truth — no batch-state exclusion)', () => {
    it('counts an observed worktree belonging to a ticket in a DONE batch (FLUX-1090 exclusion reversed)', async () => {
      // FLUX-1090 used to discount this on the assumption a terminal batch's worktree was reclaimed —
      // it isn't (takeover semantics never delete it), which let the gauge under-report a physically-full
      // pool. FLUX-1157: the gauge counts every observed worktree; reclaim (not discounting) is what
      // actually frees a genuinely-reclaimable one — see the ignite-time reclaim tests.
      const batch = await createFurnaceBatch({ title: 'finished', kind: 'parallel', tickets: [newBatchTicket('T1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'done';
        const t = b.tickets[0]!;
        t.owner = 'human'; // yielded mid-burn; worktree deliberately never reclaimed
        t.state = 'parked';
      });
      // The ticket's worktree is still on disk (takeover semantics) — observed, and still counted.
      setObservedWorktrees(['T1']);
      expect(globalSlotsInUse()).toBe(1);
    });

    it('still counts an INDEPENDENT observed worktree not tied to any batch', async () => {
      setObservedWorktrees(['SOME-OTHER-TICKET']);
      expect(globalSlotsInUse()).toBe(1);
    });

    it('still counts a worktree for a ticket whose batch is still burning', async () => {
      const batch = await createFurnaceBatch({ title: 'still going', kind: 'parallel', tickets: [newBatchTicket('T2', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.owner = 'human';
        t.state = 'parked';
      });
      setObservedWorktrees(['T2']);
      expect(globalSlotsInUse()).toBe(1);
    });
  });
});

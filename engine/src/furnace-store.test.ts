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
import { Workspace, getDefaultWorkspace } from './workspace-context.js';
import {
  createFurnaceBatch,
  updateFurnaceBatch,
  getFurnaceBatch,
  getFurnaceDir,
  loadFurnaceBatches,
  globalSlotsInUse,
  setObservedWorktrees,
  ticketHasObservedWorktree,
  setTemperReserved,
  isTemperReserved,
  mutateFurnaceBatch,
  getFurnaceBatchesCacheForWorkspace,
  getBurningBatchesForWorkspace,
  __resetFurnaceStoreForTests,
} from './furnace-store.js';
import { batchBranchName, newBatchTicket, DEFAULT_SESSION_TIMEOUT_MS } from './models/furnace.js';
import { getConfig } from './config.js';

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

  describe('createFurnaceBatch sessionTimeoutMs inheritance (FLUX-1431)', () => {
    it('inherits the global config default when no per-batch value is given', async () => {
      const config = getConfig();
      const prior = config.furnaceSettings?.sessionTimeoutMs;
      config.furnaceSettings!.sessionTimeoutMs = 90 * 60 * 1000;
      try {
        const batch = await createFurnaceBatch({ title: 'inherits watchdog' });
        expect(batch.sessionTimeoutMs).toBe(90 * 60 * 1000);
      } finally {
        config.furnaceSettings!.sessionTimeoutMs = prior;
      }
    });

    it('an explicit per-batch sessionTimeoutMs overrides the global config default', async () => {
      const config = getConfig();
      const prior = config.furnaceSettings?.sessionTimeoutMs;
      config.furnaceSettings!.sessionTimeoutMs = 90 * 60 * 1000;
      try {
        const batch = await createFurnaceBatch({ title: 'explicit watchdog', sessionTimeoutMs: 20 * 60 * 1000 });
        expect(batch.sessionTimeoutMs).toBe(20 * 60 * 1000);
      } finally {
        config.furnaceSettings!.sessionTimeoutMs = prior;
      }
    });

    it('falls back to DEFAULT_SESSION_TIMEOUT_MS when neither input nor config sets it', async () => {
      const config = getConfig();
      const prior = config.furnaceSettings?.sessionTimeoutMs;
      delete config.furnaceSettings?.sessionTimeoutMs;
      try {
        const batch = await createFurnaceBatch({ title: 'no config value' });
        expect(batch.sessionTimeoutMs).toBe(DEFAULT_SESSION_TIMEOUT_MS);
      } finally {
        config.furnaceSettings!.sessionTimeoutMs = prior;
      }
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
      setObservedWorktrees(root, ['T1']);
      expect(globalSlotsInUse()).toBe(1);
    });

    it('still counts an INDEPENDENT observed worktree not tied to any batch', async () => {
      setObservedWorktrees(root, ['SOME-OTHER-TICKET']);
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
      setObservedWorktrees(root, ['T2']);
      expect(globalSlotsInUse()).toBe(1);
    });
  });

  describe('per-root census + reservation isolation (FLUX-1551)', () => {
    it('a same-id ticket on two boards is not cross-board deduped; per-root reads stay isolated; the shared cap sums both', () => {
      const otherRoot = path.join(os.tmpdir(), 'eh-furnace-other-ws-census');

      setObservedWorktrees(root, ['FLUX-1']);
      setObservedWorktrees(otherRoot, ['FLUX-1']); // same bare id on the OTHER board
      setTemperReserved(otherRoot, 'FLUX-2', true);

      expect(ticketHasObservedWorktree(root, 'FLUX-1')).toBe(true);
      expect(ticketHasObservedWorktree(root, 'FLUX-2')).toBe(false); // otherRoot's reservation invisible to root
      expect(isTemperReserved(otherRoot, 'FLUX-2')).toBe(true);
      expect(isTemperReserved(root, 'FLUX-2')).toBe(false);
      // 1 (root:FLUX-1) + 1 (otherRoot:FLUX-1, NOT deduped cross-root) + 1 (otherRoot:FLUX-2) — proves the
      // per-root identity scoping AND the shared-cap sum across roots in the same call.
      expect(globalSlotsInUse()).toBe(3);
    });
  });
});

describe('workspace-filtered batch accessors (FLUX-1513 follow-up, FLUX-1527)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-store-ws-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('getFurnaceBatchesCacheForWorkspace: a tagged batch matches only its own workspace; an untagged legacy batch falls back to the default', async () => {
    const otherRoot = path.join(os.tmpdir(), 'eh-furnace-other-ws-cache');
    const tagged = await createFurnaceBatch({ title: 'tagged to other workspace', workspaceRoot: otherRoot });
    const legacy = await createFurnaceBatch({ title: 'legacy, untagged' });

    const defaultWs = getDefaultWorkspace(); // root === `root`, set by setWorkspaceRoot above
    const otherWs = new Workspace();
    otherWs.root = otherRoot;

    const defaultIds = getFurnaceBatchesCacheForWorkspace(defaultWs).map((b) => b.id);
    expect(defaultIds).toContain(legacy.id);
    expect(defaultIds).not.toContain(tagged.id);

    const otherIds = getFurnaceBatchesCacheForWorkspace(otherWs).map((b) => b.id);
    expect(otherIds).toContain(tagged.id);
    expect(otherIds).not.toContain(legacy.id);
  });

  it('getBurningBatchesForWorkspace: narrows getBurningBatches() to the workspace on top of the burning-status filter', async () => {
    const otherRoot = path.join(os.tmpdir(), 'eh-furnace-other-ws-burning');
    const otherBurning = await createFurnaceBatch({ title: 'other workspace, burning', workspaceRoot: otherRoot });
    await updateFurnaceBatch(otherBurning.id, { status: 'burning' });
    // Same other workspace, but still draft — must not show up as "burning" anywhere.
    await createFurnaceBatch({ title: 'other workspace, draft', workspaceRoot: otherRoot });
    const legacyBurning = await createFurnaceBatch({ title: 'legacy, untagged, burning' });
    await updateFurnaceBatch(legacyBurning.id, { status: 'burning' });

    const defaultWs = getDefaultWorkspace();
    const otherWs = new Workspace();
    otherWs.root = otherRoot;

    expect(getBurningBatchesForWorkspace(defaultWs).map((b) => b.id)).toEqual([legacyBurning.id]);
    expect(getBurningBatchesForWorkspace(otherWs).map((b) => b.id)).toEqual([otherBurning.id]);
  });

  it('null-root edge: a null default workspace root still resolves an untagged legacy batch to the default pass', async () => {
    const legacy = await createFurnaceBatch({ title: 'legacy, created under a real root' });

    const defaultWs = getDefaultWorkspace();
    defaultWs.root = null; // simulates the unbound-workspace state (`Workspace.root` before first activation)
    try {
      const ids = getFurnaceBatchesCacheForWorkspace(defaultWs).map((b) => b.id);
      expect(ids).toContain(legacy.id);
    } finally {
      defaultWs.root = root;
    }
  });
});

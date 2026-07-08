// The Furnace — ignite-time worktree reclaim + slot-holder naming (FLUX-1157).
//
// FLUX-1090's gauge exclusion assumed a terminal-batch worktree was reclaimed; nothing guaranteed
// that, so the gauge could report free slots while the physical cap (`createTaskWorktree`) was full,
// and ignite admitted batches into guaranteed spawn failures. This locks the actual fix: `igniteBatch`
// reclaims every genuinely-safe worktree BEFORE recounting (so a stale done-batch worktree really frees
// its slot, not just gets discounted), and a genuinely full pool refuses `no_slots` with the holding
// tickets named instead of silently hiding them (see furnace-store.test.ts for the gauge-physical-truth
// half of the fix).
//
// `./pr-cleanup.js` is stubbed so the reclaim outcome is directly controllable per test without a real
// git repo; `./task-worktree.js`'s `listTaskWorktrees` is stubbed the same way (mirrors ticket-isolation
// .test.ts's mocking of the same collaborators) — everything else in task-worktree.js (path helpers like
// `taskWorktreeDir`/`ticketIdFromWorktreePath`) stays real via `importOriginal`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import {
  createFurnaceBatch,
  mutateFurnaceBatch,
  setObservedWorktrees,
  globalSlotsInUse,
  ensureFurnaceLoaded,
  setTemperReserved,
  __resetFurnaceStoreForTests,
} from './furnace-store.js';
import { newBatchTicket } from './models/furnace.js';

interface FakeWorktree { path: string; branch: string | null }

let worktreesOnDisk: FakeWorktree[] = [];
const listTaskWorktreesMock = vi.fn(async (_workspaceRoot: string) => worktreesOnDisk);
vi.mock('./task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-worktree.js')>();
  return { ...actual, listTaskWorktrees: (workspaceRoot: string) => listTaskWorktreesMock(workspaceRoot) };
});

const reclaimReadyWorktreesMock = vi.fn(async (_workspaceRoot: string) => [] as string[]);
const worktreeUnreclaimableReasonMock = vi.fn((_ticketId: string) => 'status' as const);
vi.mock('./pr-cleanup.js', () => ({
  reclaimReadyWorktrees: (workspaceRoot: string) => reclaimReadyWorktreesMock(workspaceRoot),
  worktreeUnreclaimableReason: (ticketId: string) => worktreeUnreclaimableReasonMock(ticketId),
}));

import { igniteBatch, describeSlotHolders } from './furnace-stoker.js';
import { taskWorktreeDir } from './task-worktree.js';

describe('Furnace ignite-time reclaim + slot-holder naming (FLUX-1157)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-reclaim-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    await ensureFurnaceLoaded();
    worktreesOnDisk = [];
    listTaskWorktreesMock.mockClear();
    reclaimReadyWorktreesMock.mockReset().mockImplementation(async () => []);
    worktreeUnreclaimableReasonMock.mockReset().mockReturnValue('status');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Occupy `n` worktree slots with sequential filler batches — a sequential burning batch reserves its
   *  one slot unconditionally, mirroring furnace-integration.test.ts's helper of the same name. */
  async function fillSlots(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const b = await createFurnaceBatch({ title: `filler-${i}`, kind: 'sequential', tickets: [newBatchTicket(`FILLER-${i}`, 0)] });
      await mutateFurnaceBatch(b.id, (draft) => { draft.status = 'burning'; });
    }
  }

  it('reclaims a stale reclaimable worktree at ignite and frees its slot for a new batch', async () => {
    await fillSlots(3);
    worktreesOnDisk = [{ path: taskWorktreeDir(root, 'STALE-1'), branch: 'flux/STALE-1' }];
    setObservedWorktrees(['STALE-1']);
    expect(globalSlotsInUse()).toBe(4); // pool reads full

    reclaimReadyWorktreesMock.mockImplementationOnce(async () => {
      worktreesOnDisk = []; // the stale worktree is genuinely removed from disk
      return ['STALE-1'];
    });

    const draft = await createFurnaceBatch({ title: 'new work', kind: 'sequential', tickets: [newBatchTicket('NEW-1', 0)] });
    const r = await igniteBatch(draft.id);

    expect(reclaimReadyWorktreesMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.batch?.status).toBe('burning');
  });

  it('refuses ignite into a genuinely full pool and names the ticket holding the slot', async () => {
    await fillSlots(3);
    worktreesOnDisk = [{ path: taskWorktreeDir(root, 'STALE-2'), branch: 'flux/STALE-2' }];
    setObservedWorktrees(['STALE-2']);
    expect(globalSlotsInUse()).toBe(4); // genuinely full — the default reclaim mock finds nothing to free

    const draft = await createFurnaceBatch({ title: 'new work', kind: 'sequential', tickets: [newBatchTicket('NEW-2', 0)] });
    const r = await igniteBatch(draft.id);

    expect(reclaimReadyWorktreesMock).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_slots');
    expect(r.holders?.some((h) => h.ticketId === 'STALE-2')).toBe(true);
    // Never quietly admits the batch into a spawn it can't isolate — that's the whole bug this locks.
    expect(r.batch).toBeUndefined();
  });

  it('names an actively-burning filler with a distinct reason from a stale, non-reclaimable one', async () => {
    await fillSlots(4);
    // Give each filler a physical worktree entry too, so describeSlotHolders (which walks the observed
    // disk pool, not the Furnace's own reservation bookkeeping) has something to name.
    worktreesOnDisk = Array.from({ length: 4 }, (_, i) => ({ path: taskWorktreeDir(root, `FILLER-${i}`), branch: `flux/FILLER-${i}` }));

    const draft = await createFurnaceBatch({ title: 'new work', kind: 'sequential', tickets: [newBatchTicket('NEW-3', 0)] });
    const r = await igniteBatch(draft.id);

    expect(r.ok).toBe(false);
    const filler0 = r.holders?.find((h) => h.ticketId === 'FILLER-0');
    expect(filler0?.reason).toBe('actively burning');
  });

  // FLUX-1158: a reservation claimed by claimSlotsAndIgnite counts toward globalSlotsInUse the instant a
  // batch flips to `burning` — before its worktree is ever materialized on disk (the exact window several
  // batches igniting back-to-back hit). describeSlotHolders used to only walk the physical worktree pool,
  // so such a reservation was invisible to a `no_slots` refusal's holder list even though it consumed the
  // slot the refusal counted.
  it('names a reservation whose worktree is not yet on disk (back-to-back ignite window)', async () => {
    await fillSlots(4); // reservations only — no matching physical worktrees on disk at all
    expect(worktreesOnDisk).toEqual([]);

    const draft = await createFurnaceBatch({ title: 'new work', kind: 'sequential', tickets: [newBatchTicket('NEW-4', 0)] });
    const r = await igniteBatch(draft.id);

    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_slots');
    expect(r.used).toBe(4);
    expect(r.holders?.length).toBe(4);
    for (let i = 0; i < 4; i++) {
      const holder = r.holders?.find((h) => h.ticketId === `FILLER-${i}`);
      expect(holder?.reason).toBe('reserved — worktree not yet created');
    }
  });

  // FLUX-1257: FLUX-1239 gave Temper its own in-memory reservation (`temperReservedTicketIds`), held
  // during the same window a Furnace reservation is — before its worktree is materialized on disk. Without
  // this, a same-tick Temper burst would be invisible to describeSlotHolders, undercounting holders vs.
  // the reported `used` figure exactly like the pre-FLUX-1158 Furnace gap above.
  it('names a Temper reservation whose worktree is not yet on disk', async () => {
    setTemperReserved('TEMPER-1', true);
    expect(worktreesOnDisk).toEqual([]);

    const holders = await describeSlotHolders(root);

    expect(holders).toEqual([{ ticketId: 'TEMPER-1', reason: 'Temper-reserved — worktree not yet created' }]);
  });
});

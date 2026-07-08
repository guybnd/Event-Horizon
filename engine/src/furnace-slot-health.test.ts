// The Furnace — slot-exhaustion health signal (FLUX-1217).
//
// FLUX-1214's board-triage found `furnace_get` reporting `slots: {used: 6, max: 4}` with ZERO batches
// burning — a leak (orphaned worktrees from grooming sessions) that took a manual `git worktree list` +
// code read to diagnose. This locks the fix: `checkFurnaceSlotHealth` fires a `log.warn` + portal
// notification, naming the holding tickets via `describeSlotHolders`, whenever the slot pool is maxed out
// while nothing is actually burning — edge-triggered so a long-lived leak doesn't spam on every tick.
//
// `./task-worktree.js`'s `listTaskWorktrees` is stubbed the same way furnace-slot-reclaim.test.ts does it
// (a real git repo isn't needed to control the observed pool); `./notifications.js`'s `addNotification` is
// stubbed so it can be asserted on directly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import {
  createFurnaceBatch,
  mutateFurnaceBatch,
  setObservedWorktrees,
  ensureFurnaceLoaded,
  setTemperReserved,
  __resetFurnaceStoreForTests,
  FURNACE_SLOT_CAP,
} from './furnace-store.js';
import { newBatchTicket } from './models/furnace.js';
import { log } from './log.js';

interface FakeWorktree { path: string; branch: string | null }

let worktreesOnDisk: FakeWorktree[] = [];
const listTaskWorktreesMock = vi.fn(async (_workspaceRoot: string) => worktreesOnDisk);
vi.mock('./task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-worktree.js')>();
  return { ...actual, listTaskWorktrees: (workspaceRoot: string) => listTaskWorktreesMock(workspaceRoot) };
});

const worktreeUnreclaimableReasonMock = vi.fn((_ticketId: string): null => null);
vi.mock('./pr-cleanup.js', () => ({
  reclaimReadyWorktrees: vi.fn(async () => []),
  worktreeUnreclaimableReason: (ticketId: string) => worktreeUnreclaimableReasonMock(ticketId),
}));

const addNotificationMock = vi.fn();
vi.mock('./notifications.js', () => ({
  addNotification: (n: unknown) => addNotificationMock(n),
}));

import { checkFurnaceSlotHealth, __resetSlotHealthLatchForTests } from './furnace-stoker.js';
import { taskWorktreeDir } from './task-worktree.js';

describe('checkFurnaceSlotHealth (FLUX-1217)', () => {
  let root: string;

  /** Occupy `n` worktree slots with sequential filler batches, mirroring furnace-slot-reclaim.test.ts. */
  async function fillSlots(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const b = await createFurnaceBatch({ title: `filler-${i}`, kind: 'sequential', tickets: [newBatchTicket(`FILLER-${i}`, 0)] });
      await mutateFurnaceBatch(b.id, (draft) => { draft.status = 'burning'; });
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-slot-health-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    __resetSlotHealthLatchForTests();
    await ensureFurnaceLoaded();
    worktreesOnDisk = [];
    listTaskWorktreesMock.mockClear();
    worktreeUnreclaimableReasonMock.mockReset().mockReturnValue(null);
    addNotificationMock.mockClear();
    vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('does nothing when slots are free, even with nothing burning', async () => {
    await fillSlots(FURNACE_SLOT_CAP - 1);
    await checkFurnaceSlotHealth();
    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does nothing when the pool is full but a batch is actively burning', async () => {
    await fillSlots(FURNACE_SLOT_CAP);
    // fillSlots' own fillers count as "burning" (they're left status:'burning'), so this exercises the
    // guard directly: exhausted slots are fine as long as at least one batch is burning.
    await checkFurnaceSlotHealth();
    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and notifies, naming the holders, when full with nothing burning', async () => {
    setObservedWorktrees(Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => `LEAKED-${i}`));
    worktreesOnDisk = Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => ({ path: taskWorktreeDir(root, `LEAKED-${i}`), branch: null }));

    await checkFurnaceSlotHealth();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(addNotificationMock).toHaveBeenCalledTimes(1);
    const notification = addNotificationMock.mock.calls[0]![0];
    expect(notification.type).toBe('error');
    expect(notification.title).toMatch(/slots exhausted/i);
    for (let i = 0; i < FURNACE_SLOT_CAP; i++) {
      expect(notification.message).toContain(`LEAKED-${i}`);
    }
  });

  it('is edge-triggered — does not re-notify on a second call while the leak persists', async () => {
    setObservedWorktrees(Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => `LEAKED-${i}`));
    worktreesOnDisk = Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => ({ path: taskWorktreeDir(root, `LEAKED-${i}`), branch: null }));

    await checkFurnaceSlotHealth();
    await checkFurnaceSlotHealth();
    await checkFurnaceSlotHealth();

    expect(addNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms after recovery — notifies again on a fresh incident', async () => {
    setObservedWorktrees(Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => `LEAKED-${i}`));
    worktreesOnDisk = Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => ({ path: taskWorktreeDir(root, `LEAKED-${i}`), branch: null }));
    await checkFurnaceSlotHealth();
    expect(addNotificationMock).toHaveBeenCalledTimes(1);

    // The leak is reclaimed — pool drops back under the cap.
    setObservedWorktrees([]);
    worktreesOnDisk = [];
    await checkFurnaceSlotHealth();
    expect(addNotificationMock).toHaveBeenCalledTimes(1); // still just the one from the first incident

    // A fresh leak occurs later.
    setObservedWorktrees(Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => `LEAKED2-${i}`));
    worktreesOnDisk = Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => ({ path: taskWorktreeDir(root, `LEAKED2-${i}`), branch: null }));
    await checkFurnaceSlotHealth();
    expect(addNotificationMock).toHaveBeenCalledTimes(2);
  });

  // FLUX-1257: FLUX-1239's Temper reservation (`temperReservedTicketIds`) is held for the ticket's entire
  // time under Temper's control, not just its brief pre-materialization window — so a same-tick Temper
  // burst can legitimately fill the pool with zero Furnace batches burning. That's healthy activity, not
  // the leak this check exists to catch.
  it('does nothing when the pool is full solely due to legitimate Temper reservations', async () => {
    for (let i = 0; i < FURNACE_SLOT_CAP; i++) setTemperReserved(`TEMPER-${i}`, true);

    await checkFurnaceSlotHealth();

    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('still warns when usage exceeds what Temper reservations account for', async () => {
    setTemperReserved('TEMPER-1', true); // accounts for exactly 1 of the used slots
    const leakedCount = FURNACE_SLOT_CAP - 1;
    setObservedWorktrees(Array.from({ length: leakedCount }, (_, i) => `LEAKED-${i}`));
    worktreesOnDisk = Array.from({ length: leakedCount }, (_, i) => ({ path: taskWorktreeDir(root, `LEAKED-${i}`), branch: null }));

    await checkFurnaceSlotHealth();

    expect(addNotificationMock).toHaveBeenCalledTimes(1);
    const notification = addNotificationMock.mock.calls[0]![0];
    expect(notification.message).toContain('TEMPER-1');
    for (let i = 0; i < leakedCount; i++) {
      expect(notification.message).toContain(`LEAKED-${i}`);
    }
  });
});

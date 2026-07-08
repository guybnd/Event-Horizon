// Temper (FLUX-1071) — the single-ticket auto-review loop glue.
//
// The loop's DECISION core is `decideTicketAction` (unit-tested in the Furnace suite), reused verbatim
// here, so these tests target only the Temper-specific glue: the trigger guards (mode off / branchless /
// already looping / owned by a Furnace batch), the executor's state transitions (review → reimplement →
// pr-open → park), re-entrancy (a re-implementation's own Ready move must not re-trigger), and rehydrate.
//
// `dispatchSession`/`parkTicketOnBoard`/`clearReviewState` are mocked (they do real fetch/git/file I/O);
// everything else in furnace-stoker (the pure decision core + helpers) is kept real. `updateTaskWithHistory`
// is mocked to apply its writes into the real `tasksCache` so `task.tempering` reads back as the engine would.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import type { CliSessionStatus } from './agents/types.js';

let sessionSeq = 0;
// dispatchSession returns a classified DispatchOutcome (FLUX-1235) — { sid } on success, { sid: null } on refusal.
const dispatchSession = vi.fn(async (_ticketId: string, _phase: string, _opts?: unknown) => ({ sid: `sess-${++sessionSeq}` }));
const parkTicketOnBoard = vi.fn(async (_ticketId: string, _reason: string) => {});
const clearReviewState = vi.fn(async (_ticketId: string) => {});

vi.mock('./furnace-stoker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./furnace-stoker.js')>();
  return {
    ...actual,
    dispatchSession: (t: string, p: string, o?: unknown) => dispatchSession(t, p, o),
    parkTicketOnBoard: (t: string, r: string) => parkTicketOnBoard(t, r),
    clearReviewState: (t: string) => clearReviewState(t),
  };
});

vi.mock('./task-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-store.js')>();
  const updateTaskWithHistory = vi.fn(async (taskId: string, options: {
    extraFields?: Record<string, unknown>;
    deleteFields?: string[];
    nextStatus?: string;
  }) => {
    const t = actual.tasksCache[taskId];
    if (!t) return true;
    if (options.extraFields) Object.assign(t, options.extraFields);
    if (options.deleteFields) for (const f of options.deleteFields) delete t[f];
    if (options.nextStatus) t.status = options.nextStatus;
    return true;
  });
  return { ...actual, updateTaskWithHistory };
});

import { tasksCache } from './task-store.js';
import { cliSessionsById } from './session-store.js';
import { __resetFurnaceStoreForTests, createFurnaceBatch, mutateFurnaceBatch, setObservedWorktrees, FURNACE_SLOT_CAP } from './furnace-store.js';
import { newBatchTicket } from './models/furnace.js';
import { configCache } from './config.js';
import { maybeStartTemper, temperTick, isTempering, rehydrateTemper, __resetTemperForTests, disarmTemperForExternalStop } from './temper.js';

function putSession(id: string, phase: 'review' | 'implementation', status: CliSessionStatus): void {
  cliSessionsById.set(id, { id, phase, status } as unknown as ReturnType<typeof cliSessionsById.get> & object);
}

describe('Temper (FLUX-1071) — single-ticket auto-review loop', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-temper-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
    __resetTemperForTests();
    __resetFurnaceStoreForTests();
    dispatchSession.mockClear();
    parkTicketOnBoard.mockClear();
    clearReviewState.mockClear();
    sessionSeq = 0;
    configCache.gatePolicy = { boardDefault: { plan: 'you', review: 'auto' } };
    configCache.readyForMergeStatus = 'Ready';
    configCache.requireInputStatus = 'Require Input';
  });

  // Drive maybeStartTemper for a ticket that isn't yet tempering (guards permitting).
  async function enterReady(id: string, extra: Record<string, unknown> = {}): Promise<void> {
    tasksCache[id] = { id, status: 'Ready', title: id, branch: `flux/${id}`, ...extra };
    await maybeStartTemper(id, 'Ready', 'In Progress');
  }

  it('starts the loop and dispatches the first review when a branch ticket enters Ready with Temper on', async () => {
    await enterReady('T-1');
    expect(isTempering('T-1')).toBe(true);
    expect(tasksCache['T-1'].tempering).toBe(true);
    expect(tasksCache['T-1'].temperAttempts).toBe(0);
    expect(dispatchSession).toHaveBeenCalledWith('T-1', 'review', expect.anything());
  });

  it('does NOT start when Temper is off, the ticket is branchless, or it is already tempering', async () => {
    configCache.gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
    await enterReady('OFF-1');
    expect(isTempering('OFF-1')).toBe(false);

    configCache.gatePolicy = { boardDefault: { plan: 'you', review: 'auto' } };
    tasksCache['NB-1'] = { id: 'NB-1', status: 'Ready', title: 'NB-1' }; // no branch
    await maybeStartTemper('NB-1', 'Ready', 'In Progress');
    expect(isTempering('NB-1')).toBe(false);

    // Re-entrancy: a ticket already tempering (its own re-implementation returning to Ready) must not restart.
    await enterReady('RE-1');
    dispatchSession.mockClear();
    await maybeStartTemper('RE-1', 'Ready', 'In Progress'); // second Ready entry while tempering
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it('a per-ticket gatePolicyOverride wins over the board default (FLUX-1261 cascade)', async () => {
    // Board default is off, but this ticket's own override turns review on for it alone.
    configCache.gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
    await enterReady('OV-ON', { gatePolicyOverride: { review: 'auto' } });
    expect(isTempering('OV-ON')).toBe(true);

    // Board default is on, but this ticket's own override turns review off for it alone.
    configCache.gatePolicy = { boardDefault: { plan: 'you', review: 'auto' } };
    await enterReady('OV-OFF', { gatePolicyOverride: { review: 'you' } });
    expect(isTempering('OV-OFF')).toBe(false);
  });

  it('does NOT start for a ticket already owned by an active Furnace batch (AC #7)', async () => {
    const batch = await createFurnaceBatch({ title: 'b', tickets: [newBatchTicket('FB-1', 0, 'FB-1')] });
    await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; b.tickets[0]!.state = 'implementing'; });
    await enterReady('FB-1');
    expect(isTempering('FB-1')).toBe(false);
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it('stops the loop and leaves the PR at Ready (never merged) once the review approves', async () => {
    await enterReady('AP-1');
    // The review session completed and the reviewer recorded approval.
    putSession('sess-1', 'review', 'completed');
    tasksCache['AP-1'].reviewState = 'approved';
    await temperTick();
    expect(isTempering('AP-1')).toBe(false);
    expect(tasksCache['AP-1'].tempering).toBeUndefined();
    expect(tasksCache['AP-1'].status).toBe('Ready'); // never moved off Ready / merged
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  it('re-implements (bumping attempts) on changes-requested within the retry cap', async () => {
    await enterReady('CR-1');
    putSession('sess-1', 'review', 'completed');
    tasksCache['CR-1'].reviewState = 'changes-requested';
    dispatchSession.mockClear();
    await temperTick();
    expect(dispatchSession).toHaveBeenCalledWith('CR-1', 'implementation', expect.anything());
    expect(tasksCache['CR-1'].temperAttempts).toBe(1);
    expect(isTempering('CR-1')).toBe(true);
  });

  it('parks the ticket (Require Input) when its review session dies', async () => {
    await enterReady('PK-1');
    putSession('sess-1', 'review', 'failed');
    await temperTick();
    expect(parkTicketOnBoard).toHaveBeenCalledWith('PK-1', expect.stringContaining('Temper:'));
    expect(isTempering('PK-1')).toBe(false);
    expect(tasksCache['PK-1'].tempering).toBeUndefined();
  });

  // FLUX-1297: a finish/merge flow killed the review session (cancelled) AFTER the ticket's board
  // status already read Done — Temper must yield quietly instead of parking work that already landed.
  it('does NOT park when a cancelled review session is observed on a ticket whose board status is already Done', async () => {
    await enterReady('YD-1');
    tasksCache['YD-1'].status = 'Done';
    putSession('sess-1', 'review', 'cancelled');
    await temperTick();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(isTempering('YD-1')).toBe(false);
    expect(tasksCache['YD-1'].tempering).toBeUndefined();
    expect(tasksCache['YD-1'].status).toBe('Done'); // status never reverted
  });

  // FLUX-1297: the finish/merge flow's own disarm call (`disarmTemperForExternalStop`), invoked BEFORE
  // it stops the ticket's sessions — the primary fix, closing the race regardless of tick timing.
  it('disarmTemperForExternalStop disarms an actively-tempering ticket without parking', async () => {
    await enterReady('EX-1');
    expect(isTempering('EX-1')).toBe(true);
    await disarmTemperForExternalStop('EX-1');
    expect(isTempering('EX-1')).toBe(false);
    expect(tasksCache['EX-1'].tempering).toBeUndefined();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    // A subsequent tick (e.g. if the caller's session-stop lands a 'cancelled' status right after) is a
    // no-op — the ticket is no longer tracked, so it can never be parked by a stray tick.
    putSession('sess-1', 'review', 'cancelled');
    await temperTick();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  it('disarmTemperForExternalStop no-ops for a ticket Temper is not driving', async () => {
    await expect(disarmTemperForExternalStop('NOT-TEMPERING')).resolves.toBeUndefined();
    expect(isTempering('NOT-TEMPERING')).toBe(false);
  });

  it('waits (does not park) when the shared worktree pool is full, then dispatches once a slot frees (FLUX-1237)', async () => {
    // Fill the shared pool to the cap so freeSlots() === 0. `refreshWorktreePool` (run inside spawnTemper)
    // shells out to git in a non-repo temp dir, fails best-effort, and keeps this observed count — so the
    // slot gate sees a full pool exactly as it would when the Furnace holds every slot.
    setObservedWorktrees(Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => `w${i}`));

    await enterReady('WT-1');
    // The loop started (durable + in-memory) but NO session was dispatched — it is WAITING for a slot.
    expect(isTempering('WT-1')).toBe(true);
    expect(tasksCache['WT-1'].tempering).toBe(true);
    expect(dispatchSession).not.toHaveBeenCalled();

    // A full pool is not a spawn failure: many ticks with the pool still full must NOT park the ticket
    // (this is the regression the ticket targets — parking after MAX_TEMPER_SPAWN_ATTEMPTS refusals).
    for (let i = 0; i < 8; i++) await temperTick();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(isTempering('WT-1')).toBe(true);

    // A slot frees → the next tick observes no session, re-drives the review, and dispatches it.
    setObservedWorktrees([]);
    await temperTick();
    expect(dispatchSession).toHaveBeenCalledWith('WT-1', 'review', expect.anything());
  });

  it('does NOT wait when the ticket already holds a worktree, even if the pool is full (FLUX-1244)', async () => {
    // Pool full to the cap — but one of the occupied worktrees belongs to THIS ticket. A re-spawn reuses
    // that worktree via the shared branch (claims no new slot), so the slot gate must exempt it and let it
    // dispatch immediately rather than self-stall behind unrelated work until some other slot frees.
    setObservedWorktrees(['OWN-1', ...Array.from({ length: FURNACE_SLOT_CAP - 1 }, (_, i) => `w${i}`)]);

    await enterReady('OWN-1');
    expect(dispatchSession).toHaveBeenCalledWith('OWN-1', 'review', expect.anything());
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  it('a same-tick burst of new tickets dispatches exactly the free-slot count, leaving the rest waiting (FLUX-1239)', async () => {
    // 2 slots already occupied elsewhere (e.g. Furnace-held) → 2 of the FURNACE_SLOT_CAP (4) are free.
    setObservedWorktrees(['w0', 'w1']);
    const ids = ['B-1', 'B-2', 'B-3', 'B-4'];
    for (const id of ids) tasksCache[id] = { id, status: 'Ready', title: id, branch: `flux/${id}` };

    // Fire all four `maybeStartTemper` calls in the SAME tick — `temperTickets.set()` registers each
    // synchronously before any of them awaits past it, mirroring several branch tickets entering Ready
    // within the same TTL-coalesced `refreshWorktreePool` window. Without an in-memory reservation, all
    // four would read the same stale "2 free" count and all pass the gate.
    await Promise.all(ids.map((id) => maybeStartTemper(id, 'Ready', 'In Progress')));

    const dispatchedIds = ids.filter((id) => dispatchSession.mock.calls.some(([t]) => t === id));
    expect(dispatchedIds.length).toBe(2); // exactly the 2 free slots — no over-commit
    // The excess just WAIT — never a spawn failure/park — and stay tempering for the next tick to retry.
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    for (const id of ids) expect(isTempering(id)).toBe(true);
  });

  it('rehydrates in-flight loops from frontmatter after an engine restart', () => {
    tasksCache['RH-1'] = { id: 'RH-1', status: 'Ready', title: 'RH-1', branch: 'flux/RH-1', tempering: true, temperAttempts: 1 };
    expect(isTempering('RH-1')).toBe(false);
    rehydrateTemper();
    expect(isTempering('RH-1')).toBe(true);
  });
});

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

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import type { CliSessionStatus } from './agents/types.js';

// FLUX-1551: `refreshWorktreePool` (run inside `spawnTemper`) is now keyed PER ROOT, and each test here
// mints a brand-new temp-dir root — so, unlike a single flat TTL, the per-root freshness window never
// absorbs the call for a root it hasn't seen before. Force the underlying git call to fail every time
// (a real `git worktree list` would fail in this non-repo temp dir too) so `refreshWorktreePool`'s
// best-effort catch preserves whatever `setObservedWorktrees` a test seeded, instead of overwriting it
// with an empty scan result.
vi.mock('./task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-worktree.js')>();
  return { ...actual, listTaskWorktrees: async () => { throw new Error('no git repo in test temp dir'); } };
});

let sessionSeq = 0;
// dispatchSession returns a classified DispatchOutcome (FLUX-1235) — { sid } on success, { sid: null } on refusal.
const dispatchSession = vi.fn(async (_ticketId: string, _phase: string, _opts?: unknown): Promise<{ sid: string | null }> => ({ sid: `sess-${++sessionSeq}` }));
const parkTicketOnBoard = vi.fn(async (_ticketId: string, _reason: string) => {});
const clearReviewState = vi.fn(async (_ticketId: string) => {});

vi.mock('./furnace-stoker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./furnace-stoker.js')>();
  return {
    ...actual,
    dispatchSession: (t: string, p: string, o?: unknown) => dispatchSession(t, p, o),
    // FLUX-1378: `resumeOrDispatchSession` is now the real re-implement-dispatch call site — mocked
    // here as a passthrough to the SAME `dispatchSession` mock rather than reused from `actual`,
    // because `actual.resumeOrDispatchSession`'s internal call to `dispatchSession` is an ESM
    // same-module reference to the REAL function, not this factory's mocked export. No test here
    // seeds a resumable session, so this mirrors production's own fallback-to-cold-spawn behavior.
    resumeOrDispatchSession: async (t: string, p: string, o?: unknown) => {
      const r = await dispatchSession(t, p, o);
      return { ...r, resumed: false };
    },
    parkTicketOnBoard: (t: string, r: string) => parkTicketOnBoard(t, r),
    clearReviewState: (t: string) => clearReviewState(t),
  };
});

vi.mock('./task-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-store.js')>();
  const { getWorkspace: getWs } = await import('./workspace-context.js');
  const updateTaskWithHistory = vi.fn(async (taskId: string, options: {
    extraFields?: Record<string, unknown>;
    deleteFields?: string[];
    nextStatus?: string;
  }) => {
    const t = getWs().tasks[taskId];
    if (!t) return true;
    if (options.extraFields) Object.assign(t, options.extraFields);
    if (options.deleteFields) for (const f of options.deleteFields) delete t[f];
    if (options.nextStatus) t.status = options.nextStatus;
    return true;
  });
  return { ...actual, updateTaskWithHistory };
});


import { cliSessionsById, registerSession } from './session-store.js';
import { __resetFurnaceStoreForTests, createFurnaceBatch, mutateFurnaceBatch, setObservedWorktrees, FURNACE_SLOT_CAP } from './furnace-store.js';
import { newBatchTicket } from './models/furnace.js';
import { getConfig } from './config.js';
import { maybeStartTemper, temperTick, isTempering, rehydrateTemper, __resetTemperForTests, disarmTemperForExternalStop } from './temper.js';

function putSession(id: string, phase: 'review' | 'implementation', status: CliSessionStatus): void {
  cliSessionsById.set(id, { id, phase, status } as unknown as ReturnType<typeof cliSessionsById.get> & object);
}

// FLUX-1396: `putSession` only writes `cliSessionsById`, never `cliSessionsByTaskId` — so
// `getActiveSessionsForTask` (what `reconcileTemperTicket`'s adoption branch reads via
// `pickSessionForPhase`) always sees `[]` for a session seeded that way, and the adoption branch at
// temper.ts's `reconcileTemperTicket` (`if (!sess) sess = pickSessionForPhase(getActiveSessionsForTask(...), ...)`)
// is never exercised. This threads the session through the real `registerSession` too, so a "live
// session Temper never dispatched itself" can actually be found and adopted.
function putActiveSession(taskId: string, id: string, phase: 'review' | 'implementation', status: CliSessionStatus): void {
  cliSessionsById.set(id, { id, taskId, phase, status } as unknown as ReturnType<typeof cliSessionsById.get> & object);
  registerSession(taskId, id);
}

describe('Temper (FLUX-1071) — single-ticket auto-review loop', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-temper-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    __resetTemperForTests();
    __resetFurnaceStoreForTests();
    dispatchSession.mockClear();
    parkTicketOnBoard.mockClear();
    clearReviewState.mockClear();
    sessionSeq = 0;
    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'auto' } };
    getConfig().readyForMergeStatus = 'Ready';
    getConfig().requireInputStatus = 'Require Input';
  });

  // Drive maybeStartTemper for a ticket that isn't yet tempering (guards permitting).
  async function enterReady(id: string, extra: Record<string, unknown> = {}): Promise<void> {
    getWorkspace().tasks[id] = { id, status: 'Ready', title: id, branch: `flux/${id}`, ...extra };
    await maybeStartTemper(id, 'Ready', 'In Progress');
  }

  it('starts the loop and dispatches the first review when a branch ticket enters Ready with Temper on', async () => {
    await enterReady('T-1');
    expect(isTempering('T-1')).toBe(true);
    expect(getWorkspace().tasks['T-1'].tempering).toBe(true);
    expect(getWorkspace().tasks['T-1'].temperAttempts).toBe(0);
    expect(dispatchSession).toHaveBeenCalledWith('T-1', 'review', expect.anything());
  });

  it('does NOT re-arm when the Ready move itself carries a review verdict (FLUX-1394)', async () => {
    // An approval rides an In Progress → Ready move (a human approving a parked ticket, or a
    // re-dispatched review approving after a park cleared `tempering`). All other guards pass
    // (branch, review=auto, non-Ready→Ready, not tempering), so without the verdict guard this
    // would arm — wiping the just-recorded verdict (clearReviewState) and dispatching a redundant
    // re-review → the false "review completed without a verdict" park this ticket fixes.
    getWorkspace().tasks['VR-1'] = { id: 'VR-1', status: 'Ready', title: 'VR-1', branch: 'flux/VR-1' };
    await maybeStartTemper('VR-1', 'Ready', 'In Progress', 'approved');
    expect(isTempering('VR-1')).toBe(false);
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(clearReviewState).not.toHaveBeenCalled();

    // Same ticket/conditions but with NO verdict recorded on the move (an implementer finishing) still
    // arms — the first-review path is unbroken.
    await maybeStartTemper('VR-1', 'Ready', 'In Progress');
    expect(isTempering('VR-1')).toBe(true);
    expect(dispatchSession).toHaveBeenCalledWith('VR-1', 'review', expect.anything());
  });

  it('does NOT start when Temper is off, the ticket is branchless, or it is already tempering', async () => {
    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
    await enterReady('OFF-1');
    expect(isTempering('OFF-1')).toBe(false);

    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'auto' } };
    getWorkspace().tasks['NB-1'] = { id: 'NB-1', status: 'Ready', title: 'NB-1' }; // no branch
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
    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
    await enterReady('OV-ON', { gatePolicyOverride: { review: 'auto' } });
    expect(isTempering('OV-ON')).toBe(true);

    // Board default is on, but this ticket's own override turns review off for it alone.
    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'auto' } };
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
    getWorkspace().tasks['AP-1'].reviewState = 'approved';
    await temperTick();
    expect(isTempering('AP-1')).toBe(false);
    expect(getWorkspace().tasks['AP-1'].tempering).toBeUndefined();
    expect(getWorkspace().tasks['AP-1'].status).toBe('Ready'); // never moved off Ready / merged
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  it('re-implements (bumping attempts) on changes-requested within the retry cap', async () => {
    await enterReady('CR-1');
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['CR-1'].reviewState = 'changes-requested';
    dispatchSession.mockClear();
    await temperTick();
    expect(dispatchSession).toHaveBeenCalledWith('CR-1', 'implementation', expect.anything());
    expect(getWorkspace().tasks['CR-1'].temperAttempts).toBe(1);
    expect(isTempering('CR-1')).toBe(true);
  });

  it('parks the ticket (Require Input) when its review session dies', async () => {
    await enterReady('PK-1');
    putSession('sess-1', 'review', 'failed');
    await temperTick();
    expect(parkTicketOnBoard).toHaveBeenCalledWith('PK-1', expect.stringContaining('Temper:'));
    expect(isTempering('PK-1')).toBe(false);
    expect(getWorkspace().tasks['PK-1'].tempering).toBeUndefined();
  });

  // FLUX-1297: a finish/merge flow killed the review session (cancelled) AFTER the ticket's board
  // status already read Done — Temper must yield quietly instead of parking work that already landed.
  it('does NOT park when a cancelled review session is observed on a ticket whose board status is already Done', async () => {
    await enterReady('YD-1');
    getWorkspace().tasks['YD-1'].status = 'Done';
    putSession('sess-1', 'review', 'cancelled');
    await temperTick();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(isTempering('YD-1')).toBe(false);
    expect(getWorkspace().tasks['YD-1'].tempering).toBeUndefined();
    expect(getWorkspace().tasks['YD-1'].status).toBe('Done'); // status never reverted
  });

  // FLUX-1297: the finish/merge flow's own disarm call (`disarmTemperForExternalStop`), invoked BEFORE
  // it stops the ticket's sessions — the primary fix, closing the race regardless of tick timing.
  it('disarmTemperForExternalStop disarms an actively-tempering ticket without parking', async () => {
    await enterReady('EX-1');
    expect(isTempering('EX-1')).toBe(true);
    await disarmTemperForExternalStop('EX-1');
    expect(isTempering('EX-1')).toBe(false);
    expect(getWorkspace().tasks['EX-1'].tempering).toBeUndefined();
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
    setObservedWorktrees(getWorkspace().root, Array.from({ length: FURNACE_SLOT_CAP }, (_, i) => `w${i}`));

    await enterReady('WT-1');
    // The loop started (durable + in-memory) but NO session was dispatched — it is WAITING for a slot.
    expect(isTempering('WT-1')).toBe(true);
    expect(getWorkspace().tasks['WT-1'].tempering).toBe(true);
    expect(dispatchSession).not.toHaveBeenCalled();

    // A full pool is not a spawn failure: many ticks with the pool still full must NOT park the ticket
    // (this is the regression the ticket targets — parking after MAX_TEMPER_SPAWN_ATTEMPTS refusals).
    for (let i = 0; i < 8; i++) await temperTick();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(isTempering('WT-1')).toBe(true);

    // A slot frees → the next tick observes no session, re-drives the review, and dispatches it.
    setObservedWorktrees(getWorkspace().root, []);
    await temperTick();
    expect(dispatchSession).toHaveBeenCalledWith('WT-1', 'review', expect.anything());
  });

  it('does NOT wait when the ticket already holds a worktree, even if the pool is full (FLUX-1244)', async () => {
    // Pool full to the cap — but one of the occupied worktrees belongs to THIS ticket. A re-spawn reuses
    // that worktree via the shared branch (claims no new slot), so the slot gate must exempt it and let it
    // dispatch immediately rather than self-stall behind unrelated work until some other slot frees.
    setObservedWorktrees(getWorkspace().root, ['OWN-1', ...Array.from({ length: FURNACE_SLOT_CAP - 1 }, (_, i) => `w${i}`)]);

    await enterReady('OWN-1');
    expect(dispatchSession).toHaveBeenCalledWith('OWN-1', 'review', expect.anything());
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  it('a same-tick burst of new tickets dispatches exactly the free-slot count, leaving the rest waiting (FLUX-1239)', async () => {
    // 2 slots already occupied elsewhere (e.g. Furnace-held) → 2 of the FURNACE_SLOT_CAP (4) are free.
    setObservedWorktrees(getWorkspace().root, ['w0', 'w1']);
    const ids = ['B-1', 'B-2', 'B-3', 'B-4'];
    for (const id of ids) getWorkspace().tasks[id] = { id, status: 'Ready', title: id, branch: `flux/${id}` };

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

  // FLUX-1396: pins the "adoption" branch in `reconcileTemperTicket` (temper.ts around line 375-376) —
  // when Temper's own dispatch never captured a session id (e.g. a 409 against a session already live
  // on the ticket, simulated below by making the dispatch return a null sid), a tick must find that
  // live session via `pickSessionForPhase(getActiveSessionsForTask(...), ...)` and drive off IT instead
  // of endlessly re-attempting a dispatch. Never exercised before this suite (see `putActiveSession`).
  it('adopts a live human review session instead of dispatching a redundant one (High)', async () => {
    dispatchSession.mockImplementationOnce(async () => ({ sid: null })); // the ticket's own first dispatch 409s
    await enterReady('AD-1');
    expect(getWorkspace().tasks['AD-1'].tempering).toBe(true); // one refusal is not a park
    expect(parkTicketOnBoard).not.toHaveBeenCalled();

    putActiveSession('AD-1', 'human-sess-1', 'review', 'running'); // the review session a human is already in
    dispatchSession.mockClear();
    await temperTick();
    expect(dispatchSession).not.toHaveBeenCalled(); // adopted, not re-dispatched
    expect(isTempering('AD-1')).toBe(true); // still mid-review — just waiting on the adopted session now
  });

  it('an adopted review session reaching approved stops the loop (pr-open), same as a self-dispatched one', async () => {
    dispatchSession.mockImplementationOnce(async () => ({ sid: null }));
    await enterReady('AD-2');
    putActiveSession('AD-2', 'human-sess-2', 'review', 'running');
    await temperTick(); // adopts human-sess-2 (still running → wait)

    // The adopted session concludes with an approval — decideTicketAction must be reading it via the
    // ticket's own tracked `currentSessionId`, not re-deriving from `getActiveSessionsForTask` (which
    // would miss it once its status leaves the active set below).
    getWorkspace().tasks['AD-2'].reviewState = 'approved';
    cliSessionsById.set('human-sess-2', { id: 'human-sess-2', taskId: 'AD-2', phase: 'review', status: 'completed' } as unknown as ReturnType<typeof cliSessionsById.get> & object);
    dispatchSession.mockClear();
    await temperTick();
    expect(isTempering('AD-2')).toBe(false);
    expect(getWorkspace().tasks['AD-2'].status).toBe('Ready');
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it('an adopted review session reaching changes-requested re-implements, same as a self-dispatched one', async () => {
    dispatchSession.mockImplementationOnce(async () => ({ sid: null }));
    await enterReady('AD-3');
    putActiveSession('AD-3', 'human-sess-3', 'review', 'running');
    await temperTick(); // adopts human-sess-3

    getWorkspace().tasks['AD-3'].reviewState = 'changes-requested';
    cliSessionsById.set('human-sess-3', { id: 'human-sess-3', taskId: 'AD-3', phase: 'review', status: 'completed' } as unknown as ReturnType<typeof cliSessionsById.get> & object);
    dispatchSession.mockClear();
    await temperTick();
    expect(dispatchSession).toHaveBeenCalledWith('AD-3', 'implementation', expect.anything());
    expect(getWorkspace().tasks['AD-3'].temperAttempts).toBe(1);
    expect(isTempering('AD-3')).toBe(true);
  });

  // The regression this guards: before adoption, a run of dispatch refusals just kept counting
  // `spawnFailures` toward `MAX_TEMPER_SPAWN_ATTEMPTS` (6) with no way to ever succeed if the refusals
  // were caused by a session Temper itself couldn't see — eventually a false park. Once the live
  // session becomes visible, adoption must short-circuit that climb well before the cap.
  it("adopts within a few ticks rather than climbing to the spawn-failure cap on a dispatch-409 race", async () => {
    dispatchSession
      .mockImplementationOnce(async () => ({ sid: null })) // attempt 1 (during enterReady) — 409
      .mockImplementationOnce(async () => ({ sid: null })); // attempt 2 (next tick) — still 409, session not visible yet
    await enterReady('RACE-1');
    await temperTick(); // attempt 2 — still no session to adopt
    expect(parkTicketOnBoard).not.toHaveBeenCalled(); // nowhere near the cap yet

    // The human's own review session shows up in the store a beat behind the race.
    putActiveSession('RACE-1', 'human-sess-race', 'review', 'running');
    dispatchSession.mockClear();
    await temperTick(); // adopts — no further dispatch attempt
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(isTempering('RACE-1')).toBe(true);
  });

  // FLUX-519 gap: once a Temper loop rests a ticket at Ready (approved → pr-open → stopTemper), the
  // ticket is no longer in `temperTickets` — a later tick must be a complete no-op for it: no second
  // review dispatch, no repeat `clearReviewState` call (which would wipe a verdict nothing re-derives).
  it('a ticket resting at Ready after approval is never re-driven by a later tick (FLUX-519)', async () => {
    await enterReady('REST-1');
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['REST-1'].reviewState = 'approved';
    await temperTick();
    expect(isTempering('REST-1')).toBe(false);

    dispatchSession.mockClear();
    clearReviewState.mockClear();
    await temperTick();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(clearReviewState).not.toHaveBeenCalled();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(getWorkspace().tasks['REST-1'].status).toBe('Ready');
  });

  // Complements the FLUX-1394 test above (VR-1 starts NOT tempering — a human approving a parked
  // ticket that Temper wasn't currently driving). Here the ticket is ALREADY mid-loop when the manual
  // Ready→Ready approve lands, pinning that the guard holds for an in-flight loop too, not only the
  // not-yet-armed case.
  it('a manual Ready-to-Ready approve on an already-tempering ticket does not re-arm or touch the running loop', async () => {
    await enterReady('MA-1');
    expect(isTempering('MA-1')).toBe(true);
    dispatchSession.mockClear();
    clearReviewState.mockClear();

    getWorkspace().tasks['MA-1'].reviewState = 'approved';
    await maybeStartTemper('MA-1', 'Ready', 'Ready', 'approved');
    expect(isTempering('MA-1')).toBe(true); // unchanged — still the same in-flight loop
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(clearReviewState).not.toHaveBeenCalled();

    // The loop's OWN next tick still observes the verdict normally and stops (proof nothing wedged).
    putSession('sess-1', 'review', 'completed');
    await temperTick();
    expect(isTempering('MA-1')).toBe(false);
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  it('rehydrates in-flight loops from frontmatter after an engine restart', () => {
    getWorkspace().tasks['RH-1'] = { id: 'RH-1', status: 'Ready', title: 'RH-1', branch: 'flux/RH-1', tempering: true, temperAttempts: 1 };
    expect(isTempering('RH-1')).toBe(false);
    rehydrateTemper();
    expect(isTempering('RH-1')).toBe(true);
  });
});

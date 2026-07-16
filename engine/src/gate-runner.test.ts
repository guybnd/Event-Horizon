// Plan-review gate runner (FLUX-1263) — the generalized loop-driver's `plan`-gate glue.
//
// Mirrors `temper.test.ts`'s approach: `decideTicketAction` (the pure decision core) is exercised for
// real (imported from the real `furnace-stoker.js`); only the I/O edges (`dispatchSession`,
// `parkTicketOnBoard`, `updateTaskWithHistory`) are mocked. `isTicketInActiveFurnaceBatch` is left real
// too (backed by the real `furnace-store.js`), so the Furnace-yield precedence is tested against real
// batch state rather than a mock.

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import type { CliSessionStatus } from './agents/types.js';

let sessionSeq = 0;
const dispatchSession = vi.fn(async (_ticketId: string, _phase: string, _opts?: unknown) => ({ sid: `sess-${++sessionSeq}` }));
const parkTicketOnBoard = vi.fn(async (_ticketId: string, _reason: string, _opts?: unknown) => {});
// FLUX-1304: `decideTicketAction`'s 'yield' branch requires the ticket's board status to already be
// Done/Released, which `reconcileGateTicket`'s own "left Grooming" guard stops the run for BEFORE it
// ever reaches `decideTicketAction` — so the real trigger path can't be driven end-to-end in a test.
// Force it directly for one sentinel ticket id instead, real `decideTicketAction` for every other.
let forceYieldFor: string | null = null;

vi.mock('./furnace-stoker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./furnace-stoker.js')>();
  return {
    ...actual,
    dispatchSession: (t: string, p: string, o?: unknown) => dispatchSession(t, p, o),
    // FLUX-1378: `resumeOrDispatchSession` is now the real revise-dispatch call site — mocked here as
    // a passthrough to the SAME `dispatchSession` mock rather than reused from `actual`, because
    // `actual.resumeOrDispatchSession`'s internal call to `dispatchSession` is an ESM same-module
    // reference to the REAL function, not this factory's mocked export (mocking one export doesn't
    // rebind another export's internal calls to it). No test here seeds a resumable session, so this
    // mirrors production's own fallback-to-cold-spawn behavior in that case.
    resumeOrDispatchSession: async (t: string, p: string, o?: unknown) => {
      const r = await dispatchSession(t, p, o);
      return { ...r, resumed: false };
    },
    parkTicketOnBoard: (t: string, r: string, o?: unknown) => parkTicketOnBoard(t, r, o),
    decideTicketAction: (input: Parameters<typeof actual.decideTicketAction>[0]) =>
      forceYieldFor && input.ticket.ticketId === forceYieldFor
        ? { type: 'yield' as const, reason: 'test: session cancelled and ticket already merged' }
        : actual.decideTicketAction(input),
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


import { cliSessionsById } from './session-store.js';
import { __resetFurnaceStoreForTests, createFurnaceBatch, mutateFurnaceBatch } from './furnace-store.js';
import { newBatchTicket, DEFAULT_RETRY_CAP } from './models/furnace.js';
import { getConfig } from './config.js';
import { startPlanGateNow, startPlanReviseNow, resolvePlanVerdictNow, gateRunnerTick, isGateRunning, rehydrateGateRunner, __resetGateRunnerForTests } from './gate-runner.js';

function putSession(id: string, phase: string, status: CliSessionStatus): void {
  cliSessionsById.set(id, { id, phase, status } as unknown as ReturnType<typeof cliSessionsById.get> & object);
}

function seedGrooming(id: string, extra: Record<string, unknown> = {}): void {
  getWorkspace().tasks[id] = { id, status: 'Grooming', title: id, ...extra };
}

describe('Plan-review gate runner (FLUX-1263)', () => {
  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-gate-runner-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    __resetGateRunnerForTests();
    __resetFurnaceStoreForTests();
    dispatchSession.mockClear();
    parkTicketOnBoard.mockClear();
    sessionSeq = 0;
    forceYieldFor = null;
    getConfig().gatePolicy = { boardDefault: { plan: 'auto', review: 'you' } };
    getConfig().requireInputStatus = 'Require Input';
    getConfig().columns = [
      { name: 'Grooming' }, { name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' },
    ];
    getConfig().planReviewDepth = 'auto';
  });

  it('starts a run and dispatches the first (branchless) review pass', async () => {
    seedGrooming('P-1');
    const res = await startPlanGateNow('P-1', { mode: 'loop-auto' });
    expect(res.ok).toBe(true);
    expect(isGateRunning('P-1')).toBe(true);
    expect(getWorkspace().tasks['P-1'].planGateRunning).toBe(true);
    expect(getWorkspace().tasks['P-1'].planGateAttempts).toBe(0);
    expect(dispatchSession).toHaveBeenCalledWith('P-1', 'review', expect.objectContaining({ skipIsolation: true }));
  });

  it('refuses to start when the ticket is not in Grooming', async () => {
    getWorkspace().tasks['NG-1'] = { id: 'NG-1', status: 'Todo', title: 'NG-1' };
    const res = await startPlanGateNow('NG-1', { mode: 'loop-auto' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('wrong-status');
    expect(isGateRunning('NG-1')).toBe(false);
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent start on the same ticket', async () => {
    seedGrooming('DUP-1');
    await startPlanGateNow('DUP-1', { mode: 'loop-auto' });
    dispatchSession.mockClear();
    const res = await startPlanGateNow('DUP-1', { mode: 'loop-auto' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('already-running');
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it('refuses to start for a ticket owned by an active Furnace batch (mirrors Temper AC #7)', async () => {
    seedGrooming('FB-1');
    const batch = await createFurnaceBatch({ title: 'b', tickets: [newBatchTicket('FB-1', 0, 'FB-1')] });
    await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; b.tickets[0]!.state = 'implementing'; });
    const res = await startPlanGateNow('FB-1', { mode: 'loop-auto' });
    expect(res.ok).toBe(false);
    // FLUX-1269: this is the ONE genuine (non-benign) refusal reason — the `change_status` redirect must
    // NOT report its "gate runs instead" success message here (see mcp-plan-gate.test.ts).
    expect(res.reason).toBe('furnace-owned');
    expect(dispatchSession).not.toHaveBeenCalled();
  });

  it('yields mid-run when a Furnace batch adopts the ticket', async () => {
    seedGrooming('FB-2');
    await startPlanGateNow('FB-2', { mode: 'loop-auto' });
    const batch = await createFurnaceBatch({ title: 'b', tickets: [newBatchTicket('FB-2', 0, 'FB-2')] });
    await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; b.tickets[0]!.state = 'implementing'; });
    await gateRunnerTick();
    expect(isGateRunning('FB-2')).toBe(false);
  });

  it('approved under `auto` (loop-auto) moves Grooming -> Todo automatically, clears the verdict, and stops', async () => {
    seedGrooming('AP-1');
    await startPlanGateNow('AP-1', { mode: 'loop-auto' });
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['AP-1'].planReviewState = 'approved';
    await gateRunnerTick();
    expect(isGateRunning('AP-1')).toBe(false);
    expect(getWorkspace().tasks['AP-1'].status).toBe('Todo');
    expect(getWorkspace().tasks['AP-1'].planReviewState).toBeNull();
    expect(getWorkspace().tasks['AP-1'].planGateRunning).toBeUndefined();
  });

  it('approved under a one-shot pass stops WITHOUT moving status — never auto-confirms', async () => {
    seedGrooming('OS-AP-1');
    await startPlanGateNow('OS-AP-1', { mode: 'one-pass' });
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['OS-AP-1'].planReviewState = 'approved';
    await gateRunnerTick();
    expect(isGateRunning('OS-AP-1')).toBe(false);
    expect(getWorkspace().tasks['OS-AP-1'].status).toBe('Grooming');
    expect(getWorkspace().tasks['OS-AP-1'].planReviewState).toBe('approved');
    expect(getWorkspace().tasks['OS-AP-1'].planGateRunning).toBeUndefined();
    // FLUX-1273: an accurate, plan-specific needsAction — not left to the generic FLUX-651 backstop's
    // "ended its turn without a board action" message, which reads as if the agent did nothing.
    expect(getWorkspace().tasks['OS-AP-1'].needsAction).toMatch(/verdict: approved/i);
  });

  it('dispatches a `grooming`-phase revise pass on changes-requested within the retry cap, under `auto` (loop-auto)', async () => {
    seedGrooming('CR-1');
    await startPlanGateNow('CR-1', { mode: 'loop-auto' });
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['CR-1'].planReviewState = 'changes-requested';
    dispatchSession.mockClear();
    await gateRunnerTick();
    expect(dispatchSession).toHaveBeenCalledWith('CR-1', 'grooming', expect.objectContaining({ skipIsolation: true }));
    expect(getWorkspace().tasks['CR-1'].planGateAttempts).toBe(1);
    expect(isGateRunning('CR-1')).toBe(true);
  });

  it('a one-shot changes-requested pass stops WITHOUT an auto-revise (Auto→You never loops)', async () => {
    seedGrooming('OS-CR-1');
    await startPlanGateNow('OS-CR-1', { mode: 'one-pass' });
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['OS-CR-1'].planReviewState = 'changes-requested';
    dispatchSession.mockClear();
    await gateRunnerTick();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(isGateRunning('OS-CR-1')).toBe(false);
    expect(getWorkspace().tasks['OS-CR-1'].status).toBe('Grooming');
    expect(getWorkspace().tasks['OS-CR-1'].planReviewState).toBe('changes-requested');
    // FLUX-1273: same accurate needsAction on the changes-requested one-shot stop.
    expect(getWorkspace().tasks['OS-CR-1'].needsAction).toMatch(/verdict: changes requested/i);
  });

  // FLUX-1288: `auto-then-you` (`loop-confirm`) loops changes-requested -> revise -> re-review just like
  // `auto`, but an approved verdict stops the loop and flags a human instead of auto-moving.
  it('dispatches a `grooming`-phase revise pass on changes-requested within the retry cap, under `loop-confirm`', async () => {
    seedGrooming('LC-CR-1');
    await startPlanGateNow('LC-CR-1', { mode: 'loop-confirm' });
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['LC-CR-1'].planReviewState = 'changes-requested';
    dispatchSession.mockClear();
    await gateRunnerTick();
    expect(dispatchSession).toHaveBeenCalledWith('LC-CR-1', 'grooming', expect.objectContaining({ skipIsolation: true }));
    expect(getWorkspace().tasks['LC-CR-1'].planGateAttempts).toBe(1);
    expect(isGateRunning('LC-CR-1')).toBe(true);
  });

  it('approved under `loop-confirm` stops WITHOUT moving status and flags the human to confirm', async () => {
    seedGrooming('LC-AP-1');
    await startPlanGateNow('LC-AP-1', { mode: 'loop-confirm' });
    putSession('sess-1', 'review', 'completed');
    getWorkspace().tasks['LC-AP-1'].planReviewState = 'approved';
    await gateRunnerTick();
    expect(isGateRunning('LC-AP-1')).toBe(false);
    expect(getWorkspace().tasks['LC-AP-1'].status).toBe('Grooming');
    expect(getWorkspace().tasks['LC-AP-1'].planReviewState).toBe('approved');
    expect(getWorkspace().tasks['LC-AP-1'].planGateRunning).toBeUndefined();
    expect(getWorkspace().tasks['LC-AP-1'].needsAction).toMatch(/verdict: approved/i);
  });

  it('parks (Grooming, gate-parked marker) after retryCap revise attempts still request changes', async () => {
    seedGrooming('PK-1');
    await startPlanGateNow('PK-1', { mode: 'loop-auto' }); // dispatch #1 -> sess-1 (review)
    let n = 1;
    for (let attempt = 1; attempt <= DEFAULT_RETRY_CAP; attempt++) {
      putSession(`sess-${n}`, 'review', 'completed');
      getWorkspace().tasks['PK-1'].planReviewState = 'changes-requested';
      await gateRunnerTick(); // dispatches a revise pass
      n += 1;
      putSession(`sess-${n}`, 'grooming', 'completed');
      await gateRunnerTick(); // dispatches the next review pass
      n += 1;
    }
    putSession(`sess-${n}`, 'review', 'completed');
    getWorkspace().tasks['PK-1'].planReviewState = 'changes-requested';
    await gateRunnerTick(); // retryCap exhausted -> park
    expect(parkTicketOnBoard).toHaveBeenCalledWith('PK-1', expect.stringContaining('plan review:'), expect.objectContaining({ status: 'Grooming' }));
    expect(isGateRunning('PK-1')).toBe(false);
  });

  // FLUX-1304: `advanceGateTicket`'s switch previously had no `case 'yield':` (and no `default:`), so a
  // `yield` action from `decideTicketAction` fell through silently — no park, but the run was never
  // stopped either, leaving `gateRuns` (and the durable `planGateRunning` field) wedged forever.
  it('a yield action stops the gate run WITHOUT parking (mirrors Temper)', async () => {
    seedGrooming('YLD-1');
    await startPlanGateNow('YLD-1', { mode: 'loop-auto' });
    putSession('sess-1', 'review', 'completed');
    forceYieldFor = 'YLD-1';
    await gateRunnerTick();
    expect(isGateRunning('YLD-1')).toBe(false);
    expect(getWorkspace().tasks['YLD-1'].planGateRunning).toBeUndefined();
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  // FLUX-1437: `decideTicketAction` returns `review-retry` (not an immediate park) the FIRST time a
  // review session completes with no verdict AND no verdict-shaped comment (the FLUX-1434 incident
  // shape — a reviewer that narrated a dead background/monitor wait instead of calling `change_status`).
  // Regression coverage for the gate-runner-specific blocker: `advanceGateTicket`'s switch previously had
  // no `case 'review-retry':`, so this action fell through silently — the run was never stopped and
  // `reviewNudgeSent` was never set, wedging the ticket in Grooming forever (re-derived every 5s tick).
  it('a review completed with no verdict and no verdict-shaped comment gets one review-retry pass, not an immediate park', async () => {
    seedGrooming('RR-1');
    await startPlanGateNow('RR-1', { mode: 'loop-auto' });
    putSession('sess-1', 'review', 'completed');
    dispatchSession.mockClear();
    await gateRunnerTick();
    expect(dispatchSession).toHaveBeenCalledWith('RR-1', 'review', expect.objectContaining({ skipIsolation: true }));
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
    expect(isGateRunning('RR-1')).toBe(true);
  });

  it('a second verdict-less review completion (after the review-retry budget is spent) parks', async () => {
    seedGrooming('RR-2');
    await startPlanGateNow('RR-2', { mode: 'loop-auto' }); // dispatch #1 -> sess-1
    putSession('sess-1', 'review', 'completed');
    await gateRunnerTick(); // review-retry -> dispatch #2 -> sess-2, reviewNudgeSent set true
    putSession('sess-2', 'review', 'completed');
    await gateRunnerTick(); // budget spent -> park
    expect(parkTicketOnBoard).toHaveBeenCalledWith('RR-2', expect.stringContaining('plan review:'), expect.objectContaining({ status: 'Grooming' }));
    expect(isGateRunning('RR-2')).toBe(false);
  });

  it('parks when the review session dies', async () => {
    seedGrooming('PKF-1');
    await startPlanGateNow('PKF-1', { mode: 'loop-auto' });
    putSession('sess-1', 'review', 'failed');
    await gateRunnerTick();
    expect(parkTicketOnBoard).toHaveBeenCalledWith('PKF-1', expect.stringContaining('plan review:'), expect.objectContaining({ status: 'Grooming' }));
    expect(isGateRunning('PKF-1')).toBe(false);
  });

  it('rehydrates an in-flight run from frontmatter after an engine restart', () => {
    getWorkspace().tasks['RH-1'] = { id: 'RH-1', status: 'Grooming', title: 'RH-1', planGateRunning: true, planGateAttempts: 1, planGateMode: 'loop-auto' };
    expect(isGateRunning('RH-1')).toBe(false);
    rehydrateGateRunner();
    expect(isGateRunning('RH-1')).toBe(true);
  });

  // FLUX-1288: rehydrate must resolve the correct `PlanGateMode` — from the current `planGateMode`
  // field, or (for a ticket already mid-loop when this upgrade deploys) mapped from the legacy
  // `planGateOneShot` boolean — driven behaviorally: a rehydrated entry has no in-memory
  // `currentSessionId`, so its first tick redrives a fresh review session (mirrors a real restart);
  // completing THAT session with a verdict then exercises the resolved mode's terminal behavior.
  it('rehydrates `planGateMode: "loop-confirm"` and stops-and-flags (not auto-move) on approval', async () => {
    getWorkspace().tasks['RH-LC'] = { id: 'RH-LC', status: 'Grooming', title: 'RH-LC', planGateRunning: true, planGateAttempts: 0, planGateMode: 'loop-confirm' };
    rehydrateGateRunner();
    expect(isGateRunning('RH-LC')).toBe(true);
    await gateRunnerTick(); // no session on record -> redrives a fresh review session
    putSession(`sess-${sessionSeq}`, 'review', 'completed');
    getWorkspace().tasks['RH-LC'].planReviewState = 'approved';
    await gateRunnerTick();
    expect(isGateRunning('RH-LC')).toBe(false);
    expect(getWorkspace().tasks['RH-LC'].status).toBe('Grooming');
    expect(getWorkspace().tasks['RH-LC'].planReviewState).toBe('approved');
    expect(getWorkspace().tasks['RH-LC'].needsAction).toMatch(/verdict: approved/i);
  });

  it('rehydrates a legacy `planGateOneShot: true` ticket as `one-pass` — stops without auto-revise', async () => {
    getWorkspace().tasks['RH-LEGACY-OS'] = { id: 'RH-LEGACY-OS', status: 'Grooming', title: 'RH-LEGACY-OS', planGateRunning: true, planGateAttempts: 0, planGateOneShot: true };
    rehydrateGateRunner();
    expect(isGateRunning('RH-LEGACY-OS')).toBe(true);
    await gateRunnerTick(); // redrives a fresh review session
    putSession(`sess-${sessionSeq}`, 'review', 'completed');
    getWorkspace().tasks['RH-LEGACY-OS'].planReviewState = 'changes-requested';
    dispatchSession.mockClear();
    await gateRunnerTick();
    expect(dispatchSession).not.toHaveBeenCalled();
    expect(isGateRunning('RH-LEGACY-OS')).toBe(false);
  });

  it('rehydrates a legacy ticket with no `planGateOneShot`/`planGateMode` as `loop-auto`', async () => {
    getWorkspace().tasks['RH-LEGACY-AUTO'] = { id: 'RH-LEGACY-AUTO', status: 'Grooming', title: 'RH-LEGACY-AUTO', planGateRunning: true, planGateAttempts: 0 };
    rehydrateGateRunner();
    expect(isGateRunning('RH-LEGACY-AUTO')).toBe(true);
    await gateRunnerTick(); // redrives a fresh review session
    putSession(`sess-${sessionSeq}`, 'review', 'completed');
    getWorkspace().tasks['RH-LEGACY-AUTO'].planReviewState = 'approved';
    await gateRunnerTick();
    expect(isGateRunning('RH-LEGACY-AUTO')).toBe(false);
    expect(getWorkspace().tasks['RH-LEGACY-AUTO'].status).toBe('Todo');
  });

  // ── FLUX-1303: startPlanReviseNow — the atomic "Send for re-grooming" entry point ──────────────

  describe('startPlanReviseNow (FLUX-1303)', () => {
    it('dispatches a grooming revise session with the notes in the focus, stamps the verdict + hash, and registers the run', async () => {
      seedGrooming('RV-1', { body: 'plan body v1', planReviewState: 'approved' });
      const res = await startPlanReviseNow('RV-1', { notes: 'also fix the button color', user: 'Guy' });
      expect(res.ok).toBe(true);
      expect(isGateRunning('RV-1')).toBe(true);
      const t = getWorkspace().tasks['RV-1'];
      expect(t.planGateRunning).toBe(true);
      expect(t.planGateAttempts).toBe(1);
      // A revise of an approved plan is a human override — the verdict flips to changes-requested
      // (surfaces key their "Revising…" state off changes-requested + planGateRunning).
      expect(t.planReviewState).toBe('changes-requested');
      expect(typeof t.planReviewBodyHash).toBe('string');
      expect(dispatchSession).toHaveBeenCalledTimes(1);
      const [ticketId, phase, opts] = dispatchSession.mock.calls[0]!;
      expect(ticketId).toBe('RV-1');
      expect(phase).toBe('grooming');
      expect((opts as { focusComment: string }).focusComment).toContain('also fix the button color');
      expect((opts as { skipIsolation: boolean }).skipIsolation).toBe(true);
    });

    it('re-reviews the revision when the revise session completes (the loop machinery takes over)', async () => {
      seedGrooming('RV-2', { body: 'plan body', planReviewState: 'changes-requested' });
      getConfig().gatePolicy = { boardDefault: { plan: 'auto-then-you', review: 'you' } };
      const res = await startPlanReviseNow('RV-2', { user: 'Guy' });
      expect(res.ok).toBe(true);
      expect(getWorkspace().tasks['RV-2'].planGateMode).toBe('loop-confirm');
      putSession(`sess-${sessionSeq}`, 'grooming', 'completed');
      dispatchSession.mockClear();
      await gateRunnerTick();
      // revise completed → verdict cleared, fresh review pass dispatched
      expect(getWorkspace().tasks['RV-2'].planReviewState).toBeNull();
      expect(dispatchSession).toHaveBeenCalledWith('RV-2', 'review', expect.objectContaining({ skipIsolation: true }));
    });

    it("under a 'you' gate the revision gets exactly ONE re-review, then stops and flags the human", async () => {
      seedGrooming('RV-3', { body: 'plan body', planReviewState: 'changes-requested' });
      getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
      await startPlanReviseNow('RV-3', { user: 'Guy' });
      expect(getWorkspace().tasks['RV-3'].planGateMode).toBe('one-pass');
      putSession(`sess-${sessionSeq}`, 'grooming', 'completed');
      await gateRunnerTick(); // dispatches the single re-review
      putSession(`sess-${sessionSeq}`, 'review', 'completed');
      getWorkspace().tasks['RV-3'].planReviewState = 'changes-requested';
      dispatchSession.mockClear();
      await gateRunnerTick();
      // one-pass: a second changes-requested verdict stops the run instead of auto-revising again
      expect(dispatchSession).not.toHaveBeenCalled();
      expect(isGateRunning('RV-3')).toBe(false);
      expect(getWorkspace().tasks['RV-3'].needsAction).toMatch(/changes requested/i);
    });

    it('refuses when the ticket is not in Grooming or a run is already in flight', async () => {
      getWorkspace().tasks['RV-4'] = { id: 'RV-4', status: 'Todo', title: 'RV-4' };
      const wrong = await startPlanReviseNow('RV-4', { user: 'Guy' });
      expect(wrong.ok).toBe(false);
      expect(wrong.reason).toBe('wrong-status');

      seedGrooming('RV-5', { planReviewState: 'changes-requested' });
      await startPlanReviseNow('RV-5', { user: 'Guy' });
      const dup = await startPlanReviseNow('RV-5', { user: 'Guy' });
      expect(dup.ok).toBe(false);
      expect(dup.reason).toBe('already-running');
    });

    it('requires notes to override an APPROVED verdict (server-enforced, not just the portal buttons)', async () => {
      seedGrooming('RV-6', { planReviewState: 'approved' });
      const bare = await startPlanReviseNow('RV-6', { user: 'Guy' });
      expect(bare.ok).toBe(false);
      expect(bare.reason).toBe('notes-required');
      expect(getWorkspace().tasks['RV-6'].planReviewState).toBe('approved'); // untouched
      expect(dispatchSession).not.toHaveBeenCalled();
      const withNotes = await startPlanReviseNow('RV-6', { user: 'Guy', notes: 'the plan misses the migration step' });
      expect(withNotes.ok).toBe(true);
    });

    it('ABORTS (nothing dispatched, run dropped) when the persist fails — never a session against an unrecorded revise', async () => {
      seedGrooming('RV-7', { planReviewState: 'changes-requested' });
      const { updateTaskWithHistory } = await import('./task-store.js');
      vi.mocked(updateTaskWithHistory).mockRejectedValueOnce(new Error('EBUSY'));
      const res = await startPlanReviseNow('RV-7', { user: 'Guy', notes: 'fix it' });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('persist-failed');
      expect(isGateRunning('RV-7')).toBe(false);
      expect(dispatchSession).not.toHaveBeenCalled();
    });

    it('clears a stale gate-park require-input swimlane — the revise IS the answer', async () => {
      seedGrooming('RV-8', { planReviewState: 'changes-requested', swimlane: 'require-input' });
      await startPlanReviseNow('RV-8', { user: 'Guy', notes: 'redo step 2' });
      expect(getWorkspace().tasks['RV-8'].swimlane).toBeNull();
    });

    it('closes the tick-vs-revise race: a background tick firing before the notes-bearing dispatch must not redrive with a notes-less focus', async () => {
      // Pre-FLUX-1303 fix: the registry entry was visible to `gateRunnerTick` the instant it was
      // seeded, before the persist (`updateTaskWithHistory`) and the notes-bearing `spawnGate` below
      // it had run. A tick landing in that window saw "active state, no session yet" and redrove
      // via `decideTicketAction`'s `sessionStatus === undefined -> redrive` branch using the bare,
      // notes-less `PLAN_REVISE_FOCUS` — racing (and sometimes beating, or 409-ing) the notes-bearing
      // dispatch. `starting: true` on the registry entry now makes `reconcileGateTicket` skip the
      // ticket outright until the initial dispatch completes.
      seedGrooming('RV-9', { planReviewState: 'changes-requested' });
      const { updateTaskWithHistory } = await import('./task-store.js');
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
      vi.mocked(updateTaskWithHistory).mockImplementationOnce(async (taskId: string, options: { extraFields?: Record<string, unknown> }) => {
        await persistGate;
        const t = getWorkspace().tasks[taskId];
        if (t && options.extraFields) Object.assign(t, options.extraFields);
        return true;
      });

      // Not awaited yet — `startPlanReviseNow` seeds the registry synchronously, then suspends at
      // the persist await (held open by `persistGate`) before ever calling `spawnGate`.
      const revisePromise = startPlanReviseNow('RV-9', { notes: 'do not lose me', user: 'Guy' });
      expect(isGateRunning('RV-9')).toBe(true);
      expect(dispatchSession).not.toHaveBeenCalled();

      // Simulate the background tick firing in exactly this window.
      await gateRunnerTick();
      expect(dispatchSession).not.toHaveBeenCalled(); // starting guard skipped it — no redrive raced in

      releasePersist();
      const res = await revisePromise;
      expect(res.ok).toBe(true);
      expect(dispatchSession).toHaveBeenCalledTimes(1); // exactly the notes-bearing dispatch, no duplicate
      const [, , opts] = dispatchSession.mock.calls[0]!;
      expect((opts as { focusComment: string }).focusComment).toContain('do not lose me');
    });
  });

  // ── FLUX-1303: mid-run safety — runs stop when the ticket leaves Grooming; restarts resume the right phase ──

  it('stops a run when the ticket leaves Grooming mid-flight instead of re-reviewing a Todo ticket', async () => {
    seedGrooming('LG-1', { planReviewState: 'changes-requested' });
    await startPlanReviseNow('LG-1', { user: 'Guy' });
    expect(isGateRunning('LG-1')).toBe(true);
    getWorkspace().tasks['LG-1'].status = 'Todo'; // human approves anyway / drags the card while the revise runs
    await gateRunnerTick();
    expect(isGateRunning('LG-1')).toBe(false);
    expect(getWorkspace().tasks['LG-1'].planGateRunning).toBeUndefined();
  });

  it('rehydrates a run whose grooming REVISE session survived as reimplementing, not reviewing', async () => {
    getWorkspace().tasks['RH-RV'] = { id: 'RH-RV', status: 'Grooming', title: 'RH-RV', planGateRunning: true, planGateAttempts: 1, planGateMode: 'loop-confirm' };
    putSession('sess-live-revise', 'grooming', 'running');
    const { cliSessionsByTaskId } = await import('./session-store.js');
    cliSessionsByTaskId.set('RH-RV', ['sess-live-revise']);
    rehydrateGateRunner();
    expect(isGateRunning('RH-RV')).toBe(true);
    dispatchSession.mockClear();
    await gateRunnerTick();
    // A live grooming revise session ⇒ the run must WAIT on it — never redrive a CONCURRENT review
    // pass against the not-yet-revised plan (two agents writing the same ticket at once).
    expect(dispatchSession).not.toHaveBeenCalled();
    cliSessionsByTaskId.delete('RH-RV');
  });

  // ── FLUX-1320: eager verdict resolution — change_status stops a loop-terminal run the moment the
  // verdict persists (while the review session is still RUNNING), instead of waiting for the review
  // session to complete and the next 5s tick to observe it.

  describe('resolvePlanVerdictNow (FLUX-1320)', () => {
    it('approved under `loop-auto` moves Grooming -> Todo and stops synchronously, mid-session — no tick', async () => {
      seedGrooming('EG-1');
      await startPlanGateNow('EG-1', { mode: 'loop-auto' });
      putSession('sess-1', 'review', 'running'); // the reviewer is still mid-turn — the tick could not act yet
      getWorkspace().tasks['EG-1'].planReviewState = 'approved'; // what change_status just persisted
      await resolvePlanVerdictNow('EG-1', 'approved');
      expect(isGateRunning('EG-1')).toBe(false);
      expect(getWorkspace().tasks['EG-1'].status).toBe('Todo');
      expect(getWorkspace().tasks['EG-1'].planReviewState).toBeNull();
      expect(getWorkspace().tasks['EG-1'].planGateRunning).toBeUndefined();
    });

    it('approved under `loop-confirm` stops + flags with the tick path\'s exact needsAction, synchronously', async () => {
      seedGrooming('EG-2');
      await startPlanGateNow('EG-2', { mode: 'loop-confirm' });
      putSession('sess-1', 'review', 'running');
      getWorkspace().tasks['EG-2'].planReviewState = 'approved';
      await resolvePlanVerdictNow('EG-2', 'approved');
      expect(isGateRunning('EG-2')).toBe(false);
      expect(getWorkspace().tasks['EG-2'].status).toBe('Grooming');
      expect(getWorkspace().tasks['EG-2'].planReviewState).toBe('approved');
      expect(getWorkspace().tasks['EG-2'].planGateRunning).toBeUndefined();
      expect(getWorkspace().tasks['EG-2'].needsAction).toMatch(/verdict: approved/i);
    });

    it('changes-requested under `one-pass` stops + flags synchronously, never dispatching a revise', async () => {
      seedGrooming('EG-3');
      await startPlanGateNow('EG-3', { mode: 'one-pass' });
      putSession('sess-1', 'review', 'running');
      getWorkspace().tasks['EG-3'].planReviewState = 'changes-requested';
      dispatchSession.mockClear();
      await resolvePlanVerdictNow('EG-3', 'changes-requested');
      expect(dispatchSession).not.toHaveBeenCalled();
      expect(isGateRunning('EG-3')).toBe(false);
      expect(getWorkspace().tasks['EG-3'].planGateRunning).toBeUndefined();
      expect(getWorkspace().tasks['EG-3'].needsAction).toMatch(/verdict: changes requested/i);
    });

    it('changes-requested under a looping mode is NOT short-circuited — the tick still auto-revises', async () => {
      seedGrooming('EG-4');
      await startPlanGateNow('EG-4', { mode: 'loop-auto' });
      putSession('sess-1', 'review', 'running');
      getWorkspace().tasks['EG-4'].planReviewState = 'changes-requested';
      dispatchSession.mockClear();
      await resolvePlanVerdictNow('EG-4', 'changes-requested');
      expect(isGateRunning('EG-4')).toBe(true); // untouched — the revise must wait for the session to end
      expect(getWorkspace().tasks['EG-4'].planGateRunning).toBe(true);
      expect(dispatchSession).not.toHaveBeenCalled();
      // ...and once the review session actually completes, the ordinary tick dispatches the revise.
      putSession('sess-1', 'review', 'completed');
      await gateRunnerTick();
      expect(dispatchSession).toHaveBeenCalledWith('EG-4', 'grooming', expect.objectContaining({ skipIsolation: true }));
      expect(isGateRunning('EG-4')).toBe(true);
    });

    it('a tick firing after an eager stop is a no-op — no double-move, double-stop, or re-dispatch', async () => {
      seedGrooming('EG-5');
      await startPlanGateNow('EG-5', { mode: 'loop-auto' });
      putSession('sess-1', 'review', 'completed'); // even with the tick's own trigger condition met
      getWorkspace().tasks['EG-5'].planReviewState = 'approved';
      await resolvePlanVerdictNow('EG-5', 'approved');
      expect(getWorkspace().tasks['EG-5'].status).toBe('Todo');
      dispatchSession.mockClear();
      parkTicketOnBoard.mockClear();
      await gateRunnerTick();
      expect(getWorkspace().tasks['EG-5'].status).toBe('Todo');
      expect(dispatchSession).not.toHaveBeenCalled();
      expect(parkTicketOnBoard).not.toHaveBeenCalled();
      expect(isGateRunning('EG-5')).toBe(false);
    });

    it('no-ops for a verdict recorded while the run is mid-REVISE (a verdict only concludes a review pass)', async () => {
      seedGrooming('EG-6', { planReviewState: 'changes-requested' });
      await startPlanReviseNow('EG-6', { user: 'Guy' }); // registers the run in the reimplementing state
      expect(isGateRunning('EG-6')).toBe(true);
      await resolvePlanVerdictNow('EG-6', 'approved');
      expect(isGateRunning('EG-6')).toBe(true);
      expect(getWorkspace().tasks['EG-6'].status).toBe('Grooming');
      expect(getWorkspace().tasks['EG-6'].planGateRunning).toBe(true);
    });

    it('no-ops when no run is active (a manual verdict with the gate off)', async () => {
      seedGrooming('EG-7', { planReviewState: 'approved' });
      await resolvePlanVerdictNow('EG-7', 'approved');
      expect(getWorkspace().tasks['EG-7'].status).toBe('Grooming');
      expect(isGateRunning('EG-7')).toBe(false);
    });

    it('defers to the tick when the ticket already left Grooming mid-run (its stop note is the tick\'s)', async () => {
      seedGrooming('EG-8');
      await startPlanGateNow('EG-8', { mode: 'loop-auto' });
      getWorkspace().tasks['EG-8'].status = 'In Progress'; // human dragged the card out while the run was in flight
      getWorkspace().tasks['EG-8'].planReviewState = 'approved';
      await resolvePlanVerdictNow('EG-8', 'approved');
      expect(isGateRunning('EG-8')).toBe(true); // untouched — the next tick stops it with the left-Grooming note
      expect(getWorkspace().tasks['EG-8'].status).toBe('In Progress'); // and no onApproved move fired on top
    });

    it('defers to the tick when an active Furnace batch owns the ticket (the tick yields it)', async () => {
      seedGrooming('EG-9');
      await startPlanGateNow('EG-9', { mode: 'loop-auto' });
      const batch = await createFurnaceBatch({ title: 'b', tickets: [newBatchTicket('EG-9', 0, 'EG-9')] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; b.tickets[0]!.state = 'implementing'; });
      getWorkspace().tasks['EG-9'].planReviewState = 'approved';
      await resolvePlanVerdictNow('EG-9', 'approved');
      expect(isGateRunning('EG-9')).toBe(true);
      expect(getWorkspace().tasks['EG-9'].status).toBe('Grooming');
    });
  });
});

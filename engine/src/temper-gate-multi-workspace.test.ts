// FLUX-1548: regression coverage for the background-loop workspace-misroute fix. A second board
// being registered/active must not starve the DEFAULT board's Temper/plan-gate loops, and two boards
// sharing a ticket id must never bleed session/registry state into each other.
//
// `dispatchSession`/`resumeOrDispatchSession`/`parkTicketOnBoard`/`clearReviewState`/`clearGateVerdict`-
// adjacent furnace-stoker helpers are mocked (real fetch/git/file I/O); `updateTaskWithHistory` is mocked
// to apply writes into the real per-workspace `tasks` cache, honoring the explicit `ws` argument the
// FLUX-1548 changes now pass everywhere — the point of these tests is exactly that explicit `ws`
// threading, so the mock must not silently collapse it back to the ambient workspace.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWorkspace, getDefaultWorkspace, openWorkspace, closeWorkspace, liveWorkspaces, runWithWorkspace, type Workspace } from './workspace-context.js';
import { setWorkspaceRoot } from './workspace.js';

let sessionSeq = 0;
const dispatchSession = vi.fn(async (_ticketId: string, _phase: string, opts?: { workspaceRoot?: string | null }) => ({ sid: `sess-${++sessionSeq}`, workspaceRoot: opts?.workspaceRoot }));
const parkTicketOnBoard = vi.fn(async (_ticketId: string, _reason: string) => {});
const clearReviewState = vi.fn(async (_ticketId: string) => {});

vi.mock('./furnace-stoker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./furnace-stoker.js')>();
  return {
    ...actual,
    dispatchSession: (t: string, p: string, o?: { workspaceRoot?: string | null }) => dispatchSession(t, p, o),
    resumeOrDispatchSession: async (t: string, p: string, o?: { workspaceRoot?: string | null }) => {
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
  const updateTaskWithHistory = vi.fn(async (
    taskId: string,
    options: { extraFields?: Record<string, unknown>; deleteFields?: string[]; nextStatus?: string },
    ws?: unknown,
  ) => {
    const target = (ws as { tasks: Record<string, Record<string, unknown>> } | undefined) ?? getWs();
    const t = target.tasks[taskId];
    if (!t) return true;
    if (options.extraFields) Object.assign(t, options.extraFields);
    if (options.deleteFields) for (const f of options.deleteFields) delete t[f];
    if (options.nextStatus) t.status = options.nextStatus;
    return true;
  });
  return { ...actual, updateTaskWithHistory };
});

import { cliSessionsById, registerSession } from './session-store.js';
import { __resetFurnaceStoreForTests } from './furnace-store.js';
import { getConfig } from './config.js';
import { maybeStartTemper, temperTick, isTempering, __resetTemperForTests } from './temper.js';
import { startPlanGateNow, gateRunnerTick, isGateRunning, __resetGateRunnerForTests } from './gate-runner.js';
import type { CliSessionStatus } from './agents/types.js';

function putActiveSession(taskId: string, id: string, phase: 'review' | 'implementation', status: CliSessionStatus, workspaceRoot: string): void {
  cliSessionsById.set(id, { id, taskId, phase, status, workspaceRoot } as unknown as ReturnType<typeof cliSessionsById.get> & object);
  registerSession(taskId, id);
}

describe('Temper / plan gate — multi-workspace isolation (FLUX-1548)', () => {
  let defaultWs: Workspace;
  let otherWs: Workspace;

  beforeEach(() => {
    const bootRoot = `C:/eh-mw-boot-${Math.random().toString(36).slice(2)}`;
    setWorkspaceRoot(bootRoot); // binds `defaultWorkspace` (no registry entry yet — matches production boot)
    defaultWs = getDefaultWorkspace();
    for (const k of Object.keys(defaultWs.tasks)) delete defaultWs.tasks[k];

    otherWs = openWorkspace(`C:/eh-mw-other-${Math.random().toString(36).slice(2)}`); // registers + activates a 2nd board
    for (const k of Object.keys(otherWs.tasks)) delete otherWs.tasks[k];

    cliSessionsById.clear();
    __resetTemperForTests();
    __resetGateRunnerForTests();
    __resetFurnaceStoreForTests();
    dispatchSession.mockClear();
    parkTicketOnBoard.mockClear();
    clearReviewState.mockClear();
    sessionSeq = 0;
    // FLUX-1557: bind explicitly to `otherWs` rather than relying on the ambient/unbound
    // `getWorkspace()` fallback — that fallback is now deterministically `defaultWs`, not
    // whichever board was opened last, so an unbound `getConfig()` call here would seed the
    // WRONG board's config.
    runWithWorkspace(otherWs, () => {
      getConfig().gatePolicy = { boardDefault: { plan: 'auto', review: 'auto' } };
      getConfig().readyForMergeStatus = 'Ready';
      getConfig().requireInputStatus = 'Require Input';
    });
  });

  afterEach(async () => {
    if (otherWs.root) await closeWorkspace(otherWs.root);
  });

  it('liveWorkspaces() includes the default board even while a second board is registered/active', () => {
    // FLUX-1557: the unbound `getWorkspace()` fallback is deterministically the default board now,
    // never the just-opened one.
    expect(getWorkspace()).toBe(defaultWs);
    const live = liveWorkspaces();
    expect(live).toContain(defaultWs);
    expect(live).toContain(otherWs);
  });

  it('a temper-armed ticket on the DEFAULT board still dispatches its review while a second board is active', async () => {
    expect(getWorkspace()).toBe(defaultWs); // FLUX-1557: unbound resolution is the default board
    defaultWs.tasks['FLUX-1490'] = { id: 'FLUX-1490', status: 'Ready', title: 'FLUX-1490', branch: 'flux/FLUX-1490' };

    // The trigger itself must run bound to the default board (mirrors mcp-server.ts's `workspaceScope`
    // wrapping the request that owns this ticket) — that binding is what `maybeStartTemper` captures.
    const { runWithWorkspace } = await import('./workspace-context.js');
    await runWithWorkspace(defaultWs, () => maybeStartTemper('FLUX-1490', 'Ready', 'In Progress'));

    expect(isTempering('FLUX-1490', defaultWs)).toBe(true);
    expect(isTempering('FLUX-1490', otherWs)).toBe(false);
    expect(dispatchSession).toHaveBeenCalledWith('FLUX-1490', 'review', expect.objectContaining({ workspaceRoot: defaultWs.root }));

    // A subsequent tick (the background timer, unbound) must keep reconciling the default board's
    // entry even though `otherWs` is still the "active" one.
    dispatchSession.mockClear();
    putActiveSession('FLUX-1490', 'sess-1', 'review', 'completed', defaultWs.root!);
    await temperTick();
    expect(parkTicketOnBoard).not.toHaveBeenCalled(); // reconciled without falsely parking
  });

  it('same-id tickets on two boards temper independently — no cross-board session adoption', async () => {
    defaultWs.tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', title: 'FLUX-1', branch: 'flux/FLUX-1' };
    otherWs.tasks['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', title: 'FLUX-1', branch: 'flux/FLUX-1' };

    const { runWithWorkspace } = await import('./workspace-context.js');
    await runWithWorkspace(defaultWs, () => maybeStartTemper('FLUX-1', 'Ready', 'In Progress'));
    await runWithWorkspace(otherWs, () => maybeStartTemper('FLUX-1', 'Ready', 'In Progress'));

    expect(isTempering('FLUX-1', defaultWs)).toBe(true);
    expect(isTempering('FLUX-1', otherWs)).toBe(true);

    // Drop the tracked session id on the DEFAULT board's entry so its reconcile pass falls back to
    // session ADOPTION (`getActiveSessionsForTaskInWorkspace`) — the exact path a same-id collision
    // could leak through. Only `otherWs`'s live session exists for this ticket id.
    dispatchSession.mockClear();
    putActiveSession('FLUX-1', 'sess-other-live', 'review', 'running', otherWs.root!);
    await temperTick();

    // The default board's entry must NOT have adopted the other board's session, and must have
    // re-dispatched its own fresh review instead (redrive) rather than silently waiting on a foreign
    // one. `otherWs`'s entry DID adopt its own live session, so exactly one redrive happens total.
    expect(dispatchSession).toHaveBeenCalledTimes(1);
    expect(dispatchSession).toHaveBeenCalledWith('FLUX-1', 'review', expect.objectContaining({ workspaceRoot: defaultWs.root }));
  });

  it('a plan-gate run on the DEFAULT board dispatches with the default board\'s workspaceRoot while a second board is active', async () => {
    expect(getWorkspace()).toBe(defaultWs); // FLUX-1557: unbound resolution is the default board
    defaultWs.tasks['FLUX-2000'] = { id: 'FLUX-2000', status: 'Grooming', title: 'FLUX-2000', body: 'plan body' };

    const { runWithWorkspace } = await import('./workspace-context.js');
    const result = await runWithWorkspace(defaultWs, () => startPlanGateNow('FLUX-2000', { mode: 'loop-auto' }));

    expect(result.ok).toBe(true);
    expect(isGateRunning('FLUX-2000', defaultWs)).toBe(true);
    expect(isGateRunning('FLUX-2000', otherWs)).toBe(false);
    expect(dispatchSession).toHaveBeenCalledWith('FLUX-2000', 'review', expect.objectContaining({ workspaceRoot: defaultWs.root }));

    dispatchSession.mockClear();
    await gateRunnerTick(); // background tick, unbound — must still reconcile the default board's run
    expect(parkTicketOnBoard).not.toHaveBeenCalled();
  });

  // FLUX-1551 delta-3: getConfig() resolves via getWorkspace() (config.ts), so a background tick that
  // fails to bind ALS to the ticket's OWNING board would silently read whichever board is "active"
  // instead. Pins that a trigger bound via runWithWorkspace resolves the BOUND board's config even
  // when the two boards' readyForMergeStatus/gatePolicy genuinely diverge and a third board is active.
  it('a bound trigger reads the OWNING board\'s config (readyForMergeStatus/gatePolicy), not the active board\'s', async () => {
    const { runWithWorkspace } = await import('./workspace-context.js');
    // Diverge defaultWs's config from otherWs's (which keeps 'Ready'/review:'auto' from the outer beforeEach).
    await runWithWorkspace(defaultWs, async () => {
      getConfig().readyForMergeStatus = 'Approved';
      getConfig().gatePolicy = { boardDefault: { plan: 'auto', review: 'auto' } };
    });
    // FLUX-1557: unbound resolution is deterministically the default board now, so this no longer
    // demonstrates a divergence from `otherWs` — kept as a sanity check that the fix didn't regress.
    expect(getWorkspace()).toBe(defaultWs);

    defaultWs.tasks['FLUX-3000'] = { id: 'FLUX-3000', status: 'Approved', title: 'FLUX-3000', branch: 'flux/FLUX-3000' };

    // maybeStartTemper's entry guard only arms on `newStatus === readyStatus()`. If this resolved the
    // ACTIVE board's config (otherWs: 'Ready') instead of the bound one (defaultWs: 'Approved'), the
    // literal 'Approved' passed below would never match and Temper would never arm — the exact
    // misroute this test locks out.
    await runWithWorkspace(defaultWs, () => maybeStartTemper('FLUX-3000', 'Approved', 'In Progress'));

    expect(isTempering('FLUX-3000', defaultWs)).toBe(true);
    expect(dispatchSession).toHaveBeenCalledWith('FLUX-3000', 'review', expect.objectContaining({ workspaceRoot: defaultWs.root }));
  });
});

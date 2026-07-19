import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

// FLUX-1563: the initial-spawn crash handler (`raiseNeedsAction`, claude-code.ts's `proc.on('exit')`)
// and the clean-but-parked handler (`flagIfParked`, `finalizeTerminalSession`) both fire from a raw
// child_process event with no ambient `runWithWorkspace` binding. Left unbound, `getWorkspace()`
// resolves to the DEFAULT board (FLUX-1557) rather than the session's OWNING board, so a background
// board's crashed/parked session flags + notifies the wrong ticket record entirely.
//
// Unlike claude-code-needs-action.test.ts (which mocks parked-ticket.js wholesale and only checks
// `raiseNeedsAction` was called with the right message), this file keeps parked-ticket.ts, history.ts
// and notifications.ts REAL so the actual `getWorkspace()` resolution is exercised end-to-end across
// two live `Workspace` instances — the only way to prove the flag/notification land on the correct one.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../workspace.js', () => ({
  getWorkspaceRoot: () => '/tmp/board-A',
  getActiveFluxDir: () => '/tmp/board-A/.flux',
  getTaskAssetsDir: () => '/tmp/board-A/.flux/assets',
}));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, getConfig: () => ({}) };
});
// Real parked-ticket.ts writes the needsAction flag via task-store's updateTaskWithHistory — fake it
// with a workspace-aware in-memory mutation (mirrors the real implementation's default `ws =
// getWorkspace()` param) instead of hitting the filesystem, while still respecting whichever
// workspace is ambient (or explicitly passed) at call time — the exact thing this ticket's fix binds.
vi.mock('../task-store.js', () => ({
  updateTaskWithHistory: vi.fn(async (taskId: string, options: { extraFields?: Record<string, unknown> }, ws?: unknown) => {
    const { getWorkspace } = await import('../workspace-context.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetWs = (ws as any) ?? getWorkspace();
    const task = targetWs.tasks[taskId];
    if (task && options.extraFields) Object.assign(task, options.extraFields);
  }),
  updateAgentSession: vi.fn().mockResolvedValue(undefined),
  estimateCostUSD: vi.fn(() => 0),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../session-store.js', () => ({
  cliSessionsById: new Map(),
  cliSessionIdByTaskId: { get: vi.fn() },
  notifyGroupSessionTerminal: vi.fn(),
  notifyDelegationComplete: vi.fn(),
  checkAutoRestart: vi.fn(),
  getPendingCombiner: vi.fn(() => undefined),
}));
// Keep generateNeedsActionNotification/getNotifications REAL — only stub the two health-check calls
// that would otherwise scan the real filesystem for framework/skill installs.
vi.mock('../notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notifications.js')>();
  return { ...actual, checkFrameworkHealth: vi.fn().mockResolvedValue(undefined), checkSkillStaleness: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
vi.mock('./shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared.js')>();
  return {
    ...actual,
    checkBinaryInstalled: vi.fn().mockResolvedValue(undefined),
    resolveClaudeExePath: vi.fn().mockResolvedValue('C:\\fake\\claude.exe'),
  };
});

function fakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  proc.pid = 4242;
  return proc;
}

function fakeSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  const session = {
    id: 'sess-1',
    taskId: 'FLUX-TEST',
    framework: 'claude',
    status: 'running',
    command: 'claude',
    args: [] as string[],
    startedAt: new Date().toISOString(),
    label: 'Test Agent',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    ...overrides,
  };
  return session as unknown as CliSessionRecord;
}

describe('claude-code.ts — needsAction/notification binds to the OWNING board, not the default (FLUX-1563)', () => {
  let lastProc: ReturnType<typeof fakeChildProcess> | undefined;
  const boardARoot = '/tmp/board-A';
  const boardBRoot = '/tmp/board-B';

  beforeEach(async () => {
    vi.clearAllMocks();
    lastProc = undefined;
    const { spawn } = await import('child_process');
    vi.mocked(spawn).mockImplementation((() => {
      lastProc = fakeChildProcess();
      return lastProc as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);

    const { clearNotifications } = await import('../notifications.js');
    clearNotifications();
  });

  afterEach(async () => {
    const { closeWorkspace } = await import('../workspace-context.js');
    await closeWorkspace(boardBRoot);
  });

  /** Board A is the default/"active" board (what unbound `getWorkspace()` now resolves to per
   *  FLUX-1557); Board B is a second, non-default board that is NOT ambiently active. Both carry a
   *  same-numbered ticket so a misroute is observable as a flag/notification landing on the WRONG
   *  board's record instead of just silently vanishing. */
  async function seedTwoBoards() {
    const { getDefaultWorkspace, openWorkspace } = await import('../workspace-context.js');
    const wsA = getDefaultWorkspace();
    wsA.root = boardARoot;
    wsA.tasks['FLUX-TEST'] = { status: 'In Progress' };
    const wsB = openWorkspace(boardBRoot);
    wsB.tasks['FLUX-TEST'] = { status: 'In Progress' };
    return { wsA, wsB };
  }

  it('a crashed initial spawn on board B flags + notifies board B, not the default board A', async () => {
    const { wsA, wsB } = await seedTwoBoards();
    const { startCliSession } = await import('./claude-code.js');
    const { getNotifications } = await import('../notifications.js');
    const session = fakeSession();

    // Dispatched against board B's root — no runWithWorkspace wrapper here, matching how the real
    // child-process 'exit' event fires with no ambient binding of its own.
    await startCliSession(session, { status: 'In Progress' }, '', '', boardBRoot);
    expect(lastProc).toBeDefined();

    lastProc!.emit('exit', 1, null);
    await vi.waitFor(() => expect(wsB.tasks['FLUX-TEST'].needsAction).toBeTruthy());

    expect(wsA.tasks['FLUX-TEST'].needsAction).toBeFalsy();
    expect(getNotifications(wsB).some((n) => n.ticketId === 'FLUX-TEST')).toBe(true);
    expect(getNotifications(wsA).some((n) => n.ticketId === 'FLUX-TEST')).toBe(false);
  });

  it('a clean turn left parked on board B flags + notifies board B, not the default board A', async () => {
    const { wsA, wsB } = await seedTwoBoards();
    const { startCliSession } = await import('./claude-code.js');
    const { getNotifications } = await import('../notifications.js');
    const session = fakeSession();

    await startCliSession(session, { status: 'In Progress' }, '', '', boardBRoot);
    expect(lastProc).toBeDefined();

    // Clean exit (code 0) with the ticket still "In Progress" (no board action taken this turn) —
    // finalizeTerminalSession's flagIfParked call, not the crash-path raiseNeedsAction call.
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(wsB.tasks['FLUX-TEST'].needsAction).toBeTruthy());

    expect(wsA.tasks['FLUX-TEST'].needsAction).toBeFalsy();
    expect(getNotifications(wsB).some((n) => n.ticketId === 'FLUX-TEST')).toBe(true);
    expect(getNotifications(wsA).some((n) => n.ticketId === 'FLUX-TEST')).toBe(false);
  });
});

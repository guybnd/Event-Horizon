import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

// FLUX-1113 (S10 follow-up to FLUX-996/FLUX-1006): the initial-spawn and resume 'error'/'exit'
// handlers in claude-code.ts each raise the board's `needsAction` backstop via
// parked-ticket.raiseNeedsAction directly — a crashed spawn never runs long enough to trip the
// normal turn-end parked-ticket check, so this wiring was previously untested. These tests exercise
// startCliSession/sendCliSessionInput end-to-end against a faked child_process, asserting the real
// handler code calls raiseNeedsAction with the expected message — and lock the FLUX-1109/FLUX-1113
// telemetryEmitted guard that stops a late, spurious 'error' (firing after a healthy 'exit' already
// resolved the spawn) from overriding a ticket that actually succeeded.
//
// Every dependency below is mocked wholesale EXCEPT task-worktree.ts's execution-root resolvers
// (deliberately left real — a branchless task makes them return `workspaceRoot` synchronously with
// no git calls, so they're exercised for free) and shared.ts (kept real apart from the two functions
// that would otherwise hit the real filesystem/PATH: checkBinaryInstalled and resolveClaudeExePath).
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../workspace.js', () => ({
  workspaceRoot: '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
  getTaskAssetsDir: () => '/tmp/test-repo/.flux/assets',
}));
vi.mock('../config.js', () => ({ configCache: {} }));
vi.mock('../task-store.js', () => ({
  tasksCache: {} as Record<string, unknown>,
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
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
}));
vi.mock('../history.js', () => ({
  buildActivityEntry: vi.fn((comment: string) => ({ type: 'activity', comment })),
  buildCommentEntry: vi.fn((user: string, comment: string, date: string) => ({ type: 'comment', user, comment, date })),
  buildAgentMessageEntry: vi.fn(),
  buildAgentSessionEntry: vi.fn(() => ({ sessionId: 'test-session-entry', progress: [] })),
  appendSessionProgress: vi.fn(),
  closeAgentSession: vi.fn(),
}));
vi.mock('../notifications.js', () => ({
  checkFrameworkHealth: vi.fn().mockResolvedValue(undefined),
  checkSkillStaleness: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
vi.mock('../parked-ticket.js', () => ({
  captureTurnStartState: vi.fn(),
  clearNeedsActionIfSet: vi.fn().mockResolvedValue(undefined),
  flagIfParked: vi.fn().mockResolvedValue(undefined),
  raiseNeedsAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared.js')>();
  return {
    ...actual,
    checkBinaryInstalled: vi.fn().mockResolvedValue(undefined),
    resolveClaudeExePath: vi.fn().mockResolvedValue('C:\\fake\\claude.exe'),
  };
});

/** A bare EventEmitter stands in for the spawned CLI's ChildProcess, same rationale as
 *  adapter-contract.test.ts's fakeProc — the code under test only ever calls
 *  `.stdout!.on('data', …)`, `.stderr!.on('data', …)`, `.on('error', …)`, and `.on('exit', …)`. */
function fakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
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

describe('claude-code.ts — raiseNeedsAction wiring for a crashed spawn/resume (FLUX-1113)', () => {
  let lastProc: ReturnType<typeof fakeChildProcess> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastProc = undefined;
    const { spawn } = await import('child_process');
    vi.mocked(spawn).mockImplementation((() => {
      lastProc = fakeChildProcess();
      return lastProc as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
    const { tasksCache } = await import('../task-store.js');
    for (const key of Object.keys(tasksCache)) delete (tasksCache as Record<string, unknown>)[key];
  });

  describe('initial spawn (startCliSession)', () => {
    it('raises needsAction when the process never manages to start ("error")', async () => {
      const { startCliSession } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = fakeSession();

      await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
      expect(lastProc).toBeDefined();

      lastProc!.emit('error', new Error('spawn ENOENT'));
      await vi.waitFor(() => expect(raiseNeedsAction).toHaveBeenCalled());

      expect(raiseNeedsAction).toHaveBeenCalledWith('FLUX-TEST', 'Failed to start agent: spawn ENOENT');
    });

    it('raises needsAction when the process exits non-zero with no prior "error"', async () => {
      const { startCliSession } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = fakeSession();

      await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
      expect(lastProc).toBeDefined();

      lastProc!.emit('exit', 1, null);
      await vi.waitFor(() => expect(raiseNeedsAction).toHaveBeenCalled());

      expect(raiseNeedsAction).toHaveBeenCalledWith('FLUX-TEST', 'Agent process exited unexpectedly (exit code 1).');
    });

    it('does NOT raise needsAction on a healthy (code 0) exit', async () => {
      const { startCliSession } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = fakeSession();

      await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
      lastProc!.emit('exit', 0, null);
      // Let the async exit handler's microtasks settle before asserting the negative.
      await new Promise((r) => setTimeout(r, 20));

      expect(raiseNeedsAction).not.toHaveBeenCalled();
    });

    // FLUX-1113 item 3: Node can fire BOTH 'error' and 'exit' for one spawn. Before this fix, the
    // 'error' handler's raiseNeedsAction call was unconditional, so a healthy 'exit' that fires
    // FIRST (setting telemetryEmitted, itself correctly skipping raiseNeedsAction) could still be
    // overridden by a later spurious 'error' incorrectly flagging a ticket that actually succeeded.
    it('does NOT raise needsAction from a late "error" after a healthy "exit" already fired', async () => {
      const { startCliSession } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = fakeSession();

      await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
      lastProc!.emit('exit', 0, null);
      await new Promise((r) => setTimeout(r, 20));
      lastProc!.emit('error', new Error('late spurious error'));
      await new Promise((r) => setTimeout(r, 20));

      expect(raiseNeedsAction).not.toHaveBeenCalled();
    });
  });

  describe('resume (sendCliSessionInput)', () => {
    async function seedResumableSession(overrides: Partial<CliSessionRecord> = {}) {
      const { tasksCache } = await import('../task-store.js');
      (tasksCache as Record<string, unknown>)['FLUX-TEST'] = { status: 'In Progress' };
      return fakeSession({
        sessionHistoryEntry: {
          type: 'agent_session', sessionId: 'test-session-entry', startedAt: new Date().toISOString(),
          status: 'active', progress: [], user: 'Guy', date: new Date().toISOString(),
        },
        ...overrides,
      });
    }

    it('raises needsAction when the reply process never manages to start ("error")', async () => {
      const { sendCliSessionInput } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = await seedResumableSession();

      await sendCliSessionInput(session, 'continue please', 'Guy', '/tmp/test-repo');
      expect(lastProc).toBeDefined();

      lastProc!.emit('error', new Error('spawn EAGAIN'));
      await vi.waitFor(() => expect(raiseNeedsAction).toHaveBeenCalled());

      expect(raiseNeedsAction).toHaveBeenCalledWith('FLUX-TEST', 'Failed to resume agent: spawn EAGAIN');
    });

    it('raises needsAction when the reply process exits non-zero', async () => {
      const { sendCliSessionInput } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = await seedResumableSession();

      await sendCliSessionInput(session, 'continue please', 'Guy', '/tmp/test-repo');
      expect(lastProc).toBeDefined();

      lastProc!.emit('exit', 1, null);
      await vi.waitFor(() => expect(raiseNeedsAction).toHaveBeenCalled());

      expect(raiseNeedsAction).toHaveBeenCalledWith('FLUX-TEST', 'Test Agent reply ended with code 1.');
    });

    it('does NOT raise needsAction on a healthy (code 0) reply exit', async () => {
      const { sendCliSessionInput } = await import('./claude-code.js');
      const { raiseNeedsAction } = await import('../parked-ticket.js');
      const session = await seedResumableSession();

      await sendCliSessionInput(session, 'continue please', 'Guy', '/tmp/test-repo');
      lastProc!.emit('exit', 0, null);
      await new Promise((r) => setTimeout(r, 20));

      expect(raiseNeedsAction).not.toHaveBeenCalled();
    });
  });
});

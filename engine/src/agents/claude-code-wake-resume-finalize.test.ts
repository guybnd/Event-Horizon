import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

// FLUX-1390 review follow-up: `tryEnterScheduledWake`/`captureScheduledWakeup` (the pure staging
// helpers) already have unit coverage in claude-code-scheduled-wake.test.ts, but the exit-handler
// wiring AROUND them — specifically what happens when a wake-resumed turn finishes cleanly and does
// NOT go back to sleep — was untested. That "resume -> finish" path is the normal end-to-end shape of
// this feature (sleep once, wake, finish) and previously only set the in-memory session.status/endedAt
// without flushing token/cost accounting into the task's tokenMetadata or closing the persisted
// `agent_session` history entry (review comment on FLUX-1390, 2026-07-11). These tests exercise
// sendCliSessionInput end-to-end against a faked child_process (same harness as
// claude-code-needs-action.test.ts) and assert the real `finalizeTerminalSession` helper runs.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../workspace.js', () => ({
  getWorkspaceRoot: () => '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
  getTaskAssetsDir: () => '/tmp/test-repo/.flux/assets',
}));
vi.mock('../config.js', () => ({ getConfig: vi.fn(() => ({})) }));
vi.mock('../task-store.js', () => ({
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
    status: 'scheduled',
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
    // A wake-resumed session carries token usage from its PRIOR (sleeping) turn, same as any
    // resumed session — this is what must reach the task's cumulative tokenMetadata on finalize.
    inputTokens: 1234,
    outputTokens: 567,
    costUSD: 0.05,
    ...overrides,
  };
  return session as unknown as CliSessionRecord;
}

describe('claude-code.ts — wake-resume finalization (FLUX-1390 review follow-up)', () => {
  let lastProc: ReturnType<typeof fakeChildProcess> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastProc = undefined;
    const { spawn } = await import('child_process');
    vi.mocked(spawn).mockImplementation((() => {
      lastProc = fakeChildProcess();
      return lastProc as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
    const { getWorkspace } = await import('../workspace-context.js');
    for (const key of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[key];
    getWorkspace().tasks['FLUX-TEST'] = { status: 'In Progress' };
  });

  async function seedScheduledSession(overrides: Partial<CliSessionRecord> = {}) {
    return fakeSession({
      // AgentSessionEntry's typed `status` union doesn't include 'scheduled' (only the untyped
      // Record<string, unknown> updater callback in updateAgentSession sets it at runtime) — 'active'
      // is the persisted-at-rest status a real scheduled session's history entry carries.
      sessionHistoryEntry: {
        type: 'agent_session', sessionId: 'test-session-entry', startedAt: new Date().toISOString(),
        status: 'active', progress: [], user: 'Guy', date: new Date().toISOString(),
      },
      ...overrides,
    });
  }

  it('a clean wake-resumed turn that does not sleep again closes the history entry, flushes tokens, and finalizes completed', async () => {
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { updateAgentSession, updateTaskWithHistory } = await import('../task-store.js');
    const { flagIfParked } = await import('../parked-ticket.js');
    const { notifyDelegationComplete, checkAutoRestart } = await import('../session-store.js');
    const session = await seedScheduledSession();

    await sendCliSessionInput(session, 'wake', 'Guy', '/tmp/test-repo', { wakeResume: true });
    expect(lastProc).toBeDefined();
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(updateAgentSession).toHaveBeenCalled());
    // finalizeTerminalSession keeps awaiting past updateAgentSession (updateTaskWithHistory,
    // flagIfParked, notifyDelegationComplete, checkAutoRestart) — give those a tick to settle too.
    await new Promise((r) => setTimeout(r, 20));

    // In-memory session state finalized (not left dangling at 'scheduled').
    expect(session.status).toBe('completed');
    expect(session.endedAt).toBeDefined();

    // The persisted agent_session history entry must be closed out — not left frozen at 'scheduled'.
    expect(updateAgentSession).toHaveBeenCalledWith('FLUX-TEST', 'test-session-entry', expect.any(Function));
    const historyUpdater = vi.mocked(updateAgentSession).mock.calls[0]![2];
    const entry: Record<string, unknown> = { status: 'scheduled', progress: [] };
    historyUpdater(entry);
    expect(entry.status).toBe('completed');

    // Token/cost accounting from the final wake-resumed turn must reach the task's tokenMetadata.
    expect(updateTaskWithHistory).toHaveBeenCalledWith(
      'FLUX-TEST',
      expect.objectContaining({
        tokenMetadata: expect.objectContaining({ inputTokens: 1234, outputTokens: 567 }),
      }),
    );

    // Same terminal bookkeeping a fresh dispatch's completion gets.
    expect(flagIfParked).toHaveBeenCalledWith(session, 'FLUX-TEST');
    expect(notifyDelegationComplete).toHaveBeenCalledWith(session);
    expect(checkAutoRestart).toHaveBeenCalled();
  });

  it('a crashed wake-resumed turn (no further sleep) finalizes failed and closes the history entry', async () => {
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { updateAgentSession } = await import('../task-store.js');
    const session = await seedScheduledSession();

    await sendCliSessionInput(session, 'wake', 'Guy', '/tmp/test-repo', { wakeResume: true });
    lastProc!.emit('exit', 1, null);
    await vi.waitFor(() => expect(updateAgentSession).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(session.status).toBe('failed');
    expect(session.endedAt).toBeDefined();

    const historyUpdater = vi.mocked(updateAgentSession).mock.calls[0]![2];
    const entry: Record<string, unknown> = { status: 'scheduled', progress: [] };
    historyUpdater(entry);
    expect(entry.status).toBe('failed');
  });

  it('a wake-resumed turn that schedules ANOTHER wakeup does not finalize — stays scheduled', async () => {
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { updateAgentSession } = await import('../task-store.js');
    const session = await seedScheduledSession({ pendingWakeAt: new Date(Date.now() + 60_000).toISOString() });
    // The flag must be on for tryEnterScheduledWake to honor the re-staged wakeup.
    const { getConfig } = await import('../config.js');
    vi.mocked(getConfig).mockReturnValue({ agents: { honorScheduledWakeups: true } });

    await sendCliSessionInput(session, 'wake', 'Guy', '/tmp/test-repo', { wakeResume: true });
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(updateAgentSession).toHaveBeenCalled());

    expect(session.status).toBe('scheduled');
    expect(session.endedAt).toBeUndefined();
  });
});

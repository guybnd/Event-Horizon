import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

// FLUX-1437: the FLUX-1434 incident fix — a dispatched (non-chat) session's clean turn end that took
// no board action this turn (the same decision `flagIfParked` would otherwise raise a park on) AND
// narrated an unarmed "I'll wait for X" promise (WAIT_PROMISE_RE) is caught and resumed ONCE with a
// corrective message instead of parked, since its background tasks die at turn end and nothing would
// otherwise ever resume it. These tests exercise startCliSession/sendCliSessionInput end-to-end
// against a faked child_process (same harness as claude-code-needs-action.test.ts /
// claude-code-wake-resume-finalize.test.ts) and assert the real `tryResumeStaleWait` wiring in
// claude-code.ts runs. `wouldPark`/`narratesUnarmedWaitPromise` — the pure decisions already
// unit-tested in parked-ticket.test.ts — are mocked per-test so this file only exercises the RESUME
// MECHANISM: does it spawn a corrective --resume turn, does it skip flagIfParked when it does, does
// the `staleWaitResumes` cap fall through to the normal park, and are the non-firing guards honored.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../workspace.js', () => ({
  getWorkspaceRoot: () => '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
  getTaskAssetsDir: () => '/tmp/test-repo/.flux/assets',
  // A 'review'-phase dispatch (this file's fake sessions) triggers buildInitialPrompt's phase-skill-
  // module injection (shared.ts), which reads via this — an unreadable path degrades to the fallback
  // string (skill-modules.ts's own try/catch), so a nonexistent path here is harmless.
  resolveSkillSourceRoot: () => '/tmp/test-repo',
}));
// FLUX-1373: resolveModel (shared.ts, kept real) reads INTEGRATION_TIER_DEFAULTS/MODEL_POLICY_PRESETS
// from this module too — keep the real exports via importOriginal, only stub getConfig (mirrors
// claude-code-needs-action.test.ts's mock, needed here since startCliSession's initial spawn path
// calls resolveModel).
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, getConfig: vi.fn(() => ({})) };
});
vi.mock('../task-store.js', () => ({
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
  updateAgentSession: vi.fn().mockResolvedValue(undefined),
  estimateCostUSD: vi.fn(() => 0),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../session-store.js', () => ({
  cliSessionsById: new Map(),
  cliSessionIdByTaskId: { get: vi.fn() },
  notifyGroupSessionTerminal: vi.fn().mockResolvedValue(undefined),
  notifyDelegationComplete: vi.fn(),
  checkAutoRestart: vi.fn(),
  getPendingCombiner: vi.fn(() => undefined),
}));
vi.mock('../history.js', () => ({
  buildActivityEntry: vi.fn((comment: string) => ({ type: 'activity', comment })),
  buildCommentEntry: vi.fn((user: string, comment: string, date: string) => ({ type: 'comment', user, comment, date })),
  buildAgentMessageEntry: vi.fn(),
  buildAgentSessionEntry: vi.fn(() => ({ sessionId: 'test-session-entry', progress: [] })),
  appendSessionProgress: vi.fn(),
  closeAgentSession: vi.fn(),
  lastAssistantText: vi.fn(() => ''),
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
  flagIfUnarmedWaitPromise: vi.fn().mockResolvedValue(undefined),
  leadUnarmedWaitMessage: vi.fn(() => undefined),
  raiseNeedsAction: vi.fn().mockResolvedValue(undefined),
  // FLUX-1437: the two pure decisions tryResumeStaleWait consults — controlled per-test below.
  wouldPark: vi.fn(() => true),
  narratesUnarmedWaitPromise: vi.fn(() => true),
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
  // FLUX-1444: stdin stand-in — the code under test writes the prompt to stdin instead of argv.
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
    // A dispatched (non-chat) phase — the resume catch only ever applies to these.
    phase: 'review',
    // Preset so a corrective resume's `--resume <id>` args are exercised without needing to parse a
    // fake `system:init` stream event.
    resumeSessionId: 'claude-resume-abc',
    sessionHistoryEntry: {
      type: 'agent_session', sessionId: 'test-session-entry', startedAt: new Date().toISOString(),
      status: 'running', progress: [], user: 'Guy', date: new Date().toISOString(),
    },
    ...overrides,
  };
  return session as unknown as CliSessionRecord;
}

describe('claude-code.ts — stale-wait catch-and-resume (FLUX-1437)', () => {
  let procs: ReturnType<typeof fakeChildProcess>[];

  beforeEach(async () => {
    vi.clearAllMocks();
    procs = [];
    const { spawn } = await import('child_process');
    vi.mocked(spawn).mockImplementation((() => {
      const p = fakeChildProcess();
      procs.push(p);
      return p as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
    const { getWorkspace } = await import('../workspace-context.js');
    for (const key of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[key];
    getWorkspace().tasks['FLUX-TEST'] = { status: 'In Progress' };
    const { wouldPark, narratesUnarmedWaitPromise } = await import('../parked-ticket.js');
    vi.mocked(wouldPark).mockReturnValue(true);
    vi.mocked(narratesUnarmedWaitPromise).mockReturnValue(true);
    const { getPendingCombiner } = await import('../session-store.js');
    vi.mocked(getPendingCombiner).mockReturnValue(undefined);
  });

  it('AC1+AC3: resumes once with a corrective message, then the second stall of the SAME session falls through to flagIfParked', async () => {
    const { startCliSession } = await import('./claude-code.js');
    const { flagIfParked } = await import('../parked-ticket.js');
    const session = fakeSession();

    await startCliSession(session, { status: 'In Progress' } as never, 'do the review', 'default', '/tmp/test-repo');
    expect(procs.length).toBe(1);
    procs[0]!.emit('exit', 0, null);

    // tryResumeStaleWait fires: spawns a corrective --resume turn instead of flagging/parking.
    await vi.waitFor(() => expect(procs.length).toBe(2));
    expect(flagIfParked).not.toHaveBeenCalled();
    expect(session.staleWaitResumes).toBe(1);
    expect(session.status).toBe('running'); // resumed, not finalized terminal

    // Second stall of the SAME session — the staleWaitResumes cap (1) is spent, so this falls
    // through to the normal park/flag path instead of resuming again.
    procs[1]!.emit('exit', 0, null);
    await vi.waitFor(() => expect(flagIfParked).toHaveBeenCalledTimes(1));
    expect(flagIfParked).toHaveBeenCalledWith(session, 'FLUX-TEST', undefined);
    expect(procs.length).toBe(2); // no third (corrective) spawn — the cap held
    expect(session.status).toBe('completed');
  });

  it('AC2: never resumes a turn that took a board action, even with a wait-promise final text (mirrors flagIfParked\'s own gating)', async () => {
    const { wouldPark } = await import('../parked-ticket.js');
    vi.mocked(wouldPark).mockReturnValue(false); // "board action taken" — flagIfParked's own decision

    const { startCliSession } = await import('./claude-code.js');
    const { flagIfParked } = await import('../parked-ticket.js');
    const session = fakeSession();

    await startCliSession(session, { status: 'Ready' } as never, 'do the review', 'default', '/tmp/test-repo');
    procs[0]!.emit('exit', 0, null);

    await vi.waitFor(() => expect(flagIfParked).toHaveBeenCalledTimes(1));
    expect(procs.length).toBe(1); // no corrective resume spawned
    expect(session.staleWaitResumes ?? 0).toBe(0);
  });

  it('AC4: never resumes a chat session, even with a wait-promise final text and no board action', async () => {
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { flagIfParked, flagIfUnarmedWaitPromise } = await import('../parked-ticket.js');
    const session = fakeSession({ phase: 'chat' });

    // Chat sessions only reach the "resumed clean-exit" tryResumeStaleWait call site on a resumed
    // (second+) turn — the initial turn ends waiting-input via a different branch entirely.
    await sendCliSessionInput(session, 'hello', 'User', '/tmp/test-repo');
    procs[0]!.emit('exit', 0, null);

    await vi.waitFor(() => expect(flagIfParked).toHaveBeenCalledTimes(1));
    expect(flagIfUnarmedWaitPromise).toHaveBeenCalledTimes(1);
    expect(procs.length).toBe(1); // no corrective resume spawned
    expect(session.staleWaitResumes ?? 0).toBe(0);
  });

  it('never resumes when a pending combiner still owns the group (that gather step will resume it instead)', async () => {
    const { getPendingCombiner } = await import('../session-store.js');
    vi.mocked(getPendingCombiner).mockReturnValue({} as never);

    const { startCliSession } = await import('./claude-code.js');
    const { flagIfParked } = await import('../parked-ticket.js');
    const session = fakeSession({ groupId: 'group-1', patternPosition: 'lead' });

    await startCliSession(session, { status: 'In Progress' } as never, 'do the review', 'default', '/tmp/test-repo');
    procs[0]!.emit('exit', 0, null);

    await vi.waitFor(() => expect(flagIfParked).toHaveBeenCalledTimes(1));
    expect(procs.length).toBe(1); // no corrective resume spawned
    expect(session.staleWaitResumes ?? 0).toBe(0);
  });
});

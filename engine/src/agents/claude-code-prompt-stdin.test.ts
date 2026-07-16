import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

// FLUX-1444: Windows' CreateProcess caps the command line at 32,767 chars — a scatter-gather
// reviewer inlines the whole PR diff into the prompt (shared.ts's buildInitialPrompt, diffBlock),
// easily exceeding that cap when the prompt is passed as a single `-p <prompt>` argv element (the
// HomeUp PR #79 "spawn ENAMETOOLONG" incident). The fix delivers the prompt over child stdin
// instead: `-p` becomes a bare flag and the prompt is written to `proc.stdin` after spawn. These
// tests lock that the prompt bytes never land in argv (regardless of size) and DO land on stdin,
// for both the initial spawn and the resume path. Mock harness mirrors claude-code-needs-action.test.ts.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../workspace.js', () => ({
  getWorkspaceRoot: () => '/tmp/test-repo',
  getActiveFluxDir: () => '/tmp/test-repo/.flux',
  getTaskAssetsDir: () => '/tmp/test-repo/.flux/assets',
}));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, getConfig: () => ({}) };
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
  notifyGroupSessionTerminal: vi.fn(),
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
  wouldPark: vi.fn(() => false),
  narratesUnarmedWaitPromise: vi.fn(() => false),
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

// A synthetic scatter-gather reviewer prompt, well past the 32,767-char Windows CreateProcess cap.
const OVERSIZED_PROMPT = 'DIFF_LINE_'.repeat(4000); // 40,000 chars

describe('claude-code.ts — prompt delivered via stdin, not argv (FLUX-1444)', () => {
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
  });

  it('initial spawn: no argv element carries the oversized prompt, and the full prompt lands on stdin', async () => {
    const { startCliSession } = await import('./claude-code.js');
    const session = fakeSession();

    await startCliSession(session, { status: 'In Progress' }, OVERSIZED_PROMPT, '', '/tmp/test-repo');

    expect(lastProc).toBeDefined();
    // No single argv element should be anywhere near prompt size — bounds out any argv-based
    // regression (a small bound catches the prompt landing in argv again, not just this exact string).
    for (const arg of session.args ?? []) {
      expect(arg.length).toBeLessThan(1000);
    }
    expect(session.args).toContain('-p');
    const idx = (session.args ?? []).indexOf('-p');
    // '-p' must be a bare flag: the very next element is another flag, never the prompt.
    expect((session.args ?? [])[idx + 1]).not.toContain('DIFF_LINE_');

    const written = lastProc!.stdin.write.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(written).toContain(OVERSIZED_PROMPT);
    expect(lastProc!.stdin.end).toHaveBeenCalled();
  });

  it('resume: no argv element carries the oversized prompt, and the full prompt lands on stdin', async () => {
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { getWorkspace } = await import('../workspace-context.js');
    getWorkspace().tasks['FLUX-TEST'] = { status: 'In Progress' };
    const session = fakeSession({
      sessionHistoryEntry: {
        type: 'agent_session', sessionId: 'test-session-entry', startedAt: new Date().toISOString(),
        status: 'active', progress: [], user: 'Guy', date: new Date().toISOString(),
      } as never,
    });

    await sendCliSessionInput(session, OVERSIZED_PROMPT, 'Guy', '/tmp/test-repo');

    expect(lastProc).toBeDefined();
    // resume doesn't stamp session.args (only the initial spawn does) — read the resumeArgs straight
    // off the mocked spawn() call instead.
    const { spawn } = await import('child_process');
    const lastCall = vi.mocked(spawn).mock.calls[vi.mocked(spawn).mock.calls.length - 1];
    const resumeArgs = lastCall![1] as string[];
    for (const arg of resumeArgs) {
      expect(arg.length).toBeLessThan(1000);
    }
    const idx = resumeArgs.indexOf('-p');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(resumeArgs[idx + 1]).not.toContain('DIFF_LINE_');

    const written = lastProc!.stdin.write.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(written).toContain(OVERSIZED_PROMPT);
    expect(lastProc!.stdin.end).toHaveBeenCalled();
  });
});

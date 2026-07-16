// FLUX-1375: gemini.ts's resume/reply exit handler previously never flushed tokenMetadata at all —
// only the initial spawn's exit handler did (claude-code.ts got this fix under FLUX-1378; gemini.ts
// and copilot.ts did not) — so a resumed chat turn's cost was silently dropped from the ticket's cost
// meter. This drives startCliSession + sendCliSessionInput end-to-end against a faked child_process
// to prove the SECOND (resumed) turn's tokens now reach tokenMetadata too, on top of the first turn's,
// via the shared buildTokenMetadataUpdate delta helper (no double-count). Also pins that session.model
// gets persisted at spawn (FLUX-1375 bug 1) instead of staying unset.
import { getWorkspace } from '../workspace-context.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(), exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: unknown, res: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' })) };
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
}));
vi.mock('../history.js', () => ({
  buildActivityEntry: vi.fn((comment: string) => ({ type: 'activity', comment })),
  buildCommentEntry: vi.fn((user: string, comment: string, date: string) => ({ type: 'comment', user, comment, date })),
  buildAgentSessionEntry: vi.fn(() => ({ sessionId: 'test-session-entry', progress: [] })),
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
    resolveModel: vi.fn(() => 'gemini-2.5-pro'),
  };
});

function makeSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'sess-1',
    taskId: 'FLUX-TEST',
    framework: 'gemini',
    status: 'waiting-input',
    command: 'gemini',
    args: [],
    startedAt: new Date().toISOString(),
    label: 'Gemini CLI',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    ...overrides,
  } as CliSessionRecord;
}

function fakeChildProcess() {
  // FLUX-1444: stdin stand-in — the code under test writes the prompt to stdin instead of argv.
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  proc.pid = 4242;
  return proc;
}

describe('gemini.ts resumed-turn tokenMetadata flush (FLUX-1375)', () => {
  const TASK_ID = 'FLUX-TEST';
  let lastProc: ReturnType<typeof fakeChildProcess> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    lastProc = undefined;
    const { spawn } = await import('child_process');
    vi.mocked(spawn).mockImplementation((() => {
      lastProc = fakeChildProcess();
      return lastProc as unknown as ReturnType<typeof spawn>;
    }) as typeof spawn);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getWorkspace().tasks[TASK_ID] = { status: 'In Progress' };
  });

  it('flushes the initial turn, persists session.model, then flushes ONLY the resumed turn delta (no double-count)', async () => {
    const { startCliSession, sendCliSessionInput } = await import('./gemini.js');
    const { updateTaskWithHistory } = await import('../task-store.js');

    const session = makeSession();

    await startCliSession(session, { status: 'In Progress' } as never, '', '', '/tmp/test-repo');
    expect(lastProc).toBeDefined();
    // FLUX-1375 bug 1: the resolved model must be persisted onto the session, not left as a local var.
    expect(session.model).toBe('gemini-2.5-pro');

    lastProc!.emit('stdout', Buffer.from(JSON.stringify({ type: 'result', stats: { input_tokens: 5000, output_tokens: 200, cached: 0, total_cost_usd: 0.05 } }) + '\n'));
    lastProc!.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', stats: { input_tokens: 5000, output_tokens: 200, cached: 0, total_cost_usd: 0.05 } }) + '\n'));
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(updateTaskWithHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(updateTaskWithHistory).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ tokenMetadata: expect.objectContaining({ inputTokens: 5000, outputTokens: 200, costUSD: 0.05 }) }),
    );
    vi.mocked(updateTaskWithHistory).mockClear();

    // Resumed turn — a SECOND spawn/exit cycle via sendCliSessionInput.
    await sendCliSessionInput(session, 'follow up', 'Guy', '/tmp/test-repo');
    expect(lastProc).toBeDefined();
    lastProc!.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', stats: { input_tokens: 3000, output_tokens: 150, cached: 0, total_cost_usd: 0.03 } }) + '\n'));
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(updateTaskWithHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    // Before FLUX-1375 this handler never flushed at all — updateTaskWithHistory would not have been
    // called with a tokenMetadata delta here, silently dropping the resumed turn's cost.
    expect(updateTaskWithHistory).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ tokenMetadata: expect.objectContaining({ inputTokens: 3000, outputTokens: 150, costUSD: 0.03 }) }),
    );
  });
});

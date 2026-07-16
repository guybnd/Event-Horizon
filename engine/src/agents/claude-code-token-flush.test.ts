// FLUX-1378 (absorbing FLUX-1375 step 6): the resume/reply exit handler previously never flushed
// tokenMetadata at all, so a resumed turn's cost was silently dropped. `buildTokenMetadataUpdate` is
// the shared helper both the initial-spawn AND resume exit handlers now call. `session.inputTokens`/etc.
// accumulate for the WHOLE session lifetime (never reset — they also drive the live per-session cost
// badge), so the helper must diff against the session's own flushed baseline on each call, not the raw
// cumulative counters, or a second (resume-turn) flush would double-count whatever the first
// (initial-spawn) flush already persisted into the ticket.

import { getWorkspace } from '../workspace-context.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { buildTokenMetadataUpdate } from './claude-code.js';
import { pickPrReview } from '../furnace-stoker.js';
import { newFurnaceBatch, newBatchTicket } from '../models/furnace.js';
import type { CliSessionRecord } from './types.js';

// FLUX-1396 group G test 18a: exercising the real exit-handler wiring (not just the pure
// buildTokenMetadataUpdate helper above) needs startCliSession/sendCliSessionInput driven end-to-end
// against a faked child_process — same harness as claude-code-wake-resume-finalize.test.ts /
// claude-code-needs-action.test.ts. Every dependency is mocked wholesale EXCEPT task-worktree.ts's
// execution-root resolvers (a branchless task makes them resolve synchronously with no git calls) and
// shared.ts (kept real apart from checkBinaryInstalled/resolveClaudeExePath).
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
  // FLUX-1437: the stale-wait catch-and-resume's own guards — false/undefined here means it never
  // fires in these tests, so flagIfParked's existing mocked behavior is exercised unchanged.
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
// FLUX-1396 group G test 18b: pickPrReview is a pure gating function in furnace-stoker.ts — unrelated
// to the token-flush baseline above, but the ticket's own case for it (a failed/parked review AFTER
// clearReviewState nulled the ticket's reviewState mirrors NOTHING to the PR) is a decision-core case
// that belongs alongside pickPrReview's other gating tests. It has no natural home in claude-code.ts
// or this file's subject matter; kept here per the group-G brief rather than touching furnace-batch.ts
// (the file that owns pickPrReview's other coverage) — see the final report for this deviation.
// mirrorReviewVerdictToPr (the only caller that shells out) is not exercised here, so branch-manager.js
// doesn't strictly need mocking, but stub it anyway so nothing in the pulled-in module graph can shell
// out to the real `gh` CLI.
vi.mock('../branch-manager.js', () => ({
  postPrReview: vi.fn(),
  mergePullRequest: vi.fn(),
}));

function makeSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'sess-1',
    taskId: 'TICK-1',
    framework: 'claude',
    status: 'waiting-input',
    command: 'claude',
    args: [],
    startedAt: new Date().toISOString(),
    label: 'Claude Code',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    ...overrides,
  };
}

describe('buildTokenMetadataUpdate (FLUX-1378)', () => {
  const TICKET = 'TICK-1';

  beforeEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getWorkspace().tasks[TICKET] = { id: TICKET };
  });

  it('returns null when nothing accumulated yet', () => {
    const session = makeSession();
    expect(buildTokenMetadataUpdate(TICKET, session)).toBeNull();
  });

  it('flushes the full cumulative amount on the FIRST flush (baseline starts at zero)', () => {
    const session = makeSession({ inputTokens: 5000, outputTokens: 200, costUSD: 0.05, cacheReadTokens: 4000, cacheCreationTokens: 500 });
    const update = buildTokenMetadataUpdate(TICKET, session);
    expect(update).toEqual({
      inputTokens: 5000,
      outputTokens: 200,
      costUSD: 0.05,
      costIsEstimated: false,
      cacheReadTokens: 4000,
      cacheCreationTokens: 500,
    });
  });

  it('a SECOND flush (simulating a resumed turn) only accounts for the delta — no double-count', () => {
    const session = makeSession({ inputTokens: 5000, outputTokens: 200, costUSD: 0.05, cacheReadTokens: 4000, cacheCreationTokens: 500 });

    // First flush (initial-spawn exit handler) — persist into the ticket, exactly as the real handler does.
    const first = buildTokenMetadataUpdate(TICKET, session);
    getWorkspace().tasks[TICKET].tokenMetadata = first;

    // A resumed turn accrues MORE on the same session object (never reset — also drives the live badge).
    session.inputTokens = (session.inputTokens ?? 0) + 3000;
    session.outputTokens = (session.outputTokens ?? 0) + 150;
    session.costUSD = (session.costUSD ?? 0) + 0.03;
    session.cacheReadTokens = (session.cacheReadTokens ?? 0) + 2500;
    session.cacheCreationTokens = (session.cacheCreationTokens ?? 0) + 100;

    // Second flush (resume exit handler) — must add only the 3000/150/0.03/2500/100 delta on top of the
    // ticket's already-persisted first-flush total, not the full new cumulative session totals again.
    const second = buildTokenMetadataUpdate(TICKET, session);
    expect(second).toEqual({
      inputTokens: 8000,
      outputTokens: 350,
      costUSD: 0.08,
      costIsEstimated: false,
      cacheReadTokens: 6500,
      cacheCreationTokens: 600,
    });
  });

  it('returns null on a flush with nothing new since the last one', () => {
    const session = makeSession({ inputTokens: 1000, outputTokens: 50 });
    const first = buildTokenMetadataUpdate(TICKET, session);
    getWorkspace().tasks[TICKET].tokenMetadata = first;
    expect(buildTokenMetadataUpdate(TICKET, session)).toBeNull();
  });

  it('preserves costIsEstimated once true, and merges onto a pre-existing ticket total (e.g. an earlier session)', () => {
    getWorkspace().tasks[TICKET].tokenMetadata = { inputTokens: 100, outputTokens: 10, costUSD: 0.01, costIsEstimated: true };
    const session = makeSession({ inputTokens: 500, outputTokens: 20, costUSD: 0.02, costIsEstimated: false });
    const update = buildTokenMetadataUpdate(TICKET, session);
    expect(update).toEqual({
      inputTokens: 600,
      outputTokens: 30,
      costUSD: 0.03,
      costIsEstimated: true, // sticky once any contributor estimated
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

/** A bare EventEmitter stands in for the spawned CLI's ChildProcess — same rationale as
 *  claude-code-needs-action.test.ts's fakeProc: the code under test only ever calls
 *  `.stdout!.on('data', …)`, `.stderr!.on('data', …)`, `.on('error', …)`, `.on('exit', …)`, and
 *  (FLUX-1444) `.stdin!.on('error', …)`/`.write()`/`.end()` to deliver the prompt. */
function fakeChildProcess() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; pid: number };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { on: vi.fn(), write: vi.fn(), end: vi.fn() };
  proc.pid = 4242;
  return proc;
}

// FLUX-1396 group G test 18a: `finalizeTerminalSession` (unexported) is the shared helper the ticket
// says was reconciled in the FLUX-1378/#514 merge — an initial cold spawn (startCliSession's exit
// handler) and a LATER wake-resume of the SAME session (sendCliSessionInput's wakeResume branch) both
// call it, and it must not double-count whatever the earlier call already flushed. Drive both real
// entry points end-to-end (not just buildTokenMetadataUpdate directly, which the tests above already
// pin) so a regression in either caller wiring — not just the pure helper — would be caught.
describe('finalizeTerminalSession — initial-spawn AND wake-resume both flush via the shared helper without double-counting (FLUX-1396 group G test 18)', () => {
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

  it('flushes the full amount on the initial-spawn finalize, then only the fresh delta on the wake-resume finalize of the same session', async () => {
    const { startCliSession, sendCliSessionInput } = await import('./claude-code.js');
    const { updateTaskWithHistory, updateAgentSession } = await import('../task-store.js');
    const { notifyDelegationComplete, checkAutoRestart } = await import('../session-store.js');

    // `session.inputTokens`/etc accumulate for the session's WHOLE lifetime (never reset), same as the
    // resumed-turn scenario in the pure tests above — this session carries its cold-spawn turn's usage.
    const session = makeSession({ taskId: TASK_ID, inputTokens: 5000, outputTokens: 200, costUSD: 0.05 });

    // 1. Initial cold spawn — finalizeTerminalSession's FIRST caller path.
    await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
    expect(lastProc).toBeDefined();
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(updateTaskWithHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(updateTaskWithHistory).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ tokenMetadata: expect.objectContaining({ inputTokens: 5000, outputTokens: 200, costUSD: 0.05 }) }),
    );
    // Both terminal-bookkeeping markers unique to finalizeTerminalSession (the plain, non-wake resume
    // exit path below never calls these) — confirms this call actually went through the shared helper.
    expect(notifyDelegationComplete).toHaveBeenCalledWith(session);
    expect(checkAutoRestart).toHaveBeenCalled();
    vi.mocked(updateTaskWithHistory).mockClear();
    vi.mocked(notifyDelegationComplete).mockClear();
    vi.mocked(checkAutoRestart).mockClear();

    // 2. The SAME underlying session later wakes up and accrues MORE usage on top of its already-flushed
    // baseline — cumulative counters never reset, mirroring the "SECOND flush" pure test above.
    session.inputTokens = 8000; // +3000 new since the cold-spawn flush
    session.outputTokens = 350; // +150 new
    session.costUSD = 0.08; // +0.03 new

    await sendCliSessionInput(session, 'wake', 'Guy', '/tmp/test-repo', { wakeResume: true });
    expect(lastProc).toBeDefined();
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(updateTaskWithHistory).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    // Wake-resume finalize path — finalizeTerminalSession's SECOND caller. Must flush only the fresh
    // 3000/150/0.03 delta on top of what the cold-spawn flush already advanced the session's own
    // flushed baseline to — NOT the raw new cumulative 8000/350/0.08 session totals again (the
    // double-count trap the FLUX-1378/#514 merge reconciled).
    expect(updateTaskWithHistory).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ tokenMetadata: expect.objectContaining({ inputTokens: 3000, outputTokens: 150, costUSD: 0.03 }) }),
    );
    // The wake-resume path closes the persisted agent_session entry (finalizeTerminalSession's own
    // bookkeeping) — the plain resume/reply exit path never calls updateAgentSession at all.
    expect(updateAgentSession).toHaveBeenCalledWith(TASK_ID, 'test-session-entry', expect.any(Function));
    expect(notifyDelegationComplete).toHaveBeenCalledWith(session);
    expect(checkAutoRestart).toHaveBeenCalled();
  });
});

// FLUX-1396 group G test 18: `pickPrReview` (furnace-stoker.ts) is the pure decision core behind
// mirroring a reviewer's verdict onto the real GitHub PR — unrelated to the token-flush machinery
// above, but this is the ticket's own named case for it: `clearReviewState` (furnace-stoker.ts) nulls
// the ticket's `reviewState` the moment a fresh review dispatch begins (it "persists across re-impl by
// design" otherwise), so a review session that then fails/parks WITHOUT ever recording a fresh verdict
// leaves `reviewState` at that cleared `null` — pickPrReview must resolve to null (mirror nothing) for
// that combination, not mistake the absence of a verdict for one. furnace-batch.test.ts's existing
// gating tests cover this same null-mirrors-nothing shape for `ticket.state === 'implementing'`; the
// `'reviewing'` + null combination (the actual clearReviewState-then-crash shape) was not covered there.
describe('pickPrReview — a failed/parked review after clearReviewState mirrors nothing to the PR (FLUX-1396 group G test 18)', () => {
  function mkBatch() {
    return newFurnaceBatch({ id: 'batch-flux1396', now: '2026-07-12T00:00:00.000Z', title: 'Test batch' });
  }

  it('reviewing + reviewState cleared (null) + reimplement mirrors nothing', () => {
    const ticket = { ...newBatchTicket('FLUX-TEST', 0), state: 'reviewing' as const, attempts: 1 };
    const action = { type: 'reimplement' as const, attempt: 2 };
    expect(pickPrReview(mkBatch(), ticket, action, null)).toBeNull();
  });

  it('reviewing + reviewState cleared (null) + a retryCap park mirrors nothing', () => {
    const ticket = { ...newBatchTicket('FLUX-TEST', 0), state: 'reviewing' as const, attempts: 2 };
    const action = {
      type: 'park' as const,
      reason: 'the review session ended failed with no recorded verdict',
      failureClass: 'hard-fail' as const,
    };
    expect(pickPrReview(mkBatch(), ticket, action, null)).toBeNull();
  });
});

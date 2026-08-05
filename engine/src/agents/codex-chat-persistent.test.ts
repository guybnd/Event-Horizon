import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { CliSessionRecord } from './types.js';

// FLUX-1630: codex flipped `persistentChat` false -> true — a clean `phase:'chat'` turn must end
// 'waiting-input' (text stays in the chat stream, resumable via `resumeSessionId`) instead of
// forcing 'completed', which posted the reply as a ticket comment and tripped the FLUX-651 parked
// backstop (`needsAction`) on tickets like a Scratch conversation. A dispatched (non-chat) phase
// must be unaffected — it still posts its completion comment on a clean exit.
//
// Mock set mirrors claude-code-needs-action.test.ts: workspace-context.js is left REAL (an
// in-memory task registry, cleared per test) along with task-worktree.ts's execution-root
// resolvers (a branchless task resolves synchronously to workspaceRoot, no git calls) and
// group.js/group-member-worktree.js/session-binding.js (harmless no-ops with no groupId/
// memberBinding). Everything else that would touch the filesystem/network/real ticket store is
// mocked wholesale.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});
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
    framework: 'codex',
    status: 'running',
    command: 'codex',
    args: [] as string[],
    startedAt: new Date().toISOString(),
    label: 'Codex CLI',
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

/** Feeds one JSONL event through the fake process's stdout, matching codex's `--json` line shape. */
function feedEvent(proc: ReturnType<typeof fakeChildProcess>, evt: unknown) {
  proc.stdout.emit('data', Buffer.from(JSON.stringify(evt) + '\n'));
}

describe('codex.ts — chat-turn exit routes through waiting-input, not completed (FLUX-1630)', () => {
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

  it('a clean phase:"chat" turn ends waiting-input, keeps the reply in chat, and posts no comment', async () => {
    const { startCliSession } = await import('./codex.js');
    const { updateTaskWithHistory } = await import('../task-store.js');
    const { buildCommentEntry } = await import('../history.js');
    const { flagIfParked } = await import('../parked-ticket.js');
    const session = fakeSession({ phase: 'chat' });

    await startCliSession(session, { status: 'Todo' }, '', '', '/tmp/test-repo');
    expect(lastProc).toBeDefined();

    feedEvent(lastProc!, { type: 'thread.started', thread_id: 'thread_chat1' });
    feedEvent(lastProc!, { type: 'turn.started' });
    feedEvent(lastProc!, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Hello — what would you like to explore?' } });
    feedEvent(lastProc!, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(session.status).toBe('waiting-input'));

    // Resumable, not terminal: no endedAt, and the thread_id round-trips for the next --resume.
    expect(session.endedAt).toBeUndefined();
    expect(session.resumeSessionId).toBe('thread_chat1');
    // The reply stayed in the chat stream (accumulated into cumulativeOutput)...
    expect(session.cumulativeOutput).toContain('Hello — what would you like to explore?');
    // ...and was never posted as a ticket comment, so no FLUX-651 parked backstop ran either.
    expect(buildCommentEntry).not.toHaveBeenCalled();
    expect(flagIfParked).not.toHaveBeenCalled();
    for (const call of vi.mocked(updateTaskWithHistory).mock.calls) {
      const entries = (call[1]?.entries ?? []) as Array<{ type?: string }>;
      expect(entries.some((e) => e?.type === 'comment')).toBe(false);
    }
  });

  it('a clean dispatched (non-chat) phase turn still posts its completion comment', async () => {
    const { startCliSession } = await import('./codex.js');
    const { buildCommentEntry } = await import('../history.js');
    const session = fakeSession(); // no session.phase — a dispatched implementation session

    await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
    expect(lastProc).toBeDefined();

    feedEvent(lastProc!, { type: 'thread.started', thread_id: 'thread_dispatch1' });
    feedEvent(lastProc!, { type: 'turn.started' });
    feedEvent(lastProc!, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Implemented the fix and moved the ticket to Ready.' } });
    feedEvent(lastProc!, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(session.status).toBe('completed'));

    expect(session.endedAt).toBeDefined();
    expect(buildCommentEntry).toHaveBeenCalledWith('Codex CLI', 'Implemented the fix and moved the ticket to Ready.', session.endedAt);
  });
});

describe('codex.ts — transcript normalization for chat rendering (FLUX-1637)', () => {
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

  it('normalizes a completed agent_message into the canonical Claude-shaped assistant event, and tees everything else raw', async () => {
    const { startCliSession } = await import('./codex.js');
    const { appendTranscriptEvent, appendTranscriptLine } = await import('../transcript.js');
    const session = fakeSession();

    await startCliSession(session, { status: 'In Progress' }, '', '', '/tmp/test-repo');
    expect(lastProc).toBeDefined();

    feedEvent(lastProc!, { type: 'thread.started', thread_id: 'thread_norm1' });
    feedEvent(lastProc!, { type: 'turn.started' });
    feedEvent(lastProc!, { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'hi from codex' } });
    feedEvent(lastProc!, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
    lastProc!.emit('exit', 0, null);
    await vi.waitFor(() => expect(session.status === 'completed' || session.status === 'waiting-input').toBe(true));

    // The renderable agent_message is normalized — no per-CLI Codex branch in projection.ts, so
    // this must match the shape projection.ts's existing Claude branch already renders.
    expect(appendTranscriptEvent).toHaveBeenCalledWith('FLUX-TEST', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi from codex' }] },
    });
    // Non-agent_message events (thread.started, turn.started, turn.completed) still tee raw.
    expect(appendTranscriptLine).toHaveBeenCalledWith('FLUX-TEST', JSON.stringify({ type: 'thread.started', thread_id: 'thread_norm1' }));
    expect(appendTranscriptLine).toHaveBeenCalledWith('FLUX-TEST', JSON.stringify({ type: 'turn.started' }));
    // The agent_message line itself must NOT also be teed raw (no double-write).
    expect(appendTranscriptLine).not.toHaveBeenCalledWith('FLUX-TEST', expect.stringContaining('agent_message'));
  });

  it('records a user reply as a structured transcript turn alongside the history comment (FLUX-1637)', async () => {
    const { sendCliSessionInput } = await import('./codex.js');
    const { appendTranscriptEvent } = await import('../transcript.js');
    const { buildCommentEntry } = await import('../history.js');
    const { getWorkspace } = await import('../workspace-context.js');
    getWorkspace().tasks['FLUX-TEST'] = { id: 'FLUX-TEST', status: 'In Progress' };
    const session = fakeSession({ executionRoot: '/tmp/test-repo' });

    await sendCliSessionInput(session, 'follow-up question', 'Guy', '/tmp/test-repo');
    expect(lastProc).toBeDefined();

    expect(appendTranscriptEvent).toHaveBeenCalledWith('FLUX-TEST', expect.objectContaining({
      type: 'user',
      text: 'follow-up question',
      attachments: [],
    }));
    // Both surfaces are written — the durable chat transcript AND the ticket-history digest.
    expect(buildCommentEntry).toHaveBeenCalledWith('Guy', 'follow-up question', session.lastInputAt);
  });
});

// FLUX-1746: proactive checkpoint before the compaction cliff. Two surfaces under test:
//  - `maybeWriteContextCheckpoint` (agents/shared.ts) directly — the ratio/epoch decision logic.
//  - the mid-turn `liveContextTokens` gauge + subagent-frame skip, which only exist inside
//    `attachAnthropicStdoutProcessing`'s `assistant`-branch handling (anthropic-stream.ts) — so
//    those two behaviors are driven through the real Claude dialect (claude-code.ts's
//    `attachStdoutProcessing`), same harness as claude-code-telemetry-capture.test.ts.
// `updateTaskWithHistory` is mocked (not the real disk-backed implementation) so this stays
// spawn-free AND fixture-free — same technique as claude-code-token-flush.test.ts — and every
// assertion below reads the mock's own call arguments rather than best-effort workspace state.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { attachStdoutProcessing } from './claude-code.js';
import { maybeWriteContextCheckpoint, CHECKPOINT_CONTEXT_RATIO } from './shared.js';
import { updateTaskWithHistory } from '../task-store.js';
import type { CliSessionRecord } from './types.js';

vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../task-store.js', () => ({
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
  updateAgentSession: vi.fn().mockResolvedValue(undefined),
  estimateCostUSD: vi.fn(() => 0),
}));

const TICKET = 'FLUX-1746';

/** Same bare-EventEmitter technique as claude-code-telemetry-capture.test.ts's fakeProc — no real
 *  subprocess, so this stays out of the `check:classify` spawn signal and runs in the fast `unit`
 *  vitest project. */
function fakeProc(): { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  return { stdout: new EventEmitter(), kill: vi.fn() };
}
function asProc(proc: { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }): Parameters<typeof attachStdoutProcessing>[0] {
  return proc as unknown as Parameters<typeof attachStdoutProcessing>[0];
}

function fakeSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'test-session',
    taskId: TICKET,
    pendingAssistantText: '',
    liveOutputBuffer: '',
    outputBuffer: '',
    cumulativeOutput: '',
    currentActivity: undefined,
    lastProgressLog: undefined,
    resumeSessionId: undefined,
    sessionHistoryEntry: { sessionId: 'sess-1', progress: [] },
    status: 'running',
    label: 'Test',
    writeQueue: Promise.resolve(),
    flushTimer: undefined,
    ...overrides,
  } as unknown as CliSessionRecord;
}

beforeEach(() => {
  vi.mocked(updateTaskWithHistory).mockClear();
});

describe('maybeWriteContextCheckpoint (FLUX-1746)', () => {
  it('fires once when the ratio crosses 0.85, with compactionCount absent', async () => {
    const session = fakeSession({ contextWindow: 100_000, liveContextTokens: 85_000 });
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;

    expect(session.checkpointEpoch).toBe(0);
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);
    const [taskId, options] = vi.mocked(updateTaskWithHistory).mock.calls[0]!;
    expect(taskId).toBe(TICKET);
    const entries = options.entries as Array<{ comment: string }>;
    expect(entries[0]!.comment).toContain('Context checkpoint at 85% of window');
  });

  it('does not fire again at 0.90 in the same (never-compacted) epoch', async () => {
    const session = fakeSession({ contextWindow: 100_000, liveContextTokens: 85_000 });
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);

    session.liveContextTokens = 90_000;
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);
  });

  it('re-arms after compactionCount increments (a real compaction happened)', async () => {
    const session = fakeSession({ contextWindow: 100_000, liveContextTokens: 90_000 });
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);
    expect(session.checkpointEpoch).toBe(0);

    session.compactionCount = 1;
    session.liveContextTokens = 90_000;
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(2);
    expect(session.checkpointEpoch).toBe(1);
  });

  it('does not fire while contextWindow is undefined, then fires once populated', async () => {
    const session = fakeSession({ liveContextTokens: 999_999 });
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;
    expect(updateTaskWithHistory).not.toHaveBeenCalled();

    session.contextWindow = 100_000;
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);
  });

  it('never writes lastTurnContextTokens — that field stays the result-event gauge FLUX-1378/findResumeCandidate own', () => {
    const session = fakeSession({ contextWindow: 100_000, liveContextTokens: 90_000 });
    maybeWriteContextCheckpoint(session, TICKET);
    expect(session.lastTurnContextTokens).toBeUndefined();
  });

  it('CHECKPOINT_CONTEXT_RATIO is 0.85', () => {
    expect(CHECKPOINT_CONTEXT_RATIO).toBe(0.85);
  });

  it('clips each recent-progress message to 300 chars and strips backticks so they cannot break the surrounding markdown', async () => {
    const session = fakeSession({
      contextWindow: 100_000,
      liveContextTokens: 90_000,
      sessionHistoryEntry: {
        sessionId: 'sess-1',
        progress: [{ message: `run \`npm test\`${'x'.repeat(2000)}`, date: new Date().toISOString() }],
      },
    } as unknown as Partial<CliSessionRecord>);
    maybeWriteContextCheckpoint(session, TICKET);
    await session.writeQueue;

    const [, options] = vi.mocked(updateTaskWithHistory).mock.calls[0]!;
    const comment = (options.entries as Array<{ comment: string }>)[0]!.comment;
    expect(comment).not.toContain('`npm test`');
    expect(comment).toContain("run 'npm test'");
    expect(comment.length).toBeLessThan(500);
  });
});

describe('assistant frame -> liveContextTokens gauge (FLUX-1746, frame-driven via the real Claude dialect)', () => {
  it('sums message.usage into liveContextTokens and fires the checkpoint, without ever touching lastTurnContextTokens', async () => {
    const session = fakeSession({ contextWindow: 100_000 });
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, TICKET);

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: 'working on it' }],
        usage: { input_tokens: 80_000, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 1_000 },
      },
    }) + '\n'));
    await session.writeQueue;

    expect(session.liveContextTokens).toBe(86_000);
    expect(session.lastTurnContextTokens).toBeUndefined();
    expect(updateTaskWithHistory).toHaveBeenCalledTimes(1);
  });

  it('a frame with a non-null parent_tool_use_id (a subagent frame) moves neither liveContextTokens nor fires a checkpoint', async () => {
    const session = fakeSession({ contextWindow: 100_000 });
    const proc = fakeProc();
    attachStdoutProcessing(asProc(proc), session, TICKET);

    // A subagent frame carrying a MUCH larger usage than the main conversation actually has —
    // if this leaked into liveContextTokens it would falsely look safe (or falsely trip the
    // checkpoint) relative to the main session's real context size.
    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_01subagent',
      message: {
        content: [{ type: 'text', text: 'subagent output' }],
        usage: { input_tokens: 300_000 },
      },
    }) + '\n'));
    await session.writeQueue;

    expect(session.liveContextTokens).toBeUndefined();
    expect(updateTaskWithHistory).not.toHaveBeenCalled();
  });
});

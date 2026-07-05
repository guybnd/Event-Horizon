// FLUX-987 (audit finding B4): the board orchestrator's shared exit-state machine
// (wireBoardProc in board-core.ts) must not classify a CLEAN (code 0) turn as 'failed' just
// because this particular CLI never captured a resumeSessionId on this turn (gemini-only —
// copilot has a dual capture site, see agents/copilot.ts). Before this fix, that
// misclassification skipped the "Orchestrator replied" notification even though the transcript
// write (unconditional, earlier in the turn) already showed the reply — and it left the session
// 'failed' rather than the resumable 'waiting-input' the /start route's FLUX-667 self-heal
// expects, so the NEXT turn couldn't cleanly supersede it either.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';

vi.mock('../config.js', () => ({ configCache: { projects: ['FLUX'] } }));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../transcript.js', () => ({ appendTranscriptEvent: vi.fn() }));
vi.mock('../notifications.js', () => ({ generateOrchestratorReplyNotification: vi.fn() }));
vi.mock('../board-digest.js', () => ({ buildBoardDigest: vi.fn(() => '') }));
vi.mock('../resume-preamble.js', () => ({ buildResumePreamble: vi.fn(async () => null) }));
vi.mock('../board-reprime.js', () => ({ buildBoardReprime: vi.fn(async () => null) }));
vi.mock('../workspace.js', () => ({ workspaceRoot: '/tmp/test-repo' }));
vi.mock('./shared.js', () => ({
  checkBinaryInstalled: vi.fn(async () => {}),
  appendSessionOutput: vi.fn(),
  flushSessionOutput: vi.fn(),
  resolveAttachmentAbsPaths: vi.fn(() => []),
  attachmentReadInstruction: vi.fn(() => ''),
}));

import { makeBoardAdapter } from './board-core.js';
import { generateOrchestratorReplyNotification } from '../notifications.js';
import type { BoardSpec } from './board.js';
import type { CliSessionRecord } from './types.js';

const mockNotify = vi.mocked(generateOrchestratorReplyNotification);

/** A bare EventEmitter stands in for the spawned CLI's ChildProcess (mirrors adapter-contract.test.ts's fakeProc). */
function fakeProc(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242 });
  return proc;
}

interface FakeSession {
  status: string;
  proc?: ChildProcessWithoutNullStreams;
  pid?: number;
  args: string[];
  executionRoot?: string;
  startedAt: string;
  resumeSessionId: string | undefined;
  requestedStop: boolean;
}

function fakeSession(): CliSessionRecord {
  const session: FakeSession = {
    status: 'pending',
    args: [],
    startedAt: new Date().toISOString(),
    resumeSessionId: undefined,
    requestedStop: false,
  };
  return session as CliSessionRecord;
}

/** Builds a BoardSpec whose `attachStdout` optionally captures a resumeSessionId (simulating
 *  whether this turn's CLI event stream happened to carry one), matching gemini-board.ts's
 *  degrade-gracefully-without-one contract. */
function fakeSpec(opts: { capturesResumeId: boolean }): BoardSpec {
  return {
    framework: 'gemini',
    binary: 'gemini',
    buildArgs: () => [],
    spawn: (_args, _executionRoot) => fakeProc(),
    attachStdout: (_proc, session) => {
      if (opts.capturesResumeId) session.resumeSessionId = 'gemini-session-abc';
      return () => {}; // commitPending
    },
  };
}

describe('wireBoardProc exit classification (FLUX-987 / B4)', () => {
  beforeEach(() => {
    mockNotify.mockClear();
  });

  it('a clean (code 0) exit with a captured resumeSessionId parks waiting-input and notifies', async () => {
    const spec = fakeSpec({ capturesResumeId: true });
    const adapter = makeBoardAdapter(spec);
    const session = fakeSession();

    await adapter.startBoardSession(session, 'hello', '/tmp/test-repo');
    (session.proc as unknown as EventEmitter).emit('exit', 0);

    expect(session.status).toBe('waiting-input');
    expect(session.resumeSessionId).toBe('gemini-session-abc');
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  // The actual B4 regression: gemini's turn-1 event stream sometimes never carries session_id,
  // so resumeSessionId stays uncaptured even though the CLI exited cleanly and did reply.
  it('a clean (code 0) exit with NO captured resumeSessionId still parks waiting-input (not failed) and still notifies', async () => {
    const spec = fakeSpec({ capturesResumeId: false });
    const adapter = makeBoardAdapter(spec);
    const session = fakeSession();

    await adapter.startBoardSession(session, 'hello', '/tmp/test-repo');
    (session.proc as unknown as EventEmitter).emit('exit', 0);

    expect(session.resumeSessionId).toBeUndefined();
    // Before the fix this was 'failed' — wedging the board (no resumeSessionId → /input 409s
    // forever) AND silently dropping the reply notification.
    expect(session.status).toBe('waiting-input');
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('a non-zero exit is still classified failed regardless of resumeSessionId', async () => {
    const spec = fakeSpec({ capturesResumeId: false });
    const adapter = makeBoardAdapter(spec);
    const session = fakeSession();

    await adapter.startBoardSession(session, 'hello', '/tmp/test-repo');
    (session.proc as unknown as EventEmitter).emit('exit', 1);

    expect(session.status).toBe('failed');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a user-requested stop is classified cancelled, not failed, and does not notify', async () => {
    const spec = fakeSpec({ capturesResumeId: false });
    const adapter = makeBoardAdapter(spec);
    const session = fakeSession();
    session.requestedStop = true;

    await adapter.startBoardSession(session, 'hello', '/tmp/test-repo');
    (session.proc as unknown as EventEmitter).emit('exit', 0);

    expect(session.status).toBe('cancelled');
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

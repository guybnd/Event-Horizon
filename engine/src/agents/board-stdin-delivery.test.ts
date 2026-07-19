// FLUX-1496: FLUX-1444 moved prompt delivery from argv to stdin for the per-ticket adapters but
// missed the board path — board-core.ts's wireBoardProc spawned with stdio:'pipe' and never wrote
// or closed the child's stdin, so every board/Furnace-chat turn's claude/copilot/gemini `-p`
// process waited the full 3s "no stdin data received" timeout before producing any output. This
// locks: (1) wireBoardProc now writes the full prompt to stdin and closes it, for both the start
// and resume board paths; (2) none of the three board specs' buildArgs puts the prompt in argv —
// `-p` is bare (claude/copilot) or carries an empty placeholder (gemini), mirroring the per-ticket
// fix (claude-code-prompt-stdin.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcessWithoutNullStreams } from 'child_process';

vi.mock('../config.js', () => ({ getConfig: () => ({ projects: ['FLUX'] }) }));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../transcript.js', () => ({ appendTranscriptEvent: vi.fn() }));
vi.mock('../notifications.js', () => ({ generateOrchestratorReplyNotification: vi.fn() }));
vi.mock('../board-digest.js', () => ({ buildBoardDigest: vi.fn(() => '') }));
vi.mock('../resume-preamble.js', () => ({ buildResumePreamble: vi.fn(async () => null) }));
vi.mock('../board-reprime.js', () => ({ buildBoardReprime: vi.fn(async () => null) }));
vi.mock('../workspace.js', () => ({ getWorkspaceRoot: () => '/tmp/test-repo' }));
vi.mock('./shared.js', () => ({
  checkBinaryInstalled: vi.fn(async () => {}),
  appendSessionOutput: vi.fn(),
  flushSessionOutput: vi.fn(),
  resolveAttachmentAbsPaths: vi.fn(() => []),
  attachmentReadInstruction: vi.fn(() => ''),
  cleanChildEnv: vi.fn(() => ({})),
  resolveClaudeExePath: vi.fn(async () => 'C:\\fake\\claude.exe'),
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh', 'max'],
}));
vi.mock('./claude-code.js', () => ({
  attachStdoutProcessing: vi.fn(() => () => {}),
  buildSpawnMcpConfigArgs: vi.fn(() => []),
  modelEffortArgs: vi.fn(() => []),
  permissionArgs: vi.fn(() => []),
  ensureSharedServersForRoot: vi.fn(async () => {}),
  DISALLOW_NATIVE_ASK: ['--disallowed-tools', 'AskUserQuestion'],
}));
vi.mock('./copilot.js', () => ({
  attachStdoutProcessing: vi.fn(() => () => {}),
  spawnCopilot: vi.fn(),
  buildAdditionalMcpConfigArgs: vi.fn(() => []),
}));
vi.mock('./gemini.js', () => ({
  attachStdoutProcessing: vi.fn(() => () => {}),
  spawnGemini: vi.fn(),
}));

import { makeBoardAdapter } from './board-core.js';
import { claudeBoardSpec } from './claude-board.js';
import { copilotBoardSpec } from './copilot-board.js';
import { geminiBoardSpec } from './gemini-board.js';
import { BOARD_CONVERSATION_ID } from './board.js';
import type { BoardSpec } from './board.js';
import type { CliSessionRecord } from './types.js';

const OVERSIZED_PROMPT = 'DIFF_LINE_'.repeat(4000); // mirrors claude-code-prompt-stdin.test.ts

function fakeProc(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  Object.assign(proc, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242,
    stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
  });
  return proc;
}

function fakeSession(): CliSessionRecord {
  return {
    status: 'pending',
    taskId: BOARD_CONVERSATION_ID,
    label: 'Orchestrator',
    args: [],
    startedAt: new Date().toISOString(),
    resumeSessionId: undefined,
    requestedStop: false,
  } as unknown as CliSessionRecord;
}

describe('wireBoardProc delivers the prompt via stdin, not argv (FLUX-1496)', () => {
  it('start path: writes the full prompt to stdin and closes it', async () => {
    let capturedProc: ReturnType<typeof fakeProc> | undefined;
    const spec: BoardSpec = {
      framework: 'gemini',
      binary: 'gemini',
      buildArgs: () => ['-p', ''],
      spawn: () => { capturedProc = fakeProc(); return capturedProc; },
      attachStdout: () => () => {},
    };
    const adapter = makeBoardAdapter(spec);
    const session = fakeSession();

    await adapter.startBoardSession(session, 'hello there', '/tmp/test-repo');

    expect(capturedProc).toBeDefined();
    const written = (capturedProc!.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(written).toContain('hello there');
    expect((capturedProc!.stdin as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled();
  });

  it('resume path: writes the full (oversized) prompt to stdin and closes it', async () => {
    let capturedProc: ReturnType<typeof fakeProc> | undefined;
    const spec: BoardSpec = {
      framework: 'gemini',
      binary: 'gemini',
      buildArgs: () => ['-p', ''],
      spawn: () => { capturedProc = fakeProc(); return capturedProc; },
      attachStdout: () => () => {},
    };
    const adapter = makeBoardAdapter(spec);
    const session = fakeSession();
    session.resumeSessionId = 'prior-session-id';

    await adapter.sendBoardInput(session, OVERSIZED_PROMPT, '/tmp/test-repo');

    expect(capturedProc).toBeDefined();
    const written = (capturedProc!.stdin as unknown as { write: ReturnType<typeof vi.fn> }).write.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(written).toContain(OVERSIZED_PROMPT);
    expect((capturedProc!.stdin as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled();
  });

  it('attaches the stdin error listener before writing (EPIPE-safe)', async () => {
    let capturedProc: ReturnType<typeof fakeProc> | undefined;
    const spec: BoardSpec = {
      framework: 'gemini',
      binary: 'gemini',
      buildArgs: () => ['-p', ''],
      spawn: () => { capturedProc = fakeProc(); return capturedProc; },
      attachStdout: () => () => {},
    };
    const adapter = makeBoardAdapter(spec);
    await adapter.startBoardSession(fakeSession(), 'hello', '/tmp/test-repo');

    const stdin = capturedProc!.stdin as unknown as { on: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    const onOrder = stdin.on.mock.invocationCallOrder[0]!;
    const writeOrder = stdin.write.mock.invocationCallOrder[0]!;
    expect(onOrder).toBeLessThan(writeOrder);
    expect(stdin.on).toHaveBeenCalledWith('error', expect.any(Function));
  });
});

describe.each([
  { name: 'claude', spec: claudeBoardSpec, expectBarePFlag: true },
  { name: 'copilot', spec: copilotBoardSpec, expectBarePFlag: true },
  { name: 'gemini', spec: geminiBoardSpec, expectBarePFlag: false },
])('$name board spec keeps argv prompt-free (FLUX-1496)', ({ spec, expectBarePFlag }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('buildArgs never places the (oversized) prompt in argv, for a fresh turn', async () => {
    const session = fakeSession();
    const args = await spec.buildArgs({
      session, prompt: OVERSIZED_PROMPT, workspaceRoot: '/tmp/test-repo', executionRoot: '/tmp/test-repo', isResume: false,
    });

    for (const arg of args) {
      expect(arg).not.toContain('DIFF_LINE_');
    }
    const idx = args.indexOf('-p');
    expect(idx).toBeGreaterThanOrEqual(0);
    if (expectBarePFlag) {
      // The next element must be another flag, never the prompt (bare `-p`).
      expect(args[idx + 1]?.startsWith('-') || idx + 1 === args.length).toBe(true);
    } else {
      // gemini: `-p` carries an empty placeholder (merges with stdin).
      expect(args[idx + 1]).toBe('');
    }
  });

  it('buildArgs never places the (oversized) prompt in argv, on resume', async () => {
    const session = fakeSession();
    session.resumeSessionId = 'prior-session-id';
    const args = await spec.buildArgs({
      session, prompt: OVERSIZED_PROMPT, workspaceRoot: '/tmp/test-repo', executionRoot: '/tmp/test-repo', isResume: true,
    });

    for (const arg of args) {
      expect(arg).not.toContain('DIFF_LINE_');
    }
    expect(args).toContain('--resume');
    expect(args).toContain('prior-session-id');
  });
});

// FLUX-1580 review follow-up (Major, blocking): cold-resume re-prime (`buildBoardReprime`, invoked
// via board-core.ts's explicit `runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), …)` wrap at
// board-core.ts:146) must recover the OWNING workspace's `__board__.jsonl` dialogue, not whichever
// workspace happens to be ambiently active. Unlike board-core.test.ts (which stubs
// `buildBoardReprime` entirely — see its FLUX-1209 suite), this file leaves `board-reprime.js` and
// `transcript.js` REAL so the actual per-workspace transcript read is exercised end-to-end. It must
// fail if the `runWithWorkspace` wrap at board-core.ts:146 is removed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ChildProcessWithoutNullStreams } from 'child_process';

vi.mock('../config.js', () => ({ getConfig: () => ({ projects: ['FLUX'] }) }));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../notifications.js', () => ({ generateOrchestratorReplyNotification: vi.fn() }));
vi.mock('../board-digest.js', () => ({ buildBoardDigest: vi.fn(() => '') }));
vi.mock('../resume-preamble.js', () => ({ buildResumePreamble: vi.fn(async () => null) }));
vi.mock('./shared.js', () => ({
  checkBinaryInstalled: vi.fn(async () => {}),
  appendSessionOutput: vi.fn(),
  flushSessionOutput: vi.fn(),
  resolveAttachmentAbsPaths: vi.fn(() => []),
  attachmentReadInstruction: vi.fn(() => ''),
}));

import { makeBoardAdapter } from './board-core.js';
import { setWorkspaceRoot } from '../workspace.js';
import { openWorkspace, closeWorkspace, listWorkspaces, runWithWorkspace, resolveWorkspaceByRoot } from '../workspace-context.js';
import { appendTranscriptEvent, flushTranscript } from '../transcript.js';
import { BOARD_CONVERSATION_ID } from './board.js';
import type { BoardSpec } from './board.js';
import type { CliSessionRecord } from './types.js';

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

describe('cold-resume re-prime rebinds to the SESSION\'s own workspace (FLUX-1580)', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-reprime-rebind-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-reprime-rebind-b-'));
    await fs.mkdir(path.join(rootA, '.flux'), { recursive: true });
    await fs.mkdir(path.join(rootB, '.flux'), { recursive: true });
    // rootA is the AMBIENT default (unbound getWorkspace() falls back to it, FLUX-1557) — the board
    // session under test is bound to rootB, but rootA is never entered via runWithWorkspace, mirroring
    // a route handler that hands `startBoardSession` the request's workspaceRoot without itself
    // wrapping the whole call.
    setWorkspaceRoot(rootA);
    openWorkspace(rootB);

    // Seed DISTINCT prior dialogue into each workspace's own `__board__.jsonl`.
    appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'user', text: 'what happened in workspace A', timestamp: new Date().toISOString() });
    appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'message', role: 'assistant', content: 'workspace A reply', timestamp: new Date().toISOString() });
    await flushTranscript(BOARD_CONVERSATION_ID);

    await runWithWorkspace(resolveWorkspaceByRoot(rootB), async () => {
      appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'user', text: 'what happened in workspace B', timestamp: new Date().toISOString() });
      appendTranscriptEvent(BOARD_CONVERSATION_ID, { type: 'message', role: 'assistant', content: 'workspace B reply', timestamp: new Date().toISOString() });
    });
    await flushTranscript(BOARD_CONVERSATION_ID);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await fs.rm(rootA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(rootB, { recursive: true, force: true }).catch(() => {});
  });

  it('re-primes a cold board start bound to rootB with rootB\'s dialogue, not the ambient rootA\'s', async () => {
    let capturedPrompt: string | undefined;
    const spec: BoardSpec = {
      framework: 'gemini',
      binary: 'gemini',
      buildArgs: ({ prompt }) => {
        capturedPrompt = prompt;
        return [];
      },
      spawn: () => fakeProc(),
      attachStdout: (_proc, session) => {
        session.resumeSessionId = 'gemini-session-rebind';
        return () => {};
      },
    };
    const adapter = makeBoardAdapter(spec);
    const session = {
      status: 'pending',
      taskId: BOARD_CONVERSATION_ID,
      label: 'Orchestrator',
      args: [],
      startedAt: new Date().toISOString(),
      resumeSessionId: undefined,
      requestedStop: false,
    } as unknown as CliSessionRecord;

    await adapter.startBoardSession(session, 'new turn', rootB);

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toContain('workspace B reply');
    expect(capturedPrompt).not.toContain('workspace A reply');
  });
});

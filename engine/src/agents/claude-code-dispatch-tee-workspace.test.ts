// FLUX-1580 review follow-up (Major, blocking): `teeDispatchActivityToBoard` tees a dispatched
// session's lifecycle activity onto its OWN workspace's `__board__.jsonl`, not whichever workspace
// happens to be ambiently active — several of its 9 call sites fire from raw child-process
// 'exit'/timeout callbacks with no ambient request binding (claude-code.ts:321). This test drives
// it directly (unmocked transcript.js / workspace-context.js) with a DIFFERENT workspace ambiently
// active than the dispatched session's own, and asserts the note lands in the OWNING workspace's
// transcript file, not the ambient one. It must fail if the `runWithWorkspace` wrap around
// `appendTranscriptEvent` at claude-code.ts:321 is removed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));

import { teeDispatchActivityToBoard } from './claude-code.js';
import { setWorkspaceRoot } from '../workspace.js';
import { openWorkspace, closeWorkspace, listWorkspaces } from '../workspace-context.js';
import { flushTranscript } from '../transcript.js';
import { BOARD_CONVERSATION_ID } from './board.js';
import type { CliSessionRecord } from './types.js';

async function readBoardTranscriptLines(root: string): Promise<string[]> {
  const file = path.join(root, '.flux', 'transcripts', `${BOARD_CONVERSATION_ID}.jsonl`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

describe('teeDispatchActivityToBoard rebinds to the dispatched session\'s OWN workspace (FLUX-1580)', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tee-rebind-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tee-rebind-b-'));
    await fs.mkdir(path.join(rootA, '.flux'), { recursive: true });
    await fs.mkdir(path.join(rootB, '.flux'), { recursive: true });
    // rootA is the AMBIENT default (mirrors an unbound background callback resolving to
    // `defaultWorkspace` per FLUX-1557) — rootB is a second, separately-registered workspace that
    // owns the dispatched session under test but is never made ambiently active.
    setWorkspaceRoot(rootA);
    openWorkspace(rootB);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await fs.rm(rootA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(rootB, { recursive: true, force: true }).catch(() => {});
  });

  it('tees onto the dispatched session\'s own workspace transcript, not the ambiently-active one', async () => {
    const session = {
      taskId: 'FLUX-9001',
      phase: 'implementation',
      startedAt: new Date().toISOString(),
      workspaceRoot: rootB,
    } as unknown as CliSessionRecord;

    // Called OUTSIDE any runWithWorkspace(rootB) — exactly the shape of a detached child-process
    // exit-handler callback with no ambient request binding.
    teeDispatchActivityToBoard(session, 'FLUX-9001', 'started', 'implementation session started');
    await flushTranscript(BOARD_CONVERSATION_ID);

    const linesA = await readBoardTranscriptLines(rootA);
    const linesB = await readBoardTranscriptLines(rootB);

    expect(linesA).toHaveLength(0);
    expect(linesB).toHaveLength(1);
    const envelope = JSON.parse(linesB[0]!);
    expect(envelope.raw).toMatchObject({
      type: 'dispatch-activity',
      sourceTask: 'FLUX-9001',
      lifecycle: 'started',
      text: 'implementation session started',
    });
  });

  it('falls through to the ambient workspace when the session has no workspaceRoot (legacy pass-through)', async () => {
    const session = {
      taskId: 'FLUX-9002',
      phase: 'implementation',
      startedAt: new Date().toISOString(),
    } as unknown as CliSessionRecord;

    teeDispatchActivityToBoard(session, 'FLUX-9002', 'started', 'legacy session started');
    await flushTranscript(BOARD_CONVERSATION_ID);

    const linesA = await readBoardTranscriptLines(rootA);
    const linesB = await readBoardTranscriptLines(rootB);
    expect(linesA).toHaveLength(1);
    expect(linesB).toHaveLength(0);
  });
});

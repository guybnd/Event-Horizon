import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { loadTask } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';
import type { HistoryEntryLike } from './history.js';

function findAgentSession(history: unknown): HistoryEntryLike & { progress: { message: string }[] } {
  const entries = Array.isArray(history) ? (history as HistoryEntryLike[]) : [];
  const session = entries.find((e) => e.type === 'agent_session');
  if (!session) throw new Error('no agent_session entry found');
  return session as HistoryEntryLike & { progress: { message: string }[] };
}

/**
 * FLUX-1287 regression guard. FLUX-1202's compactSessionProgress only ran from
 * updateAgentSessionLocked, scoped to the one session an in-flight update touched — a session
 * that was already terminal (and already persisted bloated) before FLUX-1202 landed never got
 * revisited, so it stayed bloated forever. loadTask() now runs the same compaction over every
 * terminal agent_session entry on every load and writes back if anything shrank.
 */
describe('loadTask() retroactively compacts already-bloated terminal sessions (FLUX-1287)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-history-compact-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('shrinks a bloated terminal session progress log and persists the compacted file', async () => {
    const filePath = path.join(fluxDir, 'FLUX-1.md');
    const bloatedProgress = Array.from({ length: 8 }, (_, i) => ({
      timestamp: '2026-06-01T10:00:00.000Z',
      message: `chunk ${i + 1}`,
      type: 'text',
    }));
    await fs.writeFile(filePath, matter.stringify('body', {
      id: 'FLUX-1',
      title: 'A ticket',
      status: 'Done',
      history: [
        {
          type: 'agent_session',
          sessionId: 's1',
          status: 'completed',
          startedAt: '2026-06-01T10:00:00.000Z',
          date: '2026-06-01T10:00:00.000Z',
          user: 'Agent',
          progress: bloatedProgress,
        },
      ],
    }));

    await loadTask(filePath);

    const cachedSession = findAgentSession(getWorkspace().tasks['FLUX-1']?.history);
    expect(cachedSession.progress).toHaveLength(2);
    expect(cachedSession.progress.map((p) => p.message)).toEqual(['chunk 7', 'chunk 8']);
    expect(cachedSession.finalMessage).toBe('chunk 8');

    // Write-back actually landed on disk, not just in the in-memory cache.
    const persisted = matter(await fs.readFile(filePath, 'utf-8'));
    const persistedSession = findAgentSession(persisted.data.history);
    expect(persistedSession.progress).toHaveLength(2);
  });

  it('does not rewrite the file when the session is already compacted (idempotent, no-op write)', async () => {
    const filePath = path.join(fluxDir, 'FLUX-2.md');
    await fs.writeFile(filePath, matter.stringify('body', {
      id: 'FLUX-2',
      title: 'A ticket',
      status: 'Done',
      history: [
        {
          type: 'agent_session',
          sessionId: 's1',
          status: 'completed',
          startedAt: '2026-06-01T10:00:00.000Z',
          date: '2026-06-01T10:00:00.000Z',
          user: 'Agent',
          progress: [{ timestamp: '2026-06-01T10:00:00.000Z', message: 'Running tests', type: 'tool' }],
          finalMessage: 'done',
          originalProgressCount: 50,
        },
      ],
    }));
    const before = await fs.readFile(filePath, 'utf-8');

    await loadTask(filePath);

    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(before);
  });

  it('leaves an active session untouched', async () => {
    const filePath = path.join(fluxDir, 'FLUX-3.md');
    const activeProgress = Array.from({ length: 8 }, (_, i) => ({
      timestamp: '2026-06-01T10:00:00.000Z',
      message: `chunk ${i + 1}`,
      type: 'text',
    }));
    await fs.writeFile(filePath, matter.stringify('body', {
      id: 'FLUX-3',
      title: 'A ticket',
      status: 'In Progress',
      history: [
        {
          type: 'agent_session',
          sessionId: 's1',
          status: 'active',
          startedAt: '2026-06-01T10:00:00.000Z',
          date: '2026-06-01T10:00:00.000Z',
          user: 'Agent',
          progress: activeProgress,
        },
      ],
    }));

    await loadTask(filePath);

    const cachedSession = findAgentSession(getWorkspace().tasks['FLUX-3']?.history);
    expect(cachedSession.progress).toHaveLength(8);
  });
});

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { updateTaskWithHistory, updateAgentSession } from './task-store.js';

/**
 * FLUX-992 regression guard. updateAgentSession used to do its own unlocked
 * read-modify-write of the full ticket frontmatter, independent of the per-ticket
 * write lock (serializeTicketWrite) that updateTaskWithHistory goes through. A
 * concurrent updateTaskWithHistory write (e.g. change_status setting swimlane)
 * landing in the same window got silently reverted whenever updateAgentSession's
 * stale read committed its write afterwards — exactly what happened to PR-227's
 * require-input swimlane.
 */
describe('updateAgentSession is serialized with updateTaskWithHistory (FLUX-992)', () => {
  const taskId = 'FLUX-1';
  const sessionId = 'session-1';
  let fluxDir: string;
  let ticketPath: string;

  beforeEach(async () => {
    fluxDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-lock-'));
    ticketPath = path.join(fluxDir, `${taskId}.md`);

    const history = [{ type: 'agent_session', sessionId, status: 'active' }];
    await fs.writeFile(
      ticketPath,
      matter.stringify('body', { id: taskId, title: 'Race me', status: 'In Progress', swimlane: null, history }),
    );

    getWorkspace().tasks[taskId] = {
      id: taskId,
      title: 'Race me',
      status: 'In Progress',
      swimlane: null,
      history,
      _path: ticketPath,
    };
  });

  afterEach(async () => {
    delete getWorkspace().tasks[taskId];
    vi.restoreAllMocks();
    await fs.rm(fluxDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a concurrent session checkpoint does not revert a swimlane set moments before', async () => {
    // Both calls read the ticket at ~t=0, before either has written — the shape of the race.
    // Make the swimlane write land first and the session-checkpoint write land second (via a
    // longer delay), which is exactly the ordering that reverted PR-227's swimlane pre-fix:
    // updateAgentSession's write, built from its stale pre-swimlane read, commits last and wins.
    // Post-fix, the shared per-ticket lock forces updateAgentSession to run strictly after
    // updateTaskWithHistory, so this delay ordering can no longer matter.
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      const [filePath, data] = args;
      if (filePath === `${ticketPath}.tmp` && typeof data === 'string') {
        const isSwimlaneWrite = matter(data).data.swimlane === 'require-input';
        await new Promise((r) => setTimeout(r, isSwimlaneWrite ? 5 : 30));
      }
      return realWriteFile(...args);
    });

    await Promise.all([
      updateTaskWithHistory(taskId, { extraFields: { swimlane: 'require-input' } }),
      updateAgentSession(taskId, sessionId, (session) => {
        session.status = 'paused';
      }),
    ]);

    const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
    expect(onDisk.data.swimlane).toBe('require-input');
    const history = onDisk.data.history as Array<{ sessionId?: string; status?: string }>;
    const persistedSession = history.find((e) => e.sessionId === sessionId);
    expect(persistedSession?.status).toBe('paused');
  });
});

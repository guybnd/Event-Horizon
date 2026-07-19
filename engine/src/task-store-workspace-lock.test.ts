import { Workspace } from './workspace-context.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { updateTaskWithHistory } from './task-store.js';

/**
 * FLUX-1451 regression guard. ticketWriteChains used to be keyed by bare ticket id, so two
 * different workspaces both containing a "FLUX-1" shared one lock chain and serialized against
 * each other for no reason (a cross-board contention bug, not a data-loss one). Now keyed by
 * `(Workspace, id)` via an outer WeakMap — same id in different workspaces gets independent
 * chains, while same id in the SAME workspace still serializes (FLUX-645, unchanged).
 */
describe('ticketWriteChains is keyed per-workspace (FLUX-1451)', () => {
  const taskId = 'FLUX-1';

  async function makeWorkspace(prefix: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const ticketPath = path.join(dir, `${taskId}.md`);
    await fs.writeFile(
      ticketPath,
      matter.stringify('body', { id: taskId, title: prefix, status: 'In Progress', history: [] }),
    );
    const ws = new Workspace();
    ws.root = dir;
    ws.tasks[taskId] = { id: taskId, title: prefix, status: 'In Progress', history: [], _path: ticketPath };
    return { dir, ticketPath, ws };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('a slow write to FLUX-1 in workspace A does not delay a write to FLUX-1 in workspace B', async () => {
    const { dir: dirA, ticketPath: pathA, ws: wsA } = await makeWorkspace('eh-ws-lock-a-');
    const { dir: dirB, ticketPath: pathB, ws: wsB } = await makeWorkspace('eh-ws-lock-b-');
    try {
      const realWriteFile = fs.writeFile.bind(fs);
      let resolveAStarted: () => void;
      const aStartedPromise = new Promise<void>((resolve) => {
        resolveAStarted = resolve;
      });
      let aFinished = false;
      let bWriteCalledWhileAInFlight = false;
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        const [filePath] = args;
        if (filePath === `${pathA}.tmp`) {
          resolveAStarted();
          await new Promise((r) => setTimeout(r, 50));
          aFinished = true;
        } else if (filePath === `${pathB}.tmp`) {
          if (!aFinished) bWriteCalledWhileAInFlight = true;
        }
        return realWriteFile(...args);
      });

      // Kick off A first and wait until its (slow) write is actually in flight before starting B —
      // if the two workspaces still shared one lock chain, B's write would have to wait for A's
      // entire chain to finish before even reaching fs.writeFile, so it could never land while A
      // is still mid-write.
      const aPromise = updateTaskWithHistory(taskId, { entries: [] }, wsA);
      await aStartedPromise;
      const bPromise = updateTaskWithHistory(taskId, { entries: [] }, wsB);
      await Promise.all([aPromise, bPromise]);

      expect(bWriteCalledWhileAInFlight).toBe(true);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true }).catch(() => {});
      await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('two concurrent writes to the SAME (workspace, id) still serialize (no FLUX-645 regression)', async () => {
    const { dir, ticketPath, ws } = await makeWorkspace('eh-ws-lock-same-');
    try {
      await Promise.all([
        updateTaskWithHistory(
          taskId,
          { entries: [{ type: 'comment', user: 'Agent', comment: 'first', date: new Date().toISOString() }] },
          ws,
        ),
        updateTaskWithHistory(
          taskId,
          { entries: [{ type: 'comment', user: 'Agent', comment: 'second', date: new Date().toISOString() }] },
          ws,
        ),
      ]);

      const onDisk = matter(await fs.readFile(ticketPath, 'utf-8'));
      const history = onDisk.data.history as Array<{ comment?: string }>;
      expect(history.some((e) => e.comment === 'first')).toBe(true);
      expect(history.some((e) => e.comment === 'second')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

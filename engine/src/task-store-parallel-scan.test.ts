import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';

vi.mock('./events.js', () => ({
  broadcastEvent: vi.fn(),
  bumpTasksVersion: vi.fn(),
}));

import { initDir } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';

/**
 * FLUX-1547 Phase 1: initDir's cold-boot loop now runs a bounded-concurrency pool instead of a
 * strictly serial `for` loop. These tests cover the two properties that matter for that change:
 * the pool actually overlaps file I/O (the whole point), and the final store state is identical
 * to the old serial result regardless of which file happens to finish first.
 */
describe('initDir parallel scan (FLUX-1547)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-parallel-scan-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
  });

  afterEach(async () => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  async function writeTickets(count: number, startAt = 0) {
    for (let i = 0; i < count; i++) {
      const id = `FLUX-${3000 + startAt + i}`;
      await fs.writeFile(path.join(fluxDir, `${id}.md`), matter.stringify('body', { id, title: id, status: 'Todo' }));
    }
  }

  it('produces a complete, correct store state regardless of concurrent completion order', async () => {
    await writeTickets(80);

    await initDir();

    const ids = Object.keys(getWorkspace().tasks).sort();
    expect(ids).toHaveLength(80);
    for (const id of ids) {
      expect(getWorkspace().tasks[id]!.title).toBe(id);
      expect(getWorkspace().tasks[id]!.status).toBe('Todo');
    }
  });

  it('overlaps file reads instead of finishing one file fully before starting the next', async () => {
    await writeTickets(40);
    let concurrentReads = 0;
    let maxConcurrentReads = 0;
    const originalReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: unknown[]) => {
      concurrentReads += 1;
      maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
      try {
        // Give other in-flight workers a chance to start their own read before this one resolves.
        await new Promise((resolve) => setImmediate(resolve));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await (originalReadFile as any)(...args);
      } finally {
        concurrentReads -= 1;
      }
    }) as typeof fs.readFile);

    await initDir();

    expect(maxConcurrentReads).toBeGreaterThan(1);
    expect(Object.keys(getWorkspace().tasks).length).toBe(40);
    spy.mockRestore();
  });
});

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';

const broadcastEvent = vi.fn();
vi.mock('./events.js', () => ({
  broadcastEvent: (...args: unknown[]) => broadcastEvent(...args),
  bumpTasksVersion: vi.fn(),
}));

import { initDir } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';

/**
 * FLUX-1540: the engine emits `bootProgress` broadcasts periodically during initDir's cold-boot
 * scan so the portal can render real "Loaded X / Y tickets" progress instead of a static skeleton
 * for the whole scan. FLUX-1547 replaced the serial scan with a bounded-concurrency pool and
 * lowered the emission threshold from every 50 files to every 10 (BOOT_PROGRESS_EVERY in
 * task-store.ts) — the pool completes files out of order, but the threshold crossings themselves
 * (a simple shared counter incremented once per completion) stay deterministic regardless of which
 * specific file finishes when, so these exact-count assertions still hold.
 */
describe('initDir bootProgress broadcasts (FLUX-1540)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    broadcastEvent.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-boot-progress-'));
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
      const id = `FLUX-${1000 + startAt + i}`;
      await fs.writeFile(path.join(fluxDir, `${id}.md`), matter.stringify('body', { id, title: id, status: 'Todo' }));
    }
  }

  function bootProgressCalls() {
    return broadcastEvent.mock.calls.filter((c) => c[0] === 'bootProgress');
  }

  it('emits a bootProgress broadcast at each 10-file threshold plus a terminal ready event', async () => {
    await writeTickets(125);

    await initDir();

    const calls = bootProgressCalls();
    // 125 files at 10-per-batch thresholds (12 crossings: 10, 20, ..., 120), plus one terminal event.
    expect(calls).toHaveLength(13);
    for (let i = 0; i < 12; i++) {
      expect(calls[i]![1]).toEqual({ loaded: (i + 1) * 10, total: 125, phase: 'scanning' });
    }
    expect(calls[12]![1]).toEqual({ loaded: 125, total: 125, phase: 'ready' });
  });

  it('emits only the terminal ready event when the scan never crosses a threshold', async () => {
    await writeTickets(3);

    await initDir();

    const calls = bootProgressCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ loaded: 3, total: 3, phase: 'ready' });
  });

  it('total counts only top-level task files, not stray non-ticket files', async () => {
    await writeTickets(2);
    await fs.writeFile(path.join(fluxDir, 'notes.txt'), 'not a ticket');

    await initDir();

    const calls = bootProgressCalls();
    expect(calls[calls.length - 1]![1]).toMatchObject({ loaded: 2, total: 2, phase: 'ready' });
  });

  it('does not let a throwing broadcastEvent break the scan', async () => {
    broadcastEvent.mockImplementation((event: string) => {
      if (event === 'bootProgress') throw new Error('boom');
    });
    await writeTickets(60);

    await expect(initDir()).resolves.toBeUndefined();

    expect(Object.keys(getWorkspace().tasks).length).toBe(60);
  });
});

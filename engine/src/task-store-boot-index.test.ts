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
import { bootIndexPath, loadBootIndex, BOOT_INDEX_VERSION } from './boot-index.js';

/**
 * FLUX-1547 Phase 2: the persisted boot index lets a warm boot skip the full
 * read+parse+validate+history-normalize pipeline for every ticket unchanged since the last
 * rescan. These tests exercise the real `initDir()` end-to-end (index write → reload → reuse /
 * invalidate / fall back) rather than unit-testing boot-index.ts's helpers in isolation, since the
 * behavior that matters is what `ws.tasks` ends up containing after each boot.
 */
describe('initDir persistent boot index (FLUX-1547)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    broadcastEvent.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-boot-index-'));
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

  async function writeTicket(id: string, title: string) {
    await fs.writeFile(path.join(fluxDir, `${id}.md`), matter.stringify('body', { id, title, status: 'Todo' }));
  }

  function bootProgressCalls() {
    return broadcastEvent.mock.calls.filter((c) => c[0] === 'bootProgress');
  }

  it('writes a valid, versioned index after a cold boot', async () => {
    await writeTicket('FLUX-1', 'First');
    await writeTicket('FLUX-2', 'Second');

    await initDir();

    const index = await loadBootIndex(fluxDir);
    expect(index).not.toBeNull();
    expect(index!.version).toBe(BOOT_INDEX_VERSION);
    expect(Object.keys(index!.entries).sort()).toEqual(['FLUX-1', 'FLUX-2']);
    expect(index!.entries['FLUX-1']!.path).toBe('FLUX-1.md');
    expect(index!.entries['FLUX-1']!.data.title).toBe('First');
  });

  it('reuses the cache on a warm boot without re-deriving stale data, and reports a single terminal ready event', async () => {
    await writeTicket('FLUX-1', 'First');
    await writeTicket('FLUX-2', 'Second');
    await initDir();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    broadcastEvent.mockClear();

    await initDir();

    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');
    expect(getWorkspace().tasks['FLUX-2']?.title).toBe('Second');
    // A fully warm boot (every file hit the cache) should emit exactly one bootProgress event —
    // the terminal `ready` — not a separate 'cached' announcement plus a redundant 'ready'.
    const calls = bootProgressCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ loaded: 2, total: 2, phase: 'ready' });
  });

  it('invalidates only the changed entry when a file is edited between boots', async () => {
    await writeTicket('FLUX-1', 'First');
    await writeTicket('FLUX-2', 'Second');
    await initDir();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

    // Ensure a distinguishable mtime, then rewrite FLUX-2 with new content.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeTicket('FLUX-2', 'Second Revised');
    broadcastEvent.mockClear();

    await initDir();

    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');
    expect(getWorkspace().tasks['FLUX-2']?.title).toBe('Second Revised');
    // The changed file went through the 'cached' partial-hit path, not a fully warm boot.
    const calls = bootProgressCalls();
    expect(calls.some((c) => c[1].phase === 'cached')).toBe(true);
  });

  it('does not resurrect a ticket whose file was deleted between boots', async () => {
    await writeTicket('FLUX-1', 'First');
    await writeTicket('FLUX-2', 'Second');
    await initDir();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

    await fs.rm(path.join(fluxDir, 'FLUX-2.md'));

    await initDir();

    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');
    expect(getWorkspace().tasks['FLUX-2']).toBeUndefined();
  });

  it('picks up a ticket file added after the last snapshot', async () => {
    await writeTicket('FLUX-1', 'First');
    await initDir();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

    await writeTicket('FLUX-2', 'Second');

    await initDir();

    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');
    expect(getWorkspace().tasks['FLUX-2']?.title).toBe('Second');
  });

  it('falls back to a full scan when the index file is corrupt JSON', async () => {
    await writeTicket('FLUX-1', 'First');
    await initDir();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

    await fs.writeFile(bootIndexPath(fluxDir), '{ not valid json');

    await expect(initDir()).resolves.toBeUndefined();
    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');

    // A fresh, valid index is written by the fallback full scan.
    const index = await loadBootIndex(fluxDir);
    expect(index).not.toBeNull();
  });

  it('falls back to a full scan when the index version does not match', async () => {
    await writeTicket('FLUX-1', 'First');
    await initDir();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

    await fs.writeFile(bootIndexPath(fluxDir), JSON.stringify({ version: 999, entries: {} }));

    await initDir();

    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');
    const index = await loadBootIndex(fluxDir);
    expect(index!.version).toBe(BOOT_INDEX_VERSION);
  });

  it('boots correctly with no index file at all (first-ever boot)', async () => {
    await writeTicket('FLUX-1', 'First');

    await expect(initDir()).resolves.toBeUndefined();

    expect(getWorkspace().tasks['FLUX-1']?.title).toBe('First');
  });
});

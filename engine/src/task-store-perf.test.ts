import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { loadTask, initDir, tasksCache } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';
import { snapshot, resetForTest } from './perf/registry.js';

/**
 * FLUX-1132 regression guard. Exercises the real `loadTask`/`initDir` — heavier than a pure spy
 * test, but the wrapper only matters if it survives every real exit path (a parse error, the
 * "not a task file" guard, and the happy path all return from different points inside the
 * function). `activateWorkspace()` nests this same `initDir()` call but records its own umbrella
 * duration under the separate `recordWorkspaceActivation()`/`store.workspaceActivation` metric
 * (FLUX-1184) — not separately exercised here to avoid dragging in its git/worktree/group-docs
 * side effects (flaky on Windows per prior test-suite experience).
 */
describe('task-store perf instrumentation (FLUX-1132)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    resetForTest();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-perf-store-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  });

  afterEach(async () => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('records store.loadTask on a successful load', async () => {
    const filePath = path.join(fluxDir, 'FLUX-1.md');
    await fs.writeFile(filePath, matter.stringify('body', { id: 'FLUX-1', title: 'A ticket', status: 'Todo' }));

    await loadTask(filePath);

    expect(snapshot().histograms['store.loadTask']?.count).toBe(1);
    expect(tasksCache['FLUX-1']?.title).toBe('A ticket');
  });

  it('records store.loadTask even when the early "not a top-level task file" guard fires', async () => {
    const filePath = path.join(fluxDir, 'notes.txt');

    await loadTask(filePath);

    expect(snapshot().histograms['store.loadTask']?.count).toBe(1);
  });

  it('records store.loadTask even when the file fails to parse', async () => {
    const filePath = path.join(fluxDir, 'FLUX-2.md');
    await fs.writeFile(filePath, '   '); // blank content — loadTask's own empty-file guard

    await loadTask(filePath);

    expect(snapshot().histograms['store.loadTask']?.count).toBe(1);
  });

  it('records store.fullRescan on every initDir() call', async () => {
    await initDir();

    expect(snapshot().histograms['store.fullRescan']?.count).toBe(1);
  });

  it('loads every top-level ticket file during initDir()\'s rescan', async () => {
    await fs.writeFile(path.join(fluxDir, 'FLUX-3.md'), matter.stringify('body', { id: 'FLUX-3', title: 'Rescanned', status: 'Todo' }));

    await initDir();

    expect(tasksCache['FLUX-3']?.title).toBe('Rescanned');
    expect(snapshot().histograms['store.fullRescan']?.count).toBe(1);
  });

  it('yields to the event loop every 50 files during a large rescan (FLUX-1188)', async () => {
    const fileCount = 125;
    for (let i = 0; i < fileCount; i++) {
      const id = `FLUX-${1000 + i}`;
      await fs.writeFile(path.join(fluxDir, `${id}.md`), matter.stringify('body', { id, title: id, status: 'Todo' }));
    }
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');

    await initDir();

    // 125 files at 50-per-batch yields after file 50 and file 100 — two yields, not zero.
    expect(setImmediateSpy).toHaveBeenCalledTimes(2);
    expect(Object.keys(tasksCache).length).toBe(fileCount);
  });
});

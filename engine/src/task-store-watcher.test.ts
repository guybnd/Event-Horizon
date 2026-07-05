import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { initDir, startWatchers, tasksCache, reconcileBackgroundPull } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';
import { snapshot, resetForTest } from './perf/registry.js';
import { resetWatchStormForTest } from './perf/watch-storm.js';

/**
 * FLUX-1184 regression guard. Before this ticket, `startWatchers()`'s chokidar instances had no
 * `ignoreInitial`, so chokidar's own initial directory scan replayed an 'add' for every
 * pre-existing top-level ticket file — right after `initDir()` had already loaded every one of
 * them directly. On a large board that redundant reload flooded the FLUX-1132 watcher-storm
 * counter at boot (not real post-boot file activity) and the burst of concurrent `loadTask()`
 * promises is what inflated boot's "slow full rescan" telemetry into looking like two separate
 * rescans. These tests exercise the real chokidar watcher (not a spy) since the bug is entirely
 * in chokidar's own config — a mock would hide it. fs-watcher tests are inherently a little
 * timing-sensitive; if this flakes under a full parallel run, re-verify in isolation first
 * (precedent: storage-sync tests have the same Windows caveat).
 */
describe('startWatchers() boot behavior (FLUX-1184)', () => {
  let root: string;
  let fluxDir: string;

  async function waitFor(predicate: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition');
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  function ticketContent(id: string, title: string) {
    return matter.stringify('body', { id, title, status: 'Todo' });
  }

  beforeEach(async () => {
    resetForTest();
    resetWatchStormForTest();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-watcher-'));
    // Mirrors activateWorkspace()'s own realpath normalization (FLUX-711): an 8.3 short-name
    // path (e.g. a "Guy Razer" user profile → GUYRAZ~1) handed to chokidar aborts the whole
    // process (libuv fs-event.c assertion) instead of throwing a catchable JS error.
    try { root = realpathSync.native(root); } catch { /* keep as given */ }
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

  // startWatchers() closes the PREVIOUS watcher on each call but has no standalone stop/close
  // export — closing the last one this file opens means opening one more against a scratch dir.
  afterAll(async () => {
    let scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-watcher-scratch-'));
    try { scratch = realpathSync.native(scratch); } catch { /* keep as given */ }
    setWorkspaceRoot(scratch);
    await startWatchers();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  });

  it('does not replay pre-existing ticket files as watch events after initDir() already loaded them', async () => {
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(path.join(fluxDir, `FLUX-${i}.md`), ticketContent(`FLUX-${i}`, `Ticket ${i}`));
    }

    await initDir(); // boot's real rescan — loads all 5 directly
    expect(Object.keys(tasksCache)).toHaveLength(5);

    await startWatchers();

    // Give chokidar's initial scan a real window to (mis)fire 'add' events, then assert it didn't.
    await new Promise((r) => setTimeout(r, 1000));
    expect(snapshot().counters['store.watchEvents']).toBeUndefined();
  }, 15_000);

  it('an incremental burst of changed files reloads only those files, not a full rescan', async () => {
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(path.join(fluxDir, `FLUX-${i}.md`), ticketContent(`FLUX-${i}`, `Ticket ${i}`));
    }
    await initDir();
    await startWatchers();
    await new Promise((r) => setTimeout(r, 1000)); // let the (now-suppressed) initial scan settle

    const fullRescanCountBefore = snapshot().histograms['store.fullRescan']?.count ?? 0;

    // Touch 3 of the 5 existing files — simulates a small watcher-triggered burst.
    for (const i of [1, 2, 3]) {
      await fs.writeFile(path.join(fluxDir, `FLUX-${i}.md`), ticketContent(`FLUX-${i}`, `Ticket ${i} updated`));
    }

    await waitFor(() => (snapshot().counters['store.watchEvents'] ?? 0) >= 3);
    await new Promise((r) => setTimeout(r, 300)); // let any coalesced duplicate fs events settle

    expect(snapshot().counters['store.watchEvents']).toBe(3);
    expect(snapshot().histograms['store.fullRescan']?.count ?? 0).toBe(fullRescanCountBefore);
    expect(tasksCache['FLUX-1']?.title).toBe('Ticket 1 updated');
    expect(tasksCache['FLUX-2']?.title).toBe('Ticket 2 updated');
    expect(tasksCache['FLUX-3']?.title).toBe('Ticket 3 updated');
    expect(tasksCache['FLUX-4']?.title).toBe('Ticket 4'); // untouched — proves it's per-file, not a rescan
  }, 15_000);
});

/**
 * FLUX-1184 (review follow-up). Making activeFluxWatcher ignoreInitial:true (above) removed the
 * mechanism attachWorktreeIfPresent's backgrounded orphan-mode `git pull` used to rely on: chokidar's
 * old initial 'add' scan replaying pre-existing files, which happened to also pick up whichever side
 * of the pull-vs-scan race a late-landing write fell on. reconcileBackgroundPull (storage-sync.ts's
 * `onPulledFiles` callback, wired in activateWorkspace) is the explicit replacement — these tests
 * exercise it directly against real files in an orphan-mode (`.flux-store`) directory.
 */
describe('reconcileBackgroundPull() — orphan-mode background-pull catch-up (FLUX-1184)', () => {
  let root: string;
  let storeDir: string;

  function ticketContent(id: string, title: string) {
    return matter.stringify('body', { id, title, status: 'Todo' });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-reconcile-'));
    try { root = realpathSync.native(root); } catch { /* keep as given */ }
    storeDir = path.join(root, '.flux-store');
    await fs.mkdir(storeDir, { recursive: true });
    // getConfigFile() falls back to `.flux/config.json` until `.flux-store/config.json` exists
    // (config.json is local-only, never synced) — a real activateWorkspace() creates this dir via
    // bootstrapNewWorkspace() before initDir() runs; do the same here.
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  });

  afterEach(async () => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('loads a file the background pull added after initDir() already ran', async () => {
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), ticketContent('FLUX-1', 'Existing ticket'));
    await initDir();
    expect(Object.keys(tasksCache)).toEqual(['FLUX-1']);

    // Simulates the pull landing a new ticket file mid-boot, after initDir()'s own scan — this is
    // exactly the write the old chokidar-replay safety net used to catch.
    await fs.writeFile(path.join(storeDir, 'FLUX-2.md'), ticketContent('FLUX-2', 'Pulled-in ticket'));

    await reconcileBackgroundPull(storeDir, ['FLUX-2.md']);

    expect(tasksCache['FLUX-2']?.title).toBe('Pulled-in ticket');
    expect(Object.keys(tasksCache).sort()).toEqual(['FLUX-1', 'FLUX-2']);
  });

  it('refreshes a file whose content the pull changed after initDir() cached the stale version', async () => {
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), ticketContent('FLUX-1', 'Stale title'));
    await initDir();
    expect(tasksCache['FLUX-1']?.title).toBe('Stale title');

    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), ticketContent('FLUX-1', 'Pulled title'));
    await reconcileBackgroundPull(storeDir, ['FLUX-1.md']);

    expect(tasksCache['FLUX-1']?.title).toBe('Pulled title');
  });

  it('removes a ticket the pull deleted', async () => {
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), ticketContent('FLUX-1', 'To be deleted'));
    await initDir();
    expect(tasksCache['FLUX-1']).toBeDefined();

    await fs.rm(path.join(storeDir, 'FLUX-1.md'));
    await reconcileBackgroundPull(storeDir, ['FLUX-1.md']);

    expect(tasksCache['FLUX-1']).toBeUndefined();
  });

  it('ignores nested/non-ticket paths from the pull diff (assets, session files)', async () => {
    await initDir();
    await fs.mkdir(path.join(storeDir, 'assets', 'FLUX-1'), { recursive: true });
    await fs.writeFile(path.join(storeDir, 'assets', 'FLUX-1', 'note.png'), 'binary');

    // Should not throw despite the path not being a top-level ticket file, and must not add a
    // spurious cache entry for it.
    await reconcileBackgroundPull(storeDir, ['assets/FLUX-1/note.png']);

    expect(Object.keys(tasksCache)).toHaveLength(0);
  });
});

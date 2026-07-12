import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  setWorkspaceRoot,
  getFluxDir,
  getFluxStoreDir,
  getActiveFluxDir,
  getConfigFile,
  isOrphanMode,
  requireWorkspaceRoot,
} from './workspace.js';
import { resolveTaskExecutionRoot } from './task-worktree.js';

/**
 * FLUX-520 regression guard for the two-roots split (FLUX-516/FLUX-519).
 *
 * The engine workspace root owns ticket state; a per-task worktree is only the
 * agent EXECUTION root. These tests lock the invariant that flux/ticket-dir
 * resolution is derived from the configured workspace root — never from
 * `process.cwd()` or a per-session execution root — so an agent running with
 * `cwd` = its worktree (which may carry its own tracked `.flux/` copy) can never
 * cause the engine to read tickets from anywhere but the canonical store.
 */
describe('flux dir resolution is pinned to the engine workspace root (FLUX-520)', () => {
  let engineRoot: string;
  let elsewhere: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    engineRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-fluxdir-engine-'));
    elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-fluxdir-other-'));
  });

  afterEach(async () => {
    process.chdir(originalCwd); // restore — chdir is process-global
    await fs.rm(engineRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(elsewhere, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves .flux / .flux-store under the workspace root, not process.cwd()', () => {
    setWorkspaceRoot(engineRoot);
    // Move cwd entirely elsewhere — simulating an agent running in a worktree.
    process.chdir(elsewhere);

    expect(getFluxDir()).toBe(path.join(engineRoot, '.flux'));
    expect(getFluxStoreDir()).toBe(path.join(engineRoot, '.flux-store'));
  });

  it('keeps the canonical store authoritative even when a worktree has its own .flux copy', async () => {
    // Orphan mode: the engine root owns .flux-store.
    await fs.mkdir(path.join(engineRoot, '.flux-store'), { recursive: true });
    setWorkspaceRoot(engineRoot);
    expect(isOrphanMode()).toBe(true);

    // A worktree with its OWN tracked .flux copy must never become the store.
    const worktree = path.join(elsewhere, 'worktree');
    await fs.mkdir(path.join(worktree, '.flux'), { recursive: true });
    process.chdir(worktree);

    expect(getActiveFluxDir()).toBe(path.join(engineRoot, '.flux-store'));
    expect(getActiveFluxDir()).not.toBe(path.join(worktree, '.flux'));
  });

  it('execution root is independent of flux resolution', async () => {
    setWorkspaceRoot(engineRoot);
    // No branch → execution root is the engine root; flux resolution is independent
    // of whatever the execution root is.
    const execRoot = await resolveTaskExecutionRoot({ id: 'FLUX-1' }, engineRoot);
    expect(execRoot).toBe(engineRoot);
    expect(getActiveFluxDir().startsWith(engineRoot)).toBe(true);
  });
});

/**
 * FLUX-1340 regression guard: config path resolution on a freshly-cloned orphan store.
 *
 * config.json is gitignored on flux-data (FLUX-532), so a workspace attached by cloning an
 * existing flux-data branch has a .flux-store/ full of tickets but no .flux-store/config.json,
 * and no .flux/ directory at all. getConfigFile() must resolve to the STORE path in that state,
 * not the in-repo .flux/config.json — otherwise loadConfig()'s first-run default write throws
 * ENOENT writing .flux/config.json.tmp (the dir doesn't exist), which unwinds out of initDir()
 * before any ticket is scanned and leaves the board empty.
 */
describe('getConfigFile resolution in orphan mode (FLUX-1340)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-cfgpath-'));
  });
  afterEach(async () => {
    setWorkspaceRoot(process.cwd()); // don't leak the binding to later tests
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves to .flux-store/config.json when orphan store exists but no config file does yet', async () => {
    await fs.mkdir(path.join(root, '.flux-store'), { recursive: true });
    setWorkspaceRoot(root);
    expect(isOrphanMode()).toBe(true);
    // The bug returned path.join(root, '.flux', 'config.json') here — a dir that doesn't exist on
    // a clone, so the default-config write later ENOENT'd and aborted activation.
    expect(getConfigFile()).toBe(path.join(root, '.flux-store', 'config.json'));
  });

  it('prefers an existing .flux-store/config.json over the in-repo path', async () => {
    await fs.mkdir(path.join(root, '.flux-store'), { recursive: true });
    await fs.writeFile(path.join(root, '.flux-store', 'config.json'), '{}', 'utf-8');
    setWorkspaceRoot(root);
    expect(getConfigFile()).toBe(path.join(root, '.flux-store', 'config.json'));
  });

  it('still reads a legacy un-migrated .flux/config.json in orphan mode', async () => {
    await fs.mkdir(path.join(root, '.flux-store'), { recursive: true });
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    await fs.writeFile(path.join(root, '.flux', 'config.json'), '{}', 'utf-8');
    setWorkspaceRoot(root);
    // No store config yet, but a legacy in-repo copy exists → read it in place (it gets migrated
    // into the store by migrateStrandedFluxTickets before initDir runs).
    expect(getConfigFile()).toBe(path.join(root, '.flux', 'config.json'));
  });

  it('resolves to .flux/config.json in non-orphan (in-repo) mode', async () => {
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    expect(isOrphanMode()).toBe(false);
    expect(getConfigFile()).toBe(path.join(root, '.flux', 'config.json'));
  });
});

/**
 * FLUX-705 unbound-workspace contract. When no workspace is bound (workspaceRoot null),
 * the path getters must throw a CLEAR error instead of `path.join(null, …)`'s cryptic
 * "Received null", and isOrphanMode() must return false (a boolean probe must never throw).
 */
describe('unbound workspace contract (FLUX-705)', () => {
  afterEach(() => setWorkspaceRoot(process.cwd())); // don't leak the null binding to later tests
  it('requireWorkspaceRoot throws, isOrphanMode returns false, and path getters throw when unbound', () => {
    setWorkspaceRoot(null as unknown as string);
    expect(isOrphanMode()).toBe(false); // boolean probe — must NOT throw when unbound
    expect(() => requireWorkspaceRoot()).toThrow(/no active.*workspace/i);
    expect(() => getFluxDir()).toThrow(); // getters surface the clear error, not "Received null"
    expect(() => getActiveFluxDir()).toThrow();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  setWorkspaceRoot,
  getFluxDir,
  getFluxStoreDir,
  getActiveFluxDir,
  isOrphanMode,
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

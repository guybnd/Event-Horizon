import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  createTaskWorktree,
  removeTaskWorktree,
  detachTaskWorktree,
  pruneTaskWorktrees,
  listTaskWorktrees,
  reclaimWorktrees,
  ticketIdFromWorktreePath,
  resolveTaskExecutionRoot,
  taskWorktreeDir,
  taskWorktreesBaseDir,
  worktreeChangeCount,
  listLocalBranches,
  stashDirtyTree,
} from './task-worktree.js';

// Real git worktree ops are slow on Windows under parallel suite load — the default 5000ms
// testTimeout intermittently overruns when the full engine suite runs concurrently (FLUX-749).
// Raise it file-wide so these don't flake the `check` gate (mirrors group-integration.test.ts).
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const execFileAsync = promisify(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A temp parent dir that will hold the repo AND its sibling .eh-worktrees. */
async function makeParent(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eh-taskwt-'));
}

/** git init on `master` with one committed file so the repo has a HEAD. */
async function gitInit(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await execFileAsync('git', ['-C', root, 'init', '-b', 'master'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test'], { windowsHide: true });
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  // Mirror the real repo's committed `.serena/.gitignore` so the per-worktree
  // Serena override (`project.local.yml`, FLUX-843) is gitignored and never
  // registers as a dirty/untracked change in the worktree.
  await fs.mkdir(path.join(root, '.serena'), { recursive: true });
  await fs.writeFile(path.join(root, '.serena', '.gitignore'), '/cache\n/project.local.yml\n', 'utf8');
  await execFileAsync('git', ['-C', root, 'add', '.'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'init'], { windowsHide: true });
}

async function currentBranch(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true });
  return stdout.trim();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('task-worktree', () => {
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    parent = await makeParent();
    repo = path.join(parent, 'EventHorizon');
    await gitInit(repo);
  });

  afterEach(async () => {
    // Force-remove any task worktrees so their dirs unlock, then nuke the parent.
    try {
      const wts = await listTaskWorktrees(repo).catch(() => []);
      for (const w of wts) {
        await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', w.path], { windowsHide: true }).catch(() => {});
      }
      await execFileAsync('git', ['-C', repo, 'worktree', 'prune'], { windowsHide: true }).catch(() => {});
    } catch { /* best-effort */ }
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  });

  describe('worktreeChangeCount (FLUX-516 board chip)', () => {
    it('counts modified, newly-committed, and untracked files vs master', async () => {
      const branch = 'flux/FLUX-1-count';
      const wt = await createTaskWorktree(repo, 'FLUX-1', branch);

      // Clean worktree → no diff vs master.
      expect(await worktreeChangeCount(wt)).toBe(0);

      // Modify a tracked file (uncommitted), add an untracked file, and commit a third.
      await fs.writeFile(path.join(wt, 'README.md'), '# changed\n', 'utf8');
      await fs.writeFile(path.join(wt, 'untracked.txt'), 'x\n', 'utf8');
      await fs.writeFile(path.join(wt, 'committed.txt'), 'y\n', 'utf8');
      await execFileAsync('git', ['-C', wt, 'add', 'committed.txt'], { windowsHide: true });
      await execFileAsync('git', ['-C', wt, 'commit', '-m', 'add committed'], { windowsHide: true });

      // README (modified) + committed.txt (committed-ahead) + untracked.txt = 3.
      expect(await worktreeChangeCount(wt)).toBe(3);
    });

    it('returns 0 for a path that does not exist', async () => {
      expect(await worktreeChangeCount(path.join(parent, 'nope'))).toBe(0);
    });
  });

  describe('listLocalBranches (FLUX-516 attach-to-branch picker)', () => {
    it('lists master plus any task branches', async () => {
      expect(await listLocalBranches(repo)).toEqual(['master']);
      await createTaskWorktree(repo, 'FLUX-7', 'flux/FLUX-7-x');
      const branches = await listLocalBranches(repo);
      expect(branches).toContain('master');
      expect(branches).toContain('flux/FLUX-7-x');
    });
  });

  describe('removeTaskWorktree (FLUX-516 folder sweep)', () => {
    it('leaves no directory shell behind after removing a clean worktree', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-9', 'flux/FLUX-9-x');
      expect(existsSync(wt)).toBe(true);
      await removeTaskWorktree(repo, wt);
      // The folder must be fully gone — a leftover shell would later block re-add.
      expect(existsSync(wt)).toBe(false);
    });
  });

  describe('createTaskWorktree', () => {
    it('creates a worktree on a new task branch under the sibling .eh-worktrees', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-demo');

      expect(wt).toBe(taskWorktreeDir(repo, 'FLUX-1'));
      expect(existsSync(wt)).toBe(true);
      // It is a real checkout of the base branch content...
      expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
      // ...on the new task branch...
      expect(await currentBranch(wt)).toBe('flux/FLUX-1-demo');
      // ...located outside the repo, as a sibling.
      expect(wt.startsWith(taskWorktreesBaseDir(repo))).toBe(true);
      expect(taskWorktreesBaseDir(repo)).toBe(path.join(parent, '.eh-worktrees'));
      // The main tree stays on master.
      expect(await currentBranch(repo)).toBe('master');
    });

    it('is idempotent: returns the same path for the same ticket + branch', async () => {
      const a = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-demo');
      const b = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-demo');
      expect(b).toBe(a);
    });

    it('guards a branch already checked out elsewhere (no --force)', async () => {
      await createTaskWorktree(repo, 'FLUX-1', 'flux/shared');
      await expect(createTaskWorktree(repo, 'FLUX-2', 'flux/shared')).rejects.toThrow(/already checked out/i);
    });

    it('names the blocking EH worktree and the git worktree remove remedy when the guard fires (FLUX-1059)', async () => {
      const blocking = await createTaskWorktree(repo, 'FLUX-1', 'flux/shared');
      const err = await createTaskWorktree(repo, 'FLUX-2', 'flux/shared').then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeTruthy();
      // The message pinpoints the blocking path (basename is realpath-agnostic) and the exact remedy.
      expect(err!.message).toContain(path.basename(blocking));
      expect(err!.message).toMatch(/git worktree remove/);
      expect(err!.message).toContain('flux/shared');
    });

    it('reuses an external worktree (outside .eh-worktrees/) as the execution root instead of refusing (FLUX-1059)', async () => {
      const branch = 'flux/FLUX-50-ext';
      // A manual/dev checkout of the branch, OUTSIDE the EH-managed pool.
      const external = path.join(parent, 'manual-checkout');
      await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', branch, external, 'master'], { windowsHide: true });

      // Re-entry on the same branch must NOT throw — it reuses the external tree in place.
      const resolved = await createTaskWorktree(repo, 'FLUX-50', branch);
      expect(realpathSync(resolved)).toBe(realpathSync(external));
      // ...and it did NOT spin up a second worktree at the EH target.
      expect(existsSync(taskWorktreeDir(repo, 'FLUX-50'))).toBe(false);
    });

    it('recreates at the EH target when an external worktree record is stale (dir removed) (FLUX-1059)', async () => {
      const branch = 'flux/FLUX-51-stale';
      const external = path.join(parent, 'manual-stale');
      await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', branch, external, 'master'], { windowsHide: true });
      // Remove the external dir WITHOUT pruning — git still reports a (now stale) record.
      await fs.rm(external, { recursive: true, force: true });

      // The prune inside createTaskWorktree clears the stale record; a fresh EH worktree is created.
      const resolved = await createTaskWorktree(repo, 'FLUX-51', branch);
      expect(realpathSync(resolved)).toBe(realpathSync(taskWorktreeDir(repo, 'FLUX-51')));
      expect(existsSync(resolved)).toBe(true);
      expect(await currentBranch(resolved)).toBe(branch);
    });

    it('enforces the configurable concurrency cap', async () => {
      await createTaskWorktree(repo, 'FLUX-1', 'flux/a', { maxWorktrees: 2 });
      await createTaskWorktree(repo, 'FLUX-2', 'flux/b', { maxWorktrees: 2 });
      await expect(
        createTaskWorktree(repo, 'FLUX-3', 'flux/c', { maxWorktrees: 2 }),
      ).rejects.toThrow(/limit reached/i);
    });

    it('does not count a manually-deleted (unpruned) worktree toward the cap', async () => {
      const a = await createTaskWorktree(repo, 'FLUX-1', 'flux/a', { maxWorktrees: 2 });
      await createTaskWorktree(repo, 'FLUX-2', 'flux/b', { maxWorktrees: 2 });
      // Nuke one worktree dir WITHOUT pruning — git still reports it as a record.
      await fs.rm(a, { recursive: true, force: true });
      // The next create reconciles the phantom (prune + existsSync) and succeeds.
      const c = await createTaskWorktree(repo, 'FLUX-3', 'flux/c', { maxWorktrees: 2 });
      expect(existsSync(c)).toBe(true);
    });

    it('writes a per-worktree Serena override with a unique project_name (FLUX-843)', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-demo');
      const override = path.join(wt, '.serena', 'project.local.yml');
      expect(existsSync(override)).toBe(true);
      const body = await fs.readFile(override, 'utf8');
      // Unique name = worktree dir basename (`<repo>-<id>`), distinct from main "EventHorizon".
      expect(body).toContain(`project_name: "${path.basename(wt)}"`);
      expect(body).toContain('EventHorizon-FLUX-1');
    });

    it('self-heals the Serena override on idempotent reuse (FLUX-843)', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-demo');
      const override = path.join(wt, '.serena', 'project.local.yml');
      // Simulate a worktree created before FLUX-843 (override missing).
      await fs.rm(override, { force: true });
      expect(existsSync(override)).toBe(false);
      // Reuse rewrites it.
      await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-demo');
      expect(existsSync(override)).toBe(true);
    });
  });

  describe('removeTaskWorktree', () => {
    it('removes a worktree directory', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      expect(existsSync(wt)).toBe(true);
      await removeTaskWorktree(repo, wt);
      expect(existsSync(wt)).toBe(false);
    });

    it('refuses to remove a worktree with uncommitted work (no silent discard)', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await fs.writeFile(path.join(wt, 'precious.txt'), 'do not lose me\n', 'utf8');
      await expect(removeTaskWorktree(repo, wt)).rejects.toThrow(/uncommitted/i);
      // The worktree and the work survive — nothing was force-discarded.
      expect(existsSync(path.join(wt, 'precious.txt'))).toBe(true);
    });
  });

  describe('detachTaskWorktree', () => {
    it('removes a clean worktree and reports "clean"', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      const res = await detachTaskWorktree(repo, wt, { ticketId: 'FLUX-1' });
      expect(res.outcome).toBe('clean');
      expect(existsSync(wt)).toBe(false);
    });

    it('applies uncommitted changes onto the main tree (visible on master)', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await fs.writeFile(path.join(wt, 'agent-work.txt'), 'work in progress\n', 'utf8');

      const res = await detachTaskWorktree(repo, wt, { ticketId: 'FLUX-1' });

      expect(res.outcome).toBe('applied');
      expect(res.stashRef).toBeTruthy();
      expect(existsSync(wt)).toBe(false);
      // The change now lives in the main tree, on master.
      expect(existsSync(path.join(repo, 'agent-work.txt'))).toBe(true);
      expect(await currentBranch(repo)).toBe('master');
      // Stash was consumed on a clean apply.
      const { stdout } = await execFileAsync('git', ['-C', repo, 'stash', 'list'], { windowsHide: true });
      expect(stdout.trim()).toBe('');
    });

    it('keeps the stash and reports its ref when the apply conflicts', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      // Diverge master so the same file differs from the stash base.
      await fs.writeFile(path.join(repo, 'README.md'), '# master change\n', 'utf8');
      await execFileAsync('git', ['-C', repo, 'commit', '-am', 'master change'], { windowsHide: true });
      // Conflicting edit in the worktree.
      await fs.writeFile(path.join(wt, 'README.md'), '# worktree change\n', 'utf8');

      const res = await detachTaskWorktree(repo, wt, { ticketId: 'FLUX-1' });

      expect(res.outcome).toBe('stashed');
      expect(res.stashRef).toBeTruthy();
      expect(existsSync(wt)).toBe(false);
      // The stash is retained for manual recovery.
      const { stdout } = await execFileAsync('git', ['-C', repo, 'stash', 'list'], { windowsHide: true });
      expect(stdout).toContain('EH abandon FLUX-1');
    });

    it('applyToMain:false keeps the stash without touching the main tree (abandon)', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await fs.writeFile(path.join(wt, 'scratch.txt'), 'wip\n', 'utf8');

      const res = await detachTaskWorktree(repo, wt, { ticketId: 'FLUX-1', applyToMain: false });

      expect(res.outcome).toBe('stashed');
      expect(res.stashRef).toBeTruthy();
      expect(existsSync(wt)).toBe(false);
      // NOT applied to the main tree...
      expect(existsSync(path.join(repo, 'scratch.txt'))).toBe(false);
      // ...but preserved as a recoverable stash.
      const { stdout } = await execFileAsync('git', ['-C', repo, 'stash', 'list'], { windowsHide: true });
      expect(stdout).toContain('EH abandon FLUX-1');
    });
  });

  describe('pruneTaskWorktrees', () => {
    it('prunes records of worktrees whose dirs were deleted out of band', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      // Simulate a manual delete (e.g. user nuked the folder in Explorer).
      await fs.rm(wt, { recursive: true, force: true });

      await pruneTaskWorktrees(repo);

      const { stdout } = await execFileAsync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { windowsHide: true });
      expect(stdout).not.toContain(wt);
    });
  });

  describe('dependency links (FLUX-518)', () => {
    /** Commit engine/ + portal/ workspaces and seed real node_modules with markers. */
    async function seedDeps(root: string): Promise<void> {
      for (const sub of ['engine', 'portal']) {
        await fs.mkdir(path.join(root, sub), { recursive: true });
        await fs.writeFile(path.join(root, sub, '.gitkeep'), '', 'utf8');
      }
      await execFileAsync('git', ['-C', root, 'add', '.'], { windowsHide: true });
      await execFileAsync('git', ['-C', root, 'commit', '-m', 'add workspaces'], { windowsHide: true });
      for (const sub of ['.', 'engine', 'portal']) {
        const nm = path.join(root, sub, 'node_modules');
        await fs.mkdir(nm, { recursive: true });
        await fs.writeFile(path.join(nm, 'marker.txt'), `deps:${sub}\n`, 'utf8');
      }
    }

    it('junctions root/engine/portal node_modules into the worktree', async () => {
      await seedDeps(repo);
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      for (const sub of ['.', 'engine', 'portal']) {
        const marker = path.join(wt, sub, 'node_modules', 'marker.txt');
        expect(existsSync(marker)).toBe(true);
        expect(await fs.readFile(marker, 'utf8')).toContain(`deps:${sub}`);
      }
    });

    it('removal unlinks the junctions without deleting the real node_modules', async () => {
      await seedDeps(repo);
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await removeTaskWorktree(repo, wt);
      expect(existsSync(wt)).toBe(false);
      // The main tree's real deps must survive worktree removal.
      for (const sub of ['.', 'engine', 'portal']) {
        expect(existsSync(path.join(repo, sub, 'node_modules', 'marker.txt'))).toBe(true);
      }
    });

    it('respects linkDependencies:false', async () => {
      await seedDeps(repo);
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1', { linkDependencies: false });
      expect(existsSync(path.join(wt, 'node_modules'))).toBe(false);
    });
  });

  describe('resolveTaskExecutionRoot (FLUX-519)', () => {
    const sameDir = (a: string, b: string) =>
      realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

    it('returns the engine root when the task has no branch', async () => {
      expect(await resolveTaskExecutionRoot({ id: 'FLUX-1' }, repo)).toBe(repo);
    });

    it('returns the engine root when no task is given', async () => {
      expect(await resolveTaskExecutionRoot(undefined, repo)).toBe(repo);
    });

    it('resolves a ticket to the worktree checked out on its branch', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      expect(sameDir(await resolveTaskExecutionRoot({ id: 'FLUX-1', branch: 'flux/FLUX-1' }, repo), wt)).toBe(true);
    });

    // FLUX-1018: read-only callers (create:false) keep the legacy fall-back — a
    // branch with no worktree resolves to the engine root WITHOUT side effects.
    it('create:false falls back to the engine root for a branch with no worktree (no recreation)', async () => {
      expect(await resolveTaskExecutionRoot({ id: 'FLUX-2', branch: 'flux/FLUX-2' }, repo, { create: false })).toBe(repo);
      // Nothing was created under .eh-worktrees.
      expect(await listTaskWorktrees(repo)).toHaveLength(0);
    });

    // FLUX-1018: the spawn path (create defaults to true) must NEVER degrade to
    // master — a branch whose worktree is missing is recreated in place.
    it('recreates a missing worktree instead of falling back to master (spawn path)', async () => {
      const root = await resolveTaskExecutionRoot({ id: 'FLUX-2', branch: 'flux/FLUX-2' }, repo);
      // Resolved to a fresh worktree under .eh-worktrees, NOT the engine root.
      expect(sameDir(root, repo)).toBe(false);
      expect(root.startsWith(taskWorktreesBaseDir(repo))).toBe(true);
      expect(sameDir(root, taskWorktreeDir(repo, 'FLUX-2'))).toBe(true);
      expect(existsSync(root)).toBe(true);
      expect(await currentBranch(root)).toBe('flux/FLUX-2');
    });

    // FLUX-1018: self-heal a worktree whose directory was deleted out of band.
    it('recreates a worktree whose directory was removed out of band', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-3', 'flux/FLUX-3');
      await fs.rm(wt, { recursive: true, force: true });
      const root = await resolveTaskExecutionRoot({ id: 'FLUX-3', branch: 'flux/FLUX-3' }, repo);
      expect(existsSync(root)).toBe(true);
      expect(sameDir(root, taskWorktreeDir(repo, 'FLUX-3'))).toBe(true);
      expect(await currentBranch(root)).toBe('flux/FLUX-3');
    });

    // FLUX-1018: when recreation genuinely can't happen (concurrency cap), fail
    // closed with a clear error rather than silently returning master.
    it('throws (never returns master) when a missing worktree cannot be recreated', async () => {
      // Fill the cap with OTHER branches, then ask for a capless branch with no worktree.
      await createTaskWorktree(repo, 'FLUX-4', 'flux/FLUX-4', { maxWorktrees: 1 });
      await expect(
        resolveTaskExecutionRoot({ id: 'FLUX-5', branch: 'flux/FLUX-5' }, repo, { maxWorktrees: 1 }),
      ).rejects.toThrow(/missing and could not be recreated|refusing to run the agent on master/i);
    });

    // FLUX-1031: the changes-requested round-trip. A Ready ticket's worktree is reclaimed to
    // free its pool slot; when it bounces back to In Progress the spawn path transparently
    // recreates the worktree — and because the work was committed on the branch (commit-before-
    // Ready invariant), recreation re-checks-out a tree that still carries every commit.
    it('recreates a reclaimed Ready worktree on bounce-back with the branch commits intact', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-9', 'flux/FLUX-9');
      // Commit work on the branch (as a real ticket would before reaching Ready).
      await fs.writeFile(path.join(wt, 'work.txt'), 'committed work\n', 'utf8');
      await execFileAsync('git', ['-C', wt, 'add', '.'], { windowsHide: true });
      await execFileAsync('git', ['-C', wt, 'commit', '-m', 'ready work'], { windowsHide: true });

      // Reclaim it (the FLUX-1031 at-Ready path frees the slot). The worktree is gone...
      const reclaimed = await reclaimWorktrees(repo, () => true);
      expect(reclaimed).toEqual(['FLUX-9']);
      expect(existsSync(wt)).toBe(false);
      expect(await listTaskWorktrees(repo)).toHaveLength(0);

      // ...but the branch (with its commit) survives, so the bounce-back spawn recreates the tree.
      const root = await resolveTaskExecutionRoot({ id: 'FLUX-9', branch: 'flux/FLUX-9' }, repo);
      expect(existsSync(root)).toBe(true);
      expect(await currentBranch(root)).toBe('flux/FLUX-9');
      // The committed work is present in the recreated worktree — nothing was lost.
      expect(await fs.readFile(path.join(root, 'work.txt'), 'utf8')).toContain('committed work');
    });

    it('resolves a JOINED ticket to the worktree holding the shared branch', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      // FLUX-2 has no worktree of its own but shares FLUX-1's branch (joined).
      expect(sameDir(await resolveTaskExecutionRoot({ id: 'FLUX-2', branch: 'flux/FLUX-1' }, repo), wt)).toBe(true);
    });

    // FLUX-741 AC2: two parallel branch tickets must never share one checkout.
    it('gives two parallel branch tickets distinct worktrees / execution roots', async () => {
      const wtA = await createTaskWorktree(repo, 'FLUX-A', 'flux/FLUX-A');
      const wtB = await createTaskWorktree(repo, 'FLUX-B', 'flux/FLUX-B');

      expect(sameDir(wtA, wtB)).toBe(false);
      const rootA = await resolveTaskExecutionRoot({ id: 'FLUX-A', branch: 'flux/FLUX-A' }, repo);
      const rootB = await resolveTaskExecutionRoot({ id: 'FLUX-B', branch: 'flux/FLUX-B' }, repo);
      expect(sameDir(rootA, wtA)).toBe(true);
      expect(sameDir(rootB, wtB)).toBe(true);
      // Neither resolves to the shared engine root, and the two are isolated from each other.
      expect(sameDir(rootA, repo)).toBe(false);
      expect(sameDir(rootB, repo)).toBe(false);
      expect(sameDir(rootA, rootB)).toBe(false);
    });
  });

  // FLUX-1018: reclaim stale terminal-ticket worktrees so a full cap self-heals
  // instead of forcing a new task onto master.
  describe('reclaimWorktrees (FLUX-1018 cap self-heal)', () => {
    it('recovers the ticket id from a worktree path (and rejects foreign paths)', () => {
      const wtPath = taskWorktreeDir(repo, 'FLUX-42');
      expect(ticketIdFromWorktreePath(repo, wtPath)).toBe('FLUX-42');
      expect(ticketIdFromWorktreePath(repo, repo)).toBeNull();
      expect(ticketIdFromWorktreePath(repo, path.join(parent, 'somewhere-else'))).toBeNull();
    });

    it('removes clean reclaimable worktrees and frees the cap', async () => {
      const a = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1', { maxWorktrees: 2 });
      await createTaskWorktree(repo, 'FLUX-2', 'flux/FLUX-2', { maxWorktrees: 2 });
      expect(await listTaskWorktrees(repo)).toHaveLength(2);

      // FLUX-1 is "terminal" → reclaimable; FLUX-2 is not.
      const reclaimed = await reclaimWorktrees(repo, (id) => id === 'FLUX-1');
      expect(reclaimed).toEqual(['FLUX-1']);
      expect(existsSync(a)).toBe(false);
      // The non-reclaimable one survives...
      expect(await listTaskWorktrees(repo)).toHaveLength(1);
      // ...and the freed slot lets a new worktree be created under the same cap.
      const c = await createTaskWorktree(repo, 'FLUX-3', 'flux/FLUX-3', { maxWorktrees: 2 });
      expect(existsSync(c)).toBe(true);
    });

    it('never reclaims a worktree with real uncommitted work', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await fs.writeFile(path.join(wt, 'precious.txt'), 'do not lose me\n', 'utf8');
      const reclaimed = await reclaimWorktrees(repo, () => true);
      expect(reclaimed).toEqual([]);
      // The worktree and the work survive.
      expect(existsSync(path.join(wt, 'precious.txt'))).toBe(true);
    });

    it('treats node_modules junctions as clean (reclaims despite them)', async () => {
      // Seed real deps so createTaskWorktree junctions them into the worktree.
      for (const sub of ['engine', 'portal']) {
        await fs.mkdir(path.join(repo, sub), { recursive: true });
        await fs.writeFile(path.join(repo, sub, '.gitkeep'), '', 'utf8');
      }
      await execFileAsync('git', ['-C', repo, 'add', '.'], { windowsHide: true });
      await execFileAsync('git', ['-C', repo, 'commit', '-m', 'workspaces'], { windowsHide: true });
      for (const sub of ['.', 'engine', 'portal']) {
        await fs.mkdir(path.join(repo, sub, 'node_modules'), { recursive: true });
        await fs.writeFile(path.join(repo, sub, 'node_modules', 'm.txt'), 'x\n', 'utf8');
      }
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      // The junctions make `git status` non-empty, but they are not real work.
      const reclaimed = await reclaimWorktrees(repo, () => true);
      expect(reclaimed).toEqual(['FLUX-1']);
      expect(existsSync(wt)).toBe(false);
      // The main tree's real deps survive the reclaim.
      for (const sub of ['.', 'engine', 'portal']) {
        expect(existsSync(path.join(repo, sub, 'node_modules', 'm.txt'))).toBe(true);
      }
    });
  });

  // FLUX-741 AC1: the dirty-root backstop the post-merge cleanup uses before switching/resetting
  // the MAIN tree. It must never silently discard work — dirty trees are stashed (recoverable).
  describe('stashDirtyTree (FLUX-741 dirty-root backstop)', () => {
    it('is a no-op on a clean tree', async () => {
      const res = await stashDirtyTree(repo);
      expect(res.stashed).toBe(false);
      expect(res.stashRef).toBeUndefined();
    });

    it('stashes uncommitted + untracked work and returns a recoverable ref', async () => {
      // A tracked modification AND an untracked file — both must be preserved.
      await fs.writeFile(path.join(repo, 'README.md'), '# dirty edit\n', 'utf8');
      await fs.writeFile(path.join(repo, 'precious.txt'), 'do not lose me\n', 'utf8');

      const res = await stashDirtyTree(repo, { reason: 'EH test backstop' });

      expect(res.stashed).toBe(true);
      expect(res.stashRef).toBeTruthy();
      // The working tree is now clean (the switch the caller is about to do is safe)...
      const { stdout: porcelain } = await execFileAsync('git', ['-C', repo, 'status', '--porcelain'], { windowsHide: true });
      expect(porcelain.trim()).toBe('');
      // ...but NOTHING was lost — both changes come back when the stash is applied.
      await execFileAsync('git', ['-C', repo, 'stash', 'apply', res.stashRef!], { windowsHide: true });
      expect(await fs.readFile(path.join(repo, 'README.md'), 'utf8')).toContain('dirty edit');
      expect(await fs.readFile(path.join(repo, 'precious.txt'), 'utf8')).toContain('do not lose me');
    });
  });
});

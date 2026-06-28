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
      // A branch with no worktree → engine root.
      expect(await resolveTaskExecutionRoot({ id: 'FLUX-2', branch: 'flux/FLUX-2' }, repo)).toBe(repo);
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

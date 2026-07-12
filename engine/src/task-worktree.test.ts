import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync, realpathSync, chmodSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile, spawn, type ChildProcess } from 'child_process';
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
  resolveResumeExecutionRoot,
  isRegisteredWorktree,
  taskWorktreeDir,
  taskWorktreesBaseDir,
  worktreeChangeCount,
  worktreeChangeCounts,
  worktreeUncommittedCount,
  worktreeIsDirty,
  depNodeModulesExcludePathspecs,
  listLocalBranches,
  stashDirtyTree,
  writeWorktreeSerenaOverride,
} from './task-worktree.js';
import { cliSessionsById, armReclaimGrace, __resetSessionStubStateForTests } from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

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

/**
 * git init on `master` WITHOUT mirroring EventHorizon's own committed
 * `.serena/.gitignore` — i.e. a stand-in for every OTHER repo EH manages,
 * which never adopted that convention (FLUX-1155).
 */
async function gitInitPlain(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await execFileAsync('git', ['-C', root, 'init', '-b', 'master'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test'], { windowsHide: true });
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  await execFileAsync('git', ['-C', root, 'add', '.'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'init'], { windowsHide: true });
}

/**
 * Genuinely lock `dir` the same way the 2026-07-06 incident did: spawn a real child process
 * whose cwd is inside it. Windows blocks deleting a directory that is any live process's cwd
 * (confirmed empirically — an in-process open file handle does NOT block deletion on Windows,
 * since Node opens with FILE_SHARE_DELETE by default; only a real external cwd handle does), so
 * this is the one reliable way to force a genuine `fs.rm` failure without touching production
 * code's real implementations. Callers MUST kill the returned process (directly, or via a mock
 * that does so) before the directory can actually be removed.
 */
async function spawnDirLockHolder(dir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  // Give the OS a moment to establish the cwd handle before any caller races it with fs.rm.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return child;
}

/**
 * FLUX-1327: `spawnDirLockHolder` alone only blocks removal on Windows — a process cwd'd into (or
 * with an open handle inside) a directory does NOT stop Linux from unlinking its contents or
 * rmdir-ing it, so on the Linux CI runner the plain `fs.rm` in the production reap routine was
 * succeeding immediately and the reap path (`reapDescendantsByPid`/`findLockHolders`) was never
 * reached — the tests below failed deterministically there. This picks whichever lock is genuinely
 * enforced on the current OS and returns an `unlock()` that releases it:
 *  - Windows: `spawnDirLockHolder` (real child process cwd'd into `dir`).
 *  - POSIX (Linux/macOS): strip write permission from `dir` AND its parent. Removing an entry from
 *    a directory needs write+exec permission on the CONTAINING directory, not the entry itself, so
 *    this blocks both "unlink a child inside dir" (needs write on `dir`) and "rmdir dir itself"
 *    (needs write on dir's parent) — covering both an empty leftover dir and one with contents,
 *    regardless of which. Still spawns a real child cwd'd into `dir` alongside it, purely so the
 *    PID-based assertions (reapDescendantsByPid / findLockHolders / killPid) exercise a genuine
 *    process on every OS, even though killing it isn't what actually releases this lock.
 */
async function lockDirAgainstRemoval(dir: string): Promise<{ pid: number; unlock: () => void }> {
  if (process.platform === 'win32') {
    const child = await spawnDirLockHolder(dir);
    return { pid: child.pid as number, unlock: () => { child.kill(); } };
  }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const parentDir = path.dirname(dir);
  chmodSync(dir, 0o500);
  chmodSync(parentDir, 0o500);
  return {
    pid: child.pid as number,
    unlock: () => {
      child.kill();
      try { chmodSync(dir, 0o700); } catch { /* already restored/removed */ }
      try { chmodSync(parentDir, 0o700); } catch { /* already restored/removed */ }
    },
  };
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

    it('treats node_modules junctions as clean (FLUX-1125, regardless of .gitignore)', async () => {
      // Seed real deps so createTaskWorktree junctions them into the worktree. This fixture's
      // .gitignore does NOT cover node_modules, so this proves the fix doesn't depend on it.
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
      expect(await worktreeChangeCount(wt)).toBe(0);

      // Real untracked work outside the dep subdirs is still detected.
      await fs.writeFile(path.join(wt, 'real-work.txt'), 'x\n', 'utf8');
      expect(await worktreeChangeCount(wt)).toBe(1);
    });
  });

  describe('worktreeUncommittedCount (FLUX-1121 Ready-transition guard)', () => {
    it('stays 0 when master drifts after the branch was cut, unlike the diff-vs-base metric', async () => {
      const branch = 'flux/FLUX-4-drift';
      const wt = await createTaskWorktree(repo, 'FLUX-4', branch);

      // Advance master with a commit unrelated to this ticket — simulates a review-confirmation
      // ticket whose branch has 0 commits of its own while master moves on afterward.
      await fs.writeFile(path.join(repo, 'README.md'), '# drifted\n', 'utf8');
      await execFileAsync('git', ['-C', repo, 'commit', '-am', 'drift master'], { windowsHide: true });

      // The pre-existing diff-vs-base metric DOES pick up the drift (FLUX-1121 misattribution)...
      expect(await worktreeChangeCount(wt)).toBe(1);
      // ...but the worktree itself has nothing uncommitted.
      expect(await worktreeUncommittedCount(wt)).toBe(0);
    });

    it('counts modified and untracked files', async () => {
      const branch = 'flux/FLUX-5-uncommitted';
      const wt = await createTaskWorktree(repo, 'FLUX-5', branch);
      await fs.writeFile(path.join(wt, 'README.md'), '# changed\n', 'utf8');
      await fs.writeFile(path.join(wt, 'untracked.txt'), 'x\n', 'utf8');
      expect(await worktreeUncommittedCount(wt)).toBe(2);
    });

    it('returns 0 for a path that does not exist', async () => {
      expect(await worktreeUncommittedCount(path.join(parent, 'nope'))).toBe(0);
    });

    it('treats node_modules junctions as clean, regardless of .gitignore', async () => {
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
      const wt = await createTaskWorktree(repo, 'FLUX-6', 'flux/FLUX-6');
      expect(await worktreeUncommittedCount(wt)).toBe(0);
    });
  });

  describe('worktreeChangeCounts (FLUX-1126 shared ls-files across base branches)', () => {
    it('computes per-base counts that each include the shared untracked files', async () => {
      const branch = 'flux/FLUX-2-counts';
      const wt = await createTaskWorktree(repo, 'FLUX-2', branch);

      // Commit a file (diverges HEAD from master) and leave one untracked file.
      await fs.writeFile(path.join(wt, 'committed.txt'), 'y\n', 'utf8');
      await execFileAsync('git', ['-C', wt, 'add', 'committed.txt'], { windowsHide: true });
      await execFileAsync('git', ['-C', wt, 'commit', '-m', 'add committed'], { windowsHide: true });
      await fs.writeFile(path.join(wt, 'untracked.txt'), 'x\n', 'utf8');

      const counts = await worktreeChangeCounts(wt, ['HEAD', 'master']);
      // vs HEAD: just the untracked file — the commit above already IS HEAD.
      expect(counts.HEAD).toBe(1);
      // vs master: the committed-ahead file + the untracked file.
      expect(counts.master).toBe(2);
    });

    it('spawns ls-files exactly once no matter how many base branches are requested', async () => {
      const branch = 'flux/FLUX-3-counts-spy';
      const wt = await createTaskWorktree(repo, 'FLUX-3', branch);
      await fs.writeFile(path.join(wt, 'untracked.txt'), 'x\n', 'utf8');

      let lsFilesCalls = 0;
      const spyRunner = async (cwd: string, args: string[]) => {
        if (args[0] === 'ls-files') lsFilesCalls += 1;
        const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
        return { stdout, stderr };
      };

      const counts = await worktreeChangeCounts(wt, ['HEAD', 'master'], { gitRunner: spyRunner });
      expect(lsFilesCalls).toBe(1);
      expect(counts.HEAD).toBe(1);
      expect(counts.master).toBe(1);
    });

    it('returns 0 for every requested base when the path does not exist', async () => {
      const counts = await worktreeChangeCounts(path.join(parent, 'nope'), ['HEAD', 'master']);
      expect(counts).toEqual({ HEAD: 0, master: 0 });
    });
  });

  describe('worktreeIsDirty (FLUX-1125 /pr/update-branch guard)', () => {
    it('reports clean for a worktree with only node_modules junction contents', async () => {
      for (const sub of ['.', 'engine', 'portal']) {
        await fs.mkdir(path.join(repo, sub, 'node_modules'), { recursive: true });
        await fs.writeFile(path.join(repo, sub, 'node_modules', 'm.txt'), 'x\n', 'utf8');
      }
      await fs.mkdir(path.join(repo, 'engine'), { recursive: true });
      await fs.mkdir(path.join(repo, 'portal'), { recursive: true });
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      expect(await worktreeIsDirty(wt)).toBe(false);
    });

    it('reports dirty for real uncommitted work', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await fs.writeFile(path.join(wt, 'real-work.txt'), 'x\n', 'utf8');
      expect(await worktreeIsDirty(wt)).toBe(true);
    });
  });

  describe('depNodeModulesExcludePathspecs (FLUX-1125)', () => {
    it('derives one exclude pathspec per dep subdir', () => {
      expect(depNodeModulesExcludePathspecs()).toEqual([':!node_modules', ':!engine/node_modules', ':!portal/node_modules']);
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

    // FLUX-1207: the leftover-directory sweep gets the same best-effort reap before its `fs.rm`.
    // FLUX-1216: a plain removal is tried FIRST now (see reapWorktreeLockHoldersAndRemove), so
    // this genuinely locks the directory with a real child process (an unlocked directory would
    // be removed on the first attempt and never exercise the reap path at all).
    it('reaps a known session pid for the derived ticket id before sweeping a leftover directory (FLUX-1207)', async () => {
      const ticketId = 'FLUX-61';
      const worktreePath = taskWorktreeDir(repo, ticketId);
      // Simulate `git worktree remove` reporting success but leaving a shell dir behind (a held
      // handle) by injecting a gitRunner that never touches the filesystem — the worktree was
      // never registered with real git for this test, so the directory we create by hand is what
      // survives the (faked) remove/prune, exactly the "leftover" condition the sweep guards.
      await fs.mkdir(worktreePath, { recursive: true });
      const holder = await lockDirAgainstRemoval(worktreePath);

      cliSessionsById.set('fake-sess-61', {
        id: 'fake-sess-61',
        taskId: ticketId,
        pid: 535353,
      } as CliSessionRecord);

      try {
        const gitRunner = async () => ({ stdout: '', stderr: '' });
        const reapDescendantsByPid = vi.fn(async (pid: number) => {
          expect(pid).toBe(535353);
          holder.unlock(); // release the real lock this reap call is responsible for
          return [pid];
        });

        await removeTaskWorktree(repo, worktreePath, { gitRunner, reapDescendantsByPid, findLockHolders: async () => [] });

        expect(reapDescendantsByPid).toHaveBeenCalledWith(535353);
        // Same end-state as the pre-existing sweep test: the leftover dir is gone.
        expect(existsSync(worktreePath)).toBe(false);
      } finally {
        holder.unlock();
        cliSessionsById.delete('fake-sess-61');
      }
    });

    // FLUX-1207 review fix: an unidentifiable leftover dir must fail CLOSED (reap nothing),
    // never fall back to reaping every tracked session's pid engine-wide.
    it('never reaps any pid when the leftover directory name does not match <repo>-<ticketId> (FLUX-1207)', async () => {
      // Doesn't match the `<repo>-<ticketId>` naming convention, so ticketIdFromWorktreePath
      // returns null for it — the exact condition that must fail closed, not open.
      const worktreePath = path.join(taskWorktreesBaseDir(repo), 'not-a-ticket-worktree');
      expect(ticketIdFromWorktreePath(repo, worktreePath)).toBeNull();

      await fs.mkdir(worktreePath, { recursive: true });
      await fs.writeFile(path.join(worktreePath, 'shell.txt'), 'leftover\n', 'utf8');

      // An unrelated, live session tracked by the engine — must NOT be touched by this sweep.
      cliSessionsById.set('fake-sess-unrelated', {
        id: 'fake-sess-unrelated',
        taskId: 'FLUX-999',
        pid: 646464,
      } as CliSessionRecord);

      try {
        const gitRunner = async () => ({ stdout: '', stderr: '' });
        const reapDescendantsByPid = vi.fn(async (_pid: number) => [] as number[]);

        await removeTaskWorktree(repo, worktreePath, { gitRunner, reapDescendantsByPid });

        expect(reapDescendantsByPid).not.toHaveBeenCalled();
        expect(existsSync(worktreePath)).toBe(false);
      } finally {
        cliSessionsById.delete('fake-sess-unrelated');
      }
    });

    // FLUX-1216: killDescendantsByPid alone only reaches a KNOWN session's pid — useless once the
    // session record is already gone (ended hours/days earlier, or an engine restart). The
    // command-line path matcher is the fallback that finds a holder with zero tracking state.
    it('falls back to the command-line path matcher (findLockHolders) when no session pid is tracked for the ticket (FLUX-1216)', async () => {
      const ticketId = 'FLUX-62';
      const worktreePath = taskWorktreeDir(repo, ticketId);
      await fs.mkdir(worktreePath, { recursive: true });
      const holder = await lockDirAgainstRemoval(worktreePath);
      // No cliSessionsById entry at all for FLUX-62 — simulates a session that already ended.

      try {
        const gitRunner = async () => ({ stdout: '', stderr: '' });
        const reapDescendantsByPid = vi.fn(async (_pid: number) => [] as number[]);
        const findLockHolders = vi.fn(async (_wt: string, _base: string) => [holder.pid]);
        const killPid = vi.fn((pid: number) => {
          expect(pid).toBe(holder.pid);
          holder.unlock(); // release the real lock this "kill" call is responsible for
        });

        await removeTaskWorktree(repo, worktreePath, { gitRunner, reapDescendantsByPid, findLockHolders, killPid });

        expect(reapDescendantsByPid).not.toHaveBeenCalled(); // nothing tracked to reap by pid
        expect(findLockHolders).toHaveBeenCalledWith(worktreePath, taskWorktreesBaseDir(repo));
        expect(killPid).toHaveBeenCalledWith(holder.pid);
        expect(existsSync(worktreePath)).toBe(false);
      } finally {
        holder.unlock();
      }
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

    // FLUX-1341: resolveDefaultBaseBranch's origin/HEAD fallback is only reached when
    // neither local master nor main exists. In that degenerate case the bare branch
    // name (e.g. `trunk` stripped from `origin/trunk`) may have no local copy to
    // resolve against, so `git worktree add -b <branch> <target> trunk` fails with
    // "invalid reference". The unstripped `origin/trunk` remote-tracking ref always
    // resolves.
    it('falls back to the unstripped origin/<default> ref when neither local master nor main exists', async () => {
      const remoteParent = await makeParent();
      const bareRemote = path.join(remoteParent, 'remote.git');
      await execFileAsync('git', ['init', '--bare', '-b', 'trunk', bareRemote], { windowsHide: true });

      // Seed the bare remote with a commit on `trunk` via a scratch clone.
      const seed = path.join(remoteParent, 'seed');
      await execFileAsync('git', ['clone', bareRemote, seed], { windowsHide: true });
      await execFileAsync('git', ['-C', seed, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
      await execFileAsync('git', ['-C', seed, 'config', 'user.name', 'Test'], { windowsHide: true });
      await fs.writeFile(path.join(seed, 'README.md'), '# test\n', 'utf8');
      await execFileAsync('git', ['-C', seed, 'add', '.'], { windowsHide: true });
      await execFileAsync('git', ['-C', seed, 'commit', '-m', 'init'], { windowsHide: true });
      await execFileAsync('git', ['-C', seed, 'push', 'origin', 'trunk'], { windowsHide: true });

      // The repo under test: cloned from the remote (so origin/HEAD -> origin/trunk is
      // set up), then moved off `trunk` onto an unrelated branch and its local `trunk`
      // copy deleted — leaving ONLY the remote-tracking ref, no local master/main/trunk.
      const remoteOnlyRepo = path.join(remoteParent, 'remote-only-checkout');
      await execFileAsync('git', ['clone', bareRemote, remoteOnlyRepo], { windowsHide: true });
      await execFileAsync('git', ['-C', remoteOnlyRepo, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
      await execFileAsync('git', ['-C', remoteOnlyRepo, 'config', 'user.name', 'Test'], { windowsHide: true });
      await execFileAsync('git', ['-C', remoteOnlyRepo, 'checkout', '-b', 'scratch'], { windowsHide: true });
      await execFileAsync('git', ['-C', remoteOnlyRepo, 'branch', '-D', 'trunk'], { windowsHide: true });

      const wt = await createTaskWorktree(remoteOnlyRepo, 'FLUX-1341', 'flux/FLUX-1341-demo');
      expect(existsSync(wt)).toBe(true);
      expect(await currentBranch(wt)).toBe('flux/FLUX-1341-demo');
      expect(existsSync(path.join(wt, 'README.md'))).toBe(true);

      await execFileAsync('git', ['-C', remoteOnlyRepo, 'worktree', 'remove', '--force', wt], { windowsHide: true }).catch(() => {});
      await fs.rm(remoteParent, { recursive: true, force: true }).catch(() => {});
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

    // FLUX-167 follow-up: the ONE external tree that must NOT be reused in place is
    // the main checkout itself — reusing it hands the agent the primary tree
    // (run-on-master). Fail with the actionable "free the branch" remedy, not the
    // cryptic `git worktree add` "already checked out" error.
    it('throws an actionable "free the main checkout" error when the branch is pinned in the main tree', async () => {
      const branch = 'flux/FLUX-51-pinned';
      await execFileAsync('git', ['-C', repo, 'checkout', '-b', branch], { windowsHide: true });
      const err = await createTaskWorktree(repo, 'FLUX-51', branch).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeTruthy();
      expect(err!.message).toMatch(/checked out in the main checkout/i);
      expect(err!.message).toContain(branch);
      expect(err!.message).toMatch(/git checkout master/);
      // It did NOT reuse the main checkout or spin up a second worktree at the EH target.
      expect(existsSync(taskWorktreeDir(repo, 'FLUX-51'))).toBe(false);
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

    it('reclaims an empty leftover directory at the target instead of refusing (FLUX-1277)', async () => {
      const branch = 'flux/FLUX-52-empty';
      const target = taskWorktreeDir(repo, 'FLUX-52');
      // Simulate a Windows cleanup that emptied the dir but couldn't rmdir the top level
      // (e.g. a lingering handle) — the dir exists, isn't a registered worktree, and has
      // no `.git` link file for `git worktree repair` to re-link.
      await fs.mkdir(target, { recursive: true });

      const resolved = await createTaskWorktree(repo, 'FLUX-52', branch);
      expect(realpathSync(resolved)).toBe(realpathSync(target));
      expect(await currentBranch(resolved)).toBe(branch);
    });

    it('still refuses a non-empty directory at the target that is not a valid/repairable worktree (FLUX-1277)', async () => {
      const branch = 'flux/FLUX-53-nonempty';
      const target = taskWorktreeDir(repo, 'FLUX-53');
      // Same leftover scenario, but with real content still sitting in it — never auto-delete.
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'leftover.txt'), 'un-pushed work\n', 'utf8');

      await expect(createTaskWorktree(repo, 'FLUX-53', branch)).rejects.toThrow(
        /not a valid git worktree and could not be repaired/i,
      );
    });

    // FLUX-1207: repair can fail because an orphaned descendant of a killed session (e.g. a
    // Bash-tool-launched vitest run) still holds a Windows file-handle lock on the worktree dir.
    // The no-known-session case is already covered by the FLUX-53 test above (unchanged behavior);
    // this covers the NEW reap-and-retry wiring that fires when a session pid IS known.
    it('reaps a known session pid for the ticket before retrying repair, and still throws when repair genuinely cannot succeed (FLUX-1207)', async () => {
      const branch = 'flux/FLUX-60-reap';
      const ticketId = 'FLUX-60';
      const target = taskWorktreeDir(repo, ticketId);
      // Same non-empty, non-repairable leftover scenario as the FLUX-53 test above.
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'leftover.txt'), 'un-pushed work\n', 'utf8');

      cliSessionsById.set('fake-sess-60', {
        id: 'fake-sess-60',
        taskId: ticketId,
        pid: 424242,
      } as CliSessionRecord);

      try {
        const reapDescendantsByPid = vi.fn(async (_pid: number) => [] as number[]);

        await expect(
          createTaskWorktree(repo, ticketId, branch, { reapDescendantsByPid }),
        ).rejects.toThrow(/not a valid git worktree and could not be repaired/i);

        // The wiring fired: the known session pid was reaped before the retry (and the retry
        // still failed since nothing about the underlying corruption changed in this test).
        expect(reapDescendantsByPid).toHaveBeenCalledWith(424242);
      } finally {
        cliSessionsById.delete('fake-sess-60');
      }
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

    describe('Serena override exclusion in repos without a committed .serena/.gitignore (FLUX-1155)', () => {
      let userParent: string;
      let userRepo: string;

      beforeEach(async () => {
        userParent = await makeParent();
        userRepo = path.join(userParent, 'UserRepo');
        await gitInitPlain(userRepo);
      });

      afterEach(async () => {
        const wts = await listTaskWorktrees(userRepo).catch(() => []);
        for (const w of wts) {
          await execFileAsync('git', ['-C', userRepo, 'worktree', 'remove', '--force', w.path], { windowsHide: true }).catch(() => {});
        }
        await fs.rm(userParent, { recursive: true, force: true }).catch(() => {});
      });

      it('never leaves a worktree born dirty, without touching the user\'s tracked .gitignore', async () => {
        const wt = await createTaskWorktree(userRepo, 'FLUX-1', 'flux/FLUX-1-demo');
        const override = path.join(wt, '.serena', 'project.local.yml');
        expect(existsSync(override)).toBe(true);

        // The override is untracked but must not read as a dirty change — the
        // repo-local git/info/exclude (NOT a tracked .gitignore) suppresses it.
        const { stdout } = await execFileAsync('git', ['-C', wt, 'status', '--porcelain'], { windowsHide: true });
        expect(stdout.trim()).toBe('');
        expect(existsSync(path.join(userRepo, '.gitignore'))).toBe(false);

        const excludeBody = await fs.readFile(path.join(userRepo, '.git', 'info', 'exclude'), 'utf8');
        expect(excludeBody).toContain('.serena/project.local.yml');
      });

      it('appends the exclude pattern only once across repeated (self-heal) writes', async () => {
        await createTaskWorktree(userRepo, 'FLUX-1', 'flux/FLUX-1-demo');
        // Idempotent reuse re-runs writeWorktreeSerenaOverride on the same repo.
        await createTaskWorktree(userRepo, 'FLUX-1', 'flux/FLUX-1-demo');
        const excludeBody = await fs.readFile(path.join(userRepo, '.git', 'info', 'exclude'), 'utf8');
        const matches = excludeBody.split('\n').filter((l) => l.trim() === '.serena/project.local.yml');
        expect(matches).toHaveLength(1);
      });

      it('serializes concurrent writes to the same repo, appending the exclude pattern only once (FLUX-1162)', async () => {
        // Two calls racing on the SAME repo's info/exclude — without the per-repo
        // write lock, both could read the file before either appends, duplicating
        // the line. Route both through the same fake gitRunner so they resolve to
        // the identical `--git-common-dir`, independent of real worktree add timing.
        const gitCommonDir = path.join(userRepo, '.git');
        const gitRunner = async () => ({ stdout: gitCommonDir, stderr: '' });
        const wtA = path.join(userParent, 'wtA');
        const wtB = path.join(userParent, 'wtB');
        await Promise.all([
          writeWorktreeSerenaOverride(wtA, { gitRunner }),
          writeWorktreeSerenaOverride(wtB, { gitRunner }),
        ]);
        const excludeBody = await fs.readFile(path.join(gitCommonDir, 'info', 'exclude'), 'utf8');
        const matches = excludeBody.split('\n').filter((l) => l.trim() === '.serena/project.local.yml');
        expect(matches).toHaveLength(1);
      });

      it('lets reclaimWorktrees collect a terminal-ticket worktree instead of skipping it as dirty', async () => {
        const wt = await createTaskWorktree(userRepo, 'FLUX-1', 'flux/FLUX-1-demo');
        const reclaimed = await reclaimWorktrees(userRepo, () => true);
        expect(reclaimed).toEqual(['FLUX-1']);
        expect(existsSync(wt)).toBe(false);
      });
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

    // FLUX-1216: git's own `worktree prune` only drops the RECORD of a worktree whose dir is
    // already gone — it never retries deleting a directory still sitting on disk. These tests
    // cover the orphan-directory sweep added alongside it.
    describe('orphaned directory sweep (FLUX-1216)', () => {
      /** A leftover dir under .eh-worktrees that is NOT a registered git worktree (never `git
       *  worktree add`-ed), simulating a folder that survived a prior failed removal. */
      async function makeOrphanDir(ticketId: string): Promise<string> {
        const dir = taskWorktreeDir(repo, ticketId);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'shell.txt'), 'leftover\n', 'utf8');
        return dir;
      }

      it('sweeps (removes) an orphaned, unregistered directory with no active session', async () => {
        const dir = await makeOrphanDir('FLUX-70');
        const findLockHolders = async () => [] as number[]; // stub out the real Windows process scan

        await pruneTaskWorktrees(repo, { isSessionActiveForTask: () => false, findLockHolders });

        expect(existsSync(dir)).toBe(false);
      });

      // FLUX-1216: a plain removal is tried FIRST (see reapWorktreeLockHoldersAndRemove), so this
      // genuinely locks the directory with a real child process — an unlocked one would be
      // removed on the first attempt and never exercise the reap/escalation path at all.
      it('reaps lock holders (both tracked session pids and the path matcher) for each orphaned dir before removing it', async () => {
        const dir = await makeOrphanDir('FLUX-71');
        const holder = await lockDirAgainstRemoval(dir);
        cliSessionsById.set('fake-sess-71', { id: 'fake-sess-71', taskId: 'FLUX-71', pid: 111222 } as CliSessionRecord);

        try {
          const reapDescendantsByPid = vi.fn(async (pid: number) => {
            expect(pid).toBe(111222);
            holder.unlock(); // release the real lock this reap call is responsible for
            return [pid];
          });
          const findLockHolders = vi.fn(async (_wt: string, _base: string) => [] as number[]);
          const killPid = vi.fn((_pid: number) => {});

          await pruneTaskWorktrees(repo, {
            isSessionActiveForTask: () => false,
            reapDescendantsByPid,
            findLockHolders,
            killPid,
          });

          expect(reapDescendantsByPid).toHaveBeenCalledWith(111222);
          expect(findLockHolders).toHaveBeenCalledWith(dir, taskWorktreesBaseDir(repo));
          expect(killPid).not.toHaveBeenCalled(); // findLockHolders found nothing — reap alone released the lock
          expect(existsSync(dir)).toBe(false);
        } finally {
          holder.unlock();
          cliSessionsById.delete('fake-sess-71');
        }
      });

      // FLUX-1216 review fix: a directory that lost its EH worktree registration (e.g. FLUX-1018-
      // style ".git link is broken" corruption) but still holds a real, dirty checkout must never
      // be force-deleted outright — mirrors reclaimWorktrees'/removeTaskWorktree's own established
      // "never discard uncommitted work" guard.
      it('never deletes an orphaned directory that is still a dirty (standalone) git checkout', async () => {
        const dir = await makeOrphanDir('FLUX-76');
        await execFileAsync('git', ['-C', dir, 'init', '-b', 'master'], { windowsHide: true });
        await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
        await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test'], { windowsHide: true });
        await fs.writeFile(path.join(dir, 'wip.txt'), 'real uncommitted work\n', 'utf8');
        const findLockHolders = vi.fn(async () => [] as number[]);

        await pruneTaskWorktrees(repo, { isSessionActiveForTask: () => false, findLockHolders });

        expect(findLockHolders).not.toHaveBeenCalled(); // never even reached the reap/kill step
        expect(existsSync(dir)).toBe(true);
        expect(existsSync(path.join(dir, 'wip.txt'))).toBe(true);
      });

      it('never touches a directory whose ticket has an active session', async () => {
        const dir = await makeOrphanDir('FLUX-72');
        const findLockHolders = vi.fn(async () => [] as number[]);

        await pruneTaskWorktrees(repo, { isSessionActiveForTask: (id) => id === 'FLUX-72', findLockHolders });

        expect(findLockHolders).not.toHaveBeenCalled();
        expect(existsSync(dir)).toBe(true);
      });

      it('never touches a still-registered worktree, even when its session looks inactive', async () => {
        const wt = await createTaskWorktree(repo, 'FLUX-73', 'flux/FLUX-73');
        const findLockHolders = vi.fn(async () => [] as number[]);

        await pruneTaskWorktrees(repo, { isSessionActiveForTask: () => false, findLockHolders });

        expect(findLockHolders).not.toHaveBeenCalled();
        expect(existsSync(wt)).toBe(true);
        expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
      });

      // FLUX-1216 review fix: a transient failure of the `git worktree list` QUERY itself (index.lock
      // contention, a momentary spawn timeout) must NEVER be read as "confirmed zero worktrees
      // registered" — that would make every real, live worktree look orphaned and the sweep would
      // force-kill its holders and delete it, directly violating this routine's own "registered
      // worktrees are never touched" contract. Repro from the review: a runner that fails only on
      // `worktree list --porcelain` (prune itself still "succeeds") against a real, registered
      // worktree, with isSessionActiveForTask stubbed to `false` (as it would read for any ticket
      // with no live CLI session, e.g. a Ready ticket kept around for review).
      it('never deletes a live, registered worktree when the `git worktree list` query itself transiently fails', async () => {
        const wt = await createTaskWorktree(repo, 'FLUX-75', 'flux/FLUX-75');
        const findLockHolders = vi.fn(async () => [] as number[]);
        let listCalls = 0;
        const flakyRunner = async (cwd: string, args: string[]) => {
          if (args[0] === 'worktree' && args[1] === 'list') {
            listCalls++;
            throw new Error('simulated transient git failure (e.g. index.lock contention)');
          }
          const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
          return { stdout, stderr };
        };

        await pruneTaskWorktrees(repo, { gitRunner: flakyRunner, isSessionActiveForTask: () => false, findLockHolders });

        expect(listCalls).toBeGreaterThan(0); // the query really was attempted and really did fail
        expect(findLockHolders).not.toHaveBeenCalled(); // bailed out before ever considering candidates
        expect(existsSync(wt)).toBe(true);
        expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
      });

      it('never touches a directory whose name does not resolve to one of this repo\'s ticket ids', async () => {
        const dir = path.join(taskWorktreesBaseDir(repo), 'some-other-repo-FLUX-1');
        await fs.mkdir(dir, { recursive: true });
        const findLockHolders = vi.fn(async () => [] as number[]);

        await pruneTaskWorktrees(repo, { isSessionActiveForTask: () => false, findLockHolders });

        expect(findLockHolders).not.toHaveBeenCalled();
        expect(existsSync(dir)).toBe(true);
      });

      it('defaults isSessionActiveForTask to the real session store when not injected', async () => {
        // No opts.isSessionActiveForTask AND no tracked session anywhere for FLUX-74 — exercises
        // the real getActiveSessionsForTask default wiring (not a mock), which must resolve "no
        // session at all" the same as "inactive" and allow the sweep to proceed.
        __resetSessionStubStateForTests(); // ensure no reclaim-grace window is leaking in from another test
        const dir = await makeOrphanDir('FLUX-74');
        // Stub out the Windows process scan (real WMI query, slow + irrelevant here) — this test
        // is only exercising the isSessionActiveForTask default, not findWorktreeLockHolders.
        const findLockHolders = async () => [] as number[];

        await pruneTaskWorktrees(repo, { findLockHolders });

        expect(existsSync(dir)).toBe(false);
      });

      // FLUX-1216: pruneTaskWorktrees runs fire-and-forget from workspace activation, which
      // starts BEFORE rehydrateSessionStubs() repopulates the in-memory session map from
      // persisted stubs on the same boot — so a bare getActiveSessionsForTask check can read a
      // genuinely-active ticket as inactive during that window. isWithinReclaimGrace() (armed at
      // boot, inert otherwise) must make the default treat EVERY ticket as presumed-active until
      // the grace window elapses.
      it('presumes every ticket active (skips the whole sweep) during the post-restart reclaim grace window', async () => {
        const dir = await makeOrphanDir('FLUX-77');
        const findLockHolders = vi.fn(async () => [] as number[]);
        armReclaimGrace(); // simulate "engine just booted"

        try {
          await pruneTaskWorktrees(repo, { findLockHolders }); // real default isSessionActiveForTask

          expect(findLockHolders).not.toHaveBeenCalled();
          expect(existsSync(dir)).toBe(true);
        } finally {
          __resetSessionStubStateForTests();
        }
      });
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

    // FLUX-167 follow-up: a branch checked out in the MAIN checkout is the
    // run-on-master trap — resolving it to `repo` made the downstream spawn guard
    // emit a misleading "worktree is missing". Surface the real cause + remedy here
    // instead, and never resolve to the engine root.
    it('throws an actionable error (never resolves to master) when the branch is pinned in the main tree', async () => {
      const branch = 'flux/FLUX-7-pinned';
      await execFileAsync('git', ['-C', repo, 'checkout', '-b', branch], { windowsHide: true });
      const err = await resolveTaskExecutionRoot({ id: 'FLUX-7', branch }, repo).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeTruthy();
      expect(err!.message).toMatch(/checked out in the main checkout/i);
      expect(err!.message).toContain('FLUX-7');
      expect(err!.message).toMatch(/git checkout master/);
      // It did not fall back to the engine root, and created nothing under .eh-worktrees.
      expect(await listTaskWorktrees(repo)).toHaveLength(0);
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

  // FLUX-1120: a worktree can be reclaimed (or otherwise deregistered) while its directory
  // survives on disk — a bare `existsSync` can't tell the two apart, and running an agent in
  // such a stale directory produces opaque git errors instead of a clear "reclaimed" signal.
  describe('isRegisteredWorktree (FLUX-1120)', () => {
    it('is true for a live, registered worktree', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-30', 'flux/FLUX-30');
      await expect(isRegisteredWorktree(repo, wt)).resolves.toBe(true);
    });

    it('is false for a path that was never a worktree', async () => {
      await expect(isRegisteredWorktree(repo, path.join(parent, 'not-a-worktree'))).resolves.toBe(false);
    });

    it('is false once removed, even if a directory reappears at the same path', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-31', 'flux/FLUX-31');
      await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { windowsHide: true });
      // Simulate a stale/leftover directory surviving at the same path after reclaim (or a
      // registration removed by something other than `removeTaskWorktree`).
      await fs.mkdir(wt, { recursive: true });
      expect(existsSync(wt)).toBe(true);
      await expect(isRegisteredWorktree(repo, wt)).resolves.toBe(false);
    });

    // FLUX-1120 review: a transient failure of the `git worktree list` QUERY itself (lock
    // contention, a momentary spawn hiccup) must NOT be treated as evidence of reclaim — that
    // would falsely fail a perfectly healthy, resumable session. Falls back to the pre-FLUX-1120
    // existsSync-only signal instead of confidently reporting "not registered".
    it('falls back to existsSync (does not report "not registered") when the query itself fails', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-32', 'flux/FLUX-32');
      const flakyRunner = async (cwd: string, args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') throw new Error('simulated transient git failure');
        const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
        return { stdout, stderr };
      };
      await expect(isRegisteredWorktree(repo, wt, { gitRunner: flakyRunner })).resolves.toBe(true);
      // ...and still correctly falls back to false for a path that plainly doesn't exist.
      await expect(
        isRegisteredWorktree(repo, path.join(parent, 'nope'), { gitRunner: flakyRunner }),
      ).resolves.toBe(false);
    });
  });

  // FLUX-1182: `isRegisteredWorktree` runs a `git worktree list` subprocess on every resumed turn
  // (resolveResumeExecutionRoot), not just the first — a short TTL cache lets a burst of turns on
  // the same repo within the window share one query instead of re-shelling out per turn.
  describe('isRegisteredWorktree read-cache (FLUX-1182)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('serves the cached `git worktree list` within the TTL and re-queries once it elapses', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-50', 'flux/FLUX-50');
      let listCalls = 0;
      const countingRunner = async (cwd: string, args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') listCalls++;
        const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
        return { stdout, stderr };
      };

      await expect(isRegisteredWorktree(repo, wt, { gitRunner: countingRunner })).resolves.toBe(true);
      expect(listCalls).toBe(1);

      await expect(isRegisteredWorktree(repo, wt, { gitRunner: countingRunner })).resolves.toBe(true);
      expect(listCalls).toBe(1); // served from cache — no new subprocess

      await vi.advanceTimersByTimeAsync(3_100);
      await expect(isRegisteredWorktree(repo, wt, { gitRunner: countingRunner })).resolves.toBe(true);
      expect(listCalls).toBe(2);
    });

    it('is never masked by a stale cache after create/remove in the same process', async () => {
      const target = taskWorktreeDir(repo, 'FLUX-51');
      // A miss caches "not (yet) registered"...
      await expect(isRegisteredWorktree(repo, target)).resolves.toBe(false);
      // ...creating it must be visible immediately, not after the rest of the TTL window.
      await createTaskWorktree(repo, 'FLUX-51', 'flux/FLUX-51');
      await expect(isRegisteredWorktree(repo, target)).resolves.toBe(true);
      // ...and removing it must likewise be visible immediately.
      await removeTaskWorktree(repo, target);
      await expect(isRegisteredWorktree(repo, target)).resolves.toBe(false);
    });

    // FLUX-1195: the entry-invalidation above only clears the cache at the START of
    // createTaskWorktree — a concurrent read whose `git worktree list` runs (and caches) DURING
    // the mutation, before it completes, would otherwise cache a pre-mutation "not registered"
    // snapshot for the rest of the TTL window. Reproduce that interleaving deterministically by
    // pausing the `worktree add` subprocess and letting a concurrent read complete first.
    it('is not masked by a read that caches a pre-mutation snapshot while create is in flight', async () => {
      const id = 'FLUX-52';
      const branch = `flux/${id}`;
      const target = taskWorktreeDir(repo, id);

      let releaseAdd: (() => void) | undefined;
      const addGate = new Promise<void>((resolve) => { releaseAdd = resolve; });
      let addGateReachedResolve: (() => void) | undefined;
      const addGateReached = new Promise<void>((resolve) => { addGateReachedResolve = resolve; });

      const gatedRunner = async (cwd: string, args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'add') {
          addGateReachedResolve?.();
          await addGate;
        }
        const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
        return { stdout, stderr };
      };

      const createPromise = createTaskWorktree(repo, id, branch, { gitRunner: gatedRunner });

      // Wait until create is paused at the mutating `worktree add`, then run a concurrent read —
      // its `git worktree list` reflects the still-pre-mutation state and gets cached.
      await addGateReached;
      await expect(isRegisteredWorktree(repo, target)).resolves.toBe(false);

      // Let the mutation proceed and complete.
      releaseAdd!();
      await createPromise;

      // The stale "not registered" snapshot cached above must not be served post-creation.
      await expect(isRegisteredWorktree(repo, target)).resolves.toBe(true);
    });
  });

  describe('resolveResumeExecutionRoot (FLUX-1018 / FLUX-1120)', () => {
    it('returns the cached executionRoot when it is still a registered worktree', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-40', 'flux/FLUX-40');
      const root = await resolveResumeExecutionRoot(
        { executionRoot: wt, taskId: 'FLUX-40' },
        { id: 'FLUX-40', branch: 'flux/FLUX-40' },
        repo,
      );
      expect(root).toBe(wt);
    });

    // FLUX-1120: the actual gap this ticket closes — a bare `existsSync` passed for a stale
    // directory left behind at a reclaimed worktree's path; the registered-worktree check catches it.
    it('throws a clear "reclaimed" error when the cached path still exists but is no longer a registered worktree', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-41', 'flux/FLUX-41');
      await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { windowsHide: true });
      await fs.mkdir(wt, { recursive: true });
      await expect(
        resolveResumeExecutionRoot({ executionRoot: wt, taskId: 'FLUX-41' }, { id: 'FLUX-41', branch: 'flux/FLUX-41' }, repo),
      ).rejects.toThrow(/reclaimed|no longer a registered git worktree/i);
    });

    it('throws a clear error when the cached executionRoot has vanished entirely', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-42', 'flux/FLUX-42');
      await fs.rm(wt, { recursive: true, force: true });
      await expect(
        resolveResumeExecutionRoot({ executionRoot: wt, taskId: 'FLUX-42' }, { id: 'FLUX-42', branch: 'flux/FLUX-42' }, repo),
      ).rejects.toThrow(/reclaimed|no longer a registered git worktree/i);
    });

    it('throws when no cached executionRoot is set and the branch has no live worktree', async () => {
      await expect(
        resolveResumeExecutionRoot({ taskId: 'FLUX-43' }, { id: 'FLUX-43', branch: 'flux/FLUX-43' }, repo),
      ).rejects.toThrow(/missing — refusing to resume/i);
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

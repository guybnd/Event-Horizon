import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { addOrphanWorktree, isWorktreeOnBranch, type GitRunner } from './git-worktree.js';

const execFileAsync = promisify(execFile);
const realGit: GitRunner = (cwd, args) => execFileAsync('git', args, { cwd, windowsHide: true });

/** The exact shape git < 2.42 (e.g. macOS stock Apple Git 2.39.x) prints for the unsupported flag. */
const UNKNOWN_ORPHAN_OPTION_ERROR =
  "error: unknown option `orphan'\nusage: git worktree add [-f] [--detach] [--checkout] [--lock [--reason <string>]] [-b <new-branch>] <path> [<commit-ish>] ...";

describe('addOrphanWorktree (FLUX-297)', () => {
  let repo: string;
  let storeDir: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-orphan-wt-'));
    await realGit(repo, ['init', '-b', 'master']);
    await realGit(repo, ['config', 'user.email', 'test@test.com']);
    await realGit(repo, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await realGit(repo, ['add', '.']);
    await realGit(repo, ['commit', '-m', 'init']);
    storeDir = path.join(repo, '.flux-store');
  });

  afterEach(async () => {
    await realGit(repo, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('uses `worktree add --orphan` directly when the git binary supports it (modern path unchanged)', async () => {
    let orphanCalls = 0;
    const counting: GitRunner = (cwd, args) => {
      if (args[0] === 'worktree' && args.includes('--orphan')) orphanCalls++;
      return realGit(cwd, args);
    };

    await addOrphanWorktree(repo, 'flux-data', storeDir, counting);

    expect(orphanCalls).toBe(1);
    // Unborn (no commit yet, exactly like a real `--orphan` worktree) — HEAD doesn't resolve to a
    // revision until the first commit, so `git rev-parse` rejects; the worktree registration itself
    // is what proves this path ran (isWorktreeOnBranch legitimately can't confirm branch identity
    // pre-commit — same limitation the pre-existing helper already had).
    expect(existsSync(path.join(storeDir, '.git'))).toBe(true);
    const { stdout: worktrees } = await realGit(repo, ['worktree', 'list']);
    expect(worktrees).toContain('flux-data');
  });

  it('falls back to plumbing when --orphan is rejected as an unknown option (pre-2.42 git)', async () => {
    const rejectingOldGit: GitRunner = (cwd, args) => {
      if (args[0] === 'worktree' && args.includes('--orphan')) {
        return Promise.reject(new Error(`Command failed: git worktree add --orphan -b flux-data ${storeDir}\n${UNKNOWN_ORPHAN_OPTION_ERROR}`));
      }
      return realGit(cwd, args);
    };

    await addOrphanWorktree(repo, 'flux-data', storeDir, rejectingOldGit);

    expect(existsSync(path.join(storeDir, '.git'))).toBe(true);
    expect(await isWorktreeOnBranch(realGit, storeDir, 'flux-data')).toBe(true);

    // The root commit is a genuine parentless commit, not an unborn HEAD.
    const { stdout: parents } = await realGit(storeDir, ['rev-list', '--parents', '-n', '1', 'HEAD']);
    expect(parents.trim().split(' ').length).toBe(1);

    // The branch is immediately usable — committing real content on top works exactly like --orphan.
    await fs.writeFile(path.join(storeDir, 'hello.md'), '# hi\n', 'utf8');
    await realGit(storeDir, ['add', '-A']);
    await realGit(storeDir, ['commit', '-m', 'real content']);
    const { stdout: log } = await realGit(storeDir, ['log', '--oneline']);
    expect(log.trim().split('\n').length).toBe(2);
  });

  it('annotates a non-version failure with the engine git identity instead of falling back', async () => {
    let fellBackToCommitTree = false;
    const alwaysFails: GitRunner = (cwd, args) => {
      if (args[0] === 'worktree' && args.includes('--orphan')) {
        return Promise.reject(new Error('fatal: some other worktree error'));
      }
      if (args[0] === 'commit-tree') fellBackToCommitTree = true;
      return realGit(cwd, args);
    };

    await expect(addOrphanWorktree(repo, 'flux-data', storeDir, alwaysFails)).rejects.toThrow(/engine git: git version/);
    expect(fellBackToCommitTree).toBe(false);
  });

  it('annotates a fallback-stage failure with the engine git identity too', async () => {
    const failsOnBranchCreate: GitRunner = (cwd, args) => {
      if (args[0] === 'worktree' && args.includes('--orphan')) {
        return Promise.reject(new Error(UNKNOWN_ORPHAN_OPTION_ERROR));
      }
      if (args[0] === 'branch') {
        return Promise.reject(new Error('fatal: could not create branch'));
      }
      return realGit(cwd, args);
    };

    await expect(addOrphanWorktree(repo, 'flux-data', storeDir, failsOnBranchCreate)).rejects.toThrow(/engine git: git version/);
  });
});

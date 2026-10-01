// FLUX-1739: worktree teardown, against a real repo.
//
// This covers the two failures that would have shipped:
//
//  1. `removeTaskWorktree` THROWS on a dirty tree rather than force-removing it, and a benchmark
//     run's tree is dirty by design. Unaddressed, teardown fails on essentially every run, the
//     worktree slot is never returned, and the suite deadlocks after a few cells.
//
//  2. Once the run ticket is archived it reads as terminal, so the reconcile sweep takes the
//     `detachDirty` branch and calls `detachTaskWorktree` with `applyToMain` defaulting to TRUE —
//     stashing and APPLYING the run's edits onto the user's own checkout. The uncontrolled
//     destination is not `origin`; it is the working repo.
//
// Both are prevented by the same ordering: commit onto the run's own branch first, remove only a
// clean tree, and never detach without `applyToMain: false`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGitFixture } from './test-helpers/git-fixture.js';
import { runGit } from './git-exec.js';
import { teardownRun } from './benchmark-runner.js';

async function status(cwd: string): Promise<string> {
  return (await runGit(['status', '--porcelain'], { cwd })).stdout.trim();
}

describe('teardownRun', () => {
  let repo: string;
  let worktree: string;

  beforeEach(async () => {
    repo = await createGitFixture({
      templateKey: 'benchmark-teardown',
      populate: async (root) => {
        await fs.writeFile(path.join(root, 'seed.txt'), 'seed\n', 'utf-8');
      },
    });
    worktree = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
    await runGit(['worktree', 'add', '-b', 'flux/BENCH-1-run', worktree, 'HEAD'], { cwd: repo });
  });

  afterEach(async () => {
    await runGit(['worktree', 'remove', '--force', worktree], { cwd: repo }).catch(() => {});
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('commits uncommitted agent work and removes the tree, returning the slot', async () => {
    await fs.writeFile(path.join(worktree, 'agent-edit.ts'), 'export const x = 1;\n', 'utf-8');

    const res = await teardownRun(repo, worktree, 'run-1');

    expect(res.outcome).toBe('removed');
    await expect(fs.access(worktree)).rejects.toThrow(); // slot genuinely returned
  });

  it('leaves the run branch carrying a REAL commit — not the zero-commit branch the plan would have kept', async () => {
    await fs.writeFile(path.join(worktree, 'agent-edit.ts'), 'export const x = 1;\n', 'utf-8');
    await teardownRun(repo, worktree, 'run-2');

    const log = (await runGit(['log', '--oneline', 'flux/BENCH-1-run'], { cwd: repo })).stdout;
    expect(log).toContain('benchmark run run-2');
    const files = (await runGit(['show', '--name-only', '--format=', 'flux/BENCH-1-run'], { cwd: repo })).stdout;
    expect(files).toContain('agent-edit.ts');
  });

  it('NEVER applies the run\'s work onto the main checkout', async () => {
    const before = await status(repo);
    await fs.writeFile(path.join(worktree, 'agent-edit.ts'), 'export const x = 1;\n', 'utf-8');
    await fs.writeFile(path.join(worktree, 'seed.txt'), 'AGENT OVERWROTE THIS\n', 'utf-8');

    await teardownRun(repo, worktree, 'run-3');

    expect(await status(repo)).toBe(before);
    // The main tree's own copy is untouched. Compared line-ending-agnostically: git's autocrlf
    // rewrites the checkout on Windows, which says nothing about whether the run's work leaked.
    expect((await fs.readFile(path.join(repo, 'seed.txt'), 'utf-8')).trim()).toBe('seed');
    await expect(fs.access(path.join(repo, 'agent-edit.ts'))).rejects.toThrow();
  });

  it('handles a run that changed nothing — a zero-commit branch is honest, not an error', async () => {
    const res = await teardownRun(repo, worktree, 'run-4');
    expect(res.outcome).toBe('removed');
    await expect(fs.access(worktree)).rejects.toThrow();
  });

  it('handles untracked directories as well as modified files', async () => {
    await fs.mkdir(path.join(worktree, 'newdir'), { recursive: true });
    await fs.writeFile(path.join(worktree, 'newdir', 'a.ts'), 'export const a = 1;\n', 'utf-8');
    const res = await teardownRun(repo, worktree, 'run-5');
    expect(res.outcome).toBe('removed');
  });

  it('reports failure rather than throwing when the worktree path is gone', async () => {
    const res = await teardownRun(repo, path.join(repo, 'no-such-worktree'), 'run-6');
    expect(res.outcome).toBe('failed');
    expect(res.error).toBeTruthy();
  });
});

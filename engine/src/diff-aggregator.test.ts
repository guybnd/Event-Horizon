import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createTaskWorktree, listTaskWorktrees } from './task-worktree.js';
import { buildDiffOverview, diffFileContent, diffFilesForBranch, computeCollisions, type DiffGroup } from './diff-aggregator.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

async function makeParent(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eh-diffagg-'));
}

async function gitInit(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await git(root, ['init', '-b', 'master']);
  await git(root, ['config', 'user.email', 'test@test.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'init']);
}

describe('diff-aggregator', () => {
  let parent: string;
  let repo: string;

  beforeEach(async () => {
    parent = await makeParent();
    repo = path.join(parent, 'EventHorizon');
    await gitInit(repo);
  });

  afterEach(async () => {
    try {
      const wts = await listTaskWorktrees(repo).catch(() => []);
      for (const w of wts) await git(repo, ['worktree', 'remove', '--force', w.path]).catch(() => {});
      await git(repo, ['worktree', 'prune']).catch(() => {});
    } catch { /* best-effort */ }
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  });

  it('groups a worktree’s committed-ahead, uncommitted, and untracked changes by status', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-x', { linkDependencies: false });
    // committed-ahead on the branch
    await fs.writeFile(path.join(wt, 'committed.txt'), 'a\n', 'utf8');
    await git(wt, ['add', 'committed.txt']);
    await git(wt, ['commit', '-m', 'add committed']);
    // uncommitted modification + untracked file
    await fs.writeFile(path.join(wt, 'README.md'), '# changed\n', 'utf8');
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'u\n', 'utf8');

    const { groups } = await buildDiffOverview(repo);
    const g = groups.find((x) => x.kind === 'worktree' && x.branch === 'flux/FLUX-1-x');
    expect(g).toBeTruthy();
    const byFile = Object.fromEntries(g!.files.map((f) => [f.file, f.status]));
    expect(byFile['committed.txt']).toBe('added');
    expect(byFile['README.md']).toBe('modified');
    expect(byFile['untracked.txt']).toBe('untracked');
  });

  it('reports the main tree’s uncommitted + untracked changes in a main group', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# main edit\n', 'utf8');
    await fs.writeFile(path.join(repo, 'loose.txt'), 'x\n', 'utf8');
    const { groups } = await buildDiffOverview(repo);
    const main = groups.find((x) => x.kind === 'main');
    expect(main).toBeTruthy();
    const files = main!.files.map((f) => f.file);
    expect(files).toContain('README.md');
    expect(files).toContain('loose.txt');
  });

  it('flags a file changed in two worktrees as a collision and annotates each file', async () => {
    const wtA = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-a', { linkDependencies: false });
    const wtB = await createTaskWorktree(repo, 'FLUX-2', 'flux/FLUX-2-b', { linkDependencies: false });
    await fs.writeFile(path.join(wtA, 'README.md'), '# A\n', 'utf8');
    await fs.writeFile(path.join(wtB, 'README.md'), '# B\n', 'utf8');

    const { collisions, groups } = await buildDiffOverview(repo);
    const c = collisions.find((x) => x.file === 'README.md');
    expect(c).toBeTruthy();
    expect(c!.refs).toEqual(expect.arrayContaining(['flux/FLUX-1-a', 'flux/FLUX-2-b']));
    const fileA = groups.find((g) => g.branch === 'flux/FLUX-1-a')!.files.find((f) => f.file === 'README.md');
    expect(fileA!.collidesWith).toContain('flux/FLUX-2-b');
  });

  it('flags a worktree+main collision', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-a', { linkDependencies: false });
    await fs.writeFile(path.join(wt, 'README.md'), '# wt\n', 'utf8');
    await fs.writeFile(path.join(repo, 'README.md'), '# main\n', 'utf8');
    const { collisions } = await buildDiffOverview(repo);
    const c = collisions.find((x) => x.file === 'README.md');
    expect(c).toBeTruthy();
    expect(c!.refs).toEqual(expect.arrayContaining(['flux/FLUX-1-a', 'main']));
  });

  it('diffFileContent returns a unified diff for a tracked change and an added-file diff for untracked', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-a', { linkDependencies: false });
    await fs.writeFile(path.join(wt, 'README.md'), '# changed in wt\n', 'utf8');
    await fs.writeFile(path.join(wt, 'new.txt'), 'brand new\n', 'utf8');

    const tracked = await diffFileContent(repo, 'flux/FLUX-1-a', 'README.md');
    expect(tracked).toContain('README.md');
    expect(tracked).toContain('# changed in wt');

    const untracked = await diffFileContent(repo, 'flux/FLUX-1-a', 'new.txt');
    expect(untracked).toContain('new.txt');
    expect(untracked).toContain('brand new');
  });

  it('diffFileContent(main) diffs the engine root vs HEAD', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# root edit\n', 'utf8');
    const d = await diffFileContent(repo, 'main', 'README.md');
    expect(d).toContain('# root edit');
  });

  it('diffFilesForBranch returns a worktree branch’s committed + uncommitted + untracked changes (FLUX-615)', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-x', { linkDependencies: false });
    await fs.writeFile(path.join(wt, 'committed.txt'), 'a\n', 'utf8');
    await git(wt, ['add', 'committed.txt']);
    await git(wt, ['commit', '-m', 'add committed']);
    await fs.writeFile(path.join(wt, 'README.md'), '# changed\n', 'utf8');
    await fs.writeFile(path.join(wt, 'untracked.txt'), 'u\n', 'utf8');

    const summary = await diffFilesForBranch(repo, 'flux/FLUX-1-x');
    expect(summary.branch).toBe('flux/FLUX-1-x');
    // git reports the worktree path in a normalized form (slashes / long names differ from
    // createTaskWorktree's return on Windows), so assert it resolves rather than string-equals.
    expect(summary.worktree).toBeTruthy();
    expect(path.basename(summary.worktree!)).toBe(path.basename(wt));
    const byFile = Object.fromEntries(summary.files.map((f) => [f.file, f.status]));
    expect(byFile['committed.txt']).toBe('added');
    expect(byFile['README.md']).toBe('modified');
    expect(byFile['untracked.txt']).toBe('untracked');
  });

  it('diffFilesForBranch falls back to the committed range for a branch with no worktree (FLUX-615)', async () => {
    // A plain branch (no task worktree): commit a file on it, then return to master.
    await git(repo, ['checkout', '-b', 'feature/no-wt']);
    await fs.writeFile(path.join(repo, 'feat.txt'), 'hello\n', 'utf8');
    await git(repo, ['add', 'feat.txt']);
    await git(repo, ['commit', '-m', 'feat']);
    await git(repo, ['checkout', 'master']);

    const summary = await diffFilesForBranch(repo, 'feature/no-wt');
    expect(summary.worktree).toBeNull();
    expect(summary.base).toContain('..feature/no-wt');
    const byFile = Object.fromEntries(summary.files.map((f) => [f.file, f.status]));
    expect(byFile['feat.txt']).toBe('added');
  });

  it('diffFilesForBranch returns an empty summary for an unknown branch (FLUX-615)', async () => {
    const summary = await diffFilesForBranch(repo, 'flux/does-not-exist');
    expect(summary.worktree).toBeNull();
    expect(summary.files).toEqual([]);
  });

  it('computeCollisions lists only multi-group files and annotates collidesWith', () => {
    const groups: DiffGroup[] = [
      {
        kind: 'worktree', path: '/a', branch: 'b1',
        files: [
          { file: 'x.ts', additions: 1, deletions: 0, status: 'modified' },
          { file: 'only-a.ts', additions: 1, deletions: 0, status: 'modified' },
        ],
      },
      {
        kind: 'main', path: '/root',
        files: [{ file: 'x.ts', additions: 2, deletions: 1, status: 'modified' }],
      },
    ];
    const collisions = computeCollisions(groups);
    expect(collisions.map((c) => c.file)).toEqual(['x.ts']);
    expect(collisions[0]!.refs).toEqual(['b1', 'main']);
    expect(groups[0]!.files.find((f) => f.file === 'x.ts')!.collidesWith).toEqual(['main']);
    expect(groups[0]!.files.find((f) => f.file === 'only-a.ts')!.collidesWith).toBeUndefined();
  });
});

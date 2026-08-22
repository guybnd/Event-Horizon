import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createTaskWorktree, listTaskWorktrees } from './task-worktree.js';
import {
  buildDiffOverview, diffFileContent, diffFilesForBranch, changedFilesMasterSideOfBranch,
  computeCollisions, parseStatusPorcelain, isDocsRootMarkdownFile, fileContentPair, type DiffGroup,
} from './diff-aggregator.js';

// Real git worktree ops are slow on Windows under parallel suite load — the default 5000ms
// testTimeout intermittently overruns when the full engine suite runs concurrently (FLUX-749).
// Raise it file-wide so these don't flake the `check` gate (mirrors group-integration.test.ts).
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

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

  it('flags committed-ahead files with committed:true and leaves loose files falsy (FLUX-582)', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-c', { linkDependencies: false });
    // committed-ahead on the branch
    await fs.writeFile(path.join(wt, 'committed.txt'), 'a\n', 'utf8');
    await git(wt, ['add', 'committed.txt']);
    await git(wt, ['commit', '-m', 'add committed']);
    // a purely-loose untracked file (never committed)
    await fs.writeFile(path.join(wt, 'loose.txt'), 'u\n', 'utf8');

    const { groups } = await buildDiffOverview(repo);
    const g = groups.find((x) => x.kind === 'worktree' && x.branch === 'flux/FLUX-1-c');
    expect(g).toBeTruthy();
    const byFile = Object.fromEntries(g!.files.map((f) => [f.file, f]));
    expect(byFile['committed.txt']!.committed).toBe(true);
    expect(byFile['loose.txt']!.committed).toBeFalsy();
  });

  it('flags uncommitted files with uncommitted:true in worktree groups and the main group, leaving committed-only files falsy (FLUX-1333)', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-u', { linkDependencies: false });
    // committed-ahead only
    await fs.writeFile(path.join(wt, 'committed.txt'), 'a\n', 'utf8');
    await git(wt, ['add', 'committed.txt']);
    await git(wt, ['commit', '-m', 'add committed']);
    // committed-ahead + further loose edits (mixed)
    await fs.writeFile(path.join(wt, 'mixed.txt'), 'v1\n', 'utf8');
    await git(wt, ['add', 'mixed.txt']);
    await git(wt, ['commit', '-m', 'add mixed']);
    await fs.writeFile(path.join(wt, 'mixed.txt'), 'v2\n', 'utf8');
    // purely loose
    await fs.writeFile(path.join(wt, 'loose.txt'), 'u\n', 'utf8');
    // main-tree loose edit
    await fs.writeFile(path.join(repo, 'README.md'), '# main edit\n', 'utf8');

    const { groups } = await buildDiffOverview(repo);
    const g = groups.find((x) => x.kind === 'worktree' && x.branch === 'flux/FLUX-1-u');
    expect(g).toBeTruthy();
    const byFile = Object.fromEntries(g!.files.map((f) => [f.file, f]));
    expect(byFile['committed.txt']!.uncommitted).toBeFalsy();
    expect(byFile['mixed.txt']!.uncommitted).toBe(true);
    expect(byFile['loose.txt']!.uncommitted).toBe(true);
    // The main group is uncommitted-vs-HEAD by construction — flagged anyway for a uniform contract.
    const main = groups.find((x) => x.kind === 'main')!;
    expect(main.files.length).toBeGreaterThan(0);
    for (const f of main.files) expect(f.uncommitted).toBe(true);
  });

  it('flags uncommitted files in diffFilesForBranch and leaves the no-worktree fallback unflagged (FLUX-1333)', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-v', { linkDependencies: false });
    await fs.writeFile(path.join(wt, 'committed.txt'), 'a\n', 'utf8');
    await git(wt, ['add', 'committed.txt']);
    await git(wt, ['commit', '-m', 'add committed']);
    await fs.writeFile(path.join(wt, 'loose.txt'), 'u\n', 'utf8');

    const summary = await diffFilesForBranch(repo, 'flux/FLUX-1-v');
    const byFile = Object.fromEntries(summary.files.map((f) => [f.file, f]));
    expect(byFile['committed.txt']!.uncommitted).toBeFalsy();
    expect(byFile['loose.txt']!.uncommitted).toBe(true);

    // Remove the worktree → the branch falls back to its committed range: nothing is discardable.
    await git(repo, ['worktree', 'remove', '--force', wt]);
    const fallback = await diffFilesForBranch(repo, 'flux/FLUX-1-v');
    expect(fallback.worktree).toBeNull();
    expect(fallback.files.length).toBeGreaterThan(0);
    for (const f of fallback.files) expect(f.uncommitted).toBeFalsy();
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

  it('diffFileContent falls back to the committed range for a branch with no worktree (FLUX-1670)', async () => {
    await git(repo, ['checkout', '-b', 'feature/x']);
    await fs.writeFile(path.join(repo, 'feat.txt'), 'hello\n', 'utf8');
    await git(repo, ['add', 'feat.txt']);
    await git(repo, ['commit', '-m', 'feat']);
    await git(repo, ['checkout', 'master']);

    const diff = await diffFileContent(repo, 'feature/x', 'feat.txt');
    expect(diff).toContain('feat.txt');
    expect(diff).toContain('hello');

    // Unknown branch still yields '' rather than a spurious diff.
    expect(await diffFileContent(repo, 'feature/does-not-exist', 'feat.txt')).toBe('');
  });

  it('fileContentPair falls back to the committed range for a branch with no worktree (FLUX-1670)', async () => {
    await git(repo, ['checkout', '-b', 'feature/y']);
    await fs.writeFile(path.join(repo, 'feat.txt'), 'v2\n', 'utf8');
    await git(repo, ['add', 'feat.txt']);
    await git(repo, ['commit', '-m', 'feat v2']);
    await git(repo, ['checkout', 'master']);

    const pair = await fileContentPair(repo, 'feature/y', 'feat.txt');
    expect(pair.before).toBe(''); // file didn't exist at the merge-base
    expect(pair.after).toBe('v2\n');

    // Unknown branch still yields empty content rather than throwing.
    const unknown = await fileContentPair(repo, 'feature/does-not-exist', 'feat.txt');
    expect(unknown).toEqual({ before: '', after: '' });
  });

  it('diffFilesForBranch prefers the stored baselineCommit over merge-base once the branch is merged (FLUX-1676)', async () => {
    // Reproduce the reported drift: branch a ticket branch off master, commit on it, merge it back
    // into master (fast-forward), then diff with no dedicated worktree — exactly a merged PR ticket
    // whose worktree has been reclaimed. Once merged, master contains the branch's own tip as an
    // ancestor, so a live `merge-base(master, branch)` recompute now returns the branch tip itself
    // (not the pre-merge divergence point) and `<tip>..<tip>` collapses to an empty range.
    const baselineCommit = await git(repo, ['rev-parse', 'master']).then((r) => r.stdout.trim());
    await git(repo, ['checkout', '-b', 'flux/merged-pr']);
    await fs.writeFile(path.join(repo, 'feat.txt'), 'hello\n', 'utf8');
    await git(repo, ['add', 'feat.txt']);
    await git(repo, ['commit', '-m', 'feat']);
    await git(repo, ['checkout', 'master']);
    await git(repo, ['merge', '--ff-only', 'flux/merged-pr']);

    // Confirm the drift actually reproduces: merge-base now equals the branch tip.
    const branchTip = await git(repo, ['rev-parse', 'flux/merged-pr']).then((r) => r.stdout.trim());
    const mergeBase = await git(repo, ['merge-base', 'master', 'flux/merged-pr']).then((r) => r.stdout.trim());
    expect(mergeBase).toBe(branchTip);

    // Without baselineCommit: the drifted merge-base still yields an empty summary (the bug).
    const drifted = await diffFilesForBranch(repo, 'flux/merged-pr');
    expect(drifted.files).toEqual([]);

    // With the ticket's stored baselineCommit: the pre-merge divergence point is used instead,
    // and the branch's file shows up again.
    const fixed = await diffFilesForBranch(repo, 'flux/merged-pr', { baselineCommit });
    expect(fixed.base).toBe(`${baselineCommit}..flux/merged-pr`);
    const byFile = Object.fromEntries(fixed.files.map((f) => [f.file, f.status]));
    expect(byFile['feat.txt']).toBe('added');
  });

  it('diffFileContent and fileContentPair also prefer baselineCommit once the branch is merged (FLUX-1676)', async () => {
    const baselineCommit = await git(repo, ['rev-parse', 'master']).then((r) => r.stdout.trim());
    await git(repo, ['checkout', '-b', 'flux/merged-pr-2']);
    await fs.writeFile(path.join(repo, 'feat2.txt'), 'v1\n', 'utf8');
    await git(repo, ['add', 'feat2.txt']);
    await git(repo, ['commit', '-m', 'feat2']);
    await git(repo, ['checkout', 'master']);
    await git(repo, ['merge', '--ff-only', 'flux/merged-pr-2']);

    expect(await diffFileContent(repo, 'flux/merged-pr-2', 'feat2.txt')).toBe('');
    const diff = await diffFileContent(repo, 'flux/merged-pr-2', 'feat2.txt', { baselineCommit });
    expect(diff).toContain('feat2.txt');
    expect(diff).toContain('v1');

    // Drifted merge-base equals the branch tip, so before/after both read the same post-merge
    // content — no visible change, masking that the file was ever added (the bug).
    const driftedPair = await fileContentPair(repo, 'flux/merged-pr-2', 'feat2.txt');
    expect(driftedPair).toEqual({ before: 'v1\n', after: 'v1\n' });
    const pair = await fileContentPair(repo, 'flux/merged-pr-2', 'feat2.txt', { baselineCommit });
    expect(pair.before).toBe('');
    expect(pair.after).toBe('v1\n');
  });

  it('diffFilesForBranch returns an empty summary for an unknown branch (FLUX-615)', async () => {
    const summary = await diffFilesForBranch(repo, 'flux/does-not-exist');
    expect(summary.worktree).toBeNull();
    expect(summary.files).toEqual([]);
  });

  it('changedFilesMasterSideOfBranch lists what master changed underneath a branch (FLUX-655)', async () => {
    // Branch diverges from master at the init commit; master then advances with a new file.
    await git(repo, ['branch', 'flux/FLUX-9-x']);
    await fs.writeFile(path.join(repo, 'on-master.txt'), 'm\n', 'utf8');
    await git(repo, ['add', 'on-master.txt']);
    await git(repo, ['commit', '-m', 'master advances']);

    const files = await changedFilesMasterSideOfBranch(repo, 'flux/FLUX-9-x');
    const byFile = Object.fromEntries(files.map((f) => [f.file, f.status]));
    expect(byFile['on-master.txt']).toBe('added');
  });

  it('changedFilesMasterSideOfBranch is empty when the branch is up to date with master (FLUX-655)', async () => {
    // A branch at the master tip has no master-side delta.
    await git(repo, ['branch', 'flux/FLUX-9-y']);
    expect(await changedFilesMasterSideOfBranch(repo, 'flux/FLUX-9-y')).toEqual([]);
  });

  it('changedFilesMasterSideOfBranch returns [] for an unknown branch (FLUX-655)', async () => {
    expect(await changedFilesMasterSideOfBranch(repo, 'flux/does-not-exist')).toEqual([]);
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

  it('flags docsRoot markdown files with isDoc:true and leaves other files unflagged (FLUX-1653)', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-doc', { linkDependencies: false });
    await fs.mkdir(path.join(wt, '.docs'), { recursive: true });
    await fs.writeFile(path.join(wt, '.docs', 'guide.md'), '# guide\n', 'utf8');
    await fs.writeFile(path.join(wt, 'src.ts'), 'export {};\n', 'utf8');

    const { groups } = await buildDiffOverview(repo);
    const g = groups.find((x) => x.kind === 'worktree' && x.branch === 'flux/FLUX-1-doc');
    const byFile = Object.fromEntries(g!.files.map((f) => [f.file, f]));
    expect(byFile['.docs/guide.md']!.isDoc).toBe(true);
    expect(byFile['src.ts']!.isDoc).toBeUndefined();
  });

  it('fileContentPair returns before/after raw content, empty on add/delete', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1-pair', { linkDependencies: false });
    // modified: README.md exists at the merge-base and is edited loose in the worktree.
    await fs.writeFile(path.join(wt, 'README.md'), '# changed\n', 'utf8');
    // added: a brand-new untracked file has no merge-base content.
    await fs.writeFile(path.join(wt, 'new.md'), '# new\n', 'utf8');

    const modified = await fileContentPair(repo, 'flux/FLUX-1-pair', 'README.md');
    expect(modified.before).toContain('# test');
    expect(modified.after).toContain('# changed');

    const added = await fileContentPair(repo, 'flux/FLUX-1-pair', 'new.md');
    expect(added.before).toBe('');
    expect(added.after).toContain('# new');

    // deleted: remove README.md entirely — `after` reads live off disk and finds nothing.
    await fs.rm(path.join(wt, 'README.md'));
    const deleted = await fileContentPair(repo, 'flux/FLUX-1-pair', 'README.md');
    expect(deleted.before).toContain('# test');
    expect(deleted.after).toBe('');
  });

  it('fileContentPair(main) reads the engine root vs HEAD', async () => {
    await fs.writeFile(path.join(repo, 'README.md'), '# root edit\n', 'utf8');
    const pair = await fileContentPair(repo, 'main', 'README.md');
    expect(pair.before).toContain('# test');
    expect(pair.after).toContain('# root edit');
  });
});

describe('isDocsRootMarkdownFile (FLUX-1653)', () => {
  it('matches a .md file under the default .docs root', () => {
    expect(isDocsRootMarkdownFile('.docs/guide.md')).toBe(true);
    expect(isDocsRootMarkdownFile('.docs/nested/guide.md')).toBe(true);
  });

  it('rejects non-.md files and files outside the docs root', () => {
    expect(isDocsRootMarkdownFile('.docs/image.png')).toBe(false);
    expect(isDocsRootMarkdownFile('src/index.ts')).toBe(false);
    expect(isDocsRootMarkdownFile('docsRoot-lookalike/guide.md')).toBe(false);
  });
});

describe('parseStatusPorcelain (FLUX-1333)', () => {
  it('parses plain, staged-rename, and untracked entries', () => {
    const entries = parseStatusPorcelain('M  a.txt\n D b.txt\nR  old.txt -> new.txt\n?? dir/u.txt\n');
    expect(entries).toEqual([
      { x: 'M', y: ' ', path: 'a.txt', rawPath: 'a.txt' },
      { x: ' ', y: 'D', path: 'b.txt', rawPath: 'b.txt' },
      { x: 'R', y: ' ', path: 'new.txt', rawPath: 'new.txt', origPath: 'old.txt' },
      { x: '?', y: '?', path: 'dir/u.txt', rawPath: 'dir/u.txt' },
    ]);
  });

  it('unquotes C-quoted exotic paths while keeping the raw spelling', () => {
    const entries = parseStatusPorcelain('?? "caf\\303\\251.txt"\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('café.txt');
    expect(entries[0]!.rawPath).toBe('"caf\\303\\251.txt"');
  });
});

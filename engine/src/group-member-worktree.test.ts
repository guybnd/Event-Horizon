import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  attachMemberWorktree,
  detachMemberWorktree,
  ensureMemberGitignore,
  buildGroupDocsScopeArg,
} from './group-member-worktree.js';
import { GROUP_DOCS_BRANCH, GROUP_STORE_DIRNAME } from './group.js';

const execFileAsync = promisify(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eh-worktree-test-'));
}

/** Minimal git init with a committed README so the repo has a HEAD commit. */
async function gitInit(root: string): Promise<void> {
  await execFileAsync('git', ['-C', root, 'init'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test'], { windowsHide: true });
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  await execFileAsync('git', ['-C', root, 'add', '.'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'commit', '-m', 'init'], { windowsHide: true });
}

/**
 * Create an orphan `flux-group-docs` branch in `root` with at least one commit
 * so that member fetches find a non-empty branch.
 */
async function createGroupDocsBranch(root: string, fileName = 'features/overview.md'): Promise<void> {
  const storeDir = path.join(root, GROUP_STORE_DIRNAME);
  await fs.mkdir(storeDir, { recursive: true });
  await execFileAsync('git', ['-C', root, 'worktree', 'add', '--orphan', '-b', GROUP_DOCS_BRANCH, storeDir], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test'], { windowsHide: true });
  const filePath = path.join(storeDir, ...fileName.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '# Overview\n\nShared knowledge base.\n', 'utf8');
  await execFileAsync('git', ['-C', storeDir, 'add', '-A'], { windowsHide: true });
  await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'group: initial docs'], { windowsHide: true });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('attachMemberWorktree', () => {
  let parentRoot: string;
  let memberRoot: string;
  let tmpDirs: string[];

  beforeEach(async () => {
    tmpDirs = [];
    parentRoot = await makeTempRoot(); tmpDirs.push(parentRoot);
    memberRoot = await makeTempRoot(); tmpDirs.push(memberRoot);
    await gitInit(parentRoot);
    await gitInit(memberRoot);
  });

  afterEach(async () => {
    // git worktrees need to be removed before the repo dir can be deleted.
    for (const root of [parentRoot, memberRoot]) {
      const storeDir = path.join(root, GROUP_STORE_DIRNAME);
      if (existsSync(storeDir)) {
        await execFileAsync('git', ['-C', root, 'worktree', 'remove', '--force', storeDir], { windowsHide: true }).catch(() => {});
      }
      await execFileAsync('git', ['-C', root, 'worktree', 'prune'], { windowsHide: true }).catch(() => {});
    }
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('returns false when the parent has no flux-group-docs branch yet', async () => {
    const result = await attachMemberWorktree(memberRoot, parentRoot);
    expect(result).toBe(false);
    expect(existsSync(path.join(memberRoot, GROUP_STORE_DIRNAME))).toBe(false);
  });

  it('creates a local worktree in the member when the parent has commits on flux-group-docs', async () => {
    await createGroupDocsBranch(parentRoot);
    const result = await attachMemberWorktree(memberRoot, parentRoot);
    expect(result).toBe(true);

    const storeDir = path.join(memberRoot, GROUP_STORE_DIRNAME);
    expect(existsSync(storeDir)).toBe(true);
    // The doc must be present in the member's local copy.
    expect(existsSync(path.join(storeDir, 'features', 'overview.md'))).toBe(true);
  });

  it('is idempotent: refreshes an existing worktree without error', async () => {
    await createGroupDocsBranch(parentRoot);
    await attachMemberWorktree(memberRoot, parentRoot);

    // Add a new doc to the parent's store and re-sync.
    const storeDir = path.join(parentRoot, GROUP_STORE_DIRNAME);
    await fs.writeFile(path.join(storeDir, 'features', 'api.md'), '# API\n', 'utf8');
    await execFileAsync('git', ['-C', storeDir, 'add', '-A'], { windowsHide: true });
    await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'group: add api doc'], { windowsHide: true });

    const result = await attachMemberWorktree(memberRoot, parentRoot);
    expect(result).toBe(true);
    // The new doc should now be present in the member's copy.
    expect(existsSync(path.join(memberRoot, GROUP_STORE_DIRNAME, 'features', 'api.md'))).toBe(true);
  });

  it('adds /.flux-group/ to the member .gitignore', async () => {
    await createGroupDocsBranch(parentRoot);
    await attachMemberWorktree(memberRoot, parentRoot);

    const gitignore = await fs.readFile(path.join(memberRoot, '.gitignore'), 'utf8').catch(() => '');
    expect(gitignore).toContain('/.flux-group/');
  });
});

describe('detachMemberWorktree', () => {
  let parentRoot: string;
  let memberRoot: string;
  let tmpDirs: string[];

  beforeEach(async () => {
    tmpDirs = [];
    parentRoot = await makeTempRoot(); tmpDirs.push(parentRoot);
    memberRoot = await makeTempRoot(); tmpDirs.push(memberRoot);
    await gitInit(parentRoot);
    await gitInit(memberRoot);
  });

  afterEach(async () => {
    for (const root of [parentRoot, memberRoot]) {
      await execFileAsync('git', ['-C', root, 'worktree', 'prune'], { windowsHide: true }).catch(() => {});
    }
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('removes the worktree directory when one exists', async () => {
    await createGroupDocsBranch(parentRoot);
    await attachMemberWorktree(memberRoot, parentRoot);
    expect(existsSync(path.join(memberRoot, GROUP_STORE_DIRNAME))).toBe(true);

    await detachMemberWorktree(memberRoot);
    expect(existsSync(path.join(memberRoot, GROUP_STORE_DIRNAME))).toBe(false);
  });

  it('is a no-op when no worktree exists (does not throw)', async () => {
    await expect(detachMemberWorktree(memberRoot)).resolves.toBeUndefined();
  });
});

describe('ensureMemberGitignore', () => {
  let memberRoot: string;

  beforeEach(async () => { memberRoot = await makeTempRoot(); });
  afterEach(async () => { await fs.rm(memberRoot, { recursive: true, force: true }).catch(() => {}); });

  it('creates .gitignore with the entry when no file exists', async () => {
    await ensureMemberGitignore(memberRoot);
    const content = await fs.readFile(path.join(memberRoot, '.gitignore'), 'utf8');
    expect(content).toContain(`/${GROUP_STORE_DIRNAME}/`);
  });

  it('appends to an existing .gitignore', async () => {
    await fs.writeFile(path.join(memberRoot, '.gitignore'), 'node_modules/\n', 'utf8');
    await ensureMemberGitignore(memberRoot);
    const content = await fs.readFile(path.join(memberRoot, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain(`/${GROUP_STORE_DIRNAME}/`);
  });

  it('is idempotent: does not add a duplicate entry', async () => {
    await ensureMemberGitignore(memberRoot);
    await ensureMemberGitignore(memberRoot);
    const content = await fs.readFile(path.join(memberRoot, '.gitignore'), 'utf8');
    const matches = content.split('\n').filter((l) => l.trim() === `/${GROUP_STORE_DIRNAME}/`);
    expect(matches.length).toBe(1);
  });

  it('recognises alternate spellings as already present', async () => {
    await fs.writeFile(path.join(memberRoot, '.gitignore'), `.flux-group\n`, 'utf8');
    await ensureMemberGitignore(memberRoot);
    const content = await fs.readFile(path.join(memberRoot, '.gitignore'), 'utf8');
    const matches = content.split('\n').filter((l) => l.includes(GROUP_STORE_DIRNAME));
    expect(matches.length).toBe(1);
  });
});

describe('buildGroupDocsScopeArg', () => {
  let memberRoot: string;

  beforeEach(async () => { memberRoot = await makeTempRoot(); });
  afterEach(async () => { await fs.rm(memberRoot, { recursive: true, force: true }).catch(() => {}); });

  it('returns [] when the store dir does not exist', () => {
    // getMemberBinding() is null in the test context, so returns [] anyway.
    expect(buildGroupDocsScopeArg(memberRoot)).toEqual([]);
  });

  it('returns [] for an empty string memberRoot', () => {
    expect(buildGroupDocsScopeArg('')).toEqual([]);
  });
});

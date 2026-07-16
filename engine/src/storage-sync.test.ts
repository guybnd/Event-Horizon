import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { excludeLocalConfigFromSync, ensureUnionMergeAttributes, ensureSyncProtocolMarker, migrateToOrphan } from './storage-sync.js';
import { SUPPORTED_SYNC_PROTOCOL } from './sync-watcher.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

async function trackedFiles(storeDir: string): Promise<string[]> {
  const { stdout } = await git(storeDir, ['ls-files']);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('storage-sync — local config exclusion (FLUX-532)', () => {
  let repo: string;
  let storeDir: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-sync-'));
    await git(repo, ['init', '-b', 'master']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'init']);

    // Orphan flux-data worktree (mirrors orphan storage mode).
    storeDir = path.join(repo, '.flux-store');
    await git(repo, ['worktree', 'add', '--orphan', '-b', 'flux-data', storeDir]);
  });

  afterEach(async () => {
    await git(repo, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('untracks an already-committed config.json + read-state.json and keeps the files on disk', async () => {
    // Simulate an older engine that committed local config to flux-data.
    await fs.writeFile(path.join(storeDir, 'config.json'), '{"requireCommentOnStatusChange":false}', 'utf8');
    await fs.writeFile(path.join(storeDir, 'read-state.json'), '{}', 'utf8');
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), '# ticket\n', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'init store (with config tracked)']);
    expect(await trackedFiles(storeDir)).toContain('config.json');

    await excludeLocalConfigFromSync(storeDir);

    const tracked = await trackedFiles(storeDir);
    expect(tracked).not.toContain('config.json');
    expect(tracked).not.toContain('read-state.json');
    expect(tracked).toContain('FLUX-1.md'); // ticket data still synced
    expect(tracked).toContain('.gitignore');
    // The local files are preserved on disk (settings kept).
    expect(existsSync(path.join(storeDir, 'config.json'))).toBe(true);
    expect(existsSync(path.join(storeDir, 'read-state.json'))).toBe(true);
    // And the .gitignore lists them.
    const gi = await fs.readFile(path.join(storeDir, '.gitignore'), 'utf8');
    expect(gi).toContain('config.json');
    expect(gi).toContain('read-state.json');
  });

  it('keeps config.json out of a subsequent `git add -A` sync commit', async () => {
    await fs.writeFile(path.join(storeDir, 'config.json'), '{"a":1}', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'init store']);
    await excludeLocalConfigFromSync(storeDir);

    // A later local settings change must not show up as a syncable change.
    await fs.writeFile(path.join(storeDir, 'config.json'), '{"a":2}', 'utf8');
    await git(storeDir, ['add', '-A']);
    const { stdout: status } = await git(storeDir, ['status', '--porcelain']);
    expect(status).not.toContain('config.json');
  });

  it('is idempotent — a second run makes no new commit', async () => {
    await fs.writeFile(path.join(storeDir, 'config.json'), '{}', 'utf8');
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), '# t\n', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'init store']);

    await excludeLocalConfigFromSync(storeDir);
    const { stdout: firstHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    await excludeLocalConfigFromSync(storeDir);
    const { stdout: secondHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    expect(secondHead.trim()).toBe(firstHead.trim());
  });

  it('seeds the .gitignore even when config.json was never tracked', async () => {
    // Fresh store: config present on disk but never committed.
    await fs.writeFile(path.join(storeDir, 'config.json'), '{}', 'utf8');
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), '# t\n', 'utf8');
    await git(storeDir, ['add', 'FLUX-1.md']);
    await git(storeDir, ['commit', '-m', 'tickets only']);

    await excludeLocalConfigFromSync(storeDir);

    const gi = await fs.readFile(path.join(storeDir, '.gitignore'), 'utf8');
    expect(gi).toContain('config.json');
    expect(await trackedFiles(storeDir)).not.toContain('config.json');
  });
});

describe('storage-sync — union-merge attribute for transcripts (FLUX-1076)', () => {
  let repo: string;
  let storeDir: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-sync-'));
    await git(repo, ['init', '-b', 'master']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'init']);

    storeDir = path.join(repo, '.flux-store');
    await git(repo, ['worktree', 'add', '--orphan', '-b', 'flux-data', storeDir]);
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), '# ticket\n', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'init store']);
  });

  afterEach(async () => {
    await git(repo, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('seeds .gitattributes with a union-merge rule for transcripts/*.jsonl and commits it', async () => {
    await ensureUnionMergeAttributes(storeDir);

    const ga = await fs.readFile(path.join(storeDir, '.gitattributes'), 'utf8');
    expect(ga).toContain('transcripts/*.jsonl merge=union');
    expect(await trackedFiles(storeDir)).toContain('.gitattributes');
  });

  it('is idempotent — a second run makes no new commit', async () => {
    await ensureUnionMergeAttributes(storeDir);
    const { stdout: firstHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    await ensureUnionMergeAttributes(storeDir);
    const { stdout: secondHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    expect(secondHead.trim()).toBe(firstHead.trim());
  });

  it('preserves pre-existing .gitattributes content', async () => {
    await fs.writeFile(path.join(storeDir, '.gitattributes'), '*.png binary\n', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'pre-existing attributes']);

    await ensureUnionMergeAttributes(storeDir);

    const ga = await fs.readFile(path.join(storeDir, '.gitattributes'), 'utf8');
    expect(ga).toContain('*.png binary');
    expect(ga).toContain('transcripts/*.jsonl merge=union');
  });
});

describe('storage-sync — sync-protocol marker seeding (FLUX-1426)', () => {
  let repo: string;
  let storeDir: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-sync-'));
    await git(repo, ['init', '-b', 'master']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'init']);

    storeDir = path.join(repo, '.flux-store');
    await git(repo, ['worktree', 'add', '--orphan', '-b', 'flux-data', storeDir]);
    await fs.writeFile(path.join(storeDir, 'FLUX-1.md'), '# ticket\n', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'init store']);
  });

  afterEach(async () => {
    await git(repo, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('seeds a sync-protocol marker with the supported version and commits it', async () => {
    await ensureSyncProtocolMarker(storeDir);

    const marker = await fs.readFile(path.join(storeDir, 'sync-protocol'), 'utf8');
    expect(marker.trim()).toBe(String(SUPPORTED_SYNC_PROTOCOL));
    expect(await trackedFiles(storeDir)).toContain('sync-protocol');
  });

  it('is idempotent — a second run makes no new commit', async () => {
    await ensureSyncProtocolMarker(storeDir);
    const { stdout: firstHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    await ensureSyncProtocolMarker(storeDir);
    const { stdout: secondHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    expect(secondHead.trim()).toBe(firstHead.trim());
  });

  it('never overwrites an existing (e.g. bumped) marker', async () => {
    await fs.writeFile(path.join(storeDir, 'sync-protocol'), '99\n', 'utf8');
    await git(storeDir, ['add', '-A']);
    await git(storeDir, ['commit', '-m', 'protocol bump']);

    await ensureSyncProtocolMarker(storeDir);

    const marker = await fs.readFile(path.join(storeDir, 'sync-protocol'), 'utf8');
    expect(marker.trim()).toBe('99');
  });
});

describe('migrateToOrphan — idempotent retry after a partial failure (FLUX-297)', () => {
  let repo: string;
  let storeDir: string;
  let fluxDir: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-migrate-'));
    await git(repo, ['init', '-b', 'master']);
    await git(repo, ['config', 'user.email', 'test@test.com']);
    await git(repo, ['config', 'user.name', 'Test']);
    fluxDir = path.join(repo, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    await fs.writeFile(path.join(fluxDir, 'FLUX-1.md'), '# ticket\n', 'utf8');
    await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'init']);
    storeDir = path.join(repo, '.flux-store');
  });

  afterEach(async () => {
    await git(repo, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('converges when .flux-store is a stray leftover (not a real worktree) instead of erroring', async () => {
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(path.join(storeDir, 'stray.txt'), 'leftover from a previous crash', 'utf8');

    await migrateToOrphan(repo);

    expect(existsSync(path.join(storeDir, '.git'))).toBe(true);
    expect(await trackedFiles(storeDir)).toContain('FLUX-1.md');
    expect(existsSync(path.join(fluxDir, 'FLUX-1.md'))).toBe(false);
  });

  it('resumes when .flux-store is attached but unborn (crashed before the first commit)', async () => {
    // Simulate a crash right after `worktree add --orphan` succeeded, before any files were
    // moved in or committed.
    await git(repo, ['worktree', 'add', '--orphan', '-b', 'flux-data', storeDir]);

    await migrateToOrphan(repo);

    const { stdout } = await git(storeDir, ['log', '--oneline']);
    expect(stdout.trim()).not.toBe('');
    expect(existsSync(path.join(storeDir, 'FLUX-1.md'))).toBe(true);
    expect(existsSync(path.join(fluxDir, 'FLUX-1.md'))).toBe(false);
  });

  it('converges (does not silently no-op) when .flux-store is on the fallback path with only the init commit (FLUX-1410)', async () => {
    // Simulate the pre-2.42 plumbing fallback (`addOrphanWorktree`'s fallback branch in
    // git-worktree.ts): it commits a root commit immediately when creating the branch, unlike
    // the modern `--orphan` path which leaves HEAD unborn until the caller's own first commit.
    // A crash right after that fallback returns — before any ticket files have moved — leaves
    // exactly this state: an attached worktree on `flux-data` with a resolvable HEAD, but no
    // migrated content.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-empty-tree-'));
    const emptyFile = path.join(tmpDir, 'empty');
    await fs.writeFile(emptyFile, '');
    const { stdout: treeSha } = await git(repo, ['hash-object', '-t', 'tree', '-w', emptyFile]);
    await fs.rm(tmpDir, { recursive: true, force: true });
    const { stdout: commitSha } = await git(repo, ['commit-tree', treeSha.trim(), '-m', 'flux: init flux-data']);
    await git(repo, ['branch', 'flux-data', commitSha.trim()]);
    await git(repo, ['worktree', 'add', storeDir, 'flux-data']);

    // Sanity-check the simulated pre-condition: worktree on-branch with a resolvable HEAD, but
    // the ticket file is still sitting un-migrated in .flux/.
    expect(existsSync(path.join(fluxDir, 'FLUX-1.md'))).toBe(true);
    const { stdout: preHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    expect(preHead.trim()).not.toBe('');

    await migrateToOrphan(repo);

    expect(existsSync(path.join(storeDir, 'FLUX-1.md'))).toBe(true);
    expect(existsSync(path.join(fluxDir, 'FLUX-1.md'))).toBe(false);
    const { stdout: log } = await git(storeDir, ['log', '--format=%s']);
    expect(log).toContain('flux: migrate tickets to orphan branch');
  });

  it('is a no-op when .flux-store is already fully migrated', async () => {
    await migrateToOrphan(repo);
    const { stdout: firstHead } = await git(storeDir, ['rev-parse', 'HEAD']);

    await migrateToOrphan(repo);
    const { stdout: secondHead } = await git(storeDir, ['rev-parse', 'HEAD']);

    expect(secondHead.trim()).toBe(firstHead.trim());
  });
});

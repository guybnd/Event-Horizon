import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { excludeLocalConfigFromSync, ensureUnionMergeAttributes } from './storage-sync.js';

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

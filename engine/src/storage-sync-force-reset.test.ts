// FLUX-1232 — forceResetToRemote() is the "my local board state is disposable — just match
// remote" escape hatch. Tested against real git repos (temp bare origin + a local clone standing
// in for .flux-store), mirroring sync-watcher.test.ts's style, since the primitive's whole job is
// a specific sequence of real git operations (tag, fetch, reset --hard, clean) that a mocked
// execFile can't meaningfully verify.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { forceResetToRemote, STORE_LOCAL_IGNORES } from './storage-sync.js';
import { getSyncStatus, isSyncUnhealthy, reportDivergedStatus, _resetSyncStateForTests, SUPPORTED_SYNC_PROTOCOL, SYNC_PROTOCOL_MARKER_FILE } from './sync-watcher.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

describe('forceResetToRemote — force-reset-to-remote escape hatch (FLUX-1232)', () => {
  let remote: string;   // bare origin holding flux-data
  let storeDir: string; // local flux-data clone (stands in for .flux-store)

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');

  async function commitAll(dir: string, msg: string) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', msg]);
  }

  beforeEach(async () => {
    _resetSyncStateForTests();

    remote = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-remote-'));
    await git(remote, ['init', '--bare', '-b', 'flux-data']);

    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-seed-'));
    await git(seed, ['init', '-b', 'flux-data']);
    await git(seed, ['config', 'user.email', 'seed@test.com']);
    await git(seed, ['config', 'user.name', 'Seed']);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(seed, TICKET), baseContent, 'utf8');
    // Seed the same .gitignore/.gitattributes/sync-protocol-marker entries a real migrated store
    // already carries, so forceResetToRemote's idempotent post-attach steps
    // (excludeLocalConfigFromSync, ensureUnionMergeAttributes, ensureSyncProtocolMarker) are true
    // no-ops here, not a self-healing commit on top of the reset — matching the ticket's actual
    // scenario (an already-migrated store diverging). Built FROM STORE_LOCAL_IGNORES (not
    // hand-duplicated) so this fixture can't silently drift stale again the next time an entry is
    // added there (FLUX-1581 — that drift, missing boot-index.json/*.body-history.json, is exactly
    // what broke this test: excludeLocalConfigFromSync saw them "missing" and added a real
    // self-healing commit, so `newHead` no longer matched the pre-reset remote head).
    await fs.writeFile(path.join(seed, '.gitignore'), STORE_LOCAL_IGNORES.join('\n') + '\n', 'utf8');
    await fs.writeFile(path.join(seed, '.gitattributes'), 'transcripts/*.jsonl merge=union\n', 'utf8');
    await fs.writeFile(path.join(seed, SYNC_PROTOCOL_MARKER_FILE), `${SUPPORTED_SYNC_PROTOCOL}\n`, 'utf8');
    await commitAll(seed, 'seed ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    for (const d of [remote, storeDir]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('throws when the store dir is not an orphan-mode worktree', async () => {
    const missing = path.join(os.tmpdir(), 'eh-nonexistent-store-does-not-exist');
    await expect(forceResetToRemote(missing)).rejects.toThrow(/not in orphan mode/i);
  });

  it('hard-resets local-only commits to match origin/flux-data, tagging a recoverable backup', async () => {
    // Local diverges: an un-pushed local commit that must be discarded.
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
    await commitAll(storeDir, 'local: wip status change');
    const oldHeadExpected = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    // Remote moves ahead too, from a second clone (a genuine divergence).
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, TICKET), baseContent.replace('status: Todo', 'status: Done'), 'utf8');
    await commitAll(other, 'other machine: status Done');
    await git(other, ['push', 'origin', 'flux-data']);
    const remoteHeadExpected = (await git(other, ['rev-parse', 'HEAD'])).stdout.trim();
    await fs.rm(other, { recursive: true, force: true }).catch(() => {});

    const result = await forceResetToRemote(storeDir);

    expect(result.oldHead).toBe(oldHeadExpected);
    expect(result.newHead).toBe(remoteHeadExpected);
    expect(result.backupRef).toMatch(/^flux-data-backup-/);
    expect(result.changedFiles).toContain(TICKET);

    // The worktree now exactly matches origin/flux-data — no leftover unmerged/conflicted state.
    // (scaffoldModuleDirs may leave an untracked module dir behind, same as every other startup
    // attach path — that's not what this test is verifying.)
    const headAfter = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headAfter).toBe(remoteHeadExpected);
    const unmerged = (await git(storeDir, ['diff', '--name-only', '--diff-filter=U'])).stdout;
    expect(unmerged.trim()).toBe('');
    const content = (await git(storeDir, ['show', `HEAD:${TICKET}`])).stdout;
    expect(content).toContain('status: Done');

    // The discarded local commit is recoverable via the backup tag.
    const tagged = (await git(storeDir, ['rev-parse', result.backupRef])).stdout.trim();
    expect(tagged).toBe(oldHeadExpected);
  }, 30_000);

  it('drops untracked leftovers but preserves gitignored local-only files (config.json)', async () => {
    // A stray untracked file (e.g. a half-written diff from an aborted merge).
    await fs.writeFile(path.join(storeDir, 'stray.diff'), 'leftover', 'utf8');
    // A gitignored local-only file that must survive the reset untouched.
    await fs.writeFile(path.join(storeDir, '.gitignore'), 'config.json\n', 'utf8');
    await fs.writeFile(path.join(storeDir, 'config.json'), '{"local":true}', 'utf8');

    await forceResetToRemote(storeDir);

    await expect(fs.access(path.join(storeDir, 'stray.diff'))).rejects.toThrow();
    const preserved = await fs.readFile(path.join(storeDir, 'config.json'), 'utf8');
    expect(preserved).toBe('{"local":true}');
  }, 30_000);

  it('clears a stale conflict/diverged sync status after resetting', async () => {
    reportDivergedStatus(3, 5);
    expect(getSyncStatus().state).toBe('diverged');
    expect(isSyncUnhealthy()).toBe(true);

    await forceResetToRemote(storeDir);

    expect(getSyncStatus().state).toBe('synced');
    expect(isSyncUnhealthy()).toBe(false);
  }, 30_000);

  it('refuses to run while a sync/resolution already holds the lock (FLUX-989)', async () => {
    // resolveConflicts() acquires the same lock and throws synchronously when there is nothing
    // pending — easiest way to hold it deterministically is to race two calls, but here we just
    // assert the mutual-exclusion contract via a manual pending conflict + concurrent call.
    const first = forceResetToRemote(storeDir);
    await expect(forceResetToRemote(storeDir)).rejects.toThrow(/sync is currently in progress/i);
    await first;
  }, 30_000);
});

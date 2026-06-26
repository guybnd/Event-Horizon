import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { syncDefaultBranch } from './pr-cleanup.js';
import { clearNotifications, getNotifications } from './notifications.js';

const execFileAsync = promisify(execFile);

// These cases perform real git ops (init/clone/fetch/push to a local bare remote), which are
// slow on Windows under parallel suite load — vitest's default 5000ms testTimeout intermittently
// overruns when the full engine suite runs concurrently (FLUX-749). Raise it file-wide so the
// dirty-root backstop tests don't flake the `check` gate (mirrors group-integration.test.ts).
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-741 AC1 — the dirty-ROOT backstop. The engine-driven post-merge sync fast-forwards
// the main tree in place; a fast-forward that would overwrite a locally-modified file aborts
// (`git merge --ff-only`) — so WITHOUT the backstop the engine either can't sync or, in the
// FLUX-734/739 incident, the surrounding switch discarded the uncommitted root edits.
// stashDirtyTree (wired into syncDefaultBranch/cleanupMergedBranch) stashes the dirty work
// FIRST, so the sync proceeds AND nothing is lost — the work stays recoverable in a stash.
// Built against a real temp repo + bare origin (mirrors branch-manager.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

async function gitC(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

let tmp: string;
let repo: string;
let origin: string;

beforeEach(async () => {
  clearNotifications();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-pr-cleanup-'));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });

  await execFileAsync('git', ['init', '--bare', origin], { windowsHide: true });
  await gitC(repo, ['init', '-b', 'master']);
  await gitC(repo, ['config', 'user.email', 'test@test.com']);
  await gitC(repo, ['config', 'user.name', 'Test']);
  await gitC(repo, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(repo, 'feat.txt'), 'v1\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'init']);
  await gitC(repo, ['remote', 'add', 'origin', origin]);
  await gitC(repo, ['push', '-u', 'origin', 'master']);

  setWorkspaceRoot(repo);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Push an extra commit to origin/master that MODIFIES feat.txt, so a clean repo is behind. */
async function advanceOrigin(): Promise<void> {
  const work = path.join(tmp, 'work');
  await execFileAsync('git', ['clone', origin, work], { windowsHide: true });
  await gitC(work, ['config', 'user.email', 'test@test.com']);
  await gitC(work, ['config', 'user.name', 'Test']);
  await gitC(work, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(work, 'feat.txt'), 'v-origin\n', 'utf8');
  await gitC(work, ['commit', '-am', 'origin advances feat.txt']);
  await gitC(work, ['push', 'origin', 'master']);
}

describe('syncDefaultBranch dirty-root backstop (FLUX-741)', () => {
  it('syncs a behind master WITHOUT losing a conflicting uncommitted root edit', async () => {
    await advanceOrigin();
    // Local root (on master) is now behind origin AND dirty on the very file the incoming
    // commit changes — the case a plain `merge --ff-only` refuses (would overwrite).
    await fs.writeFile(path.join(repo, 'feat.txt'), 'v2-uncommitted\n', 'utf8');

    const ok = await syncDefaultBranch(repo);

    // The sync proceeded (the backstop unblocked it)...
    expect(ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'feat.txt'), 'utf8')).toContain('v-origin');
    // ...and the dirty edit was NOT discarded — it's preserved in a recoverable stash.
    const stashList = await gitC(repo, ['stash', 'list']);
    expect(stashList).toContain('EH pre-sync');
    const stashDiff = await gitC(repo, ['stash', 'show', '-p', 'stash@{0}']);
    expect(stashDiff).toContain('v2-uncommitted');
    // The user is told where the work went.
    const note = getNotifications().find((n) => n.title === 'Uncommitted root changes stashed');
    expect(note).toBeTruthy();
    expect(note!.message).toContain('git stash apply');
  });

  it('is a clean no-op (no stash, no notification) when the root tree is clean', async () => {
    await advanceOrigin();

    const ok = await syncDefaultBranch(repo);

    expect(ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'feat.txt'), 'utf8')).toContain('v-origin');
    expect(await gitC(repo, ['stash', 'list'])).toBe('');
    expect(getNotifications().find((n) => n.title === 'Uncommitted root changes stashed')).toBeUndefined();
  });
});

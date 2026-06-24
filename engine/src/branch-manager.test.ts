import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { deleteTicketBranch } from './branch-manager.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-591 — deleteTicketBranch was made idempotent + remote-independent in FLUX-588:
//   • skip `git branch -d/-D` when the local ref is already gone (a merged branch is
//     force-deleted by post-merge cleanup, so a LATER delete_branch must not throw), and
//   • attempt the remote `push --delete` REGARDLESS of the local outcome.
// Built against a real temp repo + bare `origin` (mirrors baseline-commit.test.ts), so the
// remote delete is actually exercised rather than mocked.
// ─────────────────────────────────────────────────────────────────────────────

async function gitC(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

const BRANCH = 'flux/FLUX-591-test-branch';

let tmp: string;
let repo: string;
let origin: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-branch-mgr-'));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });

  await execFileAsync('git', ['init', '--bare', origin], { windowsHide: true });
  await gitC(repo, ['init', '-b', 'master']);
  await gitC(repo, ['config', 'user.email', 'test@test.com']);
  await gitC(repo, ['config', 'user.name', 'Test']);
  await gitC(repo, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'init']);
  await gitC(repo, ['remote', 'add', 'origin', origin]);
  await gitC(repo, ['push', '-u', 'origin', 'master']);

  setWorkspaceRoot(repo);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function localBranchExists(name: string): Promise<boolean> {
  return (await gitC(repo, ['branch', '--list', name])).length > 0;
}

async function remoteBranchExists(name: string): Promise<boolean> {
  return (await gitC(repo, ['ls-remote', '--heads', 'origin', name])).length > 0;
}

describe('deleteTicketBranch', () => {
  it('is idempotent when the local branch is already gone — does not throw, and still deletes the remote ref', async () => {
    await gitC(repo, ['branch', BRANCH, 'master']);
    await gitC(repo, ['push', 'origin', BRANCH]);
    // Simulate post-merge cleanup having already force-deleted the local ref (FLUX-588).
    await gitC(repo, ['branch', '-D', BRANCH]);
    expect(await localBranchExists(BRANCH)).toBe(false);
    expect(await remoteBranchExists(BRANCH)).toBe(true);

    await expect(deleteTicketBranch(BRANCH, true)).resolves.toBeUndefined();

    // The remote delete is attempted regardless of the (skipped) local delete, and lands.
    expect(await remoteBranchExists(BRANCH)).toBe(false);
  });

  it('deletes both the local and remote branch when present', async () => {
    await gitC(repo, ['branch', BRANCH, 'master']);
    await gitC(repo, ['push', 'origin', BRANCH]);

    await deleteTicketBranch(BRANCH, true);

    expect(await localBranchExists(BRANCH)).toBe(false);
    expect(await remoteBranchExists(BRANCH)).toBe(false);
  });

  it('swallows a missing remote ref (best-effort) — no throw when neither local nor remote exists', async () => {
    // Branch never created anywhere: local absent → skipped; remote `push --delete` errors → swallowed.
    await expect(deleteTicketBranch(BRANCH, true)).resolves.toBeUndefined();
  });

  it('non-force delete of an unmerged branch rethrows (the "refuses unmerged" safety the caller wants)', async () => {
    await gitC(repo, ['branch', BRANCH, 'master']);
    await gitC(repo, ['checkout', BRANCH]);
    await fs.writeFile(path.join(repo, 'feature.txt'), 'wip\n', 'utf8');
    await gitC(repo, ['add', '.']);
    await gitC(repo, ['commit', '-m', 'unmerged work']);
    await gitC(repo, ['checkout', 'master']);

    await expect(deleteTicketBranch(BRANCH, false)).rejects.toThrow();
    // The refused `-d` leaves the local branch intact (no data loss).
    expect(await localBranchExists(BRANCH)).toBe(true);
  });
});

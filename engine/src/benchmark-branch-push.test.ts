// FLUX-1739: `createTicketBranch({ push: false })` — a benchmark run's branch is LOCAL-ONLY.
//
// Without this, a 45-cell suite pushes 45 throwaway branches to `origin` and puts a network
// round-trip in the runner's hot path, for branches that exist only as the local record of what a
// configuration produced and are never merged. The default MUST stay `push: true` so no existing
// caller changes behavior — asserted here in the same test, since a silent flip of that default
// would be an invisible regression for every real ticket.
//
// Built against a real repo + bare origin (the branch-manager.test.ts pattern) so the push is
// genuinely exercised rather than mocked.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { createTicketBranch, getTicketBranchStatus } from './branch-manager.js';

const execFileAsync = promisify(execFile);

async function gitC(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

let tmp: string;
let repo: string;
let origin: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-bench-push-'));
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

describe('createTicketBranch push control', () => {
  it('creates the branch locally and does NOT push it when push:false', async () => {
    const name = await createTicketBranch('BENCH-1', 'benchmark run', 'master', { push: false });
    expect(await localBranchExists(name)).toBe(true);
    expect(await remoteBranchExists(name)).toBe(false);
  });

  it('still pushes by default — every existing caller is unchanged', async () => {
    const name = await createTicketBranch('FLUX-1', 'ordinary ticket', 'master');
    expect(await localBranchExists(name)).toBe(true);
    expect(await remoteBranchExists(name)).toBe(true);
  });

  it('pushes when push:true is passed explicitly', async () => {
    const name = await createTicketBranch('FLUX-2', 'explicit push', 'master', { push: true });
    expect(await remoteBranchExists(name)).toBe(true);
  });

  it('accepts a raw commit SHA as the base — a suite pins to a commit, never a moving branch', async () => {
    const sha = await gitC(repo, ['rev-parse', 'HEAD']);
    const name = await createTicketBranch('BENCH-2', 'pinned run', sha, { push: false });
    expect(await gitC(repo, ['rev-parse', name])).toBe(sha);
    expect(await remoteBranchExists(name)).toBe(false);
  });
});

// FLUX-1792: a repo with no `origin` remote (the gauntlet board) — the default push must not throw and
// abort the session launch; the branch is created locally.
describe('createTicketBranch on a repo with no origin remote', () => {
  it('creates the branch locally and skips the push instead of throwing', async () => {
    await gitC(repo, ['remote', 'remove', 'origin']);
    const name = await createTicketBranch('EHG-1', 'no remote', 'master');
    expect(await localBranchExists(name)).toBe(true);
  });
});

// FLUX-1796: the commit-before-Ready guard on a `main`-only repo with no remote read 0 commits ahead,
// because the default branch fell back to a non-existent 'master'.
describe('getTicketBranchStatus on a main-only repo with no remote', () => {
  it('counts the branch commits against the local main', async () => {
    await gitC(repo, ['remote', 'remove', 'origin']);
    await gitC(repo, ['branch', '-m', 'master', 'main']);
    const name = await createTicketBranch('EHG-2', 'main only', 'main');
    await gitC(repo, ['checkout', '-q', name]);
    await fs.writeFile(path.join(repo, 'x.txt'), 'x', 'utf8');
    await gitC(repo, ['add', '.']);
    await gitC(repo, ['commit', '-q', '-m', 'work']);
    await gitC(repo, ['checkout', '-q', 'main']);
    expect((await getTicketBranchStatus(name)).aheadCount).toBe(1);
  });
});


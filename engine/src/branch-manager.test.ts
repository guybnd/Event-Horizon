import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { deleteTicketBranch, planFinishPr, checkGhAuth, type PrStatus } from './branch-manager.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-741 — planFinishPr: finish must never merge onto a DEAD (MERGED/CLOSED) PR.
// Incident FLUX-656: a commit pushed after a PR merged hit `gh pr merge` on the dead PR,
// which throws "already merged" and strands the commit. planFinishPr opens a fresh PR for
// any non-OPEN (or absent) PR, and routes a 0-commits-ahead branch to Require Input instead.
// Pure: deps are injected, so no gh/git is exercised here.
// ─────────────────────────────────────────────────────────────────────────────

function prStatus(state: string): PrStatus {
  return {
    number: 7,
    state,
    url: `https://example.test/pr/7`,
    title: 'old',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
  };
}

describe('planFinishPr (FLUX-741 / FLUX-656)', () => {
  const ahead = async () => ({ exists: true, aheadCount: 2, behindCount: 0 });
  const noneAhead = async () => ({ exists: true, aheadCount: 0, behindCount: 0 });

  it('reuses an OPEN PR (no fresh PR opened)', async () => {
    let created = false;
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => prStatus('OPEN'),
      getBranchStatus: ahead,
      createPr: async () => { created = true; return 'new'; },
    });
    expect(plan.action).toBe('reuse');
    expect(plan.url).toBe('https://example.test/pr/7');
    expect(created).toBe(false);
  });

  it('opens a FRESH PR when the prior PR is MERGED (the FLUX-656 dead-PR case)', async () => {
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => prStatus('MERGED'),
      getBranchStatus: ahead,
      createPr: async (b, t) => `https://example.test/pr/new?${b}-${t}`,
    });
    expect(plan.action).toBe('created');
    expect(plan.url).toContain('pr/new');
  });

  it('opens a FRESH PR when the prior PR is CLOSED', async () => {
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => prStatus('CLOSED'),
      getBranchStatus: ahead,
      createPr: async () => 'https://example.test/pr/new',
    });
    expect(plan.action).toBe('created');
  });

  it('opens a FRESH PR when there is no PR at all but the branch has commits', async () => {
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => null,
      getBranchStatus: ahead,
      createPr: async () => 'https://example.test/pr/new',
    });
    expect(plan.action).toBe('created');
  });

  it('blocks (→ Require Input) a MERGED PR whose branch has no new commits ahead', async () => {
    let created = false;
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => prStatus('MERGED'),
      getBranchStatus: noneAhead,
      createPr: async () => { created = true; return 'new'; },
    });
    expect(plan.action).toBe('blocked');
    expect(plan.reason).toMatch(/MERGED/);
    expect(created).toBe(false); // never opens an empty PR
  });

  it('blocks when there is no PR and no commits yet', async () => {
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => null,
      getBranchStatus: noneAhead,
      createPr: async () => 'new',
    });
    expect(plan.action).toBe('blocked');
    expect(plan.reason).toMatch(/no commits/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-998 regression — checkGhAuth() MUST NOT go through the runner's default
// (buildGitSyncEnv()) env-building path. buildGitSyncEnv() itself calls checkGhAuth() to decide
// whether to inject gh's credential helper, so routing checkGhAuth's own probe through that same
// path recurses infinitely: buildGitSyncEnv → checkGhAuth → runGh → buildGitSyncEnv → … This was
// hit live while routing this module through the S1 runner (a real RangeError: Maximum call stack
// size exceeded, surfaced as this exact test timing out). checkGhAuth's runGh call MUST pass an
// explicit `env` override to opt out of buildGitSyncEnv() — see git-exec.ts's GitExecOptions.env
// and branch-manager.ts's checkGhAuth for the fix + full explanation.
// ─────────────────────────────────────────────────────────────────────────────
describe('checkGhAuth (FLUX-998: must not recurse through buildGitSyncEnv)', () => {
  it('resolves to a boolean promptly — does not hang/stack-overflow via buildGitSyncEnv', async () => {
    // Whether `gh` is installed/authed in the test environment is irrelevant here; the invariant
    // under test is "this returns, at all" — a reintroduced recursion bug would time this out.
    await expect(checkGhAuth()).resolves.toEqual(expect.any(Boolean));
    // Per-test timeout raised above runGh's own 60s ceiling: when `gh` is installed and authed,
    // `gh auth status` makes a network round-trip to github.com to validate the token, which on a
    // slow/congested CI network can exceed vitest's default 5s and flake this test. 65s comfortably
    // clears runGh's 60s worst case so a false timeout can't masquerade as a recursion regression.
  }, 65_000);
});

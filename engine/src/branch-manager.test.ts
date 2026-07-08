import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { deleteTicketBranch, planFinishPr, checkGhAuth, isMergeConflict, type PrStatus } from './branch-manager.js';

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

  it('FLUX-1231: a branch still held by a worktree is a tolerated force-delete failure — resolves, still deletes the remote, and logs at debug (one line, no raw git stderr) rather than warn', async () => {
    await gitC(repo, ['branch', BRANCH, 'master']);
    await gitC(repo, ['push', 'origin', BRANCH]);
    // A worktree checks out the branch → a local `git branch -D` is guaranteed to fail with
    // git's "cannot delete branch '…' used by worktree at '…'" — the case this ticket quiets.
    const wt = path.join(tmp, 'held-worktree');
    await gitC(repo, ['worktree', 'add', wt, BRANCH]);
    expect(await localBranchExists(BRANCH)).toBe(true);

    // Capture the real diagnostic surface: both `log.*` (log.ts) and `console.warn` write to
    // process.stderr, so intercepting it catches whatever this actually logs — no reliance on
    // module-singleton spying (the `log` instance the test imports isn't the one the source uses).
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await expect(deleteTicketBranch(BRANCH, true)).resolves.toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
    const logged = stderr.join('');

    // Tolerated: the worktree still holds the local branch, but the remote ref is still cleaned.
    expect(await localBranchExists(BRANCH)).toBe(true);
    expect(await remoteBranchExists(BRANCH)).toBe(false);
    // Quieted: no raw multi-line git stderr, no warn-level line — just a terse debug line.
    expect(logged).not.toMatch(/error: cannot delete branch/i);
    expect(logged).not.toContain('[warn]');
    expect(logged).not.toContain('forced local delete');
    expect(logged).toMatch(/\[debug\].*deferred local delete/i);
    expect(logged).toContain(BRANCH);
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

function prStatus(state: string, headRefName = 'flux/x'): PrStatus {
  return {
    number: 7,
    state,
    url: `https://example.test/pr/7`,
    title: 'old',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: { total: 0, passed: 0, failed: 0, pending: 0 },
    headRefName,
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
// FLUX-944 — the empty-branch guard is a false positive for a ticket whose deliverable was
// deliberately folded onto a SIBLING ticket's branch/PR instead of its own (the fold-together
// pattern). planFinishPr auto-detects this from the caller-supplied implementationLink: if it
// already points at a MERGED PR on a *different* branch, finish should proceed (`folded`), not
// block. A non-folded empty branch (no such link, or the link isn't actually merged/is this same
// branch) must still be blocked exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

describe('planFinishPr — folded-sibling auto-detect (FLUX-944)', () => {
  const noneAhead = async () => ({ exists: true, aheadCount: 0, behindCount: 0 });

  it('folds when implementationLink points at a MERGED PR on a different branch', async () => {
    const seen: string[] = [];
    const plan = await planFinishPr(
      'flux/x',
      'T',
      'B',
      {
        getStatus: async (selector) => {
          seen.push(selector);
          if (selector === 'flux/x') return null; // no PR of its own
          return prStatus('MERGED', 'flux/sibling');
        },
        getBranchStatus: noneAhead,
        createPr: async () => { throw new Error('must not open a PR for a folded ticket'); },
      },
      'https://example.test/pr/99',
    );
    expect(plan.action).toBe('folded');
    expect(plan.url).toBe('https://example.test/pr/99');
    expect(seen).toContain('https://example.test/pr/99');
  });

  it('does NOT fold when the linked PR is still OPEN', async () => {
    const plan = await planFinishPr(
      'flux/x',
      'T',
      'B',
      {
        getStatus: async (selector) => (selector === 'flux/x' ? null : prStatus('OPEN', 'flux/sibling')),
        getBranchStatus: noneAhead,
        createPr: async () => 'new',
      },
      'https://example.test/pr/99',
    );
    expect(plan.action).toBe('blocked');
  });

  it('does NOT fold when the linked PR is on this ticket\'s OWN branch (not a sibling)', async () => {
    const plan = await planFinishPr(
      'flux/x',
      'T',
      'B',
      {
        getStatus: async () => prStatus('MERGED', 'flux/x'),
        getBranchStatus: noneAhead,
        createPr: async () => 'new',
      },
      'https://example.test/pr/7',
    );
    expect(plan.action).toBe('blocked');
  });

  it('does NOT fold when no implementationLink is supplied', async () => {
    const plan = await planFinishPr('flux/x', 'T', 'B', {
      getStatus: async () => null,
      getBranchStatus: noneAhead,
      createPr: async () => 'new',
    });
    expect(plan.action).toBe('blocked');
  });

  it('is irrelevant when the branch has commits ahead (folding never overrides real work)', async () => {
    const ahead = async () => ({ exists: true, aheadCount: 1, behindCount: 0 });
    let created = false;
    const plan = await planFinishPr(
      'flux/x',
      'T',
      'B',
      {
        getStatus: async (selector) => (selector === 'flux/x' ? null : prStatus('MERGED', 'flux/sibling')),
        getBranchStatus: ahead,
        createPr: async () => { created = true; return 'https://example.test/pr/new'; },
      },
      'https://example.test/pr/99',
    );
    expect(plan.action).toBe('created');
    expect(created).toBe(true);
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

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-1104 — isMergeConflict(): follow-up from FLUX-986's review, which shipped this heuristic
// with zero test coverage and flagged (but didn't resolve) that "not mergeable" text is not
// conflict-specific. Confirmed via real `gh pr merge` behavior (cli/cli#7518, cli/cli#12773):
// checks-failed/branch-protection merges say "is not mergeable: the base branch policy prohibits
// the merge" — the exact same "not mergeable" wording a real conflict uses — so the heuristic was
// tightened to drop the bare "not mergeable"/"mergeable state" match in favor of phrases that are
// actually specific to a conflicting merge state.
// ─────────────────────────────────────────────────────────────────────────────

function execErr(message: string, stderr = ''): Error & { stderr?: string } {
  const err = new Error(message) as Error & { stderr?: string };
  if (stderr) err.stderr = stderr;
  return err;
}

describe('isMergeConflict (FLUX-1104)', () => {
  it('detects a literal CONFLICT marker', () => {
    expect(isMergeConflict(execErr('git merge failed', 'CONFLICT (content): Merge conflict in foo.ts'))).toBe(true);
  });

  it('detects gh\'s "has conflicts and isn\'t mergeable" phrasing', () => {
    expect(isMergeConflict(execErr("Pull request #124 has conflicts and isn't mergeable."))).toBe(true);
  });

  it('detects gh\'s "cannot be cleanly created" conflict phrasing (no literal "conflict" word)', () => {
    expect(isMergeConflict(execErr('is not mergeable: the merge commit cannot be cleanly created.'))).toBe(true);
  });

  it('detects the "could not be cleanly created" past-tense variant', () => {
    expect(isMergeConflict(execErr('is not mergeable: the merge commit could not be cleanly created.'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMergeConflict(execErr('MERGE CONFLICT in file.ts'))).toBe(true);
  });

  it.each([
    ['gh auth', execErr('gh auth login required before this action')],
    ['authentication', execErr('authentication failed for remote')],
    ['permission denied', execErr('permission denied (publickey)')],
    ['could not read username', execErr('fatal: could not read Username for https://github.com')],
    ['could not read password', execErr('fatal: could not read Password for https://github.com')],
  ])('returns false for an auth/permission signature: %s', (_label, err) => {
    expect(isMergeConflict(err)).toBe(false);
  });

  it('auth signature always wins even when conflict-like text is also present', () => {
    const err = execErr('gh auth: authentication failed', 'CONFLICT (content): Merge conflict in foo.ts');
    expect(isMergeConflict(err)).toBe(false);
  });

  // The false-positive risk flagged (but left unresolved) in FLUX-986's grooming — real gh output
  // for branch-protection/required-checks failures shares the generic "not mergeable" wording with
  // real conflicts, but never the conflict-specific phrases isMergeConflict now requires.
  it('does not flag a branch-protection "not mergeable" failure as a conflict', () => {
    const err = execErr('Pull request #1227 is not mergeable: the base branch policy prohibits the merge.');
    expect(isMergeConflict(err)).toBe(false);
  });

  it('does not flag a failing-required-check error as a conflict', () => {
    const err = execErr('GraphQL: Required status check "ci/test" is failing. (mergePullRequest)');
    expect(isMergeConflict(err)).toBe(false);
  });

  it('does not flag a bare generic "not mergeable" message with no conflict-specific wording', () => {
    const err = execErr('Pull request #42 is not mergeable at this time.');
    expect(isMergeConflict(err)).toBe(false);
  });

  it('does not flag an unrelated network error', () => {
    expect(isMergeConflict(execErr('connect ETIMEDOUT 140.82.112.3:443'))).toBe(false);
  });

  it('checks stderr in addition to message', () => {
    const err = execErr('gh: process exited with code 1', 'CONFLICT (content): Merge conflict in bar.ts');
    expect(isMergeConflict(err)).toBe(true);
  });

  it('handles a non-Error thrown value', () => {
    expect(isMergeConflict('CONFLICT (content): Merge conflict in foo.ts')).toBe(true);
    expect(isMergeConflict('authentication failed')).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isMergeConflict(null)).toBe(false);
    expect(isMergeConflict(undefined)).toBe(false);
  });
});

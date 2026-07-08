// FLUX-1270 — cleanupMergedBranch must NOT delete a branch that another OPEN PR still bases off.
//
// Root cause of the live incident this traces to (FLUX-861/FLUX-1265, 2026-07-07): FLUX-1265 opened
// its PR with `base: flux/FLUX-861-...` because the code it touched only existed on FLUX-861's still-
// open branch. When FLUX-861 later merged, `cleanupMergedBranch` deleted that branch without checking
// whether another open PR still based off it — GitHub auto-closed FLUX-1265's PR the instant the base
// ref disappeared, silently reverting it with no error surfaced anywhere. This pins the fix: before
// deleting, check for a dependent open PR (`getOpenPullRequestsWithBase`); if one exists, skip the
// delete and flag the dependent ticket(s) `swimlane: 'merge-conflict'` instead (the same swimlane +
// "Launch Rebase Session" CTA a real git conflict gets — generalized off PrDeckCard.tsx-only scoping,
// see MergeConflictBanner.tsx).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { cleanupMergedBranch, recheckDependentBranches, pruneMergedBranches } from './pr-cleanup.js';
import { tasksCache, createTask, updateTaskWithHistory } from './task-store.js';
import { clearNotifications } from './notifications.js';
import type { OpenPrOnBase } from './branch-manager.js';

const execFileAsync = promisify(execFile);

const getOpenPullRequestsWithBase = vi.fn(async (_branch: string): Promise<OpenPrOnBase[]> => []);
vi.mock('./branch-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./branch-manager.js')>();
  return {
    ...actual,
    getOpenPullRequestsWithBase: (branch: string) => getOpenPullRequestsWithBase(branch),
  };
});

// pruneMergedBranches' "recently-merged PR head refs" lookup shells `gh pr list --state merged`
// via runGh (git-exec.js) — mock only that call (importOriginal keeps runGit real, so every other
// git op in this suite's real temp repos is untouched).
const mergedPrHeadRefs = vi.hoisted(() => ({ refs: [] as string[] }));
vi.mock('./git-exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-exec.js')>();
  return {
    ...actual,
    runGh: (args: string[], opts?: unknown) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return Promise.resolve({ stdout: JSON.stringify(mergedPrHeadRefs.refs.map((headRefName) => ({ headRefName }))), stderr: '' });
      }
      return (actual.runGh as (a: string[], o?: unknown) => Promise<{ stdout: string; stderr: string }>)(args, opts);
    },
  };
});

async function gitC(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

let tmp: string;
let repo: string;
let origin: string;

beforeEach(async () => {
  clearNotifications();
  getOpenPullRequestsWithBase.mockReset();
  getOpenPullRequestsWithBase.mockResolvedValue([]);
  mergedPrHeadRefs.refs = [];
  for (const k of Object.keys(tasksCache)) delete tasksCache[k];

  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-pr-cleanup-dep-'));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });

  await execFileAsync('git', ['init', '--bare', '-b', 'master', origin], { windowsHide: true });
  await gitC(repo, ['init', '-b', 'master']);
  await gitC(repo, ['config', 'user.email', 'test@test.com']);
  await gitC(repo, ['config', 'user.name', 'Test']);
  await gitC(repo, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(repo, 'feat.txt'), 'v1\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'init']);
  await gitC(repo, ['remote', 'add', 'origin', origin]);
  await gitC(repo, ['push', '-u', 'origin', 'master']);
  await fs.mkdir(path.join(repo, '.flux'), { recursive: true });

  setWorkspaceRoot(repo);
});

afterEach(async () => {
  for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('cleanupMergedBranch — dependent-branch safety net (FLUX-1270)', () => {
  it('skips the branch delete and flags the dependent ticket merge-conflict when an open PR still bases off it', async () => {
    const followUp = await createTask({ title: 'Follow-up', status: 'In Progress' });
    // A real on-disk `branch` field — cleanupMergedBranch's dependent-ticket lookup reads the live
    // tasksCache, but the flagging write re-reads fresh frontmatter from disk, so `branch` must
    // actually be persisted (not just in-memory) to survive that round-trip.
    await updateTaskWithHistory(followUp.id, { updatedBy: 'Agent', extraFields: { branch: 'flux/followup' } });
    // Ticket markdown is normally tracked in git (the board IS the git history) — commit it so the
    // dirty-root backstop (`syncDefaultBranch`'s `stashDirtyTree`, unrelated to this fix) doesn't see
    // it as untracked work and stash it away before this test gets to assert on it.
    await gitC(repo, ['add', '-A']);
    await gitC(repo, ['commit', '-m', 'seed follow-up ticket']);

    getOpenPullRequestsWithBase.mockResolvedValue([
      { number: 434, url: 'https://github.com/acme/repo/pull/434', title: 'Follow-up PR', headRefName: 'flux/followup' },
    ]);

    const result = await cleanupMergedBranch(repo, 'flux/FLUX-861-parent', { auto: true });

    expect(result.branchDeleted).toBe(false);
    expect(result.reason).toBe('branch-depended-on');
    expect(result.dependentTicketIds).toEqual([followUp.id]);
    expect(tasksCache[followUp.id]?.swimlane).toBe('merge-conflict');
  });

  it('does not re-flag (or re-comment) a ticket already flagged merge-conflict', async () => {
    const followUp = await createTask({ title: 'Follow-up', status: 'In Progress' });
    await updateTaskWithHistory(followUp.id, { updatedBy: 'Agent', extraFields: { branch: 'flux/followup', swimlane: 'merge-conflict' } });
    await gitC(repo, ['add', '-A']);
    await gitC(repo, ['commit', '-m', 'seed follow-up ticket']);
    const historyBefore = tasksCache[followUp.id]?.history?.length ?? 0;

    getOpenPullRequestsWithBase.mockResolvedValue([
      { number: 434, url: 'https://github.com/acme/repo/pull/434', title: 'Follow-up PR', headRefName: 'flux/followup' },
    ]);

    await cleanupMergedBranch(repo, 'flux/FLUX-861-parent', { auto: true });

    expect(tasksCache[followUp.id]?.history?.length ?? 0).toBe(historyBefore); // no duplicate comment
  });

  it('proceeds with the normal delete path when no dependent PR is found (unaffected default)', async () => {
    getOpenPullRequestsWithBase.mockResolvedValue([]);
    const result = await cleanupMergedBranch(repo, 'flux/no-dependents', { auto: true });
    expect(result.reason).not.toBe('branch-depended-on');
  });
});

// FLUX-1326 — once every ticket on a `branch-depended-on` branch reaches Done (step 1 of
// cleanupMergedBranch runs BEFORE the dependent-PR check), reconcilePullRequests's non-terminal
// grouping never calls cleanupMergedBranch for that branch again, so the branch lingered forever
// even after the dependency cleared. cleanupMergedBranch now persists a `branchDeletePending`
// marker on the branch's own tickets when it hits the guard; recheckDependentBranches sweeps for
// that marker (independent of ticket status) and retries.
describe('branchDeletePending marker + recheckDependentBranches close the loop (FLUX-1326)', () => {
  async function seedParentTicket(branch: string) {
    const parent = await createTask({ title: 'Parent', status: 'In Progress' });
    await updateTaskWithHistory(parent.id, { updatedBy: 'Agent', extraFields: { branch } });
    await gitC(repo, ['add', '-A']);
    await gitC(repo, ['commit', '-m', 'seed parent ticket']);
    return parent;
  }

  it('marks the branch-owning (now-Done) ticket branchDeletePending when flagged branch-depended-on', async () => {
    const parent = await seedParentTicket('flux/FLUX-861-parent');
    getOpenPullRequestsWithBase.mockResolvedValue([
      { number: 434, url: 'https://github.com/acme/repo/pull/434', title: 'Follow-up PR', headRefName: 'flux/followup' },
    ]);

    const result = await cleanupMergedBranch(repo, 'flux/FLUX-861-parent', { auto: true });

    expect(result.reason).toBe('branch-depended-on');
    expect(tasksCache[parent.id]?.branchDeletePending).toBe(true);
  });

  it('recheckDependentBranches retries a pending branch and clears the marker once the dependency clears', async () => {
    const parent = await seedParentTicket('flux/FLUX-861-parent');
    getOpenPullRequestsWithBase.mockResolvedValue([
      { number: 434, url: 'https://github.com/acme/repo/pull/434', title: 'Follow-up PR', headRefName: 'flux/followup' },
    ]);
    await cleanupMergedBranch(repo, 'flux/FLUX-861-parent', { auto: true });
    expect(tasksCache[parent.id]?.branchDeletePending).toBe(true);

    // The dependent PR has since merged/closed/or was rebased off `branch` — nothing depends on it
    // any more.
    getOpenPullRequestsWithBase.mockResolvedValue([]);
    await recheckDependentBranches(repo);

    expect(tasksCache[parent.id]?.branchDeletePending).toBeFalsy();
  });

  it('recheckDependentBranches is a no-op when no ticket carries the marker', async () => {
    await seedParentTicket('flux/unrelated');
    await expect(recheckDependentBranches(repo)).resolves.toBeUndefined();
  });

  it('pruneMergedBranches does NOT force-delete a branch still pending a dependency recheck', async () => {
    const parent = await seedParentTicket('flux/FLUX-861-parent');
    // Create the real branch so pruneMergedBranches' "still exists" check finds it, mirroring the
    // state cleanupMergedBranch leaves behind (worktree/checkout already torn down, branch left).
    await gitC(repo, ['branch', 'flux/FLUX-861-parent']);
    await updateTaskWithHistory(parent.id, {
      updatedBy: 'Agent',
      nextStatus: 'Done',
      extraFields: { branchDeletePending: true },
    });
    mergedPrHeadRefs.refs = ['flux/FLUX-861-parent'];

    await pruneMergedBranches(repo);

    const branches = await gitC(repo, ['branch', '--list', 'flux/FLUX-861-parent']);
    expect(branches).toContain('flux/FLUX-861-parent'); // NOT deleted — would have silently
    // reintroduced the FLUX-1270 GitHub auto-close-the-dependent-PR incident.
  });

  it('pruneMergedBranches DOES delete a merged branch with no pending marker (unaffected default)', async () => {
    const parent = await seedParentTicket('flux/no-marker');
    await gitC(repo, ['branch', 'flux/no-marker']);
    await updateTaskWithHistory(parent.id, { updatedBy: 'Agent', nextStatus: 'Done' });
    mergedPrHeadRefs.refs = ['flux/no-marker'];

    await pruneMergedBranches(repo);

    const branches = await gitC(repo, ['branch', '--list', 'flux/no-marker']);
    expect(branches).toBe('');
  });
});

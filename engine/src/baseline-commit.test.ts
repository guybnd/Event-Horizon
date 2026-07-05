import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import {
  getMergeBase,
  isAncestor,
  resolveBaselineCommit,
  getCurrentCommit,
  captureDiff,
} from './branch-manager.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-585 — a PR/branch ticket's baselineCommit must anchor at the branch's fork
// point (merge-base), not at whatever the engine's HEAD happened to be at launch.
// A non-ancestor sibling baseline produces phantom-revert review diffs.
//
// Scenario built per test:
//   C0 (init)           ← fork point / true merge-base
//   ├─ master:  +sibling.txt → C1   (the bad "sibling baseline", NOT on the PR branch)
//   └─ flux/PR: +pr.txt      → P1   (the PR head)
// Diffing C1..P1 shows a phantom removal of sibling.txt; C0..P1 is the truth.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `setWorkspaceRoot`'s declared param type is `string`, but the module state it
 * assigns into (`workspaceRoot` in workspace.ts) is `string | null` — tests need to
 * unbind it between runs. Routing `null` through this same-shaped function boundary
 * keeps its static type as the real `string | null` (a bare `const x: string | null
 * = null` gets narrowed back to the literal `null` by control-flow analysis, which
 * makes even a single `as string` cast fail as "insufficiently overlapping") without
 * reaching for `any`/`unknown`.
 */
function unbindWorkspaceRoot(root: string | null): string | null {
  return root;
}

async function gitC(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

interface Scenario {
  repo: string;
  C0: string; // fork point (true merge-base)
  C1: string; // sibling baseline on master, NOT an ancestor of the PR branch
  P1: string; // PR head
  prBranch: string;
}

async function buildScenario(parent: string): Promise<Scenario> {
  const repo = path.join(parent, 'repo');
  await fs.mkdir(repo, { recursive: true });
  await gitC(repo, ['init', '-b', 'master']);
  await gitC(repo, ['config', 'user.email', 'test@test.com']);
  await gitC(repo, ['config', 'user.name', 'Test']);

  await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'init']);
  const C0 = await gitC(repo, ['rev-parse', 'HEAD']);

  // PR branch forks at C0 and adds pr.txt.
  const prBranch = 'flux/PR-1-feature';
  await gitC(repo, ['checkout', '-b', prBranch]);
  await fs.writeFile(path.join(repo, 'pr.txt'), 'pr feature\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'PR feature']);
  const P1 = await gitC(repo, ['rev-parse', 'HEAD']);

  // master advances past the fork with sibling work the PR never touched.
  await gitC(repo, ['checkout', 'master']);
  await fs.writeFile(path.join(repo, 'sibling.txt'), 'sibling work\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'sibling baseline']);
  const C1 = await gitC(repo, ['rev-parse', 'HEAD']);

  return { repo, C0, C1, P1, prBranch };
}

describe('baselineCommit anchoring (FLUX-585)', () => {
  let parent: string;
  let s: Scenario;

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-baseline-'));
    s = await buildScenario(parent);
    setWorkspaceRoot(s.repo);
  });

  afterEach(async () => {
    setWorkspaceRoot(unbindWorkspaceRoot(null) as string);
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  });

  describe('getMergeBase', () => {
    it('returns the branch fork point, not the sibling baseline', async () => {
      const mb = await getMergeBase(s.prBranch);
      expect(mb).toBe(s.C0);
      expect(mb).not.toBe(s.C1);
    });

    it('returns null for an unknown branch', async () => {
      expect(await getMergeBase('flux/does-not-exist')).toBeNull();
    });

    it('resolves via the origin/<branch> remote-tracking ref when no local ref exists', async () => {
      // Clone so the consumer repo has the PR branch only as origin/<branch>.
      const consumer = path.join(parent, 'consumer');
      await gitC(parent, ['clone', s.repo, consumer]);
      await gitC(consumer, ['config', 'user.email', 'test@test.com']);
      await gitC(consumer, ['config', 'user.name', 'Test']);
      // Local default branch is master; the PR branch lives only at origin/<branch>.
      setWorkspaceRoot(consumer);
      const mb = await getMergeBase(s.prBranch);
      expect(mb).toBe(s.C0);
    });
  });

  describe('isAncestor', () => {
    it('true when the commit is an ancestor of the branch tip', async () => {
      expect(await isAncestor(s.C0, s.prBranch)).toBe(true);
    });

    it('false for a sibling commit that never landed on the branch', async () => {
      expect(await isAncestor(s.C1, s.prBranch)).toBe(false);
    });

    it('false for an unknown ref', async () => {
      expect(await isAncestor('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', s.prBranch)).toBe(false);
    });
  });

  describe('resolveBaselineCommit', () => {
    it('anchors a branch ticket at the merge-base (the fork point)', async () => {
      const baseline = await resolveBaselineCommit(s.prBranch);
      expect(baseline).toBe(s.C0);
      expect(baseline).not.toBe(s.C1);
    });

    it('falls back to current HEAD for a branch-less ticket', async () => {
      const head = await getCurrentCommit();
      expect(await resolveBaselineCommit(null)).toBe(head);
    });

    it('falls back to current HEAD when the branch cannot be resolved', async () => {
      const head = await getCurrentCommit();
      expect(await resolveBaselineCommit('flux/does-not-exist')).toBe(head);
    });
  });

  describe('captureDiff is immune to a bad sibling baseline', () => {
    it('a branch ticket diffs merge-base..branch — no phantom sibling revert', async () => {
      // Even handed the wrong (sibling) baseline, the branch path wins and uses the merge-base.
      const diff = await captureDiff(s.prBranch, s.C1);
      const files = (diff?.summary ?? []).map((f) => f.file);
      expect(files).toContain('pr.txt');
      expect(files).not.toContain('sibling.txt'); // would be a phantom deletion under C1..P1
    });

    it('a stale non-ancestor baseline does not yield a phantom-revert diff', async () => {
      // Branch-less path: HEAD on the PR commit, baseline pointing at the sibling commit.
      await gitC(s.repo, ['checkout', s.prBranch]);
      const diff = await captureDiff(null, s.C1);
      const files = (diff?.summary ?? []).map((f) => f.file);
      // The ancestor guard rejects C1 (not an ancestor of P1) and falls back to HEAD~1..HEAD.
      expect(files).not.toContain('sibling.txt');
      expect(files).toContain('pr.txt');
    });
  });
});

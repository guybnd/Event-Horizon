import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { syncGroup } from './group-sync.js';
import { submitGroupEdit } from './group-edit.js';
import { GROUP_DOCS_BRANCH, getGroupStoreDir, type GroupContext, type ResolvedMember } from './group.js';

/**
 * Real-git end-to-end integration test for the multi-repo group fan-out flow
 * (FLUX-400). Unlike the unit suites (which inject a fake `GitRunner`), this
 * drives the *real* default git runner against local bare repos — no network,
 * no external members. It proves the actual plumbing of:
 *   - FLUX-396 fan-out: canonical worktree → commit → push to a member remote
 *   - FLUX-397 push-through-parent: a sub-repo edit re-fans-out to members
 *   - fan-out safety: a diverged member branch is reported, never force-pushed
 *
 * These cases perform real git ops (clone/fetch/push to local file:// remotes)
 * which are slow on Windows under parallel suite load, so vitest's default
 * 5000ms testTimeout intermittently overruns when the full engine suite runs
 * concurrently (FLUX-749). Raise the per-test timeout file-wide to a generous
 * value so concurrent Windows git ops don't flake the `check` gate.
 */

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

/** Apply a deterministic, isolated identity so commits never depend on global config. */
async function setIdentity(dir: string): Promise<void> {
  await git(dir, ['config', 'user.email', 'eh-test@example.com']);
  await git(dir, ['config', 'user.name', 'EH Integration Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

interface Harness {
  base: string;
  parent: string;
  memberBare: string;
  group: GroupContext;
  storeDir: string;
}

async function makeHarness(): Promise<Harness> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-integ-'));

  // Parent repo: the EH project that owns the canonical group store.
  const parent = path.join(base, 'parent');
  await fs.mkdir(parent, { recursive: true });
  await git(parent, ['init', '-b', 'master']);
  await setIdentity(parent);
  await fs.writeFile(path.join(parent, 'README.md'), '# parent\n');
  await git(parent, ['add', '-A']);
  await git(parent, ['commit', '-m', 'init parent']);

  // Bare member repo standing in for a real member's git remote.
  const memberBare = path.join(base, 'member.git');
  await git(base, ['init', '--bare', '-b', 'master', memberBare]);

  // Scaffold the canonical .flux-group store with a couple of mapped docs.
  const storeDir = getGroupStoreDir(parent);
  await fs.mkdir(path.join(storeDir, 'features'), { recursive: true });
  await fs.writeFile(path.join(storeDir, 'index.md'), '# Product Index\n');
  await fs.writeFile(path.join(storeDir, 'features', 'login.md'), '# Login\n');

  const member: ResolvedMember = {
    name: 'member',
    role: 'api',
    remote: memberBare,
    path: path.join(base, 'member-checkout'),
    pathExists: false,
  };
  const group: GroupContext = {
    parentRoot: parent,
    config: { name: 'acme', members: [member] },
    members: [member],
    groupStoreDir: storeDir,
    docsBranch: GROUP_DOCS_BRANCH,
  };

  return { base, parent, memberBare, group, storeDir };
}

/** Clone a member's fan-out branch into a fresh checkout and return its path. */
async function checkoutMemberDocs(harness: Harness, label: string): Promise<string> {
  const dest = path.join(harness.base, `verify-${label}`);
  await git(harness.base, ['clone', '-b', GROUP_DOCS_BRANCH, harness.memberBare, dest]);
  return dest;
}

let harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses) {
    // Detach worktree bookkeeping before removing, then best-effort rm.
    await git(h.parent, ['worktree', 'prune']).catch(() => {});
    await fs.rm(h.base, { recursive: true, force: true }).catch(() => {});
  }
  harnesses = [];
});

async function harness(): Promise<Harness> {
  const h = await makeHarness();
  harnesses.push(h);
  return h;
}

describe('group fan-out (real git, local remotes)', () => {
  it('promotes the canonical store, commits, and fans out to a member remote', async () => {
    const h = await harness();

    const result = await syncGroup(h.group, { allowLocalRemotes: true });

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.members[0]!.ok).toBe(true);

    // The canonical store is now a worktree on the fan-out branch.
    const head = await git(h.storeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(head.stdout.trim()).toBe(GROUP_DOCS_BRANCH);

    // The member remote received the branch and the member can read it offline.
    const verify = await checkoutMemberDocs(h, 'initial');
    expect(existsSync(path.join(verify, 'index.md'))).toBe(true);
    expect(existsSync(path.join(verify, 'features', 'login.md'))).toBe(true);

    // The parent's own master branch was never touched by the fan-out.
    const masterFiles = await git(h.parent, ['ls-tree', '--name-only', 'master']);
    expect(masterFiles.stdout).not.toContain('.flux-group');
  });

  it('re-fans-out a push-through-parent edit to the member', async () => {
    const h = await harness();
    await syncGroup(h.group, { allowLocalRemotes: true });

    const edit = await submitGroupEdit(
      h.group,
      [
        { path: 'features/login.md', content: '# Login v2\n' },
        { path: 'features/signup.md', content: '# Signup\n' },
      ],
      { allowLocalRemotes: true },
    );

    expect(edit.applied).toEqual(['features/login.md', 'features/signup.md']);
    expect(edit.sync.pushed).toBe(1);
    expect(edit.sync.members[0]!.ok).toBe(true);

    const verify = await checkoutMemberDocs(h, 'edited');
    expect(await fs.readFile(path.join(verify, 'features', 'login.md'), 'utf8')).toContain('Login v2');
    expect(existsSync(path.join(verify, 'features', 'signup.md'))).toBe(true);
  });

  it('reports a diverged member branch instead of force-pushing', async () => {
    const h = await harness();
    await syncGroup(h.group, { allowLocalRemotes: true });

    // Simulate a member whose fan-out branch advanced independently: clone it,
    // add a commit, and push it straight back into the bare remote.
    const rogue = path.join(h.base, 'rogue');
    await git(h.base, ['clone', '-b', GROUP_DOCS_BRANCH, h.memberBare, rogue]);
    await setIdentity(rogue);
    await fs.writeFile(path.join(rogue, 'features', 'rogue.md'), '# Rogue\n');
    await git(rogue, ['add', '-A']);
    await git(rogue, ['commit', '-m', 'member-side change']);
    await git(rogue, ['push', 'origin', GROUP_DOCS_BRANCH]);

    // Now the parent advances its canonical branch and tries to fan out again.
    const result = await submitGroupEdit(
      h.group,
      [{ path: 'features/login.md', content: '# Login v3\n' }],
      { allowLocalRemotes: true },
    );

    expect(result.sync.failed).toBe(1);
    expect(result.sync.pushed).toBe(0);
    expect(result.sync.members[0]!.ok).toBe(false);
    expect(result.sync.members[0]!.diverged).toBe(true);

    // The member's rogue commit was never overwritten (no force-push).
    const verify = await checkoutMemberDocs(h, 'diverged');
    expect(existsSync(path.join(verify, 'features', 'rogue.md'))).toBe(true);
  });
});

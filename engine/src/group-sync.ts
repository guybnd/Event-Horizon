import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GROUP_DOCS_BRANCH, getGroupStoreDir, type GroupContext, type ResolvedMember } from './group.js';
import { validateGitRemote } from './group-setup.js';
import { refreshMemberWorktrees } from './group-member-worktree.js';

const execFileAsync = promisify(execFile);

/**
 * Group fan-out sync (FLUX-396).
 *
 * Single-writer model: the parent repo holds the canonical group docs on the
 * `flux-group-docs` orphan branch (checked out as a worktree at `.flux-group/`)
 * and **pushes** them to every member repo's `flux-group-docs` branch. Pushes
 * go to the declared `remote` URL directly (not via a named remote / a member's
 * local `origin`), are **fast-forward only** (a normal non-force push), and are
 * **per-member isolated** — one member's failure never aborts the rest.
 *
 * Member-side worktree attach (checking the branch out inside each member repo)
 * is deferred to a thin follow-up (decision C2); this module delivers the push.
 */

export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) =>
  execFileAsync('git', args, { cwd, windowsHide: true });

async function gitWithRetry(runner: GitRunner, cwd: string, args: string[], maxRetries = 3): Promise<{ stdout: string; stderr: string }> {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      return await runner(cwd, args);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('index.lock') && attempts < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000));
        attempts++;
      } else {
        throw err;
      }
    }
  }
  throw new Error('Unreachable');
}

// ─── Canonical branch on the parent ──────────────────────────────────────────

/** True when `dir` is a git work tree checked out on `branch`. */
async function isWorktreeOnBranch(runner: GitRunner, dir: string, branch: string): Promise<boolean> {
  if (!existsSync(path.join(dir, '.git'))) return false;
  try {
    const { stdout } = await runner(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() === branch;
  } catch {
    return false;
  }
}

/** Move every entry out of `dir` into a fresh temp dir; returns the temp path. */
async function evacuateDir(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  if (entries.length === 0) return null;
  // Backup must live on the same volume as `dir` so fs.rename never hits EXDEV
  // (os.tmpdir() can be a different drive than the repo). Place it alongside.
  const backup = await fs.mkdtemp(path.join(path.dirname(dir), '.eh-group-evac-'));
  for (const name of entries) {
    await fs.rename(path.join(dir, name), path.join(backup, name));
  }
  return backup;
}

/** Restore entries from a backup dir into `dir` without overwriting existing files. */
async function restoreDir(backup: string, dir: string): Promise<void> {
  const entries = await fs.readdir(backup).catch(() => [] as string[]);
  for (const name of entries) {
    const dst = path.join(dir, name);
    if (existsSync(dst)) continue; // branch already carried this file — keep canonical
    await fs.rename(path.join(backup, name), dst);
  }
  await fs.rm(backup, { recursive: true, force: true });
}

/**
 * Ensure `.flux-group/` is a worktree on the `flux-group-docs` orphan branch.
 *
 * FLUX-393 scaffolds `.flux-group/` as a plain (gitignored) directory, so on the
 * first sync we promote it to a worktree: evacuate any scaffolded content, create
 * the worktree (attaching an existing branch, or `--orphan` for a brand-new one),
 * then restore the scaffolded content that the branch didn't already carry.
 * Idempotent — a no-op once the worktree exists.
 */
export async function ensureCanonicalBranch(
  parentRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<void> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const storeDir = getGroupStoreDir(parentRoot);

  if (await isWorktreeOnBranch(runner, storeDir, GROUP_DOCS_BRANCH)) return;

  const { stdout: localList } = await runner(parentRoot, ['branch', '--list', GROUP_DOCS_BRANCH]).catch(() => ({ stdout: '' }));
  const branchExists = !!localList.trim();

  const backup = existsSync(storeDir) ? await evacuateDir(storeDir) : null;
  if (existsSync(storeDir)) {
    await fs.rm(storeDir, { recursive: true, force: true });
  }

  if (branchExists) {
    await runner(parentRoot, ['worktree', 'add', storeDir, GROUP_DOCS_BRANCH]);
  } else {
    await runner(parentRoot, ['worktree', 'add', '--orphan', '-b', GROUP_DOCS_BRANCH, storeDir]);
  }

  if (backup) {
    await restoreDir(backup, storeDir);
  }
}

/**
 * Stage and commit the canonical group docs in the `.flux-group` worktree.
 * Returns true when a commit was made, false when there was nothing to commit.
 */
export async function commitCanonicalDocs(
  parentRoot: string,
  message: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<boolean> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const storeDir = getGroupStoreDir(parentRoot);

  await gitWithRetry(runner, storeDir, ['add', '-A']);
  const { stdout } = await runner(storeDir, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) return false;

  await runner(storeDir, ['commit', '-m', message]);
  return true;
}

// ─── Fan-out ─────────────────────────────────────────────────────────────────

export interface MemberSyncResult {
  name: string;
  remote: string;
  ok: boolean;
  /** Set when the member branch had diverged (push was rejected, not forced). */
  diverged?: boolean;
  error?: string;
}

export interface GroupSyncResult {
  pushed: number;
  failed: number;
  members: MemberSyncResult[];
  /** True when a canonical commit was created this run. */
  committed: boolean;
}

function isRejection(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('[rejected]') || m.includes('fetch first') || m.includes('non-fast-forward');
}

/**
 * Push the canonical `flux-group-docs` branch to every member's remote, by URL,
 * fast-forward only. Per-member isolated: a failure (auth, network, or a diverged
 * member branch) is recorded and never aborts the other members. A diverged
 * member is surfaced as an error — never merged or force-pushed.
 */
export async function fanOutGroupDocs(
  group: GroupContext,
  opts: { gitRunner?: GitRunner; allowLocalRemotes?: boolean } = {},
): Promise<MemberSyncResult[]> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const refspec = `${GROUP_DOCS_BRANCH}:${GROUP_DOCS_BRANCH}`;
  const results: MemberSyncResult[] = [];

  for (const member of group.members as ResolvedMember[]) {
    const check = validateGitRemote(member.remote, { allowLocal: opts.allowLocalRemotes });
    if (!check.ok) {
      results.push({ name: member.name, remote: member.remote, ok: false, error: `invalid remote: ${check.reason}` });
      continue;
    }
    try {
      // Non-force push by URL → fast-forward only; git rejects a diverged member.
      await runner(group.parentRoot, ['push', member.remote, refspec]);
      results.push({ name: member.name, remote: member.remote, ok: true });
    } catch (err: any) {
      const message = err?.message ? String(err.message) : String(err);
      results.push({
        name: member.name,
        remote: member.remote,
        ok: false,
        diverged: isRejection(message),
        error: message,
      });
    }
  }

  return results;
}

/**
 * Full group sync: ensure the canonical branch, commit pending canonical docs,
 * then fan out to every member. The single entry point behind `POST /api/group/sync`.
 */
export async function syncGroup(
  group: GroupContext,
  opts: { gitRunner?: GitRunner; allowLocalRemotes?: boolean; message?: string } = {},
): Promise<GroupSyncResult> {
  await ensureCanonicalBranch(group.parentRoot, opts);
  const committed = await commitCanonicalDocs(
    group.parentRoot,
    opts.message ?? `group: sync canonical docs (${new Date().toISOString()})`,
    opts,
  );
  const members = await fanOutGroupDocs(group, opts);

  // Refresh local member worktrees from the parent's latest canonical data
  // (Case 1: same-machine fetch — no internet required).
  await refreshMemberWorktrees(group, opts).catch((err) =>
    console.error('[group-sync] member worktree refresh failed:', err),
  );

  return {
    committed,
    pushed: members.filter((m) => m.ok).length,
    failed: members.filter((m) => !m.ok).length,
    members,
  };
}

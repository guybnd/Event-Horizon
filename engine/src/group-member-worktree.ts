import { log } from './log.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  GROUP_DOCS_BRANCH,
  GROUP_STORE_DIRNAME,
  getMemberBinding,
  type GroupContext,
  type ResolvedMember,
} from './group.js';

/**
 * Member-side worktree management for the shared group docs (FLUX-422).
 *
 * Gives each member repo a LOCAL checkout of `flux-group-docs` at `.flux-group/`
 * so that non-EH developers, editors, and agents running in the member repo see
 * real files on disk — not just the in-place read the engine does from the
 * parent's store.
 *
 * Git strategy (Case 1, same machine):
 *   Fetch `flux-group-docs` from the parent's local git repo by path into a
 *   dedicated tracking ref (`refs/remotes/group-parent/docs`). No internet or
 *   configured remote required. The member owns its own local copy of the branch
 *   and worktree; refresh is a fetch + hard-reset in the worktree.
 *
 * The worktree is READ-ONLY by convention: edits go through `submit_group_doc`
 * (MCP) or the portal editor, which commit on the parent's copy and fan out.
 * Agents receive `--add-dir .flux-group` so they can read docs as real files.
 */

const execFileAsync = promisify(execFile);

// Defined locally to avoid a circular import with group-sync.ts.
type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) =>
  execFileAsync('git', args, { cwd, windowsHide: true });

/** Remote-tracking ref the member uses to track the parent's canonical branch. */
const GROUP_PARENT_TRACKING_REF = 'refs/remotes/group-parent/docs';

/** True when `dir` is a git worktree checked out on `branch`. */
async function isWorktreeOnBranch(runner: GitRunner, dir: string, branch: string): Promise<boolean> {
  if (!existsSync(path.join(dir, '.git'))) return false;
  try {
    const { stdout } = await runner(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() === branch;
  } catch {
    return false;
  }
}

/**
 * Ensure the member at `memberRoot` has `.flux-group/` checked out as a local
 * worktree on `flux-group-docs`, fetching the branch from the parent's local
 * git repo by path. Idempotent — refreshes in place if the worktree already
 * exists.
 *
 * Returns `true` when the worktree was created or refreshed. Returns `false`
 * when the parent branch doesn't exist yet (no commits on `flux-group-docs`),
 * which is safe — the caller can retry after the first `syncGroup`.
 */
export async function attachMemberWorktree(
  memberRoot: string,
  parentRoot: string,
  opts: { gitRunner?: GitRunner | undefined } = {},
): Promise<boolean> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const storeDir = path.resolve(path.join(memberRoot, GROUP_STORE_DIRNAME));

  // 1. Fetch the canonical branch from the parent's local git repo into a
  //    dedicated tracking ref. Using an anonymous path-based remote avoids
  //    needing a named remote or internet access.
  try {
    await runner(memberRoot, [
      'fetch',
      path.resolve(parentRoot),
      `${GROUP_DOCS_BRANCH}:${GROUP_PARENT_TRACKING_REF}`,
    ]);
  } catch {
    // Parent branch has no commits yet — safe to skip; retry after first sync.
    return false;
  }

  // 2. Already a worktree on the right branch? Fast-forward it by resetting
  //    the working tree to the latest tracking ref. Read-only convention means
  //    there are no local changes to lose.
  if (await isWorktreeOnBranch(runner, storeDir, GROUP_DOCS_BRANCH)) {
    try {
      await runner(storeDir, ['reset', '--hard', GROUP_PARENT_TRACKING_REF]);
    } catch (err) {
      console.error(`[group-worktree] Failed to fast-forward member worktree at ${storeDir}:`, err);
    }
    return true;
  }

  // 3. Remove any stale directory or detached worktree at the target path.
  if (existsSync(storeDir)) {
    await runner(memberRoot, ['worktree', 'remove', '--force', storeDir]).catch(() => {});
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Ensure a local branch exists pointing at the tracking ref.
  const { stdout: localList } = await runner(memberRoot, [
    'branch', '--list', GROUP_DOCS_BRANCH,
  ]).catch(() => ({ stdout: '' }));

  if (!localList.trim()) {
    // First time — create the local branch.
    await runner(memberRoot, ['branch', GROUP_DOCS_BRANCH, GROUP_PARENT_TRACKING_REF]);
  } else {
    // Branch exists but its worktree was removed — advance the branch tip.
    await runner(memberRoot, ['branch', '-f', GROUP_DOCS_BRANCH, GROUP_PARENT_TRACKING_REF]);
  }

  // 5. Create the worktree from the member's own local branch.
  await runner(memberRoot, ['worktree', 'add', storeDir, GROUP_DOCS_BRANCH]);

  // 6. Ensure .gitignore so the worktree dir doesn't appear as untracked.
  await ensureMemberGitignore(memberRoot);

  log.info(`[group-worktree] Attached local docs store at ${storeDir}`);
  return true;
}

/**
 * Refresh the local member worktrees for all present members of `group`.
 * Called by `syncGroup` after a canonical commit so each member's copy stays
 * in sync without requiring internet access.
 */
export async function refreshMemberWorktrees(
  group: GroupContext,
  opts: { gitRunner?: GitRunner | undefined } = {},
): Promise<void> {
  for (const member of group.members as ResolvedMember[]) {
    if (!member.path || !existsSync(member.path)) continue;
    try {
      await attachMemberWorktree(member.path, group.parentRoot, opts);
    } catch (err) {
      console.error(`[group-worktree] Failed to refresh member '${member.name}' at ${member.path}:`, err);
    }
  }
}

/**
 * Remove the member-side `.flux-group/` worktree and prune the tracking ref.
 * Best-effort — logs errors but never throws.
 */
export async function detachMemberWorktree(
  memberRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<void> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const storeDir = path.resolve(path.join(memberRoot, GROUP_STORE_DIRNAME));
  try {
    await runner(memberRoot, ['worktree', 'remove', '--force', storeDir]);
  } catch { /* storeDir may not be a worktree — fall through to rm */ }
  try {
    await fs.rm(storeDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
  try {
    await runner(memberRoot, ['update-ref', '-d', GROUP_PARENT_TRACKING_REF]);
  } catch { /* tracking ref may not exist */ }
  try {
    // Prune the worktree entry from git's administrative records.
    await runner(memberRoot, ['worktree', 'prune']);
  } catch { /* best-effort */ }
}

/**
 * Append `/.flux-group/` to `memberRoot/.gitignore` if not already present.
 * Best-effort — skips silently on I/O errors.
 */
export async function ensureMemberGitignore(memberRoot: string): Promise<void> {
  const gitignorePath = path.join(memberRoot, '.gitignore');
  const entry = `/${GROUP_STORE_DIRNAME}/`;
  try {
    const existing = await fs.readFile(gitignorePath, 'utf8').catch(() => '');
    const lines = existing.split('\n').map((l) => l.trim());
    // Accept any of the common spellings already present.
    const alreadyPresent = lines.some(
      (l) => l === entry || l === entry.slice(1) || l === GROUP_STORE_DIRNAME || l === `${GROUP_STORE_DIRNAME}/`,
    );
    if (alreadyPresent) return;
    const updated = existing.endsWith('\n')
      ? `${existing}${entry}\n`
      : existing
        ? `${existing}\n${entry}\n`
        : `${entry}\n`;
    await fs.writeFile(gitignorePath, updated, 'utf8');
  } catch { /* best-effort */ }
}

/**
 * Returns `['--add-dir', '<memberRoot>/.flux-group']` when the local member
 * group docs worktree exists AND this workspace is a bound member (not a parent
 * whose cwd already contains `.flux-group`). Spread into agent spawn args so
 * the agent can read shared group docs as real local files (FLUX-422).
 */
export function buildGroupDocsScopeArg(memberRoot: string): string[] {
  if (!memberRoot) return [];
  // Only emit when we're a member — on a parent the cwd already covers .flux-group.
  if (!getMemberBinding()) return [];
  const storeDir = path.join(memberRoot, GROUP_STORE_DIRNAME);
  return existsSync(storeDir) ? ['--add-dir', storeDir] : [];
}

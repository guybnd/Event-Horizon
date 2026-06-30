import fs from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { evictSharedServersForPath } from './shared-mcp-server.js';

/**
 * Per-task-branch git worktree management (FLUX-517).
 *
 * Each task agent runs on its own branch (`flux/<id>-<slug>`). git's HEAD and
 * working files are per-worktree, so giving every task its own worktree lets
 * concurrent agents — and any human/CLI session on `master` — operate without
 * flipping each other's branch or clobbering working files. The `.git` object
 * store is shared, so commits/refs/stashes are visible everywhere.
 *
 * Design decisions (see FLUX-516 / FLUX-517):
 *   - Location: `<repoParent>/.eh-worktrees/<repo>-<id>` — a SIBLING of the repo,
 *     so it is inherently outside the tracked tree (no .gitignore entry needed)
 *     and never picked up by the engine's flux/docs watchers.
 *   - One branch = one worktree: git refuses to check a branch out twice. We
 *     guard explicitly and surface a clear error rather than ever using --force.
 *   - Dirty abandon never discards work: changes are stashed (shared .git) and
 *     best-effort applied onto the main tree so they surface on master; on
 *     conflict the stash is kept and its ref reported.
 *   - Concurrency cap: configurable, reject past it (no hidden queue).
 *
 * This module owns ONLY the lifecycle primitives. Spawn cwd wiring (FLUX-519)
 * and the launch/settings/detach UI (FLUX-521) live elsewhere.
 */

const execFileAsync = promisify(execFile);

/** Injectable git runner (matches group-member-worktree.ts for testability). */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) =>
  execFileAsync('git', args, { cwd, windowsHide: true });

/** Directory name (sibling of the repo) that holds all task worktrees. */
export const EH_WORKTREES_DIRNAME = '.eh-worktrees';

/** Default cap on simultaneous task worktrees. FLUX-521 overrides via settings. */
export const DEFAULT_MAX_TASK_WORKTREES = 4;

export interface TaskWorktreeOptions {
  gitRunner?: GitRunner;
  /** Max simultaneous task worktrees for this repo (default DEFAULT_MAX_TASK_WORKTREES). */
  maxWorktrees?: number;
  /** Branch to create the task branch from when it doesn't exist yet (default 'master'). */
  baseBranch?: string | undefined;
  /** Junction the main tree's node_modules into the new worktree (default true). FLUX-518. */
  linkDependencies?: boolean;
}

/**
 * Sub-paths (relative to the repo root) whose `node_modules` are shared into a
 * worktree. This monorepo installs at the root plus the `engine` and `portal`
 * workspaces; each is linked only when it actually exists in the main tree.
 */
export const WORKTREE_DEP_SUBDIRS = ['.', 'engine', 'portal'];

/**
 * Per-checkout Serena override path (FLUX-843). `.serena/project.local.yml` is
 * gitignored (see `.serena/.gitignore`), so unlike the committed `project.yml`
 * it is NOT shared into worktrees — each worktree owns its own copy.
 */
export const SERENA_PROJECT_LOCAL_RELPATH = path.join('.serena', 'project.local.yml');

export interface DetachOptions {
  gitRunner?: GitRunner;
  /** Label used in the stash message / result (defaults to the worktree dir name). */
  ticketId?: string;
  /**
   * Apply stashed uncommitted work onto the main tree so it surfaces on master
   * (default true — the manual-finish escape hatch). Set false for an ABANDON
   * (e.g. delete_branch): the work is still preserved as a stash ref, but not
   * applied onto master, so abandoning doesn't pollute the main tree.
   */
  applyToMain?: boolean;
}

export interface DetachResult {
  /** 'clean' = nothing to save; 'applied' = changes now on the main tree; 'stashed' = kept as a stash ref (conflict). */
  outcome: 'clean' | 'applied' | 'stashed';
  /** The stash commit SHA, when changes were stashed/applied. */
  stashRef?: string;
  /** Human-readable summary for the detach UI (FLUX-521). */
  message: string;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

// ─── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Canonicalize for comparison. `git worktree list` reports the long, real-cased
 * path with forward slashes; a configured workspace root may be a short (8.3) or
 * differently-cased form. realpath (native) reconciles both; we fall back to a
 * plain resolve when the path doesn't exist yet.
 */
function canonical(p: string): string {
  let out: string;
  try {
    out = realpathSync.native(path.resolve(p));
  } catch {
    out = path.resolve(p);
  }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

function pathsEqual(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** True when `child` is `parent` or nested under it. */
function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(canonical(parent), canonical(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `<repoParent>/.eh-worktrees` — the sibling dir holding this repo's task worktrees. */
export function taskWorktreesBaseDir(workspaceRoot: string): string {
  const root = path.resolve(workspaceRoot);
  return path.join(path.dirname(root), EH_WORKTREES_DIRNAME);
}

/** `<repoParent>/.eh-worktrees/<repo>-<id>` — the worktree path for one ticket. */
export function taskWorktreeDir(workspaceRoot: string, ticketId: string): string {
  const root = path.resolve(workspaceRoot);
  return path.join(taskWorktreesBaseDir(workspaceRoot), `${path.basename(root)}-${ticketId}`);
}

// ─── Git introspection ──────────────────────────────────────────────────────────

/** Parse `git worktree list --porcelain` into { path, branch } entries. */
async function listWorktrees(runner: GitRunner, workspaceRoot: string): Promise<WorktreeEntry[]> {
  const { stdout } = await runner(workspaceRoot, ['worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }));
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && current) {
      // e.g. "branch refs/heads/flux/FLUX-1-foo" → "flux/FLUX-1-foo"
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    // "detached" / "bare" lines leave branch null.
  }
  if (current) entries.push(current);
  return entries;
}

async function localBranchExists(runner: GitRunner, workspaceRoot: string, branch: string): Promise<boolean> {
  try {
    await runner(workspaceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

/**
 * Create (or reuse) the task worktree for `ticketId` on `branch`.
 *
 * - Idempotent: if the target path is already a worktree on `branch`, returns it.
 * - Branch-exclusivity guard: throws if `branch` is checked out at another path
 *   (never uses --force).
 * - Concurrency cap: throws if the repo already has `maxWorktrees` task worktrees.
 * - Creates `branch` from `baseBranch` when it doesn't exist yet.
 *
 * Returns the absolute worktree path.
 */
export async function createTaskWorktree(
  workspaceRoot: string,
  ticketId: string,
  branch: string,
  opts: TaskWorktreeOptions = {},
): Promise<string> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const maxWorktrees = opts.maxWorktrees ?? DEFAULT_MAX_TASK_WORKTREES;
  const baseBranch = opts.baseBranch ?? 'master';
  const target = taskWorktreeDir(workspaceRoot, ticketId);
  const base = taskWorktreesBaseDir(workspaceRoot);

  // Reconcile records of worktrees whose dirs were removed out of band first, so
  // neither the branch-exclusivity guard nor the concurrency cap trips on a
  // phantom entry git would otherwise still report (review fix).
  await runner(workspaceRoot, ['worktree', 'prune']).catch(() => {});
  const worktrees = await listWorktrees(runner, workspaceRoot);

  // Idempotent reuse / collision at the target path.
  const atTarget = worktrees.find((w) => pathsEqual(w.path, target));
  if (atTarget) {
    if (atTarget.branch === branch) {
      // Self-heal a reused worktree missing its node_modules junctions (created
      // before FLUX-518, or a prior link attempt failed) — best-effort, and the
      // existsSync(dest) guard skips already-linked sub-paths, so it's cheap (TRAIL-1).
      if (opts.linkDependencies !== false) {
        await linkWorktreeDependencies(workspaceRoot, target).catch((err) =>
          console.error('[task-worktree] re-linking node_modules on reuse failed:', err),
        );
      }
      // Self-heal the Serena binding on reuse (worktree created before FLUX-843,
      // or a prior write failed) — best-effort, idempotent (FLUX-843).
      await writeWorktreeSerenaOverride(target);
      return target;
    }
    throw new Error(
      `A worktree already exists at ${target} on a different branch (${atTarget.branch ?? 'detached'}).`,
    );
  }

  // Branch-exclusivity guard — one branch = one worktree.
  const elsewhere = worktrees.find((w) => w.branch === branch);
  if (elsewhere) {
    throw new Error(
      `Branch '${branch}' is already checked out at ${elsewhere.path}. ` +
        `Refusing to create a second worktree for the same branch.`,
    );
  }

  // Concurrency cap — count existing task worktrees under .eh-worktrees.
  const taskCount = worktrees.filter((w) => isUnder(w.path, base) && existsSync(w.path)).length;
  if (taskCount >= maxWorktrees) {
    throw new Error(
      `Task worktree limit reached (${taskCount}/${maxWorktrees}). ` +
        `Finish or abandon a task before starting another.`,
    );
  }

  await fs.mkdir(base, { recursive: true });

  const branchExists = await localBranchExists(runner, workspaceRoot, branch);
  const args = branchExists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, baseBranch];
  await runner(workspaceRoot, args);

  // Make the worktree runnable by sharing the main tree's installed deps
  // (best-effort; no-op when the repo has no node_modules) — FLUX-518.
  if (opts.linkDependencies !== false) {
    await linkWorktreeDependencies(workspaceRoot, target).catch((err) =>
      console.error('[task-worktree] linking node_modules failed:', err),
    );
  }

  // Bind Serena to this worktree (not the main checkout) so its symbol-editing
  // tools write here — FLUX-843.
  await writeWorktreeSerenaOverride(target);

  return target;
}

/**
 * Remove a task worktree on the clean finish path (after the agent committed).
 * Falls back to --force only if the plain remove fails (e.g. leftover ignored
 * build artifacts), then prunes git's administrative records.
 */
export async function removeTaskWorktree(
  workspaceRoot: string,
  worktreePath: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<void> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  // FLUX-579: tear down any engine-managed shared MCP server(s) pinned to THIS
  // worktree before the tree is removed — their (module, worktree) key won't be
  // requested again and the server would otherwise linger pointing at a gone tree.
  // Best-effort; only matches this path's servers (sibling worktrees untouched).
  try { evictSharedServersForPath(worktreePath); } catch { /* best-effort */ }
  // Remove the node_modules junctions FIRST so `git worktree remove` (which
  // deletes the directory tree) cannot follow a junction and destroy the main
  // tree's real dependencies — FLUX-518.
  await unlinkWorktreeDependencies(worktreePath);
  try {
    await runner(workspaceRoot, ['worktree', 'remove', worktreePath]);
  } catch {
    // Plain remove failed. NEVER `--force` a worktree that still has uncommitted
    // work — that would silently discard whatever's there (e.g. someone editing
    // the tree by accident). Only force when the tree is genuinely clean (the
    // failure was a lock or leftover ignored files, with nothing to lose).
    // Callers that expect dirty trees (finish/abandon) go through detachTaskWorktree,
    // which stashes/surfaces the work first.
    const { stdout } = await runner(worktreePath, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
    if (stdout.trim().length > 0) {
      throw new Error(
        `Refusing to remove ${worktreePath}: it has uncommitted changes. ` +
          `Detach it first (stashes/surfaces the work) instead of discarding it.`,
      );
    }
    await runner(workspaceRoot, ['worktree', 'remove', '--force', worktreePath]).catch(() => {});
  }
  await runner(workspaceRoot, ['worktree', 'prune']).catch(() => {});

  // `git worktree remove` deletes the files it manages but can leave the top
  // directory behind as an empty shell when a handle is held (e.g. a VS Code
  // window still open on the worktree — FLUX-522 makes this routine). A leftover
  // shell at the target path later blocks `git worktree add` for the same ticket,
  // so sweep it. Guarded to our own .eh-worktrees subtree and best-effort: a
  // truly locked folder is harmless (it's empty) and reconciles on the next prune.
  if (existsSync(worktreePath) && isUnder(worktreePath, taskWorktreesBaseDir(workspaceRoot))) {
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Detach (abandon) a task worktree without losing uncommitted work.
 *
 * Clean worktree → just remove. Dirty worktree → stash the changes (incl.
 * untracked) in the worktree (shared .git), best-effort `git stash apply` them
 * onto the main tree so they surface on master (visible in GitHub Desktop). On
 * a clean apply the stash is dropped; on conflict the stash is kept and its ref
 * reported. The worktree (now clean after the stash) is then removed.
 *
 * Used by the manual-finish escape hatch (UI in FLUX-521) and crash/abandon
 * cleanup.
 */
export async function detachTaskWorktree(
  workspaceRoot: string,
  worktreePath: string,
  opts: DetachOptions = {},
): Promise<DetachResult> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const label = opts.ticketId ?? path.basename(worktreePath);

  const { stdout: status } = await runner(worktreePath, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
  const dirty = status.trim().length > 0;

  if (!dirty) {
    await removeTaskWorktree(workspaceRoot, worktreePath, { gitRunner: runner });
    return { outcome: 'clean', message: `Worktree for ${label} had no uncommitted changes; removed.` };
  }

  // Stash dirty + untracked changes in the worktree, then capture the stash SHA
  // so we apply/drop the RIGHT entry regardless of concurrent stash pushes.
  await runner(worktreePath, ['stash', 'push', '--include-untracked', '-m', `EH abandon ${label}`]);
  const { stdout: shaOut } = await runner(worktreePath, ['rev-parse', 'stash@{0}']);
  const stashSha = shaOut.trim();

  let result: DetachResult;
  if (opts.applyToMain === false) {
    // Abandon path (e.g. delete_branch): preserve the work as a recoverable stash,
    // but do NOT apply it onto master — abandoning shouldn't pollute the main tree.
    result = {
      outcome: 'stashed',
      stashRef: stashSha,
      message:
        `Uncommitted changes from ${label} were kept as stash ${stashSha.slice(0, 10)} ` +
        `(not applied to master). Recover with: git stash apply ${stashSha}`,
    };
  } else {
    try {
      // Surface the changes on the main tree (on master) so the user is aware.
      await runner(workspaceRoot, ['stash', 'apply', stashSha]);
      // Applied cleanly — drop OUR stash entry, matched by SHA (a blind `stash drop`
      // would remove stash@{0}, which a concurrent push could have shifted off the top).
      await dropStashBySha(runner, workspaceRoot, stashSha);
      result = {
        outcome: 'applied',
        stashRef: stashSha,
        message:
          `Uncommitted changes from ${label} were applied onto the main tree ` +
          `(visible as uncommitted edits in GitHub Desktop).`,
      };
    } catch {
      result = {
        outcome: 'stashed',
        stashRef: stashSha,
        message:
          `Uncommitted changes from ${label} conflicted with the main tree and were kept as ` +
          `stash ${stashSha.slice(0, 10)}. Recover with: git stash apply ${stashSha}`,
      };
    }
  }

  // The worktree is clean after the stash — remove it.
  await removeTaskWorktree(workspaceRoot, worktreePath, { gitRunner: runner });
  return result;
}

/**
 * Drop the stash entry whose commit matches `sha` — NOT a blind `git stash drop`
 * (which removes stash@{0}; a concurrent `git stash push` from any process sharing
 * this repo's `refs/stash` could have shifted our entry off the top). Best-effort:
 * leaving the stash in place is safe (it stays recoverable).
 */
async function dropStashBySha(runner: GitRunner, workspaceRoot: string, sha: string): Promise<void> {
  try {
    const { stdout } = await runner(workspaceRoot, ['stash', 'list', '--format=%gd %H']);
    const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith(sha));
    const ref = line ? line.split(/\s+/)[0] : null;
    if (ref) await runner(workspaceRoot, ['stash', 'drop', ref]);
  } catch {
    /* best-effort */
  }
}

export interface StashGuardResult {
  /** True when the tree was dirty and its changes were stashed before the caller proceeded. */
  stashed: boolean;
  /** The stash commit SHA when changes were stashed — surface it so work stays recoverable. */
  stashRef?: string;
}

/**
 * Dirty-tree backstop for engine-driven destructive git ops that MUST proceed on a tree the
 * engine owns — chiefly the post-merge cleanup that switches/resets the MAIN tree off a merged
 * branch (FLUX-741, incident FLUX-734). Worktree paths are already guarded
 * ({@link removeTaskWorktree}/{@link detachTaskWorktree}); this protects the root/main tree,
 * whose switch/`merge --ff-only` would otherwise silently discard uncommitted work.
 *
 * If `treeDir` has uncommitted or untracked changes, stash them (incl. untracked) and capture
 * the stash SHA so nothing is lost — the work stays recoverable via `git stash apply <sha>`.
 * Reuses {@link detachTaskWorktree}'s stash pattern but does NOT apply onto master (the caller
 * is about to switch the tree, not abandon a worktree). Clean tree → no-op `{ stashed: false }`.
 */
export async function stashDirtyTree(
  treeDir: string,
  opts: { reason?: string; gitRunner?: GitRunner } = {},
): Promise<StashGuardResult> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const { stdout: status } = await runner(treeDir, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
  if (status.trim().length === 0) return { stashed: false };

  const label = opts.reason ?? 'EH auto-stash (dirty-tree backstop)';
  await runner(treeDir, ['stash', 'push', '--include-untracked', '-m', label]);
  const { stdout: shaOut } = await runner(treeDir, ['rev-parse', 'stash@{0}']).catch(() => ({ stdout: '' }));
  const stashRef = shaOut.trim() || undefined;
  return stashRef ? { stashed: true, stashRef } : { stashed: true };
}

/**
 * Prune git's records of task worktrees whose directories were removed out of
 * band (manual delete, crash). Safe to call on engine startup.
 */
export async function pruneTaskWorktrees(
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<void> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  await runner(workspaceRoot, ['worktree', 'prune']).catch(() => {});
}

/**
 * Resolve the **agent execution root** for a task (FLUX-519). A task runs in
 * whatever worktree currently holds **its branch** — its own dedicated worktree,
 * or one it has *joined* (a ticket whose `branch` is another ticket's branch
 * resolves to that branch's worktree, so review-bug fixes can ride along on the
 * same branch/worktree). When no worktree holds the branch, it falls back to the
 * engine workspace root (today's behavior). This is distinct from the engine
 * workspace root, which still owns the flux/ticket store, config, and watchers
 * (FLUX-520). Resolving by branch (not ticket id) is what makes "Join" work.
 */
export async function resolveTaskExecutionRoot(
  task: { id?: string; branch?: string } | undefined,
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<string> {
  const branch = task?.branch;
  if (!branch) return workspaceRoot;
  const match = await findWorktreeForBranch(workspaceRoot, branch, opts);
  return match ?? workspaceRoot;
}

/** Absolute path of the worktree currently checked out on `branch`, or null. */
export async function findWorktreeForBranch(
  workspaceRoot: string,
  branch: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<string | null> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const worktrees = await listWorktrees(runner, workspaceRoot);
  const match = worktrees.find((w) => w.branch === branch && existsSync(w.path));
  return match ? match.path : null;
}

/** List the task worktrees currently registered for this repo (under .eh-worktrees). */
export async function listTaskWorktrees(
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<WorktreeEntry[]> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const base = taskWorktreesBaseDir(workspaceRoot);
  const worktrees = await listWorktrees(runner, workspaceRoot);
  return worktrees.filter((w) => isUnder(w.path, base) && existsSync(w.path));
}

/**
 * Count how many files differ in `worktreePath` versus `baseBranch` — the
 * worktree's current working state (committed + uncommitted tracked changes)
 * plus untracked files. Powers the "N changed" badge on the board worktree chip
 * (FLUX-516). Best-effort: returns 0 when the worktree is gone or git errors.
 */
export async function worktreeChangeCount(
  worktreePath: string,
  baseBranch = 'master',
  opts: { gitRunner?: GitRunner } = {},
): Promise<number> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  if (!existsSync(worktreePath)) return 0;
  const countLines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).length;
  try {
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      runner(worktreePath, ['diff', '--name-only', baseBranch]).catch(() => ({ stdout: '' })),
      runner(worktreePath, ['ls-files', '--others', '--exclude-standard']).catch(() => ({ stdout: '' })),
    ]);
    return countLines(tracked) + countLines(untracked);
  } catch {
    return 0;
  }
}

/** Local branch names (`refs/heads/*`), for the "Attach to branch" picker (FLUX-516). */
export async function listLocalBranches(
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<string[]> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const { stdout } = await runner(workspaceRoot, [
    'for-each-ref', '--format=%(refname:short)', 'refs/heads',
  ]).catch(() => ({ stdout: '' }));
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Current branch name of `dir` (e.g. 'master'); 'HEAD' when detached, null on error. */
export async function currentBranchName(
  dir: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<string | null> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const { stdout } = await runner(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
  const branch = stdout.trim();
  return branch || null;
}

// ─── Serena per-worktree binding (FLUX-843) ──────────────────────────────────

/**
 * Write `<worktree>/.serena/project.local.yml` with a **unique** `project_name`
 * so Serena binds its language server (and its editing tools) to THIS worktree
 * instead of the main checkout (FLUX-843).
 *
 * Why this is needed: `.serena/project.yml` is committed with
 * `project_name: "EventHorizon"`, and git worktrees share all tracked files, so
 * every worktree would start Serena under the *same* name. Serena's project
 * registry is keyed by name, so `--project-from-cwd` from a worktree resolves to
 * the already-registered "EventHorizon" → the main checkout path, and symbol
 * edits silently land on `master` in the main tree. A unique name (derived from
 * the worktree dir, e.g. `EventHorizon-FLUX-843`) has no prior registration, so
 * `--project-from-cwd` registers/binds it at the worktree path.
 *
 * `project.local.yml` is gitignored, so it is per-checkout and never shared into
 * other worktrees. Best-effort: a failure here only degrades Serena binding, it
 * must not block worktree creation.
 */
export async function writeWorktreeSerenaOverride(worktreePath: string): Promise<void> {
  // The unique name is the worktree dir name (`<repo>-<ticketId>`), already
  // guaranteed unique per ticket by taskWorktreeDir().
  const projectName = path.basename(worktreePath);
  const dest = path.join(worktreePath, SERENA_PROJECT_LOCAL_RELPATH);
  const body =
    `# Auto-generated by EventHorizon (FLUX-843) — DO NOT COMMIT (gitignored).\n` +
    `# Binds Serena to THIS worktree by giving it a project_name that is not yet\n` +
    `# registered, so --project-from-cwd cannot resolve back to the main checkout's\n` +
    `# "EventHorizon" registration. Without this, Serena symbol edits land on master.\n` +
    `project_name: "${projectName}"\n`;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, body, 'utf8');
  } catch (err) {
    console.error(`[task-worktree] failed to write Serena override at ${dest}:`, err);
  }
}

// ─── Dependency links (FLUX-518) ─────────────────────────────────────────────

/**
 * Junction (Windows) / symlink (POSIX) the main tree's `node_modules` into the
 * worktree for each present workspace in WORKTREE_DEP_SUBDIRS, so the worktree
 * can build/test without a reinstall. Installs must still happen in the main
 * tree only — these are shared links, not copies. Best-effort per sub-path;
 * skips a sub-path that has no source deps, no worktree dir, or an existing link.
 */
export async function linkWorktreeDependencies(workspaceRoot: string, worktreePath: string): Promise<void> {
  // Junctions (not symlinks) on Windows so no Developer Mode / admin is needed.
  const linkType: 'junction' | 'dir' = process.platform === 'win32' ? 'junction' : 'dir';
  for (const sub of WORKTREE_DEP_SUBDIRS) {
    const src = path.join(workspaceRoot, sub, 'node_modules');
    const dest = path.join(worktreePath, sub, 'node_modules');
    if (!existsSync(src)) continue; // nothing installed to share for this sub
    if (!existsSync(path.join(worktreePath, sub))) continue; // sub-workspace absent in worktree
    if (existsSync(dest)) continue; // already present — don't overwrite
    try {
      await fs.symlink(src, dest, linkType);
    } catch (err) {
      console.error(`[task-worktree] failed to link ${dest} -> ${src}:`, err);
    }
  }
}

/**
 * Remove the node_modules links from a worktree WITHOUT touching their targets.
 * Acts only on entries that are actually symlinks/junctions (never a real dir),
 * using link-only deletes (unlink → rmdir fallback) that cannot recurse into the
 * shared dependencies. Call before `git worktree remove`.
 */
export async function unlinkWorktreeDependencies(worktreePath: string): Promise<void> {
  for (const sub of WORKTREE_DEP_SUBDIRS) {
    const dest = path.join(worktreePath, sub, 'node_modules');
    const stat = await fs.lstat(dest).catch(() => null);
    if (!stat || !stat.isSymbolicLink()) continue; // never delete a real directory
    try {
      await fs.unlink(dest);
    } catch {
      // Windows directory junctions sometimes need rmdir rather than unlink;
      // both remove only the reparse point, never the target's contents.
      await fs.rmdir(dest).catch(() => {});
    }
  }
}

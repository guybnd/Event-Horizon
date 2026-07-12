import fs from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { evictSharedServersForPath } from './shared-mcp-server.js';
// FLUX-999 (epic FLUX-996): defaultGitRunner used to be a bare execFileAsync — no timeout, no
// non-interactive env — so `git worktree add` (the spawn-agent-with-isolation path) could hang
// forever on a slow/unreachable remote or a stalled credential prompt. Route through the S1
// runner; every caller here goes through this one default (or an injected test runner).
import { runGit } from './git-exec.js';
import { cliSessionsById, getActiveSessionsForTask, isWithinReclaimGrace } from './session-store.js';
import { killDescendantsByPid, defaultKillWin32Pid } from './kill-process-tree.js';
import { findWorktreeLockHolders } from './worktree-lock-holders.js';
import { log } from './log.js';

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

/** Injectable git runner (matches group-member-worktree.ts for testability). */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) => runGit(args, { cwd });

/** Directory name (sibling of the repo) that holds all task worktrees. */
export const EH_WORKTREES_DIRNAME = '.eh-worktrees';

/** Default cap on simultaneous task worktrees. FLUX-521 overrides via settings. */
export const DEFAULT_MAX_TASK_WORKTREES = 4;

export interface TaskWorktreeOptions {
  gitRunner?: GitRunner;
  /** Max simultaneous task worktrees for this repo (default DEFAULT_MAX_TASK_WORKTREES). */
  maxWorktrees?: number;
  /** Branch to create the task branch from when it doesn't exist yet (default: the repo's
   *  resolved default branch — local master → main → origin/HEAD → 'master'). */
  baseBranch?: string | undefined;
  /** Junction the main tree's node_modules into the new worktree (default true). FLUX-518. */
  linkDependencies?: boolean;
  /** Injectable for tests (FLUX-1207) — defaults to the real killDescendantsByPid. */
  reapDescendantsByPid?: (pid: number) => Promise<number[]>;
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

/**
 * Same path as SERENA_PROJECT_LOCAL_RELPATH, but forward-slash-joined for use
 * as a git pathspec/exclude pattern (FLUX-1155) — `info/exclude` lines are
 * matched by git, not resolved by the OS, so a Windows backslash join would be
 * a literal (non-matching) pattern rather than a path separator.
 */
export const SERENA_PROJECT_LOCAL_GITIGNORE_PATTERN = '.serena/project.local.yml';

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

/** Parse `git worktree list --porcelain` output into { path, branch } entries. */
function parseWorktreeListPorcelain(stdout: string): WorktreeEntry[] {
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

/** List registered worktrees, swallowing a query failure to an empty list — the existing,
 *  established contract every OTHER caller in this file relies on (create/repair flows treat
 *  "couldn't tell" as "none found" and proceed; worst case `git worktree add` itself fails loudly
 *  on a genuine conflict). {@link isRegisteredWorktree} deliberately does NOT reuse this swallowing
 *  variant — see its own comment for why. */
async function listWorktrees(runner: GitRunner, workspaceRoot: string): Promise<WorktreeEntry[]> {
  const { stdout } = await runner(workspaceRoot, ['worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }));
  return parseWorktreeListPorcelain(stdout);
}

// ── Read-path registered-worktree cache (FLUX-1182) ─────────────────────────────
//
// `resolveResumeExecutionRoot` calls `isRegisteredWorktree` on EVERY resumed turn (not just the
// first) — a deliberate FLUX-1120 correctness fix that replaced what used to be a bare in-process
// `existsSync` check with a `git worktree list` subprocess. That's a new recurring cost on the
// hottest possible path (every message sent to every resumed session). Mirror the
// `reconcileBatchCached` TTL pattern (FLUX-1145 / d329715f — the near-identical "poll re-runs an
// expensive ground-truth check every request" shape) so a burst of turns against the same repo
// within the TTL window shares one `git worktree list` instead of re-shelling out per turn. Keyed
// by workspaceRoot: one shared list serves every ticket's resume check against that repo. A query
// FAILURE is never cached — `isRegisteredWorktree` falls back to `existsSync` on failure the same
// as before, and caching that failure would mask it as a completed pass for the rest of the TTL
// window (the FLUX-1145 review fix for the furnace reconcile gate, mirrored here for the same
// reason). `createTaskWorktree`/`removeTaskWorktree`/`pruneTaskWorktrees` invalidate their
// workspaceRoot's entry on entry, so a create/remove that lands in the same process is never
// masked by a stale list for the rest of the TTL window. FLUX-1195: the entry invalidation alone
// leaves a window between it and the mutating git command actually completing — a concurrent read
// that lands in that window can re-cache a pre-mutation snapshot for the rest of the TTL. Only
// `createTaskWorktree` needs a second, post-mutation invalidation to narrow that window (remove/
// prune are already covered by `isRegisteredWorktree`'s own `existsSync` check, per FLUX-1195).
const WORKTREE_LIST_READ_TTL_MS = 3_000;
const worktreeListReadCache = new Map<string, { entries: WorktreeEntry[]; at: number }>();
const worktreeListReadInFlight = new Map<string, Promise<WorktreeEntry[]>>();

function invalidateWorktreeListCache(workspaceRoot: string): void {
  worktreeListReadCache.delete(workspaceRoot);
}

async function listWorktreesCached(runner: GitRunner, workspaceRoot: string): Promise<WorktreeEntry[]> {
  const cached = worktreeListReadCache.get(workspaceRoot);
  if (cached && Date.now() - cached.at < WORKTREE_LIST_READ_TTL_MS) return cached.entries;
  const inFlight = worktreeListReadInFlight.get(workspaceRoot);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const { stdout } = await runner(workspaceRoot, ['worktree', 'list', '--porcelain']);
      const entries = parseWorktreeListPorcelain(stdout);
      worktreeListReadCache.set(workspaceRoot, { entries, at: Date.now() });
      return entries;
    } finally {
      worktreeListReadInFlight.delete(workspaceRoot);
    }
  })();
  worktreeListReadInFlight.set(workspaceRoot, p);
  return p;
}

async function localBranchExists(runner: GitRunner, workspaceRoot: string, branch: string): Promise<boolean> {
  try {
    await runner(workspaceRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Actionable error for the case where `branch` is checked out in the MAIN checkout
 * (the primary worktree). Git allows a branch in only one worktree, so EH can't
 * `git worktree add` a dedicated tree for it, and running the agent in the main
 * checkout is exactly the run-on-master case the spawn/resume guards refuse. Both
 * the execution-root resolver and the worktree-creation primitive surface this so
 * the user sees the real cause and remedy — not the misleading "worktree is
 * missing" the downstream guards emit (they can't tell "never created" apart from
 * "the branch is pinned in the main checkout").
 */
function branchPinnedToMainCheckoutError(branch: string, workspaceRoot: string, id?: string): Error {
  return new Error(
    `Branch '${branch}' is currently checked out in the main checkout (${workspaceRoot}), ` +
      `so EH can't create an isolated worktree for ${id ?? 'this ticket'} — git allows a branch in ` +
      `only one worktree at a time, and it won't run the agent in the main checkout. Switch the main ` +
      `checkout to another branch (e.g. \`git checkout master\`) to free '${branch}', then retry.`,
  );
}

/**
 * Resolve the ref a new task branch should be created from when the caller didn't
 * pass an explicit `baseBranch`. Hardcoding 'master' breaks any repo whose default
 * branch is 'main': `git worktree add -b <branch> <path> master` fails with
 * "fatal: invalid reference: master", which aborts the entire spawn-with-isolation
 * path and leaves the agent session unable to start (FLUX-167). Probe the local
 * branches that actually exist (master, then main — matching diff-aggregator's
 * `resolveBaseBranch`), then fall back to origin's advertised default, then 'master'.
 */
async function resolveDefaultBaseBranch(runner: GitRunner, workspaceRoot: string): Promise<string> {
  for (const candidate of ['master', 'main']) {
    if (await localBranchExists(runner, workspaceRoot, candidate)) return candidate;
  }
  try {
    // Keep the `origin/` prefix: this is only reached when neither local master nor
    // main exists, so the bare branch name may have no local copy to resolve against.
    // The remote-tracking ref always resolves as a commit-ish for `git worktree add -b`.
    const { stdout } = await runner(workspaceRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = stdout.trim();
    if (ref) return ref;
  } catch {
    /* no origin/HEAD configured — fall through to the last-resort default */
  }
  return 'master';
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────────

/**
 * Create (or reuse) the task worktree for `ticketId` on `branch`.
 *
 * - Idempotent: if the target path is already a worktree on `branch`, returns it.
 * - Branch-exclusivity guard: if `branch` is already checked out at another
 *   EH-managed path, throws (never uses --force) with the `git worktree remove`
 *   remedy. If it is checked out OUTSIDE `.eh-worktrees/` (a manual checkout),
 *   that external tree is reused in place as the execution root (FLUX-1059).
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
  const baseBranch = opts.baseBranch ?? (await resolveDefaultBaseBranch(runner, workspaceRoot));
  const target = taskWorktreeDir(workspaceRoot, ticketId);
  const base = taskWorktreesBaseDir(workspaceRoot);
  // FLUX-1182: this may add/repair a registered worktree below — drop the cached
  // `isRegisteredWorktree` read so a resume check racing this call never sees a
  // pre-mutation list for the rest of the TTL window.
  invalidateWorktreeListCache(workspaceRoot);

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
      await writeWorktreeSerenaOverride(target, { gitRunner: runner });
      return target;
    }
    throw new Error(
      `A worktree already exists at ${target} on a different branch (${atTarget.branch ?? 'detached'}).`,
    );
  }

  // FLUX-1018 — orphaned tree self-heal. The target DIRECTORY exists but git has
  // no worktree record for it (the `worktree prune` above dropped the entry
  // because its `<target>/.git` link file was deleted / points nowhere — the live
  // "gitdir points to non-existent location" corruption). A plain `git worktree
  // add <target> <branch>` would then fail with "already exists", so the branch
  // could never get a working tree and the agent would fall back to master. Try
  // `git worktree repair <target>` to re-link the existing tree; if that
  // re-registers it on our branch, reuse it in place instead of recreating.
  if (existsSync(target)) {
    // FLUX-1277 — an empty leftover directory carries nothing to lose (e.g. a
    // Windows cleanup deleted the contents but the top-level rmdir failed because
    // something briefly held a handle). Reclaim it instead of refusing — there's
    // no un-pushed work to protect, and `git worktree repair` would fail anyway
    // with no `.git` link file to re-link.
    const entries = await fs.readdir(target).catch(() => null);
    if (entries !== null && entries.length === 0) {
      console.warn(`[task-worktree] reclaiming empty leftover directory at ${target}`);
      await fs.rmdir(target);
    } else {
      const attemptRepair = async () => {
        await runner(workspaceRoot, ['worktree', 'repair', target]).catch((err) =>
          console.error('[task-worktree] worktree repair on orphaned tree failed:', err),
        );
        // FLUX-1195: repair just changed the registered set — invalidate again so a read racing
        // this call isn't served a pre-repair snapshot for the rest of the TTL window.
        invalidateWorktreeListCache(workspaceRoot);
        return (await listWorktrees(runner, workspaceRoot)).find((w) => pathsEqual(w.path, target));
      };

      let repaired = await attemptRepair();
      if (!repaired) {
        // FLUX-1207: repair can fail because an orphaned descendant of a killed session (e.g. a
        // Bash-tool-launched vitest run) still holds a Windows file-handle lock on the worktree
        // dir. Best-effort reap any known session pid for this ticket, then retry once before
        // giving up.
        const pids = [...cliSessionsById.values()]
          .filter((s) => s.taskId === ticketId && typeof s.pid === 'number')
          .map((s) => s.pid as number);
        if (pids.length > 0) {
          const reap = opts.reapDescendantsByPid ?? killDescendantsByPid;
          const killedGroups = await Promise.all(pids.map((pid) => reap(pid).catch(() => [] as number[])));
          const killed = killedGroups.flat();
          if (killed.length > 0) {
            console.warn(
              `[task-worktree] ${ticketId}: reaped orphaned descendant pid(s) ${killed.join(', ')} before retrying worktree repair`,
            );
          }
          repaired = await attemptRepair();
        }
      }
      if (repaired) {
        if (repaired.branch === branch) {
          if (opts.linkDependencies !== false) {
            await linkWorktreeDependencies(workspaceRoot, target).catch((err) =>
              console.error('[task-worktree] re-linking node_modules after repair failed:', err),
            );
          }
          await writeWorktreeSerenaOverride(target, { gitRunner: runner });
          return target;
        }
        throw new Error(
          `A worktree already exists at ${target} on a different branch (${repaired.branch ?? 'detached'}).`,
        );
      }
      // Repair could not re-register the tree (e.g. its .git metadata is gone
      // entirely). Refuse rather than let `git worktree add` fail cryptically or,
      // worse, degrade to master.
      throw new Error(
        `A directory already exists at ${target} but is not a valid git worktree and could not be repaired. ` +
          `Remove it and retry.`,
      );
    }
  }

  // Branch-exclusivity — git already refuses to check a branch out twice, so at
  // most ONE live worktree holds `branch`. Where it lives decides what we do
  // (FLUX-1059). A stale record whose dir is gone is skipped here — the prune
  // above already dropped it, so `git worktree add` below can recreate cleanly.
  const holder = worktrees.find((w) => w.branch === branch && existsSync(w.path));
  if (holder) {
    if (pathsEqual(holder.path, workspaceRoot)) {
      // The one external tree we must NOT reuse in place: the main checkout
      // itself. Reusing it would hand the agent the primary tree (run-on-master),
      // which every spawn/resume guard refuses. Throw the actionable "free the
      // branch" error instead of falling through to a cryptic `git worktree add`
      // failure ("fatal: '<branch>' is already checked out at <main>").
      throw branchPinnedToMainCheckoutError(branch, workspaceRoot, ticketId);
    }
    if (!isUnder(holder.path, base)) {
      // Checked out OUTSIDE .eh-worktrees/ — a dev's manual checkout, or one the
      // agent created as a workaround after an earlier failure. Not ours to
      // manage: reuse it in place as the execution root rather than hard-blocking
      // re-entry. Returned untouched (no dep-linking / Serena rebind), matching
      // the findWorktreeForBranch happy path that already accepts external trees.
      return holder.path;
    }
    // A genuine EH-managed collision (another task worktree on the same branch).
    // Refuse — but name the blocking path and give the exact remedy.
    throw new Error(
      `Branch '${branch}' is already checked out at ${holder.path} ` +
        `(an EH-managed worktree). Refusing to create a second worktree for the same branch. ` +
        `Remove it with:\n  git worktree remove ${holder.path}\nthen retry.`,
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
  // FLUX-1195: the entry invalidation above covers the whole function body's window, but a read
  // that lands between it and this mutation actually completing could still cache a pre-mutation
  // (missing-entry) snapshot for the rest of the TTL window. Invalidate again right after the
  // mutation itself completes, narrowing the race to the mutation's own subprocess duration.
  invalidateWorktreeListCache(workspaceRoot);

  // Make the worktree runnable by sharing the main tree's installed deps
  // (best-effort; no-op when the repo has no node_modules) — FLUX-518.
  if (opts.linkDependencies !== false) {
    await linkWorktreeDependencies(workspaceRoot, target).catch((err) =>
      console.error('[task-worktree] linking node_modules failed:', err),
    );
  }

  // Bind Serena to this worktree (not the main checkout) so its symbol-editing
  // tools write here — FLUX-843.
  await writeWorktreeSerenaOverride(target, { gitRunner: runner });

  return target;
}

/**
 * Injectable lock-holder reaping hooks (FLUX-1216), shared by {@link removeTaskWorktree}'s
 * leftover-directory sweep and {@link pruneTaskWorktrees}'s orphan sweep so both go through the
 * exact same best-effort reap-then-remove routine.
 */
interface WorktreeReapOptions {
  /** Reap descendants of a KNOWN session pid (FLUX-1207) — defaults to killDescendantsByPid. */
  reapDescendantsByPid?: (pid: number) => Promise<number[]>;
  /** Find lock holders by command-line path match, for dirs with no tracked session pid at all
   *  (FLUX-1216) — defaults to findWorktreeLockHolders. */
  findLockHolders?: (worktreePath: string, baseDir: string) => Promise<number[]>;
  /** Kill a single pid found by findLockHolders — defaults to defaultKillWin32Pid. */
  killPid?: (pid: number) => void;
}

/**
 * Best-effort: reap every lock holder we can find for `worktreePath` (both a KNOWN ticket
 * session's descendants, and any process whose command line resolves under the path — the latter
 * catches holders with no tracked session at all, e.g. a session that ended hours/days earlier
 * and was already dropped from `cliSessionsById`, or an ad-hoc test server the agent started and
 * never stopped), then remove the directory. Logs — never silently swallows — when the directory
 * survives the attempt, naming the path and any holders killed, so a folder that resists removal
 * is visible instead of accumulating unnoticed (the 2026-07-06 incident this closes: 13 stale
 * folders nobody knew were there).
 */
async function reapWorktreeLockHoldersAndRemove(
  worktreePath: string,
  base: string,
  ticketId: string | null,
  runner: GitRunner,
  opts: WorktreeReapOptions,
): Promise<void> {
  if (!existsSync(worktreePath)) return;

  // Safety net: never discard real uncommitted work. A genuine leftover has no valid git
  // metadata left by this point (its registration was already dropped — the expected case), so
  // `git status` fails and — matching removeTaskWorktree's own established convention just above
  // (a query failure reads as "nothing to lose") — is treated as clean. This only actually
  // protects the rarer case where a directory lost its git worktree REGISTRATION (e.g. the
  // FLUX-1018 "gitdir points to non-existent location" corruption) while still holding a real,
  // dirty checkout.
  const { stdout: status } = await runner(worktreePath, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
  if (status.trim().length > 0) {
    console.warn(
      `[task-worktree] ${ticketId ?? worktreePath}: skipping sweep of ${worktreePath} — it still has uncommitted changes.`,
    );
    return;
  }

  // FLUX-518: strip the shared node_modules junctions BEFORE any recursive delete, exactly like
  // removeTaskWorktree's own git-remove path does — otherwise `fs.rm(recursive)` can follow a
  // junction still intact in an orphaned directory and destroy the main tree's real dependencies.
  await unlinkWorktreeDependencies(worktreePath).catch(() => {});

  // Try a plain removal FIRST. Most leftover directories are no longer actually locked by the
  // time this runs (the holder exited seconds/minutes ago) — only escalate to hunting down and
  // killing lock-holder processes (which, via the command-line path matcher, can affect processes
  // this engine never spawned at all, e.g. a user's own editor with the folder open) when a plain
  // removal genuinely didn't work.
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  if (!existsSync(worktreePath)) return;

  const sessionPids = ticketId
    ? [...cliSessionsById.values()]
        .filter((s) => s.taskId === ticketId && typeof s.pid === 'number')
        .map((s) => s.pid as number)
    : [];
  const reap = opts.reapDescendantsByPid ?? killDescendantsByPid;
  const findHolders = opts.findLockHolders ?? findWorktreeLockHolders;
  const killPid = opts.killPid ?? defaultKillWin32Pid;

  const [reapedGroups, pathHolders] = await Promise.all([
    Promise.all(sessionPids.map((pid) => reap(pid).catch(() => [] as number[]))),
    findHolders(worktreePath, base).catch(() => [] as number[]),
  ]);
  for (const pid of pathHolders) {
    try {
      killPid(pid);
    } catch {
      /* already gone */
    }
  }
  const killed = [...new Set([...reapedGroups.flat(), ...pathHolders])];
  if (killed.length > 0) {
    console.warn(
      `[task-worktree] ${ticketId ?? worktreePath}: reaped orphaned lock-holder pid(s) ${killed.join(', ')} before removing ${worktreePath}`,
    );
  }

  // A kill (`killPid`/the reap helpers) is fire-and-forget — it returns once the OS accepts the
  // termination request, not once the target has actually exited and released its handle on the
  // directory. An immediate retry can still lose that race (empirically ~25-50ms to clear); a
  // few short-backoff attempts covers the common case without an unbounded/long wait.
  for (let attempt = 0; existsSync(worktreePath) && attempt < 5; attempt++) {
    await sleep(50);
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }
  if (existsSync(worktreePath)) {
    console.warn(
      `[task-worktree] failed to remove leftover worktree directory ${worktreePath}` +
        (killed.length > 0
          ? ` even after killing lock-holder pid(s) ${killed.join(', ')}`
          : ' (no lock holders found)') +
        ' — will be retried on the next prune sweep.',
    );
  }
}

/**
 * Remove a task worktree on the clean finish path (after the agent committed).
 * Falls back to --force only if the plain remove fails (e.g. leftover ignored
 * build artifacts), then prunes git's administrative records.
 */
export async function removeTaskWorktree(
  workspaceRoot: string,
  worktreePath: string,
  opts: { gitRunner?: GitRunner } & WorktreeReapOptions = {},
): Promise<void> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  // FLUX-1182: this removes a registered worktree below — drop the cached
  // `isRegisteredWorktree` read (see createTaskWorktree for the same rationale).
  invalidateWorktreeListCache(workspaceRoot);
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
  // window still open on the worktree — FLUX-522 makes this routine, FLUX-1207/
  // FLUX-1216 found it can also be a FULL leftover tree when an orphaned
  // descendant process — a zombie vitest run, an ad-hoc test server — holds a
  // Windows file-handle lock inside it). A leftover shell at the target path
  // later blocks `git worktree add` for the same ticket, so sweep it. Guarded to
  // our own .eh-worktrees subtree.
  if (existsSync(worktreePath) && isUnder(worktreePath, taskWorktreesBaseDir(workspaceRoot))) {
    const leftoverTicketId = ticketIdFromWorktreePath(workspaceRoot, worktreePath);
    await reapWorktreeLockHoldersAndRemove(worktreePath, taskWorktreesBaseDir(workspaceRoot), leftoverTicketId, runner, opts);
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
 * Prune git's records of task worktrees whose directories were removed out of band (manual
 * delete, crash), THEN sweep `.eh-worktrees/` itself for orphaned directories — ones that are no
 * longer a registered git worktree and have no active session — reaping any lock-holder processes
 * and deleting them (FLUX-1216). Unlike the pre-FLUX-1216 version, this is NOT limited to git's
 * bookkeeping: it does real, best-effort filesystem deletion and can force-kill OS processes.
 * Fire-and-forget safe to call on every engine boot/workspace activation — a directory that fails
 * to clear (still dirty, still locked after a retry) is simply left for the next call.
 */
export async function pruneTaskWorktrees(
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner; isSessionActiveForTask?: (ticketId: string) => boolean } & WorktreeReapOptions = {},
): Promise<void> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  // FLUX-1182: prune can deregister worktrees below — drop the cached
  // `isRegisteredWorktree` read (see createTaskWorktree for the same rationale).
  invalidateWorktreeListCache(workspaceRoot);
  await runner(workspaceRoot, ['worktree', 'prune']).catch(() => {});

  // FLUX-1216: the `worktree prune` above only drops git's RECORD of a worktree whose directory
  // is already gone — nothing before this ever re-attempted deleting a directory that survived
  // (e.g. because a lock holder blocked the first attempt in removeTaskWorktree). That let 13
  // stale folders accumulate silently (2026-07-06 incident) with no retry. Sweep the base dir
  // directly on every call — this runs on workspace activation (engine boot), so a folder that
  // fails once gets retried on every subsequent boot instead of being stranded forever.
  const base = taskWorktreesBaseDir(workspaceRoot);
  const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;

  // FLUX-1216 review fix: deliberately does NOT reuse the swallowing `listWorktrees` here. That
  // helper's "query failure → []" contract is safe for its OTHER callers (create/repair flows read
  // an empty result as "nothing registered, proceed" and worst case a subsequent `git worktree add`
  // fails loudly on a genuine conflict) but is the WRONG default here: this `[]` feeds an ALLOW-LIST
  // ("registeredPaths") that gates deletion, so reading a transient query hiccup (index.lock
  // contention, a slow/timed-out spawn) as "confirmed zero worktrees registered" would make every
  // real, live worktree look orphaned and the sweep below would force-kill its holders and delete
  // it — directly violating this routine's own "never touch a registered worktree" contract
  // (mirrors {@link isRegisteredWorktree}'s own reasoning for not reusing `listWorktrees` either).
  // Bail out of the whole sweep on a query failure instead; it is safely retried on the next
  // boot/workspace-activation call, matching this routine's fire-and-forget design.
  let registered: WorktreeEntry[];
  try {
    const { stdout } = await runner(workspaceRoot, ['worktree', 'list', '--porcelain']);
    registered = parseWorktreeListPorcelain(stdout);
  } catch (err) {
    console.warn(
      `[task-worktree] pruneTaskWorktrees: 'git worktree list' failed for ${workspaceRoot} — ` +
        `skipping the orphan sweep this pass (will retry on the next activation):`,
      err,
    );
    return;
  }
  const registeredPaths = new Set(registered.map((w) => canonical(w.path)));
  // FLUX-1216: this sweep runs fire-and-forget from workspace activation (task-store.ts), which
  // starts BEFORE `rehydrateSessionStubs()` repopulates the in-memory session map from persisted
  // stubs on this same boot — so `getActiveSessionsForTask` alone can read as "nothing active" for
  // a ticket whose session is genuinely about to be restored. `isWithinReclaimGrace()` is the
  // existing post-restart buffer built for exactly this class of race (see its callers in
  // pr-cleanup.ts's worktreeUnreclaimableReason) — during that window, presume every ticket may
  // still be active and skip the sweep entirely rather than risk deleting a live session's worktree.
  //
  // Residual, deliberately deferred scope (mirrors this ticket's own "acceptable to miss on v1"
  // framing): this check is ticket-id-scoped, not branch-scoped, so a directory that lost its git
  // registration while a *joined* sibling ticket's session is still using it (pr-cleanup.ts's
  // hasLiveSessionOnBranch handles that case for the registered-worktree reclaim path) isn't
  // covered here — task-worktree.ts can't see ticket branch/board data without a circular import
  // on task-store.ts. Narrower risk than it sounds: the directory must ALSO already be
  // git-unregistered for this sweep to ever see it in the first place.
  const isSessionActive =
    opts.isSessionActiveForTask ?? ((ticketId: string) => isWithinReclaimGrace() || getActiveSessionsForTask(ticketId).length > 0);

  const candidates: Array<{ dirPath: string; ticketId: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(base, entry.name);
    // Still a live/registered worktree — never touch, even if its session looks inactive (e.g. a
    // human editing it manually, or a race with a session about to (re)start).
    if (registeredPaths.has(canonical(dirPath))) continue;

    // Unparseable / belongs to a different repo sharing this same `.eh-worktrees` parent (FLUX-1207
    // review precedent: fail CLOSED on an unidentifiable dir, never sweep something we can't
    // positively attribute to one of THIS repo's tickets).
    const ticketId = ticketIdFromWorktreePath(workspaceRoot, dirPath);
    if (!ticketId) continue;
    if (isSessionActive(ticketId)) continue;

    candidates.push({ dirPath, ticketId });
  }

  // Each candidate is an independent directory/ticket — sweep them concurrently so N stale
  // folders (the 2026-07-06 incident found 13) cost roughly the slowest single one, not their sum.
  await Promise.all(candidates.map(({ dirPath, ticketId }) => reapWorktreeLockHoldersAndRemove(dirPath, base, ticketId, runner, opts)));
}

/**
 * Resolve the **agent execution root** for a task (FLUX-519). A task runs in
 * whatever worktree currently holds **its branch** — its own dedicated worktree,
 * or one it has *joined* (a ticket whose `branch` is another ticket's branch
 * resolves to that branch's worktree, so review-bug fixes can ride along on the
 * same branch/worktree). This is distinct from the engine workspace root, which
 * still owns the flux/ticket store, config, and watchers (FLUX-520). Resolving
 * by branch (not ticket id) is what makes "Join" work.
 *
 * FLUX-1018 — **fail closed** on the spawn path. Previously, when `task.branch`
 * was set but no live worktree held it (dir removed / `.git` link broken /
 * pruned), this quietly returned `workspaceRoot` — the MAIN checkout, which sits
 * on master. Adapters spawn with `cwd = executionRoot`, and a single-shot agent
 * (Copilot `-p`) never checks the branch out itself, so it committed straight to
 * master (the FLUX-972 incident: its commit landed on master, not its branch).
 * Now the branch-set-but-no-worktree case **self-heals** by recreating the
 * worktree (`createTaskWorktree`, idempotent), and only if that fails does it
 * throw — it never silently degrades to master. `create:false` opts read-only
 * callers (diff/status/tests) out of the side effect, preserving the old
 * fall-back-to-root behavior for them.
 *
 * FLUX-1018 (follow-up) — this is deliberate: **a branch implies a worktree on
 * the spawn path.** Even when a ticket was started "branch only" (worktree:false
 * — see ticket-isolation.ts), the spawn resolves through here with `create`
 * defaulting true, so it gets a dedicated worktree rather than running on the
 * shared main checkout. That is the fail-closed invariant, not an accident:
 * "branch but no worktree on master" is the unsafe mode that let a single-shot
 * agent commit to master (FLUX-972). The genuine "run in the main tree" escape
 * is to stay branchless (no `task.branch` → returns `workspaceRoot`); a branch
 * always earns isolation. The RESUME fallback passes `create:false` so a legacy
 * session missing its recorded `executionRoot` does not spin up a fresh worktree
 * mid-resume — its adapter guard fails closed on the returned `workspaceRoot`
 * instead.
 */
export async function resolveTaskExecutionRoot(
  task: { id?: string; branch?: string } | undefined,
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner; create?: boolean; baseBranch?: string | undefined; maxWorktrees?: number } = {},
): Promise<string> {
  const branch = task?.branch;
  if (!branch) return workspaceRoot;
  const match = await findWorktreeForBranch(workspaceRoot, branch, opts);
  // A dedicated tree elsewhere (an .eh-worktrees tree, or a dev's manual checkout
  // in some other directory — FLUX-1059) is a valid isolated root. The MAIN
  // checkout is not: the branch being pinned there is precisely why no isolated
  // worktree exists, and running the agent in it is the run-on-master case the
  // spawn/resume guards refuse. Surface the real cause + remedy here rather than
  // returning workspaceRoot and letting the downstream guard emit a misleading
  // "worktree is missing" (it can't tell that apart from a genuinely absent tree).
  if (match && !pathsEqual(match, workspaceRoot)) return match;
  if (match) throw branchPinnedToMainCheckoutError(branch, workspaceRoot, task?.id);

  // No live worktree holds this branch. Read-only callers (create:false) keep the
  // legacy behavior — resolve to the workspace root without side effects.
  if (opts.create === false) return workspaceRoot;

  // Spawn path (create defaults to true): recreate the missing worktree rather
  // than silently running the agent on master. Requires a ticket id to name it.
  const id = task?.id;
  if (!id) return workspaceRoot;
  try {
    return await createTaskWorktree(
      workspaceRoot,
      id,
      branch,
      {
        ...(opts.gitRunner ? { gitRunner: opts.gitRunner } : {}),
        ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
        ...(opts.maxWorktrees != null ? { maxWorktrees: opts.maxWorktrees } : {}),
      },
    );
  } catch (err: unknown) {
    throw new Error(
      `Worktree for ${id} on branch '${branch}' is missing and could not be recreated ` +
        `(${err instanceof Error ? err.message : err}) — refusing to run the agent on master.`,
      { cause: err },
    );
  }
}

/**
 * FLUX-1120: is `executionRoot` still a live, registered git worktree of the repo rooted at
 * `workspaceRoot`? True only when `git worktree list` (run against the MAIN checkout, so a stale
 * linked tree can't lie about its own registration) reports an entry whose path resolves to
 * `executionRoot` AND that path still exists on disk. Stricter than a bare `existsSync`: a
 * worktree directory can survive on disk after `git worktree remove` deregistered it (or after
 * something removed it outside git's bookkeeping, leaving `.git`/index files behind), in which
 * case every git command run inside it fails with an opaque `fatal: not a git repository` rather
 * than a clear "this workspace was reclaimed" signal — this check catches that stale-but-present
 * case, not just the fully-vanished one.
 *
 * Deliberately does NOT go through {@link listWorktrees} (which swallows a query failure to an
 * empty list) — that swallowing is fine for create/repair flows (worst case they retry a
 * `git worktree add` that fails loudly on a genuine conflict), but here it would turn a *transient*
 * `git worktree list` hiccup (lock contention, a momentary spawn error) into a false-positive
 * "this worktree has been reclaimed," permanently failing a perfectly healthy, resumable session
 * (review finding). A genuine query failure falls back to the pre-FLUX-1120 `existsSync`-only
 * signal instead — only a QUERY THAT SUCCEEDS and doesn't list the path counts as "reclaimed."
 */
export async function isRegisteredWorktree(
  workspaceRoot: string,
  executionRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<boolean> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  let entries: WorktreeEntry[];
  try {
    entries = await listWorktreesCached(runner, workspaceRoot);
  } catch {
    return existsSync(executionRoot);
  }
  return entries.some((w) => pathsEqual(w.path, executionRoot) && existsSync(w.path));
}

/**
 * Resume-path fail-closed guard (FLUX-1018 / FLUX-1028) — shared by all three
 * adapters' `sendCliSessionInput`, replacing what was a verbatim triple
 * duplication. Resolves READ-ONLY (`create: false`): never spins up a fresh
 * worktree mid-resume for a legacy session that lost its recorded
 * `executionRoot` — the spawn path (`resolveTaskExecutionRoot` via
 * {@link assertIsolatedSpawnRoot}) owns creation. Then fails closed two ways:
 * a branch-bearing ticket that resolved to the main checkout (no live
 * worktree) must not resume on master, and a recorded/resolved worktree path
 * that is no longer a registered git worktree (FLUX-1120 — reclaimed, or
 * vanished outright) is refused rather than silently resumed there.
 */
export async function resolveResumeExecutionRoot(
  session: { executionRoot?: string; taskId: string },
  task: { id?: string; branch?: string } | undefined,
  workspaceRoot: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<string> {
  const id = session.taskId;
  const executionRoot =
    session.executionRoot ?? (await resolveTaskExecutionRoot(task, workspaceRoot, { ...opts, create: false }));
  if (task?.branch && executionRoot === workspaceRoot) {
    throw new Error(
      `Worktree for ${id} is missing — refusing to resume the agent on master. Restart the session to recreate an isolated worktree.`,
    );
  }
  if (executionRoot !== workspaceRoot && !(await isRegisteredWorktree(workspaceRoot, executionRoot, opts))) {
    throw new Error(
      `Worktree for ${id} at ${executionRoot} has been reclaimed — it is no longer a registered git worktree — refusing to resume the agent there. Restart the session to recreate an isolated worktree.`,
    );
  }
  return executionRoot;
}

/**
 * Spawn-path fail-closed guard (FLUX-1018 / FLUX-1028) — shared by all three
 * adapters' `startCliSession`, replacing what was a verbatim triple
 * duplication. A task WITH a branch must run in that branch's worktree, never
 * the main checkout (master); a single-shot agent spawned with
 * `cwd = workspaceRoot` would commit straight to master (the FLUX-972
 * incident). `resolveTaskExecutionRoot` already self-heals/throws on this
 * path, but callers assert here too as a belt-and-suspenders guard.
 */
export function assertIsolatedSpawnRoot(
  frameworkLabel: string,
  id: string,
  task: { branch?: string } | undefined,
  executionRoot: string,
  workspaceRoot: string,
): void {
  if (task?.branch && executionRoot === workspaceRoot) {
    throw new Error(
      `Refusing to start ${frameworkLabel} for ${id} on branch '${task.branch}': its worktree is missing and ` +
        `execution resolved to the main checkout (master). Recreate the worktree and retry.`,
    );
  }
}

/**
 * Absolute path of the worktree currently checked out on `branch`, or null.
 *
 * Returns ANY worktree holding the branch whose directory still exists —
 * INCLUDING one outside `.eh-worktrees/` (a manual/dev checkout). That is
 * deliberate (FLUX-1059): such a tree is a valid execution root, so re-entry
 * reuses it rather than refusing. The `existsSync` guard skips a stale git
 * record whose dir is gone, so callers fall through to (re)create instead of
 * resolving to a path that no longer exists.
 */
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
 * Recover the owning ticket id from a task worktree path. Worktrees are named
 * `<repo>-<id>` (see {@link taskWorktreeDir}); reverse that. Returns null when
 * the path is not a task worktree of this repo (so callers can skip it).
 */
export function ticketIdFromWorktreePath(workspaceRoot: string, worktreePath: string): string | null {
  const base = taskWorktreesBaseDir(workspaceRoot);
  if (!isUnder(worktreePath, base)) return null;
  const prefix = `${path.basename(path.resolve(workspaceRoot))}-`;
  const name = path.basename(path.resolve(worktreePath));
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null;
}

/**
 * Reclaim task worktrees whose owning ticket is reclaimable (e.g. in a terminal
 * status) AND which hold no uncommitted work. This is how a full concurrency cap
 * self-heals (FLUX-1018): stale Done/Released/Archived worktrees that post-merge
 * cleanup left behind otherwise occupy slots forever, forcing a genuinely new
 * task to fail isolation and fall back onto master. Never discards real work —
 * the node_modules junctions are unlinked first (they aren't "work"), then a
 * worktree is removed ONLY when its tree is genuinely clean; a dirty reclaimable
 * worktree is skipped for explicit detach. Returns the ticket ids reclaimed.
 */
export async function reclaimWorktrees(
  workspaceRoot: string,
  isReclaimable: (ticketId: string) => boolean | string | Promise<boolean | string>,
  opts: { gitRunner?: GitRunner } = {},
): Promise<string[]> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const reclaimed: string[] = [];
  for (const wt of await listTaskWorktrees(workspaceRoot, opts)) {
    const id = ticketIdFromWorktreePath(workspaceRoot, wt.path);
    if (!id) continue;
    let rule = await isReclaimable(id);
    if (!rule) continue;
    // Drop the shared node_modules junctions first so they don't read as dirty,
    // then only remove when the tree is genuinely clean — never lose real work.
    await unlinkWorktreeDependencies(wt.path).catch(() => {});
    const { stdout } = await runner(wt.path, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
    if (stdout.trim().length > 0) continue; // real uncommitted work — leave it
    // TOCTOU re-check (FLUX-1031): the awaits above (dependency unlink + git status) open a
    // window in which a session can register on this worktree's branch — e.g. a fresh spawn
    // between worktree resolution and `registerSession`, or a joined sibling starting work.
    // Re-evaluate reclaimability immediately before removal so the sweep never yanks a slot
    // from work that started mid-iteration.
    rule = await isReclaimable(id);
    if (!rule) continue;
    try {
      await removeTaskWorktree(workspaceRoot, wt.path, opts);
      reclaimed.push(id);
      // FLUX-1305: name the rule that fired — previously silent, so a worktree vanishing left no
      // trace anywhere (engine log or ticket history) for the next debugger to find.
      log.info(`[worktree-reclaim] removed ${id} at ${wt.path} (rule: ${typeof rule === 'string' ? rule : 'reclaimable'})`);
    } catch {
      // Best-effort — a lock/leftover reconciles on the next prune.
    }
  }
  return reclaimed;
}

/**
 * Pathspec excludes for the `node_modules` junctions FLUX-518 shares into every worktree (see
 * `WORKTREE_DEP_SUBDIRS`). `reclaimWorktrees`/`cleanupMergedBranch` keep dirty-checks accurate by
 * unlinking those junctions before running git — safe there because they only ever act on
 * terminal, reclaim-eligible worktrees. `worktreeChangeCount`/`worktreeIsDirty` below instead run
 * against worktrees that may have a LIVE agent session using node_modules, so they can't unlink
 * anything; a pathspec exclude is a pure git-side filter that never touches the filesystem, and
 * unlike the unlink approach it doesn't depend on `.gitignore` covering `node_modules` either.
 */
export function depNodeModulesExcludePathspecs(): string[] {
  return WORKTREE_DEP_SUBDIRS.map((sub) => (sub === '.' ? 'node_modules' : `${sub}/node_modules`)).map((p) => `:!${p}`);
}

/**
 * Count how many files differ in `worktreePath` versus each of `baseBranches` — the
 * worktree's current working state (committed + uncommitted tracked changes) plus
 * untracked files. The untracked-file listing doesn't depend on the diff base, so it's
 * spawned ONCE and reused across every base branch (FLUX-1126: `/uncommitted-count` used
 * to call the single-base `worktreeChangeCount` twice per worktree — vs `HEAD` and vs
 * `master` — spawning a duplicate, identical `ls-files` each time). Best-effort: every
 * entry is 0 when the worktree is gone or git errors.
 */
export async function worktreeChangeCounts(
  worktreePath: string,
  baseBranches: string[],
  opts: { gitRunner?: GitRunner } = {},
): Promise<Record<string, number>> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const uniqueBranches = Array.from(new Set(baseBranches));
  const zeroed = () => Object.fromEntries(uniqueBranches.map((b) => [b, 0]));
  if (!existsSync(worktreePath)) return zeroed();
  const countLines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).length;
  const excludes = depNodeModulesExcludePathspecs();
  try {
    const [{ stdout: untracked }, ...trackedResults] = await Promise.all([
      runner(worktreePath, ['ls-files', '--others', '--exclude-standard', '--', '.', ...excludes]).catch(() => ({ stdout: '' })),
      ...uniqueBranches.map((b) =>
        runner(worktreePath, ['diff', '--name-only', b, '--', '.', ...excludes]).catch(() => ({ stdout: '' })),
      ),
    ]);
    const untrackedCount = countLines(untracked);
    const result: Record<string, number> = {};
    uniqueBranches.forEach((b, i) => {
      result[b] = countLines(trackedResults[i]?.stdout ?? '') + untrackedCount;
    });
    return result;
  } catch {
    return zeroed();
  }
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
  const counts = await worktreeChangeCounts(worktreePath, [baseBranch], opts);
  return counts[baseBranch] ?? 0;
}

/**
 * Count of genuinely UNCOMMITTED changes in `worktreePath` — working-tree modifications plus
 * untracked files, from `git status --porcelain` against the worktree's own HEAD. Unlike
 * {@link worktreeChangeCount} (a diff against a base branch), this can't be inflated by base-branch
 * drift: a worktree whose branch has zero commits of its own (e.g. a review-confirmation ticket
 * whose fix already shipped under a different PR) is byte-identical to the commit it was cut
 * from, but `master` may have moved on since — a diff-vs-base count would then misreport every
 * file master changed afterward as "uncommitted work" in THIS worktree (FLUX-1121). Excludes the
 * shared node_modules junctions like `worktreeIsDirty`. Best-effort: returns 0 when the worktree
 * is gone or git errors.
 */
export async function worktreeUncommittedCount(
  worktreePath: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<number> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  if (!existsSync(worktreePath)) return 0;
  const { stdout } = await runner(worktreePath, ['status', '--porcelain', '--', '.', ...depNodeModulesExcludePathspecs()]).catch(
    () => ({ stdout: '' }),
  );
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

/**
 * Boolean dirty-check for a live worktree (FLUX-1125), excluding the shared node_modules
 * junctions via `depNodeModulesExcludePathspecs` — see that helper's comment for why this can't
 * unlink-then-check like `reclaimWorktrees` does. A failed git call reports dirty (fail-safe: the
 * callers here gate a destructive-ish action, so an unknown state should never look clean).
 */
export async function worktreeIsDirty(worktreePath: string, opts: { gitRunner?: GitRunner } = {}): Promise<boolean> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const { stdout } = await runner(worktreePath, ['status', '--porcelain', '--', '.', ...depNodeModulesExcludePathspecs()]).catch(
    () => ({ stdout: 'err' }),
  );
  return stdout.trim().length > 0;
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
export async function writeWorktreeSerenaOverride(
  worktreePath: string,
  opts: { gitRunner?: GitRunner } = {},
): Promise<void> {
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
  // Only the EventHorizon repo itself commits a `.serena/.gitignore` covering
  // this file (FLUX-1155) — in any other repo the override above is untracked
  // from birth, so `git status` never goes clean and reclaimWorktrees refuses
  // to collect the worktree forever. Exclude it repo-locally instead.
  await excludeSerenaOverrideFromGitStatus(worktreePath, opts.gitRunner ?? defaultGitRunner);
}

// Per-repo write serialization (FLUX-1162), same shape as ticketWriteChains in task-store.ts.
// Two createTaskWorktree calls racing on the SAME repo (e.g. two worktrees created back-to-back)
// could otherwise both read info/exclude before either appends, each concluding the line is
// missing and duplicating it. A per-excludePath promise chain serializes writes to the SAME
// repo's info/exclude while writes for DIFFERENT repos stay parallel.
const excludeWriteChains = new Map<string, Promise<unknown>>();

function serializeExcludeWrite<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = excludeWriteChains.get(key) ?? Promise.resolve();
  // Chain onto the previous write whether it resolved or rejected, so one failed write
  // doesn't wedge the queue for that repo.
  const result = prev.then(run, run);
  // Keep a non-rejecting tail as the chain head, and prune the map entry once this is the
  // last write in flight so the map doesn't grow unbounded across many repos.
  const tail = result.then(() => {}, () => {});
  excludeWriteChains.set(key, tail);
  void tail.then(() => {
    if (excludeWriteChains.get(key) === tail) excludeWriteChains.delete(key);
  });
  return result;
}

/**
 * Append `.serena/project.local.yml` to this repo's local (never-committed)
 * git-exclude file so the override written above doesn't leave worktrees
 * permanently dirty in repos that don't already ignore it via a committed
 * `.gitignore` (FLUX-1155 — see writeWorktreeSerenaOverride).
 *
 * Resolved via `git rev-parse --git-common-dir` rather than the worktree's own
 * `.git` file, so the line is written ONCE to the dir shared by every worktree
 * of this repo (`<main-repo>/.git/info/exclude`), not duplicated per worktree.
 * `info/exclude` is repo-local and never committed — unlike touching the
 * user's tracked `.gitignore`, this can't leak an EH-internal convention into
 * their tree. Best-effort and idempotent, matching the override write itself.
 */
async function excludeSerenaOverrideFromGitStatus(
  worktreePath: string,
  gitRunner: GitRunner,
): Promise<void> {
  try {
    const { stdout } = await gitRunner(worktreePath, ['rev-parse', '--git-common-dir']);
    const gitCommonDir = path.resolve(worktreePath, stdout.trim());
    const excludePath = path.join(gitCommonDir, 'info', 'exclude');
    // Serialize the read-check-append critical section per excludePath (FLUX-1162) — the
    // rev-parse above is safe to run concurrently, only the file read-modify-write races.
    await serializeExcludeWrite(excludePath, async () => {
      let existing = '';
      try {
        existing = await fs.readFile(excludePath, 'utf8');
      } catch {
        // info/exclude doesn't exist yet — created below.
      }
      const alreadyExcluded = existing
        .split('\n')
        .some((line) => line.trim() === SERENA_PROJECT_LOCAL_GITIGNORE_PATTERN);
      if (alreadyExcluded) return;
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
      await fs.appendFile(
        excludePath,
        `${needsLeadingNewline ? '\n' : ''}${SERENA_PROJECT_LOCAL_GITIGNORE_PATTERN}\n`,
        'utf8',
      );
    });
  } catch (err) {
    console.error(`[task-worktree] failed to exclude Serena override for ${worktreePath}:`, err);
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

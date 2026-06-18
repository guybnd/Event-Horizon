import { execFile } from 'child_process';
import { promisify } from 'util';
import { listTaskWorktrees, findWorktreeForBranch } from './task-worktree.js';

/**
 * Cross-worktree diff aggregator (FLUX-527 / FLUX-528 / FLUX-529).
 *
 * Surfaces every in-flight change across the two-roots architecture in ONE read-
 * only overview: each active task worktree (a ticket's branch — its net changes vs
 * the merge-base PLUS uncommitted/untracked work) and the main tree's loose
 * uncommitted changes (where `detach` surfaces work and orphan edits accumulate).
 *
 * Why a new module instead of reusing branch-manager's captureDiff: those helpers
 * run `git -C workspaceRoot` (the engine root). That's correct for COMMITTED diffs
 * (refs live in the shared object store) but BLIND to a worktree's uncommitted /
 * untracked changes — those live in the worktree's own working dir. So this module
 * runs `git -C <worktreePath>` per worktree, exactly like `worktreeChangeCount`.
 *
 * Read-only: this module never mutates git state.
 */

const execFileAsync = promisify(execFile);

/** Injectable git runner (matches task-worktree.ts for testability). */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) =>
  execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  file: string;
  additions: number;
  deletions: number;
  status: ChangeStatus;
  /** Other group refs (branch name or 'main') that also touch this file (FLUX-529). */
  collidesWith?: string[];
}

export interface DiffGroup {
  kind: 'worktree' | 'main';
  /** Absolute root of this group (worktree dir, or the engine workspace root for 'main'). */
  path: string;
  /** Branch for a worktree group (undefined for 'main'). */
  branch?: string;
  files: ChangedFile[];
}

export interface DiffCollision {
  file: string;
  /** The group refs (branch names and/or 'main') that all touch this file. */
  refs: string[];
}

export interface DiffOverview {
  groups: DiffGroup[];
  collisions: DiffCollision[];
}

export interface DiffOverviewOptions {
  gitRunner?: GitRunner;
  /** Default branch to diff worktrees against (default: resolved master→main→'master'). */
  baseBranch?: string;
  /** Diff each worktree against its own HEAD (loose/uncommitted work only) instead
   *  of the merge-base, so every group is uncommitted-only — matching the main tree. */
  uncommittedOnly?: boolean;
}

// ─── Parsing ────────────────────────────────────────────────────────────────────

/** `old => new` or `pre{old => new}post` → the new path. */
function normalizeRenamePath(f: string): string {
  if (!f.includes('=>')) return f;
  const brace = f.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return ((brace[1] ?? '') + (brace[3] ?? '') + (brace[4] ?? '')).replace(/\/{2,}/g, '/');
  const parts = f.split('=>');
  return (parts[parts.length - 1] ?? '').trim();
}

/** Parse `git diff --numstat` → file → {additions, deletions}. Tab-separated; "-" = binary. */
function parseNumstat(stdout: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = parts[0] ?? '';
    const d = parts[1] ?? '';
    const additions = a === '-' ? 0 : parseInt(a, 10) || 0;
    const deletions = d === '-' ? 0 : parseInt(d, 10) || 0;
    map.set(normalizeRenamePath(parts.slice(2).join('\t')), { additions, deletions });
  }
  return map;
}

/** Parse `git diff --name-status` → [{status, file}] (file = new path for renames). */
function parseNameStatus(stdout: string): Array<{ status: ChangeStatus; file: string }> {
  const out: Array<{ status: ChangeStatus; file: string }> = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const file = parts[parts.length - 1];
    if (!file) continue;
    let status: ChangeStatus;
    if (code.startsWith('A')) status = 'added';
    else if (code.startsWith('D')) status = 'deleted';
    else if (code.startsWith('R')) status = 'renamed';
    else status = 'modified';
    out.push({ status, file });
  }
  return out;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────────

/** Resolve the repo's default branch name (master → main → 'master'). */
async function resolveBaseBranch(runner: GitRunner, root: string): Promise<string> {
  for (const candidate of ['master', 'main']) {
    try {
      await runner(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return 'master';
}

/** merge-base(defaultBranch, HEAD) in a worktree — so we show only the branch's own changes, not master's divergence. */
async function mergeBaseOrBranch(runner: GitRunner, cwd: string, defaultBranch: string): Promise<string> {
  try {
    const { stdout } = await runner(cwd, ['merge-base', defaultBranch, 'HEAD']);
    return stdout.trim() || defaultBranch;
  } catch {
    return defaultBranch;
  }
}

/**
 * Changed files in `cwd` versus `base` (committed-ahead + uncommitted tracked, via
 * name-status + numstat) plus untracked files (via ls-files). Best-effort: a failed
 * git call yields fewer/no files, never throws.
 */
async function changedFilesAgainst(runner: GitRunner, cwd: string, base: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    runner(cwd, ['diff', '--name-status', base]).then((r) => r.stdout).catch(() => ''),
    runner(cwd, ['diff', '--numstat', base]).then((r) => r.stdout).catch(() => ''),
    runner(cwd, ['ls-files', '--others', '--exclude-standard']).then((r) => r.stdout).catch(() => ''),
  ]);

  const counts = parseNumstat(numstat);
  const byFile = new Map<string, ChangedFile>();
  for (const { status, file } of parseNameStatus(nameStatus)) {
    const c = counts.get(file) ?? { additions: 0, deletions: 0 };
    byFile.set(file, { file, additions: c.additions, deletions: c.deletions, status });
  }
  for (const raw of untracked.split('\n')) {
    const file = raw.replace(/\r$/, '').trim();
    if (file && !byFile.has(file)) byFile.set(file, { file, additions: 0, deletions: 0, status: 'untracked' });
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

// ─── Collision radar (FLUX-529) ────────────────────────────────────────────────

/** Group ref used in collisions: the branch for a worktree, or 'main' for the main tree. */
function groupRef(g: DiffGroup): string {
  return g.kind === 'main' ? 'main' : (g.branch ?? g.path);
}

/**
 * Files touched by more than one group (>1 worktree, or a worktree AND loose on
 * main) — imminent merge collisions between concurrent agents. Annotates each
 * file's `collidesWith` in place and returns the collision list.
 */
export function computeCollisions(groups: DiffGroup[]): DiffCollision[] {
  const fileRefs = new Map<string, Set<string>>();
  for (const g of groups) {
    const ref = groupRef(g);
    for (const f of g.files) {
      let set = fileRefs.get(f.file);
      if (!set) { set = new Set(); fileRefs.set(f.file, set); }
      set.add(ref);
    }
  }
  for (const g of groups) {
    const ref = groupRef(g);
    for (const f of g.files) {
      const refs = fileRefs.get(f.file);
      if (refs && refs.size >= 2) f.collidesWith = [...refs].filter((r) => r !== ref).sort();
    }
  }
  const collisions: DiffCollision[] = [];
  for (const [file, refs] of fileRefs) {
    if (refs.size >= 2) collisions.push({ file, refs: [...refs].sort() });
  }
  return collisions.sort((a, b) => a.file.localeCompare(b.file));
}

// ─── Public API ──────────────────────────────────────────────────────────────────

/**
 * Build the cross-worktree change overview: one group per active task worktree
 * (changes vs the merge-base + untracked) + a 'main' group (uncommitted vs HEAD in
 * the engine root), with the collision radar folded in. Pure git read; never throws
 * for a single bad group.
 */
export async function buildDiffOverview(workspaceRoot: string, opts: DiffOverviewOptions = {}): Promise<DiffOverview> {
  const runner = opts.gitRunner ?? defaultGitRunner;
  const defaultBranch = opts.baseBranch ?? await resolveBaseBranch(runner, workspaceRoot);

  const worktrees = await listTaskWorktrees(workspaceRoot, { gitRunner: runner }).catch(() => []);
  const groups: DiffGroup[] = [];
  for (const wt of worktrees) {
    // Uncommitted mode: a worktree's working tree vs its OWN HEAD (loose work only),
    // matching the main group — not the branch's full divergence from master.
    const base = opts.uncommittedOnly ? 'HEAD' : await mergeBaseOrBranch(runner, wt.path, defaultBranch);
    const files = await changedFilesAgainst(runner, wt.path, base).catch(() => []);
    groups.push({ kind: 'worktree', path: wt.path, files, ...(wt.branch ? { branch: wt.branch } : {}) });
  }

  // Main tree: uncommitted (+ untracked) work on whatever HEAD points at.
  const mainFiles = await changedFilesAgainst(runner, workspaceRoot, 'HEAD').catch(() => []);
  groups.push({ kind: 'main', path: workspaceRoot, files: mainFiles });

  const collisions = computeCollisions(groups);
  return { groups, collisions };
}

/**
 * The unified diff for ONE file, in the correct root: `ref === 'main'` diffs the
 * engine root vs HEAD; otherwise `ref` is a branch — resolve its worktree and diff
 * vs the merge-base. Untracked files are rendered as an added-file diff via
 * `--no-index`. Returns '' when there's nothing to show. Read-only.
 */
export async function diffFileContent(
  workspaceRoot: string,
  ref: string,
  file: string,
  opts: DiffOverviewOptions = {},
): Promise<string> {
  const runner = opts.gitRunner ?? defaultGitRunner;

  let cwd: string;
  let base: string;
  if (ref === 'main') {
    cwd = workspaceRoot;
    base = 'HEAD';
  } else {
    const wt = await findWorktreeForBranch(workspaceRoot, ref, { gitRunner: runner });
    if (!wt) return '';
    cwd = wt;
    const defaultBranch = opts.baseBranch ?? await resolveBaseBranch(runner, workspaceRoot);
    base = await mergeBaseOrBranch(runner, cwd, defaultBranch);
  }

  const tracked = await runner(cwd, ['diff', base, '--', file]).then((r) => r.stdout).catch(() => '');
  if (tracked.trim()) return tracked;

  // Untracked → synth an added-file diff. `git diff --no-index` exits non-zero when
  // the files differ, so execFile rejects — recover the diff from the error's stdout.
  try {
    const { stdout } = await runner(cwd, ['diff', '--no-index', '--', '/dev/null', file]);
    return stdout;
  } catch (err: any) {
    return typeof err?.stdout === 'string' ? err.stdout : '';
  }
}

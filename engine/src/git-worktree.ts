import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** True when `dir` is a git worktree currently checked out on `branch`. */
export async function isWorktreeOnBranch(runner: GitRunner, dir: string, branch: string): Promise<boolean> {
  if (!existsSync(path.join(dir, '.git'))) return false;
  try {
    const { stdout } = await runner(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim() === branch;
  } catch {
    return false;
  }
}

function isUnsupportedOrphanFlag(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown option/i.test(message) && /orphan/i.test(message);
}

/**
 * Hash+write an empty tree object into `cwd`'s object database and return its SHA. Uses a real
 * (zero-byte) temp file rather than `--stdin` (avoids managing subprocess stdin lifetime through
 * the plain `GitRunner` abstraction) or `/dev/null` (not portable to Windows). Never hardcodes the
 * SHA-1 empty-tree constant — git computes the hash itself, so this works for SHA-256 repos too.
 */
async function writeEmptyTreeObject(cwd: string, runner: GitRunner): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-empty-tree-'));
  try {
    const emptyFile = path.join(tmpDir, 'empty');
    await fs.writeFile(emptyFile, '');
    const { stdout } = await runner(cwd, ['hash-object', '-t', 'tree', '-w', emptyFile]);
    return stdout.trim();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * `git --version` + `--exec-path` for whichever binary the engine actually spawned — surfaced in
 * errors so a terminal-vs-engine PATH mismatch (FLUX-297: a GUI-launched packaged app inherits
 * launchd's minimal PATH and resolves an old system git even though the user's terminal git is
 * current) is diagnosable instead of gaslighting the user ("but my git is 2.54!").
 */
async function describeGitBinary(cwd: string, runner: GitRunner): Promise<string> {
  const version = await runner(cwd, ['--version']).then((r) => r.stdout.trim()).catch(() => 'unknown (git --version failed)');
  const execPath = await runner(cwd, ['--exec-path']).then((r) => r.stdout.trim()).catch(() => 'unknown');
  return `${version} (exec-path: ${execPath})`;
}

async function withGitIdentity(err: unknown, cwd: string, runner: GitRunner): Promise<Error> {
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new Error(`${message}\nengine git: ${await describeGitBinary(cwd, runner)}`);
  wrapped.cause = err;
  return wrapped;
}

/**
 * Create `dir` as a new worktree on a brand-new orphan branch `branch`. Tries the modern
 * `git worktree add --orphan` (added in git 2.42) first, unchanged behavior. On a pre-2.42
 * binary rejecting the flag ("unknown option `orphan'" — e.g. macOS stock Apple Git 2.39.x)
 * falls back to plumbing that works on any git version: hash an empty tree, commit it as a root
 * commit, point `branch` at it, then attach a worktree to that branch. Net difference vs
 * `--orphan`: the branch starts from an empty root commit instead of an unborn HEAD — harmless,
 * every caller commits real content on top immediately (FLUX-297).
 *
 * On any remaining failure (from either the modern attempt or the fallback), the thrown error is
 * annotated with the engine's actual `git --version`/`--exec-path` for self-diagnosis.
 */
export async function addOrphanWorktree(
  repoRoot: string,
  branch: string,
  dir: string,
  runner: GitRunner,
): Promise<void> {
  try {
    await runner(repoRoot, ['worktree', 'add', '--orphan', '-b', branch, dir]);
    return;
  } catch (err) {
    if (!isUnsupportedOrphanFlag(err)) throw await withGitIdentity(err, repoRoot, runner);
  }

  try {
    const treeSha = await writeEmptyTreeObject(repoRoot, runner);
    const { stdout: commitOut } = await runner(repoRoot, ['commit-tree', treeSha, '-m', `flux: init ${branch}`]);
    await runner(repoRoot, ['branch', branch, commitOut.trim()]);
    await runner(repoRoot, ['worktree', 'add', dir, branch]);
  } catch (err) {
    throw await withGitIdentity(err, repoRoot, runner);
  }
}

// Shared real-git fixture helper (FLUX-1665).
//
// The engine test suite has ~116 files that build a real git repo per test via
// `mkdtemp` + `git init` + `config` + `add` + `commit` — each with its own locally-defined
// helper, duplicated with small variations. `git init` + the first commit is the expensive
// part (process spawn + filesystem work); this module builds ONE template repo per distinct
// shape (cached lazily, per process) and gives each caller a FRESH, independent, writable repo
// via `git clone --local <template> <dest>`, which is materially cheaper than repeating
// `init`+`config`+`add`+`commit` every time.
//
// A cloned repo is NOT identical to a freshly `init`-ed one in one respect: `git clone` adds an
// `origin` remote pointing at the source. Every caller migrated to this helper previously came
// from a bare `git init` (no remote at all), and at least one test (task-worktree.test.ts's
// "does not inherit a commit that is on local master but not yet pushed to origin", FLUX-1638)
// depends on that — it does its own `git remote add origin`, which fails if one already exists.
// `createGitFixture` strips the clone's `origin` remote before returning, so callers see the
// same remote-less state a fresh `init` would give them.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, windowsHide: true });
}

export interface GitFixtureTemplateOptions {
  /** Initial branch name for the template (default 'master'). */
  branch?: string;
  /** Called with the template's root dir before `add`+`commit`, to seed extra files. */
  populate?: (root: string) => Promise<void>;
}

// Cached per distinct template shape (keyed by caller-supplied templateKey), built lazily and
// at most once per process — every test in the process reuses the same template repo as the
// clone SOURCE (never mutated after its one commit).
const templateCache = new Map<string, Promise<string>>();

async function getOrBuildTemplate(key: string, options: GitFixtureTemplateOptions): Promise<string> {
  let pending = templateCache.get(key);
  if (!pending) {
    pending = (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-git-fixture-tpl-'));
      await git(root, ['init', '-b', options.branch ?? 'master']);
      await git(root, ['config', 'user.email', 'test@test.com']);
      await git(root, ['config', 'user.name', 'Test']);
      // Deterministic regardless of the host's global git config (a machine with commit
      // signing configured globally would otherwise fail this commit).
      await git(root, ['config', 'commit.gpgsign', 'false']);
      await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
      if (options.populate) await options.populate(root);
      await git(root, ['add', '.']);
      await git(root, ['commit', '-m', 'init']);
      return root;
    })();
    templateCache.set(key, pending);
  }
  return pending;
}

export interface CreateGitFixtureOptions extends GitFixtureTemplateOptions {
  /** Exact destination path for the cloned repo. Defaults to a fresh mkdtemp dir. */
  dest?: string;
  /**
   * Cache key distinguishing this template variant from others (default: the branch name).
   * Callers passing a custom `populate` MUST pass a distinct `templateKey` — otherwise a
   * differently-populated variant could reuse another variant's cached template.
   */
  templateKey?: string;
}

/**
 * Returns a fresh, independent, writable git repo with one commit (a `README.md`, plus
 * whatever `populate` added) and no remotes — built by cloning a cached template rather than
 * repeating `init`+`config`+`add`+`commit`. Safe to call concurrently; the template build is
 * de-duped per `templateKey`.
 */
export async function createGitFixture(options: CreateGitFixtureOptions = {}): Promise<string> {
  const key = options.templateKey ?? `branch:${options.branch ?? 'master'}`;
  const template = await getOrBuildTemplate(key, options);
  const dest = options.dest ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'eh-git-fixture-')));
  await fs.mkdir(dest, { recursive: true });
  await git(os.tmpdir(), ['clone', '--local', '--quiet', template, dest]);
  await git(dest, ['remote', 'remove', 'origin']);
  // `git clone` does NOT copy the template's local user.email/user.name/commit.gpgsign —
  // without these, any commit a test makes in the clone falls back to the host's global
  // config, which fails outright on a machine (or CI runner) with no global identity
  // (FLUX-1679; surfaced as "Author identity unknown" on the ubuntu runners).
  await setGitIdentity(dest);
  return dest;
}

/**
 * Set a deterministic, isolated commit identity (+ gpgsign off) — applied to every
 * `createGitFixture` clone; also callable directly for hand-rolled repos.
 */
export async function setGitIdentity(
  dir: string,
  identity: { email: string; name: string } = { email: 'test@test.com', name: 'Test' }
): Promise<void> {
  await git(dir, ['config', 'user.email', identity.email]);
  await git(dir, ['config', 'user.name', identity.name]);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

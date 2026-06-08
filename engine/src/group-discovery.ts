import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  GROUP_CONFIG_FILENAME,
  GROUP_DOCS_BRANCH,
  getGroupConfigFile,
  getGroupStoreDir,
  ensureGroupStoreScaffold,
  getOriginRemote,
  peekGroupMembers,
  type GroupMember,
} from './group.js';
import { validateGitRemote } from './group-setup.js';
import {
  getWorkspacesList,
  addWorkspaceEntry,
  pathsEqual,
  type WorkspaceEntry,
} from './workspace.js';

const execFileAsync = promisify(execFile);

/**
 * Group discovery + dedicated-parent creation — the engine side of the
 * onboarding/migration wizard (FLUX-407).
 *
 * This turns the raw `planGroupSetup`/`applyGroupSetup` API (which demands a
 * parent root, group name, and full members[] up front) into something a wizard
 * can drive: enumerate candidate repos (from a folder or the workspace
 * registry), then create a brand-new dedicated parent repo to host the group.
 *
 * Read-only discovery never mutates any repo. The only mutating entry point is
 * `createDedicatedParent`, which scaffolds a NEW parent directory and is the
 * one step the wizard confirms before running.
 *
 * Group mode is OPTIONAL: nothing here runs unless the wizard is explicitly
 * opened, and discovery is side-effect-free, so it never interferes with normal
 * single-repo use.
 */

// Directories that are never candidate member repos when scanning a folder.
// Mirrors project-scanner's SKIP_DIRS plus the per-machine group worktree dir.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.flux', '.flux-store', '.flux-group',
  'vendor', 'dist', 'build', '.next', '__pycache__', '.venv', '.docs',
]);

/** A git repo discovered as a candidate group member. */
export interface DiscoveredRepo {
  /** Absolute path to the repo root. */
  path: string;
  /** Directory basename — the default member name. */
  name: string;
  /** `origin` remote URL, or null if the repo has no origin. */
  remote: string | null;
  /** Whether this path is already a registered EH workspace. */
  registered: boolean;
  /** Whether this repo already holds a group.json (it's a parent, not a member). */
  isGroupParent: boolean;
}

export interface FolderScanResult {
  /** The folder that was scanned (absolute). */
  folder: string;
  repos: DiscoveredRepo[];
}

function isRegistered(target: string, registered: WorkspaceEntry[]): boolean {
  return registered.some((w) => pathsEqual(w.path, target));
}

/** True when `dir` is the root of a git repository (has a `.git` entry). */
function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

async function describeRepo(repoPath: string, registered: WorkspaceEntry[]): Promise<DiscoveredRepo> {
  const [remote, members] = await Promise.all([
    getOriginRemote(repoPath),
    peekGroupMembers(repoPath).catch(() => null),
  ]);
  return {
    path: repoPath,
    name: path.basename(repoPath),
    remote,
    registered: isRegistered(repoPath, registered),
    isGroupParent: members != null,
  };
}

/**
 * Enumerate the immediate child directories of `folder` that are git repos,
 * reading each one's `origin` remote and registration state. Purely read-only.
 *
 * Only direct children are scanned (the common "folder of repos" layout); it
 * does not recurse, so a monorepo's nested packages aren't mistaken for peers.
 */
export async function scanFolderForRepos(folder: string): Promise<FolderScanResult> {
  const resolved = path.resolve(folder);
  if (!existsSync(resolved)) {
    throw new Error(`Folder does not exist: ${resolved}`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  const registered = await getWorkspacesList();
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const repoPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = path.join(resolved, entry.name);
    if (isGitRepo(child)) repoPaths.push(child);
  }
  repoPaths.sort((a, b) => a.localeCompare(b));

  const repos = await Promise.all(repoPaths.map((p) => describeRepo(p, registered)));
  return { folder: resolved, repos };
}

/**
 * Project the existing workspace registry as a discovery source — every
 * registered workspace with its `origin` remote and whether it already holds a
 * group.json. Lets existing EH users build a group from repos EH already knows.
 */
export async function discoverFromRegistry(): Promise<DiscoveredRepo[]> {
  const registered = await getWorkspacesList();
  return Promise.all(
    registered.map(async (w) => describeRepo(path.resolve(w.path), registered)),
  );
}

// ─── create dedicated parent (mutating — the one confirmed wizard step) ───────

/** Injectable git runner so creation can be unit-tested without spawning git. */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultGitRunner: GitRunner = (cwd, args) => execFileAsync('git', args, { cwd, windowsHide: true });

export type WorkspaceRegistrar = (path: string, label?: string) => Promise<void>;
const defaultRegistrar: WorkspaceRegistrar = async (p, label) => {
  await addWorkspaceEntry({ path: p, ...(label ? { label } : {}) });
};

export interface CreateParentInput {
  /** Absolute path of the NEW parent directory to create/scaffold. */
  parentPath: string;
  /** Group name written into group.json. */
  groupName: string;
  /** Initial members (validated; their remotes are screened). */
  members: GroupMember[];
}

export interface CreateParentResult {
  parentRoot: string;
  groupName: string;
  /** True when `git init` ran (false when the dir was already a git repo). */
  gitInitialized: boolean;
  /** True when group.json was written. */
  wroteConfig: boolean;
  /** True when the canonical store was scaffolded. */
  scaffoldedStore: boolean;
  /** True when the parent was registered as an EH workspace. */
  registered: boolean;
}

/**
 * Create a brand-new dedicated parent repo to host a group: make the directory,
 * `git init` it, scaffold the canonical store, write group.json, and register
 * it as a workspace. The dedicated-parent model forbids reusing a member repo,
 * so the wizard always lands the group config in a fresh repo this creates.
 *
 * Refuses to clobber an existing group: if the target already has a group.json,
 * the caller must route to repair/backfill instead (never silently overwrite).
 * A hosted remote for the parent is out of scope — the user adds one later if
 * they want fan-out beyond local.
 */
export async function createDedicatedParent(
  input: CreateParentInput,
  opts: { gitRunner?: GitRunner; registerWorkspace?: WorkspaceRegistrar } = {},
): Promise<CreateParentResult> {
  const parentRoot = path.resolve(input.parentPath);
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const registerWorkspace = opts.registerWorkspace ?? defaultRegistrar;

  if (!input.groupName || input.groupName.trim().length === 0) {
    throw new Error('groupName must be a non-empty string');
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new Error('at least one member is required');
  }
  for (const m of input.members) {
    if (!m || typeof m.name !== 'string' || typeof m.role !== 'string') {
      throw new Error('each member needs name and role strings');
    }
    const check = validateGitRemote(m.remote);
    if (!check.ok) throw new Error(`member ${m.name}: ${check.reason}`);
  }

  // Never clobber an existing group — route the caller to repair instead.
  if (existsSync(getGroupConfigFile(parentRoot))) {
    throw new Error(
      `${GROUP_CONFIG_FILENAME} already exists at ${parentRoot}. This repo already hosts a group; use repair/backfill instead of creating a new parent.`,
    );
  }

  // 1. Ensure the directory exists.
  await fs.mkdir(parentRoot, { recursive: true });

  // 2. git init (idempotent — skip if already a repo).
  let gitInitialized = false;
  if (!isGitRepo(parentRoot)) {
    await gitRunner(parentRoot, ['init']);
    gitInitialized = true;
  }

  // 3. Scaffold the canonical docs store.
  await ensureGroupStoreScaffold(getGroupStoreDir(parentRoot));
  const scaffoldedStore = true;

  // 4. Write group.json.
  const config = {
    name: input.groupName,
    members: input.members.map((m) => ({
      name: m.name,
      role: m.role,
      remote: m.remote,
      ...(m.testCommand ? { testCommand: m.testCommand } : {}),
    })),
  };
  await fs.writeFile(getGroupConfigFile(parentRoot), JSON.stringify(config, null, 2) + '\n', 'utf-8');
  const wroteConfig = true;

  // 5. Register the parent as a workspace (labeled with the group name) so the
  //    Case-1 member binding can reverse-look-up the parent.
  let registered = false;
  try {
    await registerWorkspace(parentRoot, input.groupName);
    registered = true;
  } catch {
    // Registration failure is non-fatal — the parent is created; the consent
    // prompt / backfill can register it later.
    registered = false;
  }

  return { parentRoot, groupName: input.groupName, gitInitialized, wroteConfig, scaffoldedStore, registered };
}

export { GROUP_DOCS_BRANCH };

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  GROUP_CONFIG_FILENAME,
  GROUP_LOCAL_FILENAME,
  GROUP_STORE_DIRNAME,
  GROUP_DOCS_BRANCH,
  getGroupConfigFile,
  getGroupStoreDir,
  validateGroupConfig,
  formatGroupValidationErrors,
  ensureGroupStoreScaffold,
  loadGroupContext,
  type GroupMember,
} from './group.js';
import { getWorkspacesList, addWorkspaceEntry, pathsEqual } from './workspace.js';

const execFileAsync = promisify(execFile);

/**
 * Inject the workspace registry so setup can be unit-tested without touching
 * the real global settings file. Defaults wrap the live registry.
 */
export type WorkspaceLister = () => Promise<Array<{ path: string }>>;
export type WorkspaceRegistrar = (path: string, label?: string) => Promise<void>;

const defaultLister: WorkspaceLister = () => getWorkspacesList();
const defaultRegistrar: WorkspaceRegistrar = async (p, label) => {
  await addWorkspaceEntry({ path: p, ...(label ? { label } : {}) });
};

function isPathRegistered(target: string, registered: Array<{ path: string }>): boolean {
  return registered.some((w) => pathsEqual(w.path, target));
}

/**
 * Group setup — make a multi-repo group recreatable from scratch, preview-first.
 *
 * Implements the engine side of FLUX-401. `planGroupSetup` computes every
 * intrusive action with ZERO git mutation and returns a structured plan;
 * `applyGroupSetup` performs the writes only when asked, with per-member
 * isolation (one member failure never aborts the rest). Both are reused by the
 * `init-group` CLI and the portal preview UI (FLUX-402) via /api/group/plan|apply.
 */

// ─── git remote validation (security: remote is a git command-surface input) ──

/**
 * Validate that a string is a safe git remote URL before it is ever handed to
 * `git`. Members' `remote` values come from a shared `group.json`, so a hostile
 * or malformed entry is an injection vector when used as a clone/push target.
 *
 * Accepts: https(s)://, git://, ssh://, and the scp-like `user@host:path` form.
 * Optionally accepts file:// and local filesystem paths (for the local test
 * harness) when `allowLocal` is set.
 *
 * Rejects: shell metacharacters, the `ext::` / `fd::` transports, embedded
 * `--upload-pack=` / `--receive-pack=` options, and anything starting with `-`
 * (which git could interpret as an option rather than a URL).
 */
export function validateGitRemote(raw: unknown, opts: { allowLocal?: boolean } = {}): { ok: boolean; reason?: string } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'remote must be a non-empty string' };
  }
  const url = raw.trim();

  // An argument that begins with '-' can be mis-parsed by git as an option.
  if (url.startsWith('-')) {
    return { ok: false, reason: 'remote must not start with "-"' };
  }

  // Control characters are never legitimate in a remote.
  if (/[\x00-\x1f]/.test(url)) {
    return { ok: false, reason: 'remote contains illegal characters' };
  }

  // git "smuggling" transports and option-injection payloads.
  const lowered = url.toLowerCase();
  if (lowered.startsWith('ext::') || lowered.startsWith('fd::')) {
    return { ok: false, reason: 'remote uses a disallowed git transport' };
  }
  if (lowered.includes('--upload-pack') || lowered.includes('--receive-pack')) {
    return { ok: false, reason: 'remote must not embed git options' };
  }

  // Local paths (test harness) are handled before the URL metachar guard so
  // that Windows drive letters and backslashes don't trip it. They still get a
  // lighter shell-metachar screen.
  if (opts.allowLocal) {
    if (lowered.startsWith('file://')) return { ok: true };
    if (path.isAbsolute(url) || url.startsWith('.')) {
      if (/[;&|`$(){}<>^!*?"']/.test(url)) {
        return { ok: false, reason: 'remote contains illegal characters' };
      }
      return { ok: true };
    }
  }

  // Shell metacharacters in a remote URL. We never use a shell (execFile), but
  // reject them anyway as a defense-in-depth signal of a malformed/hostile URL.
  if (/[\s;&|`$(){}<>\\^!*?\[\]"']/.test(url)) {
    return { ok: false, reason: 'remote contains illegal characters' };
  }

  // Known safe transports.
  if (/^https?:\/\/[^/]+\/.+/.test(url)) return { ok: true };
  if (/^git:\/\/[^/]+\/.+/.test(url)) return { ok: true };
  if (/^ssh:\/\/[^/]+\/.+/.test(url)) return { ok: true };

  // scp-like syntax: user@host:path/to/repo(.git)
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+/.test(url)) return { ok: true };

  return { ok: false, reason: 'remote is not a recognized git URL' };
}

// ─── plan model ──────────────────────────────────────────────────────────────

export type FileAction = 'create' | 'patch' | 'exists';
export type MemberAction = 'register' | 'clone' | 'skip';

export interface PlannedFile {
  /** Workspace-relative path. */
  path: string;
  action: FileAction;
  /** Short human description of what changes. */
  detail?: string;
}

export interface PlannedMember {
  name: string;
  role: string;
  remote: string;
  /** Resolved absolute local checkout path (default ../<name>). */
  resolvedPath: string;
  action: MemberAction;
  detail?: string;
}

/** A workspace the setup will register so the Case-1 member binding can resolve it. */
export interface PlannedRegistration {
  /** Absolute path to register as an EH workspace. */
  path: string;
  /** Display name (group name for the parent, member name otherwise). */
  name: string;
  kind: 'parent' | 'member';
  /** True when this path is already in the workspace registry (apply is a no-op). */
  alreadyRegistered: boolean;
}

export interface GroupSetupPlan {
  parentRoot: string;
  groupName: string;
  /** True when a valid group.json already exists (apply requires force to overwrite). */
  alreadyConfigured: boolean;
  files: PlannedFile[];
  gitignore: string[];
  orphanBranch: { name: string; action: 'create' | 'exists' };
  members: PlannedMember[];
  /** Workspaces to register (dedicated parent + each present member) so Case-1 binding works. */
  registrations: PlannedRegistration[];
  warnings: string[];
}

export interface GroupSetupInput {
  parentRoot: string;
  groupName: string;
  members: GroupMember[];
  force?: boolean;
  /** Allow file:// and local paths as member remotes (test harness). */
  allowLocalRemotes?: boolean;
}

const GITIGNORE_MARKER = '# flux-group (multi-repo group)';
const GITIGNORE_LINES = [GROUP_LOCAL_FILENAME, `${GROUP_STORE_DIRNAME}/`];

function resolveMemberPath(parentRoot: string, member: GroupMember): string {
  return path.resolve(parentRoot, '..', member.name);
}

// ─── plan (read-only, zero mutation) ─────────────────────────────────────────

/**
 * Compute the full set of intrusive actions a group setup would perform —
 * without writing anything. Validates the requested config and every member
 * remote, and classifies each member as register / clone / skip.
 */
export async function planGroupSetup(
  input: GroupSetupInput,
  opts: { listWorkspaces?: WorkspaceLister } = {},
): Promise<GroupSetupPlan> {
  const parentRoot = path.resolve(input.parentRoot);
  const warnings: string[] = [];

  // Validate the requested config using the same rules the loader enforces.
  const candidate = { name: input.groupName, members: input.members };
  const errors = validateGroupConfig(candidate);
  if (errors.length > 0) {
    throw new Error(`Invalid group config: ${formatGroupValidationErrors(errors)}`);
  }

  // Validate every member remote up-front (security boundary).
  for (const member of input.members) {
    const check = validateGitRemote(member.remote, { allowLocal: input.allowLocalRemotes });
    if (!check.ok) {
      throw new Error(`Member '${member.name}' has an invalid remote: ${check.reason}`);
    }
  }

  const configFile = getGroupConfigFile(parentRoot);
  const alreadyConfigured = existsSync(configFile);
  if (alreadyConfigured && !input.force) {
    warnings.push(`${GROUP_CONFIG_FILENAME} already exists — apply will refuse without force.`);
  }

  const files: PlannedFile[] = [
    {
      path: GROUP_CONFIG_FILENAME,
      action: alreadyConfigured ? 'exists' : 'create',
      detail: alreadyConfigured ? 'group.json already present' : 'write group.json',
    },
  ];

  // .gitignore: only the lines not already present.
  const gitignorePath = path.join(parentRoot, '.gitignore');
  const existingGitignore = existsSync(gitignorePath)
    ? await fs.readFile(gitignorePath, 'utf-8')
    : '';
  const missingGitignore = GITIGNORE_LINES.filter((line) => !existingGitignore.includes(line));
  if (missingGitignore.length > 0) {
    files.push({ path: '.gitignore', action: existingGitignore ? 'patch' : 'create', detail: 'ignore group.local.json + store' });
  }

  // Orphan docs branch + store.
  const storeDir = getGroupStoreDir(parentRoot);
  const storeExists = existsSync(storeDir);
  files.push({
    path: `${GROUP_STORE_DIRNAME}/`,
    action: storeExists ? 'exists' : 'create',
    detail: storeExists ? 'group store present' : 'scaffold canonical docs store',
  });

  // Members.
  const members: PlannedMember[] = input.members.map((member) => {
    const resolvedPath = resolveMemberPath(parentRoot, member);
    let action: MemberAction;
    let detail: string;
    if (existsSync(resolvedPath)) {
      action = 'register';
      detail = 'checkout present — register only';
    } else {
      action = 'clone';
      detail = 'checkout missing — would clone from remote';
    }
    return { name: member.name, role: member.role, remote: member.remote, resolvedPath, action, detail };
  });

  if (members.some((m) => m.action === 'clone')) {
    warnings.push('Some members have no local checkout. This slice registers existing checkouts; a clone is reported but not performed automatically.');
  }

  // Workspaces to register for Case-1: the dedicated parent (always) + every
  // member with a present checkout. A registered parent is what lets a member
  // discover its group via reverse-lookup (FLUX-405); without it the member
  // silently shows no Product/ tree.
  const registered = await (opts.listWorkspaces ?? defaultLister)();
  const registrations: PlannedRegistration[] = [
    { path: parentRoot, name: input.groupName, kind: 'parent', alreadyRegistered: isPathRegistered(parentRoot, registered) },
  ];
  for (const member of members) {
    if (member.action === 'register') {
      registrations.push({
        path: member.resolvedPath,
        name: member.name,
        kind: 'member',
        alreadyRegistered: isPathRegistered(member.resolvedPath, registered),
      });
    }
  }

  return {
    parentRoot,
    groupName: input.groupName,
    alreadyConfigured,
    files,
    gitignore: missingGitignore,
    orphanBranch: { name: GROUP_DOCS_BRANCH, action: storeExists ? 'exists' : 'create' },
    members,
    registrations,
    warnings,
  };
}

// ─── apply (mutating, per-member isolation) ──────────────────────────────────

export interface MemberResult {
  name: string;
  action: MemberAction;
  ok: boolean;
  error?: string;
}

/** Outcome of registering one workspace (parent or member) during setup/backfill. */
export interface RegistrationResult {
  path: string;
  name: string;
  kind: 'parent' | 'member';
  ok: boolean;
  /** True when the path was already registered (no write performed). */
  alreadyRegistered: boolean;
  error?: string;
}

export interface GroupSetupResult {
  parentRoot: string;
  groupName: string;
  wroteConfig: boolean;
  patchedGitignore: boolean;
  scaffoldedStore: boolean;
  members: MemberResult[];
  /** Workspaces registered (dedicated parent + verified present members). */
  registrations: RegistrationResult[];
}

/**
 * Register one workspace path idempotently, classifying the outcome. Never
 * throws — a registry failure for one path is isolated and reported.
 */
async function registerOne(
  target: string,
  name: string,
  kind: 'parent' | 'member',
  registeredBefore: Array<{ path: string }>,
  registerWorkspace: WorkspaceRegistrar,
  dryRun: boolean,
): Promise<RegistrationResult> {
  if (isPathRegistered(target, registeredBefore)) {
    return { path: target, name, kind, ok: true, alreadyRegistered: true };
  }
  if (dryRun) {
    return { path: target, name, kind, ok: true, alreadyRegistered: false };
  }
  try {
    // Label the entry with the group/member name so the workspace switcher
    // shows something meaningful instead of the bare folder basename.
    await registerWorkspace(target, name);
    return { path: target, name, kind, ok: true, alreadyRegistered: false };
  } catch (err: any) {
    return { path: target, name, kind, ok: false, alreadyRegistered: false, error: err?.message ? String(err.message) : String(err) };
  }
}

/** Injectable git runner so apply can be unit-tested without real repos. */
export type GitRunner = (cwd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultGitRunner: GitRunner = (cwd, args) =>
  execFileAsync('git', args, { cwd, windowsHide: true });

/**
 * Perform the planned group setup. Writes group.json, patches .gitignore, and
 * scaffolds the canonical store. Member operations are isolated: each member's
 * result is collected independently and a single failure never aborts the rest.
 *
 * This slice (FLUX-401, decision 1a) registers existing checkouts; members that
 * need cloning are reported as skipped-with-reason rather than auto-cloned.
 */
export async function applyGroupSetup(
  input: GroupSetupInput,
  opts: { gitRunner?: GitRunner; listWorkspaces?: WorkspaceLister; registerWorkspace?: WorkspaceRegistrar } = {},
): Promise<GroupSetupResult> {
  const plan = await planGroupSetup(input, { listWorkspaces: opts.listWorkspaces });
  const parentRoot = plan.parentRoot;

  if (plan.alreadyConfigured && !input.force) {
    throw new Error(`${GROUP_CONFIG_FILENAME} already exists. Use force to overwrite.`);
  }

  // Ordering matters: group.json is the file that flips the repo into group
  // mode on the next activation. Write it LAST, after the store and .gitignore
  // are in place, so a mid-apply failure never leaves the repo "configured" but
  // missing its canonical store or with its local files un-ignored.

  // 1. Patch .gitignore with only the missing lines.
  let patchedGitignore = false;
  if (plan.gitignore.length > 0) {
    const gitignorePath = path.join(parentRoot, '.gitignore');
    const existing = existsSync(gitignorePath) ? await fs.readFile(gitignorePath, 'utf-8') : '';
    const block = existing.includes(GITIGNORE_MARKER)
      ? plan.gitignore.join('\n')
      : `${GITIGNORE_MARKER}\n${plan.gitignore.join('\n')}`;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    await fs.writeFile(gitignorePath, `${existing}${sep}${block}\n`, 'utf-8');
    patchedGitignore = true;
  }

  // 2. Scaffold the canonical docs store (idempotent).
  await ensureGroupStoreScaffold(getGroupStoreDir(parentRoot));
  const scaffoldedStore = true;

  // 3. Members — isolated, no single failure aborts the rest. Read-only verify.
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const members: MemberResult[] = [];
  for (const planned of plan.members) {
    try {
      if (planned.action === 'register') {
        // Existing checkout — verify it is a git repo, but don't mutate it.
        await gitRunner(planned.resolvedPath, ['rev-parse', '--is-inside-work-tree']);
        members.push({ name: planned.name, action: 'register', ok: true });
      } else {
        // Cloning is not performed in this slice (decision 1a) — report it.
        members.push({
          name: planned.name,
          action: planned.action,
          ok: false,
          error: 'checkout missing; auto-clone not performed in this slice',
        });
      }
    } catch (err: any) {
      members.push({
        name: planned.name,
        action: planned.action,
        ok: false,
        error: err?.message ? String(err.message) : String(err),
      });
    }
  }

  // 4. Write group.json LAST — this is the file that activates group mode.
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

  // 5. Register the dedicated parent + every verified present member as EH
  //    workspaces so the Case-1 member binding (FLUX-405) can resolve the
  //    parent by reverse-lookup. Done after group.json is written so the
  //    registry never points at a not-yet-configured parent. Idempotent and
  //    isolated — a registry failure never undoes the setup.
  const listWorkspaces = opts.listWorkspaces ?? defaultLister;
  const registerWorkspace = opts.registerWorkspace ?? defaultRegistrar;
  const registeredBefore = await listWorkspaces();
  const registrations: RegistrationResult[] = [
    await registerOne(parentRoot, input.groupName, 'parent', registeredBefore, registerWorkspace, false),
  ];
  for (const planned of plan.members) {
    const memberResult = members.find((m) => m.name === planned.name);
    if (planned.action === 'register' && memberResult?.ok) {
      registrations.push(
        await registerOne(planned.resolvedPath, planned.name, 'member', registeredBefore, registerWorkspace, false),
      );
    }
  }

  return { parentRoot, groupName: input.groupName, wroteConfig, patchedGitignore, scaffoldedStore, members, registrations };
}

// ─── backfill / repair (existing groups → Case 1) ────────────────────────────

export interface EnsureRegisteredResult {
  parentRoot: string;
  groupName: string;
  /** Per-target outcome for the parent + each present member. */
  registrations: RegistrationResult[];
  /** True when parent + all present members are registered after this call. */
  complete: boolean;
}

/**
 * Bring an already-configured group's workspace registry up to Case 1 without
 * re-running setup or touching group.json. Registers the dedicated parent and
 * every member with a present checkout that isn't registered yet. Idempotent.
 *
 * `dryRun` reports the gap without writing — used by the detect-on-activation
 * check so nothing is mutated until the user consents.
 *
 * Note: when invoked from a *member* workspace this is reached via the member
 * binding, which only resolves once the parent is already registered. An
 * orphaned parent therefore self-heals only when the parent itself is activated
 * (or through the folder-scan wizard, FLUX-407), not from a member.
 */
export async function ensureGroupRegistered(
  parentRoot: string,
  opts: { listWorkspaces?: WorkspaceLister; registerWorkspace?: WorkspaceRegistrar; dryRun?: boolean } = {},
): Promise<EnsureRegisteredResult> {
  const group = await loadGroupContext(parentRoot);
  if (!group) {
    throw new Error('No multi-repo group is configured at this workspace (no group.json).');
  }
  const listWorkspaces = opts.listWorkspaces ?? defaultLister;
  const registerWorkspace = opts.registerWorkspace ?? defaultRegistrar;
  const dryRun = Boolean(opts.dryRun);
  const registeredBefore = await listWorkspaces();

  const registrations: RegistrationResult[] = [
    await registerOne(group.parentRoot, group.config.name, 'parent', registeredBefore, registerWorkspace, dryRun),
  ];
  for (const member of group.members) {
    if (member.pathExists) {
      registrations.push(
        await registerOne(member.path, member.name, 'member', registeredBefore, registerWorkspace, dryRun),
      );
    }
  }

  // In dryRun nothing was written, so "complete" means everything was already
  // registered (no gap to fix). In apply mode a successful (ok) register counts.
  const complete = dryRun
    ? registrations.every((r) => r.alreadyRegistered)
    : registrations.every((r) => r.ok);
  return { parentRoot: group.parentRoot, groupName: group.config.name, registrations, complete };
}

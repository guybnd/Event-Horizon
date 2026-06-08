import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

/**
 * Multi-repo groups — additive group module.
 *
 * Implements the engine side of FLUX-393. Loads the committed `group.json`
 * (machine-independent member identity) plus an optional gitignored
 * `group.local.json` (per-machine checkout paths), resolves member paths,
 * and scaffolds the canonical `.flux-group` docs store.
 *
 * Design notes (see .docs/event-horizon/architecture/multi-repo-groups.md):
 * - This module is purely additive. When `group.json` is absent the module is
 *   inert and the engine behaves exactly as a single-repo workspace.
 * - Members are read-only for source + docs awareness — there is no per-member
 *   board cache here. The parent workspace remains the single active board.
 * - The orphan-branch worktree attach + fan-out push is owned by FLUX-396; this
 *   module only scaffolds the on-disk store layout.
 */

export const GROUP_CONFIG_FILENAME = 'group.json';
export const GROUP_LOCAL_FILENAME = 'group.local.json';
export const GROUP_STORE_DIRNAME = '.flux-group';
export const GROUP_DOCS_BRANCH = 'flux-group-docs';

/**
 * Synthetic top-level prefix under which cross-project group docs (`.flux-group`)
 * are surfaced in the portal docs tree, keeping them from colliding with a
 * repo's own `.docs/` (which render unprefixed). See the spec's path-prefixing rule.
 */
export const GROUP_DOCS_PREFIX = 'Product';

export interface GroupMember {
  /** Stable short key. Immutable once used — it is the doc path prefix + registry key. */
  name: string;
  /** Free-form role label (frontend, api, shared-lib, infra, app, …). */
  role: string;
  /** Git remote URL — canonical, machine-independent identity and fan-out target. */
  remote: string;
  /** Optional command an agent runs to validate this repo. */
  testCommand?: string;
}

export interface GroupConfig {
  name: string;
  members: GroupMember[];
}

export interface ResolvedMember extends GroupMember {
  /** Resolved absolute local checkout path. */
  path: string;
  /** Whether the resolved path currently exists on disk. */
  pathExists: boolean;
}

export interface GroupContext {
  /** Parent repo root that owns group.json and the canonical store. */
  parentRoot: string;
  config: GroupConfig;
  members: ResolvedMember[];
  /** Absolute path to the `.flux-group` canonical docs store. */
  groupStoreDir: string;
  /** Fan-out branch name for the whole group. */
  docsBranch: string;
}

export interface GroupValidationError {
  path: string;
  message: string;
}

interface GroupLocalConfig {
  paths?: Record<string, string>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Member names are used as a local path segment (`../<name>`) and as a doc path
 * prefix, so they must be a single safe path component. This rejects traversal
 * (`..`, `.`), path separators, and other unsafe characters — `group.json` is
 * shared across a team, so an unsafe name is a cross-machine injection vector.
 */
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isSafeName(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_NAME_PATTERN.test(value);
}

export function getGroupConfigFile(parentRoot: string): string {
  return path.join(parentRoot, GROUP_CONFIG_FILENAME);
}

export function getGroupLocalFile(parentRoot: string): string {
  return path.join(parentRoot, GROUP_LOCAL_FILENAME);
}

export function getGroupStoreDir(parentRoot: string): string {
  return path.join(parentRoot, GROUP_STORE_DIRNAME);
}

/**
 * Validate a parsed `group.json`. Returns an array of errors (empty = valid).
 * Mirrors the lightweight validation style of schema.ts.
 */
export function validateGroupConfig(raw: any): GroupValidationError[] {
  const errors: GroupValidationError[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ path: '', message: 'group.json must be a JSON object' }];
  }

  if (!isNonEmptyString(raw.name)) {
    errors.push({ path: 'name', message: 'missing or empty group name' });
  }

  if (!Array.isArray(raw.members)) {
    errors.push({ path: 'members', message: 'members must be an array' });
    return errors;
  }
  if (raw.members.length === 0) {
    errors.push({ path: 'members', message: 'members must be a non-empty array' });
  }

  const seenNames = new Set<string>();
  raw.members.forEach((member: any, index: number) => {
    const at = `members[${index}]`;
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      errors.push({ path: at, message: 'member must be an object' });
      return;
    }
    if (!isNonEmptyString(member.name)) {
      errors.push({ path: `${at}.name`, message: 'missing or empty member name' });
    } else if (!isSafeName(member.name)) {
      errors.push({
        path: `${at}.name`,
        message: `unsafe member name '${member.name}' (must be a single path segment: letters, digits, '.', '_', '-')`,
      });
    } else {
      if (seenNames.has(member.name)) {
        errors.push({ path: `${at}.name`, message: `duplicate member name '${member.name}' (names must be unique)` });
      }
      seenNames.add(member.name);
    }
    if (!isNonEmptyString(member.role)) {
      errors.push({ path: `${at}.role`, message: 'missing or empty member role' });
    }
    if (!isNonEmptyString(member.remote)) {
      errors.push({ path: `${at}.remote`, message: 'missing or empty member remote (git URL)' });
    }
    if (member.testCommand != null && !isNonEmptyString(member.testCommand)) {
      errors.push({ path: `${at}.testCommand`, message: 'testCommand must be a non-empty string when present' });
    }
  });

  return errors;
}

export function formatGroupValidationErrors(errors: GroupValidationError[]): string {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');
}

async function readJsonIfPresent(filePath: string): Promise<any | null> {
  if (!existsSync(filePath)) return null;
  const data = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * Resolve a member's local checkout path. Default layout assumes members are
 * siblings of the parent repo (`../<name>`). A gitignored group.local.json may
 * override per-machine via `{ "paths": { "<name>": "<path>" } }`.
 */
function resolveMemberPath(parentRoot: string, member: GroupMember, local: GroupLocalConfig | null): string {
  const override = local?.paths?.[member.name];
  if (isNonEmptyString(override)) {
    return path.isAbsolute(override) ? path.resolve(override) : path.resolve(parentRoot, override);
  }
  return path.resolve(parentRoot, '..', member.name);
}

/**
 * Load the group context for a parent workspace root. Returns null when no
 * `group.json` is present (single-repo mode — the module stays inert).
 * Throws on a present-but-invalid `group.json`.
 */
export async function loadGroupContext(parentRoot: string): Promise<GroupContext | null> {
  const configFile = getGroupConfigFile(parentRoot);
  const raw = await readJsonIfPresent(configFile);
  if (raw == null) return null;

  const errors = validateGroupConfig(raw);
  if (errors.length > 0) {
    throw new Error(`Invalid group.json: ${formatGroupValidationErrors(errors)}`);
  }

  const config: GroupConfig = {
    name: raw.name,
    members: raw.members.map((m: any) => ({
      name: m.name,
      role: m.role,
      remote: m.remote,
      ...(isNonEmptyString(m.testCommand) ? { testCommand: m.testCommand } : {}),
    })),
  };

  let local: GroupLocalConfig | null = null;
  try {
    local = await readJsonIfPresent(getGroupLocalFile(parentRoot));
  } catch (err) {
    console.warn(`[group] Ignoring malformed ${GROUP_LOCAL_FILENAME}:`, err);
    local = null;
  }

  const members: ResolvedMember[] = config.members.map((member) => {
    const resolvedPath = resolveMemberPath(parentRoot, member, local);
    return { ...member, path: resolvedPath, pathExists: existsSync(resolvedPath) };
  });

  const groupStoreDir = getGroupStoreDir(parentRoot);
  await ensureGroupStoreScaffold(groupStoreDir);

  return {
    parentRoot,
    config,
    members,
    groupStoreDir,
    docsBranch: GROUP_DOCS_BRANCH,
  };
}

/**
 * Ensure the canonical `.flux-group` store layout exists on disk. Creates the
 * directory tree and seed entry docs if missing. Idempotent — never overwrites
 * existing content. The orphan-branch worktree attach + push is owned by
 * FLUX-396; this only guarantees the on-disk layout is loadable.
 */
export async function ensureGroupStoreScaffold(groupStoreDir: string): Promise<void> {
  await fs.mkdir(path.join(groupStoreDir, 'features'), { recursive: true });
  await fs.mkdir(path.join(groupStoreDir, 'contracts'), { recursive: true });

  const indexFile = path.join(groupStoreDir, 'index.md');
  if (!existsSync(indexFile)) {
    await fs.writeFile(
      indexFile,
      '# Feature Index\n\nCross-project feature maps for this group. Entries are authored by mapping tickets.\n',
      'utf-8',
    );
  }

  const topologyFile = path.join(groupStoreDir, 'topology.md');
  if (!existsSync(topologyFile)) {
    await fs.writeFile(
      topologyFile,
      '# System Topology\n\nHow the member repos fit together. Authored by mapping tickets.\n',
      'utf-8',
    );
  }
}

// ─── Summary projection (for get_project_group / portal) ─────────────────────

/** Path equality for registry comparison (case-insensitive on Windows). Local to avoid a workspace.ts import cycle. */
function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export interface GroupMemberSummary {
  name: string;
  role: string;
  remote: string;
  path: string;
  /** Re-checked live at projection time, not the snapshot taken at load. */
  pathExists: boolean;
  /** Whether this member's checkout is a registered EH workspace (Case 1). Present only when registry is supplied. */
  registered?: boolean;
  testCommand?: string;
}

export interface GroupSummary {
  configured: boolean;
  name?: string;
  members?: GroupMemberSummary[];
  /** Parent repo root that owns the group. Present only when registry is supplied. */
  parentRoot?: string;
  /** Whether the dedicated parent is a registered EH workspace. Present only when registry is supplied. */
  parentRegistered?: boolean;
  /** True when parent + every present member is registered (Case 1 holds). Present only when registry is supplied. */
  registrationComplete?: boolean;
  /**
   * How the *current* workspace sits in a group, independent of `configured`
   * (which is parent-context only). Set on both the parent (`role: 'parent'`)
   * and a bound member (`role: 'member'`), so a member workspace can show it
   * belongs to a group without inheriting parent-only operations.
   */
  membership?: GroupMembershipInfo;
  message?: string;
}

/** The current workspace's place in a multi-repo group (FLUX-412). */
export interface GroupMembershipInfo {
  role: 'parent' | 'member';
  /** Name of the group this workspace belongs to. */
  groupName: string;
  /** Parent repo root that owns the group. */
  parentRoot: string;
  /** This workspace's member name (only when `role === 'member'`). */
  memberName?: string;
  /** This workspace's member role label (only when `role === 'member'`). */
  memberRole?: string;
}

/**
 * Project a GroupContext into a serializable summary. `pathExists` is
 * re-evaluated here (a single stat per member) rather than reused from the
 * load-time snapshot, so callers see whether each member is checked out *now*.
 * Returns a `configured: false` summary when no group is active.
 *
 * When `registeredPaths` (the current workspace registry) is supplied, the
 * summary also reports Case-1 registration state: which members + the parent
 * are registered, and whether registration is complete. Omitting it keeps the
 * legacy shape unchanged.
 */
export function summarizeGroup(group: GroupContext | null, registeredPaths?: string[]): GroupSummary {
  if (!group) {
    return {
      configured: false,
      message: 'No multi-repo group is configured (no group.json in the workspace root).',
    };
  }
  const isRegistered = (target: string): boolean =>
    !!registeredPaths && registeredPaths.some((p) => samePath(p, target));
  const members = group.members.map((m) => {
    const present = existsSync(m.path);
    return {
      name: m.name,
      role: m.role,
      remote: m.remote,
      path: m.path,
      pathExists: present,
      ...(registeredPaths ? { registered: isRegistered(m.path) } : {}),
      ...(m.testCommand ? { testCommand: m.testCommand } : {}),
    };
  });
  const summary: GroupSummary = {
    configured: true,
    name: group.config.name,
    members,
  };
  if (registeredPaths) {
    summary.parentRoot = group.parentRoot;
    summary.parentRegistered = isRegistered(group.parentRoot);
    // Complete = parent registered AND every present member registered.
    summary.registrationComplete =
      summary.parentRegistered && members.every((m) => !m.pathExists || m.registered);
  }
  return summary;
}

// ─── Agent scope (sibling-source scouring) ───────────────────────────────────

/**
 * Build the extra CLI args that put every checked-out member repo in the agent's
 * file scope. Agent sessions spawn with `cwd` at the parent root, so members
 * (siblings outside cwd) are invisible to native grep/glob/read without this.
 *
 * Emits `--add-dir <path>` per member whose checkout currently exists on disk
 * (both Copilot CLI and Claude Code accept `--add-dir`). Returns `[]` in
 * single-repo mode, so callers can spread it unconditionally.
 *
 * Read-only is convention-enforced (single-writer model + skill guidance);
 * neither CLI supports per-directory read-only mounts. The `existsSync` check is
 * live so a member cloned after activate is still picked up, and a member that
 * isn't checked out is silently skipped rather than passed as a missing path.
 */
export function buildMemberScopeArgs(group: GroupContext | null = currentGroup): string[] {
  if (!group) return [];
  const args: string[] = [];
  const seen = new Set<string>();
  const parent = path.resolve(group.parentRoot);
  for (const member of group.members) {
    const resolved = path.resolve(member.path);
    // Skip the parent (already the cwd) and any duplicate paths.
    if (resolved === parent || seen.has(resolved)) continue;
    seen.add(resolved);
    if (existsSync(resolved)) {
      args.push('--add-dir', resolved);
    }
  }
  return args;
}

// ─── Module-level current context ────────────────────────────────────────────

let currentGroup: GroupContext | null = null;

/** Get the currently loaded group context, or null in single-repo mode. */
export function getGroupContext(): GroupContext | null {
  return currentGroup;
}

/** Whether a multi-repo group is currently active. */
export function isGroupMode(): boolean {
  return currentGroup != null;
}

/**
 * Activate (or clear) the group context for a parent root. Called from
 * activateWorkspace. Never throws on absence; a malformed group.json surfaces
 * as a warning and leaves the engine in single-repo mode.
 */
export async function activateGroup(parentRoot: string): Promise<GroupContext | null> {
  try {
    currentGroup = await loadGroupContext(parentRoot);
  } catch (err) {
    console.error(`[group] Failed to activate group for ${parentRoot}:`, err);
    currentGroup = null;
  }
  if (currentGroup) {
    console.log(`[group] Active group '${currentGroup.config.name}' with ${currentGroup.members.length} member(s)`);
  }
  return currentGroup;
}

// ─── Member binding (reverse-lookup of a member's parent group) ──────────────

const execFileAsync = promisify(execFile);

export interface MemberGroupBinding {
  /** Parent repo root that owns the group this workspace belongs to. */
  parentRoot: string;
  /** The parent's fully-resolved group context (provides groupStoreDir). */
  parentGroup: GroupContext;
  /** This workspace's member name within the parent's group.json. */
  memberName: string;
  /** This workspace's own origin remote, in normalized comparison form. */
  selfRemote: string;
}

let currentMemberBinding: MemberGroupBinding | null = null;

/** Get the active member→parent binding, or null when not a bound member. */
export function getMemberBinding(): MemberGroupBinding | null {
  return currentMemberBinding;
}

/**
 * Read + validate a workspace's `group.json` and return its members' identity
 * (name + remote) WITHOUT scaffolding the store. Light enough to run across
 * every registered workspace during discovery. Returns null when absent or
 * malformed (a malformed parent is simply skipped during the scan).
 */
export async function peekGroupMembers(root: string): Promise<{ name: string; remote: string }[] | null> {
  const raw = await readJsonIfPresent(getGroupConfigFile(root)).catch(() => null);
  if (raw == null) return null;
  if (validateGroupConfig(raw).length > 0) return null;
  return (raw.members as any[])
    .filter((m) => isNonEmptyString(m?.name) && isNonEmptyString(m?.remote))
    .map((m) => ({ name: m.name as string, remote: m.remote as string }));
}

/** Read a checkout's `origin` remote URL, or null if it isn't a git repo / has no origin. */
export async function getOriginRemote(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin'], { windowsHide: true });
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a git remote URL for identity comparison. Collapses the common
 * equivalent spellings of the same repo (https / ssh / scp-like, with or
 * without a trailing `.git` or slash, with or without a `user@`) to a lowercase
 * `host/path` key. Returns '' for unusable input.
 */
export function normalizeRemoteForCompare(remote: string): string {
  let url = (remote || '').trim();
  if (!url) return '';
  // scp-like: user@host:path  →  host/path
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9._-]+):(.+)$/.exec(url);
  if (scp) {
    url = `${scp[1]}/${scp[2]}`;
  } else {
    url = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // strip scheme://
    url = url.replace(/^[^@/]+@/, ''); // strip leading user@
  }
  url = url.replace(/\.git$/i, '');
  url = url.replace(/\/+$/, '');
  return url.toLowerCase();
}

/**
 * Reverse-lookup discovery (Case 1 — same machine, one engine). When the active
 * workspace is NOT itself a parent (no `group.json`), scan the registered
 * workspaces for a parent whose `group.json` lists this workspace's `origin`
 * remote as a member. On a match, bind to that parent's group context so its
 * `.flux-group/` store can be surfaced read-only in this member's portal.
 * Never throws; clears the binding when no parent matches.
 */
export async function activateMemberBinding(selfRoot: string, registeredRoots: string[]): Promise<MemberGroupBinding | null> {
  currentMemberBinding = null;
  try {
    // If this workspace is itself a parent, the direct group context handles it.
    if (await peekGroupMembers(selfRoot)) return null;

    const selfRemoteRaw = await getOriginRemote(selfRoot);
    if (!selfRemoteRaw) return null;
    const selfKey = normalizeRemoteForCompare(selfRemoteRaw);
    if (!selfKey) return null;

    const selfResolved = path.resolve(selfRoot);
    for (const root of registeredRoots) {
      if (path.resolve(root) === selfResolved) continue;
      const members = await peekGroupMembers(root);
      if (!members) continue;
      const match = members.find((m) => normalizeRemoteForCompare(m.remote) === selfKey);
      if (!match) continue;

      const parentGroup = await loadGroupContext(root).catch(() => null);
      if (!parentGroup) continue;

      currentMemberBinding = {
        parentRoot: path.resolve(root),
        parentGroup,
        memberName: match.name,
        selfRemote: selfKey,
      };
      console.log(`[group] Workspace bound as member '${match.name}' of group '${parentGroup.config.name}' (parent: ${root})`);
      return currentMemberBinding;
    }
  } catch (err) {
    console.error(`[group] Member binding discovery failed for ${selfRoot}:`, err);
    currentMemberBinding = null;
  }
  return null;
}

/**
 * Reverse of the file→`Product/...` mapping: turn a `Product/<...>` doc path
 * back into its store-relative markdown file path (`<...>.md`). Used to route a
 * member's edit of a group doc to the parent's canonical store. Returns null
 * when the path is not under the group prefix or contains unsafe segments.
 */
export function groupDocPathToStoreRelative(docPath: string): string | null {
  const segments = (docPath || '').split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== GROUP_DOCS_PREFIX) return null;
  const rest = segments.slice(1);
  if (rest.some((s) => s === '.' || s === '..')) return null;
  return rest.join('/') + '.md';
}

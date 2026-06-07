import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

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

export interface GroupMemberSummary {
  name: string;
  role: string;
  remote: string;
  path: string;
  /** Re-checked live at projection time, not the snapshot taken at load. */
  pathExists: boolean;
  testCommand?: string;
}

export interface GroupSummary {
  configured: boolean;
  name?: string;
  members?: GroupMemberSummary[];
  message?: string;
}

/**
 * Project a GroupContext into a serializable summary. `pathExists` is
 * re-evaluated here (a single stat per member) rather than reused from the
 * load-time snapshot, so callers see whether each member is checked out *now*.
 * Returns a `configured: false` summary when no group is active.
 */
export function summarizeGroup(group: GroupContext | null): GroupSummary {
  if (!group) {
    return {
      configured: false,
      message: 'No multi-repo group is configured (no group.json in the workspace root).',
    };
  }
  return {
    configured: true,
    name: group.config.name,
    members: group.members.map((m) => ({
      name: m.name,
      role: m.role,
      remote: m.remote,
      path: m.path,
      pathExists: existsSync(m.path),
      ...(m.testCommand ? { testCommand: m.testCommand } : {}),
    })),
  };
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

import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  type WorkspaceEntry,
} from './global-settings.js';
import { isPkg, isSea, getSeaExtractDir } from './packaged-mode.js';
import { getWorkspace, canonicalizeWorkspaceRoot, normalizeWorkspaceKey } from './workspace-context.js';

// In CJS bundles (esbuild output / pkg executable), __dirname is provided by Node.
// In ESM dev mode (tsx / Node 20+), use import.meta for the source directory.
const __dirname_resolved: string = (() => {
  // __dirname exists at runtime in CJS (esbuild/pkg output); @types/node declares
  // it as an ambient global regardless of module kind, so no TS suppression is needed here.
  if (typeof __dirname === 'string' && __dirname && path.isAbsolute(__dirname)) return __dirname;
  try {
    const metaUrl = import.meta.url;
    if (metaUrl && metaUrl.startsWith('file:')) {
      return path.dirname(fileURLToPath(metaUrl));
    }
  } catch {}
  return path.join(process.cwd(), 'src');
})();

// FLUX-343: the active-root pointer lives on the Workspace object (workspace-context.ts) now,
// not as a module-level `export let` here. These accessors are the compatibility surface.
export function getWorkspaceRoot(): string | null {
  return getWorkspace().root;
}

export function setWorkspaceRoot(root: string) {
  getWorkspace().root = root;
}

/**
 * Resolve the active workspace root, or throw a clear, actionable error when none is
 * bound (FLUX-705). The path getters used to dereference `workspaceRoot!`, so an unbound
 * engine surfaced Node's cryptic `TypeError: The "path" argument must be of type string.
 * Received null` from `path.join(null, …)` on the FIRST ticket write — sending agents
 * chasing phantom "engine is down / worktree gone" theories. A workspace ends up unbound
 * when startup finds no valid candidate (lost `lastWorkspace`, or the `.flux`/`.flux-store`
 * store missing — e.g. the orphan-mode `.flux-store` worktree was removed during an update).
 */
export function requireWorkspaceRoot(): string {
  const root = getWorkspace().root;
  if (!root) {
    throw new Error(
      'No active Event Horizon workspace is bound. The engine is running but has not loaded ' +
      'a project folder — usually the saved workspace was lost or its store is missing after ' +
      'an update or move (settings.json "lastWorkspace" empty, or the folder no longer contains ' +
      'a .flux / .flux-store store; in orphan mode the .flux-store git worktree may have been ' +
      'removed). Open the Event Horizon portal and re-select your project folder to rebind it.',
    );
  }
  return root;
}

export function getFluxDir() { return path.join(requireWorkspaceRoot(), '.flux'); }
export function getFluxStoreDir() { return path.join(requireWorkspaceRoot(), '.flux-store'); }
// Boolean probe: must never throw when unbound — answer "not orphan" instead of letting
// path.join(null, …) blow up (FLUX-705). Callers branch on this before resolving real paths.
export function isOrphanMode() {
  const root = getWorkspace().root;
  return root != null && existsSync(path.join(root, '.flux-store'));
}
export function getActiveFluxDir() { return isOrphanMode() ? getFluxStoreDir() : getFluxDir(); }
export function getConfigFile() {
  // Orphan mode: config.json lives in .flux-store. It's gitignored (FLUX-532), so a workspace set
  // up by freshly cloning an existing flux-data branch has NO .flux-store/config.json yet — and it
  // must STILL resolve here, not fall through to the in-repo .flux/ path whose directory doesn't
  // exist on a clone. Returning .flux/config.json in that case made loadConfig()'s first-run default
  // write throw ENOENT on .flux/config.json.tmp, aborting workspace activation before any ticket
  // loaded — an empty board on every fresh orphan clone (FLUX-1340).
  if (isOrphanMode()) {
    const storeConfig = path.join(getFluxStoreDir(), 'config.json');
    if (existsSync(storeConfig)) return storeConfig;
    // Legacy pre-migration copy still sitting in .flux/: read it in place. migrateStrandedFluxTickets
    // moves it into the store before initDir(), so only prefer it while it actually exists.
    const legacyConfig = path.join(getFluxDir(), 'config.json');
    if (existsSync(legacyConfig)) return legacyConfig;
    // Neither exists yet — point at the store so the first-run default write lands in a directory
    // that exists (.flux-store), never the phantom .flux/.
    return storeConfig;
  }
  return path.join(getFluxDir(), 'config.json');
}
export function getTaskAssetsDir() { return path.join(getActiveFluxDir(), 'assets'); }
export function getReadStateFile() { return path.join(getActiveFluxDir(), 'read-state.json'); }

export type { WorkspaceEntry } from './global-settings.js';

export interface AppSettings {
  workspace?: string;
  workspaces?: WorkspaceEntry[];
}

export async function loadAppSettings(): Promise<AppSettings> {
  const global = await loadGlobalSettings();
  const result: AppSettings = { workspaces: global.workspaces };
  if (global.lastWorkspace) result.workspace = global.lastWorkspace;
  return result;
}

export async function saveAppSettings(settings: AppSettings) {
  const global = await loadGlobalSettings();
  if (settings.workspace !== undefined) global.lastWorkspace = settings.workspace;
  if (settings.workspaces !== undefined) global.workspaces = settings.workspaces;
  await saveGlobalSettings(global);
}

export async function getWorkspacesList(): Promise<WorkspaceEntry[]> {
  const global = await loadGlobalSettings();
  return global.workspaces ?? [];
}

/**
 * FLUX-1571: aligned with the S1 registry's own key rule (`normalizeWorkspaceKey`,
 * workspace-context.ts) — realpath'd + case-folded on win32, not a bare `path.resolve()` + fold.
 * Two entries that name the same on-disk root via an 8.3 short name / different casing now dedupe
 * (`addWorkspaceEntry`/`autoRegisterWorkspace` below) and compare equal the same way the registry
 * and HTTP/MCP header resolution do.
 */
export function pathsEqual(a: string, b: string): boolean {
  return normalizeWorkspaceKey(a) === normalizeWorkspaceKey(b);
}

export async function addWorkspaceEntry(entry: WorkspaceEntry): Promise<WorkspaceEntry[]> {
  const global = await loadGlobalSettings();
  const list = global.workspaces ?? [];
  // FLUX-1571: store the realpath-canonical form, not a bare `path.resolve()` — an entry persisted
  // as-typed (e.g. an 8.3 short name) would never byte-match the registry key `openWorkspaceLive`
  // computes for the same board, so header-based routing that echoes this stored path back would
  // silently miss and fall through to the default board.
  const normalized = canonicalizeWorkspaceRoot(entry.path);
  if (!list.some(w => pathsEqual(w.path, normalized))) {
    const newEntry: WorkspaceEntry = { path: normalized };
    if (entry.label) newEntry.label = entry.label;
    list.push(newEntry);
  }
  global.workspaces = list;
  await saveGlobalSettings(global);
  return list;
}

export async function removeWorkspaceEntry(index: number): Promise<WorkspaceEntry[]> {
  const global = await loadGlobalSettings();
  const list = global.workspaces ?? [];
  if (index >= 0 && index < list.length) {
    list.splice(index, 1);
  }
  global.workspaces = list;
  await saveGlobalSettings(global);
  return list;
}

export async function updateWorkspaceLabel(index: number, label: string | undefined): Promise<WorkspaceEntry[]> {
  const global = await loadGlobalSettings();
  const list = global.workspaces ?? [];
  const entry = list[index];
  if (entry) {
    if (label) {
      entry.label = label;
    } else {
      delete entry.label;
    }
  }
  global.workspaces = list;
  await saveGlobalSettings(global);
  return list;
}

export async function autoRegisterWorkspace(wsPath: string) {
  const global = await loadGlobalSettings();
  const list = global.workspaces ?? [];
  const normalized = canonicalizeWorkspaceRoot(wsPath);
  if (!list.some(w => pathsEqual(w.path, normalized))) {
    list.push({ path: normalized });
    global.workspaces = list;
    await saveGlobalSettings(global);
  }
}

/** True when `dir` holds an Event Horizon store (`.flux/` in-repo or `.flux-store/` orphan). */
export function hasWorkspaceStore(dir: string): boolean {
  return existsSync(path.join(dir, '.flux')) || existsSync(path.join(dir, '.flux-store'));
}

/**
 * The registered workspace entry for `rootPath` (same-on-disk match via `pathsEqual`), or `null`
 * when nothing in the settings registry names it. The "is this a board this engine knows about at
 * all?" check behind `X-EH-Workspace` auto-open (workspace-binding.ts): a header naming a
 * registered-but-not-live board is brought up rather than silently falling back to the default one.
 */
export async function findRegisteredWorkspace(rootPath: string): Promise<WorkspaceEntry | null> {
  if (!rootPath) return null;
  const list = await getWorkspacesList();
  return list.find((w) => pathsEqual(w.path, rootPath)) ?? null;
}

/**
 * Which registered board owns `anyPath` — for MCP `bind_workspace`, where a hand-launched agent
 * passes its working directory rather than the board root. Pure over `entries` so it's unit-testable
 * without a settings file. Matches, in order: the entry itself; an entry that is an ANCESTOR of the
 * path (the agent is somewhere inside the repo); and the task-worktree layout
 * `<repoParent>/.eh-worktrees/<repo>-<id>` (a worktree is a SIBLING of its repo, so an agent running
 * inside one maps back to `<repoParent>/<repo>` — see task-worktree.ts's `taskWorktreePath`).
 * Comparison is by `normalizeWorkspaceKey` (realpath'd + case-folded on win32), same as the registry.
 */
export function matchRegisteredWorkspaceForPath(entries: WorkspaceEntry[], anyPath: string): WorkspaceEntry | null {
  if (!anyPath) return null;
  const target = normalizeWorkspaceKey(anyPath);
  const keyed = entries.map((entry) => ({ entry, key: normalizeWorkspaceKey(entry.path) }));
  const exact = keyed.find(({ key }) => key === target);
  if (exact) return exact.entry;
  // Longest registered ancestor wins (a nested board inside another board resolves to the inner one).
  const ancestors = keyed
    .filter(({ key }) => target.startsWith(key.endsWith(path.sep) ? key : key + path.sep))
    .sort((a, b) => b.key.length - a.key.length);
  if (ancestors[0]) return ancestors[0].entry;
  // Task worktree: walk up until a segment whose parent dir is `.eh-worktrees`, then map
  // `<repoParent>/.eh-worktrees/<repo>-<id>` → the registered `<repoParent>/<repo>`.
  let cursor = path.resolve(anyPath);
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    if (path.basename(parent) === '.eh-worktrees') {
      const repoParent = normalizeWorkspaceKey(path.dirname(parent));
      const worktreeName = path.basename(cursor);
      const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
      const candidates = keyed
        .filter(({ key }) => normalizeWorkspaceKey(path.dirname(key)) === repoParent)
        .filter(({ key }) => fold(worktreeName).startsWith(fold(path.basename(key)) + '-'))
        .sort((a, b) => path.basename(b.key).length - path.basename(a.key).length);
      if (candidates[0]) return candidates[0].entry;
      break;
    }
    cursor = parent;
  }
  return null;
}

/** {@link matchRegisteredWorkspaceForPath} against the live settings registry. */
export async function resolveRegisteredWorkspaceForPath(anyPath: string): Promise<WorkspaceEntry | null> {
  return matchRegisteredWorkspaceForPath(await getWorkspacesList(), anyPath);
}

/**
 * Persisted set of live secondary boards (`GlobalSettings.openWorkspaces`) — the boot restore
 * (`restoreRememberedOpenWorkspaces`, workspace-binding.ts) reads this so an engine restart brings
 * every board that was open back up, not just `lastWorkspace`. Stored canonical (true-cased
 * realpath), deduped by `pathsEqual`. Idempotent.
 */
export async function rememberOpenWorkspace(rootPath: string): Promise<void> {
  const global = await loadGlobalSettings();
  const canonical = canonicalizeWorkspaceRoot(rootPath);
  const list = global.openWorkspaces ?? [];
  if (list.some((p) => pathsEqual(p, canonical))) return;
  global.openWorkspaces = [...list, canonical];
  await saveGlobalSettings(global);
}

/** Inverse of {@link rememberOpenWorkspace}. No-op when `rootPath` isn't remembered. */
export async function forgetOpenWorkspace(rootPath: string): Promise<void> {
  const global = await loadGlobalSettings();
  const list = global.openWorkspaces ?? [];
  const next = list.filter((p) => !pathsEqual(p, rootPath));
  if (next.length === list.length) return;
  global.openWorkspaces = next;
  await saveGlobalSettings(global);
}

/** The remembered live-board roots, as stored (canonical). Empty on a fresh install. */
export async function getRememberedOpenWorkspaces(): Promise<string[]> {
  const global = await loadGlobalSettings();
  return [...(global.openWorkspaces ?? [])];
}

export function getCliWorkspace(): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--workspace');
  const val = idx !== -1 ? args[idx + 1] : undefined;
  if (val) return path.resolve(val);
  return null;
}

export function resolveSkillSourceRoot(): string {
  if (isPkg) return __dirname_resolved;
  if (isSea) return getSeaExtractDir();
  // FLUX-1416: build.js stages `.docs/skills` inside dist/ for every self-contained
  // bundle (pkg, sea, and Electron's `resources/engine` dir run via ELECTRON_RUN_AS_NODE).
  // Detect that layout directly instead of enumerating launch modes, so it also covers
  // Electron (which is neither isPkg nor isSea) and any future dist-direct launcher.
  if (existsSync(path.join(__dirname_resolved, '.docs', 'skills'))) return __dirname_resolved;
  // Dev checkout: engine/dist -> repo root.
  return path.resolve(__dirname_resolved, '..', '..');
}

export function resolvePortalDist(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--portal-dist');
  const val = idx !== -1 ? args[idx + 1] : undefined;
  if (val) return path.resolve(val);
  if (isPkg) return path.join(__dirname_resolved, 'portal', 'dist');
  if (isSea) return path.join(getSeaExtractDir(), 'portal', 'dist');
  return path.resolve(__dirname_resolved, '..', '..', 'portal', 'dist');
}

export function hasCwdFlux(): boolean {
  return existsSync(path.join(process.cwd(), '.flux'));
}

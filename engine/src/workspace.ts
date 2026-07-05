import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  type WorkspaceEntry,
} from './global-settings.js';
import { isPkg, isSea, getSeaExtractDir } from './packaged-mode.js';

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

export let workspaceRoot: string | null = null;

export function setWorkspaceRoot(root: string) {
  workspaceRoot = root;
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
  if (!workspaceRoot) {
    throw new Error(
      'No active Event Horizon workspace is bound. The engine is running but has not loaded ' +
      'a project folder — usually the saved workspace was lost or its store is missing after ' +
      'an update or move (settings.json "lastWorkspace" empty, or the folder no longer contains ' +
      'a .flux / .flux-store store; in orphan mode the .flux-store git worktree may have been ' +
      'removed). Open the Event Horizon portal and re-select your project folder to rebind it.',
    );
  }
  return workspaceRoot;
}

export function getFluxDir() { return path.join(requireWorkspaceRoot(), '.flux'); }
export function getFluxStoreDir() { return path.join(requireWorkspaceRoot(), '.flux-store'); }
// Boolean probe: must never throw when unbound — answer "not orphan" instead of letting
// path.join(null, …) blow up (FLUX-705). Callers branch on this before resolving real paths.
export function isOrphanMode() { return workspaceRoot != null && existsSync(path.join(workspaceRoot, '.flux-store')); }
export function getActiveFluxDir() { return isOrphanMode() ? getFluxStoreDir() : getFluxDir(); }
export function getConfigFile() {
  const storeConfig = path.join(getFluxStoreDir(), 'config.json');
  if (isOrphanMode() && existsSync(storeConfig)) return storeConfig;
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

export function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

export async function addWorkspaceEntry(entry: WorkspaceEntry): Promise<WorkspaceEntry[]> {
  const global = await loadGlobalSettings();
  const list = global.workspaces ?? [];
  const normalized = path.resolve(entry.path);
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
  const normalized = path.resolve(wsPath);
  if (!list.some(w => pathsEqual(w.path, normalized))) {
    list.push({ path: normalized });
    global.workspaces = list;
    await saveGlobalSettings(global);
  }
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

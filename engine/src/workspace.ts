import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  type WorkspaceEntry,
} from './global-settings.js';

// In CJS bundles (esbuild output / pkg executable), __dirname is provided by Node.
// In ESM dev mode (tsx / Node 20+), use import.meta for the source directory.
const __dirname_resolved: string = (() => {
  // @ts-ignore — __dirname exists at runtime in CJS but TS ESM doesn't declare it
  if (typeof __dirname === 'string' && __dirname && path.isAbsolute(__dirname)) return __dirname;
  try {
    const metaUrl = (import.meta as any).url;
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

export function getFluxDir() { return path.join(workspaceRoot!, '.flux'); }
export function getFluxStoreDir() { return path.join(workspaceRoot!, '.flux-store'); }
export function isOrphanMode() { return existsSync(getFluxStoreDir()); }
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
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) return __dirname_resolved;
  return path.resolve(__dirname_resolved, '..', '..');
}

export function resolvePortalDist(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--portal-dist');
  const val = idx !== -1 ? args[idx + 1] : undefined;
  if (val) return path.resolve(val);
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) return path.join(__dirname_resolved, 'portal', 'dist');
  return path.resolve(__dirname_resolved, '..', '..', 'portal', 'dist');
}

export function hasCwdFlux(): boolean {
  return existsSync(path.join(process.cwd(), '.flux'));
}

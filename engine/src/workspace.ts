import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

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

const APP_SETTINGS_DIR = path.join(os.homedir(), '.event-horizon');
const APP_SETTINGS_FILE = path.join(APP_SETTINGS_DIR, 'settings.json');

export async function loadAppSettings(): Promise<{ workspace?: string }> {
  try {
    const raw = await fs.readFile(APP_SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveAppSettings(settings: { workspace?: string }) {
  await fs.mkdir(APP_SETTINGS_DIR, { recursive: true });
  await fs.writeFile(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

export function getCliWorkspace(): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--workspace');
  if (idx !== -1 && args[idx + 1]) return path.resolve(args[idx + 1]);
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
  if (idx !== -1 && args[idx + 1]) return path.resolve(args[idx + 1]);
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) return path.join(__dirname_resolved, 'portal', 'dist');
  return path.resolve(__dirname_resolved, '..', '..', 'portal', 'dist');
}

export function hasCwdFlux(): boolean {
  return existsSync(path.join(process.cwd(), '.flux'));
}

import { log } from './log.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addNotification } from './notifications.js';

const __dir = (() => {
  if (typeof __dirname === 'string' && resolve(__dirname) === __dirname) return __dirname;
  try { return dirname(fileURLToPath(import.meta.url)); } catch {}
  return resolve(process.cwd(), 'src');
})();

export interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

let cachedResult: UpdateInfo | null = null;

// Inlined at build time by esbuild's `define` (see scripts/build.js). Undefined
// under tsx/dev where the bundle isn't built, so we fall back to package.json.
declare const __EH_VERSION__: string | undefined;

export function getLocalVersion(): string {
  // Bundled builds (SEA / pkg): use the inlined version — no disk read, works
  // even when no package.json sits next to the binary.
  if (typeof __EH_VERSION__ === 'string' && __EH_VERSION__) return __EH_VERSION__;
  // Dev (tsx): read from package.json on disk.
  try {
    const pkgPath = resolve(__dir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [rMaj = 0, rMin = 0, rPatch = 0] = parse(remote);
  const [lMaj = 0, lMin = 0, lPatch = 0] = parse(local);
  if (rMaj !== lMaj) return rMaj > lMaj;
  if (rMin !== lMin) return rMin > lMin;
  return rPatch > lPatch;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const owner = 'guybnd';
  const repo = 'Event-Horizon';
  const currentVersion = getLocalVersion();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'EventHorizon' },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = await res.json() as { tag_name?: string; html_url?: string };
    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    const releaseUrl = data.html_url || `https://github.com/${owner}/${repo}/releases`;

    const updateAvailable = isNewer(latestVersion, currentVersion);

    cachedResult = { updateAvailable, currentVersion, latestVersion, releaseUrl };

    if (updateAvailable) {
      log.info(`\x1b[36m[update]\x1b[0m A newer version is available: v${latestVersion} (current: v${currentVersion}) — ${releaseUrl}`);
      addNotification({
        type: 'info',
        title: `Update available: v${latestVersion}`,
        message: `A newer version is available (current: v${currentVersion}). View the release at ${releaseUrl}`,
        actions: [{ label: 'View Release', actionId: 'open-url' }],
      });
    }

    return cachedResult;
  } catch {
    return null;
  }
}

export function getCachedUpdateInfo(): UpdateInfo | null {
  return cachedResult;
}

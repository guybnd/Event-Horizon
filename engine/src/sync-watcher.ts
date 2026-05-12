import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chokidar from 'chokidar';
import { isOrphanMode, getFluxStoreDir } from './workspace.js';

const execFileAsync = promisify(execFile);

const DEBOUNCE_MS = 30_000;

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function runSync(storeDir: string): Promise<void> {
  const workspaceRoot = path.dirname(storeDir);
  try {
    await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
    const { stdout } = await execFileAsync('git', ['-C', storeDir, 'status', '--porcelain']);
    if (!stdout.trim()) return; // nothing to commit
    await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync']);
    await execFileAsync('git', ['-C', workspaceRoot, 'push', 'origin', 'flux-data']).catch(() => {
      // push is best-effort — no remote is fine
    });
    console.log('[sync-watcher] Committed and pushed flux-data');
  } catch (err: any) {
    console.error(`[sync-watcher] sync failed: ${err.message}`);
  }
}

function scheduleSync(storeDir: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void runSync(storeDir);
  }, DEBOUNCE_MS);
}

export function startSyncWatcher(): void {
  stopSyncWatcher();
  if (!isOrphanMode()) return;

  const storeDir = getFluxStoreDir();

  watcher = chokidar.watch(storeDir, {
    ignored: (filePath: string) => {
      const base = path.basename(filePath);
      return base.startsWith('.git') || base === '.git';
    },
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on('add', () => scheduleSync(storeDir));
  watcher.on('change', () => scheduleSync(storeDir));
  watcher.on('unlink', () => scheduleSync(storeDir));

  console.log('[sync-watcher] Watching .flux-store/ for changes (30s debounce)');
}

export function stopSyncWatcher(): void {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (watcher) { void watcher.close(); watcher = null; }
}


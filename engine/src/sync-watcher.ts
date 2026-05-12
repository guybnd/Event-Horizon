import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chokidar from 'chokidar';
import { isOrphanMode, getFluxStoreDir } from './workspace.js';
import { configCache } from './config.js';

const execFileAsync = promisify(execFile);

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let scheduler: ReturnType<typeof createScheduler> | null = null;

async function runSync(storeDir: string): Promise<void> {
  const workspaceRoot = path.dirname(storeDir);
  try {
    await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
    const { stdout } = await execFileAsync('git', ['-C', storeDir, 'status', '--porcelain']);
    if (!stdout.trim()) return;
    await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync']);
    await execFileAsync('git', ['-C', workspaceRoot, 'push', 'origin', 'flux-data']).catch(() => {
      // push is best-effort — no remote is fine
    });
    console.log('[sync-watcher] Committed and pushed flux-data');
  } catch (err: any) {
    console.error(`[sync-watcher] sync failed: ${err.message}`);
  }
}

export function createScheduler(
  getDebounceMs: () => number,
  getMaxWaitMs: () => number,
  onSync: () => void
): { schedule: () => void; reset: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | null = null;

  function schedule() {
    const now = Date.now();
    if (deadline === null) deadline = now + getMaxWaitMs();
    if (timer) clearTimeout(timer);
    const remaining = deadline - now;
    const delay = Math.min(getDebounceMs(), remaining);
    timer = setTimeout(() => {
      timer = null;
      deadline = null;
      onSync();
    }, delay);
  }

  function reset() {
    if (timer) { clearTimeout(timer); timer = null; }
    deadline = null;
  }

  return { schedule, reset };
}

export function startSyncWatcher(): void {
  stopSyncWatcher();
  if (!isOrphanMode()) return;

  const storeDir = getFluxStoreDir();

  scheduler = createScheduler(
    () => configCache.syncSettings?.debounceMs ?? 30000,
    () => configCache.syncSettings?.maxWaitMs ?? 300000,
    () => { void runSync(storeDir); }
  );

  watcher = chokidar.watch(storeDir, {
    ignored: (filePath: string) => {
      const base = path.basename(filePath);
      return base.startsWith('.git') || base === '.git';
    },
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on('add', () => scheduler!.schedule());
  watcher.on('change', () => scheduler!.schedule());
  watcher.on('unlink', () => scheduler!.schedule());

  const debounceMs = configCache.syncSettings?.debounceMs ?? 30000;
  const maxWaitMs = configCache.syncSettings?.maxWaitMs ?? 300000;
  console.log(`[sync-watcher] Watching .flux-store/ for changes (${debounceMs / 1000}s debounce, ${maxWaitMs / 1000}s max-wait)`);
}

export function stopSyncWatcher(): void {
  if (scheduler) { scheduler.reset(); scheduler = null; }
  if (watcher) { void watcher.close(); watcher = null; }
}

import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import matter from 'gray-matter';
import { isOrphanMode, getFluxStoreDir } from './workspace.js';
import { configCache } from './config.js';

const execFileAsync = promisify(execFile);

let watcher: ReturnType<typeof chokidar.watch> | null = null;
let scheduler: ReturnType<typeof createScheduler> | null = null;

export interface ConflictInfo {
  ticketId: string;
  localContent: string;
  remoteContent: string;
}

export type SyncStatus =
  | { state: 'idle' }
  | { state: 'syncing' }
  | { state: 'synced'; lastSyncTime: string }
  | { state: 'conflict'; conflicts: ConflictInfo[] }
  | { state: 'error'; error: string; errorType: 'network' | 'auth' | 'conflict' | 'unknown' };

let currentStatus: SyncStatus = { state: 'idle' };
const statusListeners: Array<(status: SyncStatus) => void> = [];
let pendingConflicts: ConflictInfo[] | null = null;

function updateStatus(status: SyncStatus): void {
  currentStatus = status;
  statusListeners.forEach((listener, index) => {
    try {
      listener(status);
    } catch (err) {
      console.error(`[sync-watcher] Error in status listener ${index}:`, err);
      // Remove failed listener to prevent future errors
      const idx = statusListeners.indexOf(listener);
      if (idx !== -1) statusListeners.splice(idx, 1);
    }
  });
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
  statusListeners.push(listener);
  // Return unsubscribe function
  return () => {
    const idx = statusListeners.indexOf(listener);
    if (idx !== -1) statusListeners.splice(idx, 1);
  };
}

export function triggerTestError(): void {
  updateStatus({
    state: 'error',
    error: 'This is a test error for UI development. The actual sync error was: "Command failed: git -C C:\\GitHub\\EventHorizon\\.flux-store commit -m flux: sync\\nfatal: Unable to create index.lock: File exists.\\n\\nAnother git process seems to be running in this repository, or the lock file may be stale."',
    errorType: 'unknown'
  });
  console.log('[sync-watcher] Test error triggered for UI testing');
}

async function allocateNewTicketId(storeDir: string, projectKey: string): Promise<string> {
  const files = await fs.readdir(storeDir);
  let maxId = 0;

  for (const file of files) {
    if (file.startsWith(`${projectKey}-`) && file.endsWith('.md')) {
      const idPart = file.replace(`${projectKey}-`, '').replace('.md', '');
      const num = parseInt(idPart, 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  }

  return `${projectKey}-${maxId + 1}`;
}

async function detectConflicts(storeDir: string): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];

  try {
    // Get list of modified files between local and remote in a single git diff
    const { stdout: diffFiles } = await execFileAsync('git', [
      '-C', storeDir,
      'diff', '--name-only',
      'HEAD', 'origin/flux-data'
    ]);

    const files = diffFiles.trim().split('\n').filter(f => f.endsWith('.md') && f);

    if (files.length === 0) return conflicts;

    // Get content for all differing files at once
    for (const file of files) {
      const ticketId = path.basename(file, '.md');

      try {
        // Get local content
        const localPath = path.join(storeDir, file);
        const localContent = await fs.readFile(localPath, 'utf-8');

        // Get remote content
        const { stdout: remoteContent } = await execFileAsync('git', [
          '-C', storeDir,
          'show', `origin/flux-data:${file}`
        ]);

        // Git diff already told us the file differs - that's a conflict
        conflicts.push({ ticketId, localContent, remoteContent });
      } catch (err) {
        // File might not exist on one side - not a conflict, just a new/deleted file
        console.log(`[sync-watcher] Skipping ${file} - exists only on one side`);
      }
    }
  } catch (err: any) {
    console.error('[sync-watcher] Error detecting conflicts:', err.message);
  }

  return conflicts;
}

export async function resolveConflicts(
  resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>
): Promise<void> {
  // Validation happens in the route handler - don't duplicate here
  if (!pendingConflicts || pendingConflicts.length === 0) {
    throw new Error('No conflicts to resolve');
  }

  const storeDir = getFluxStoreDir();

  // Apply all resolutions
  for (const resolution of resolutions) {
    const conflict = pendingConflicts.find(c => c.ticketId === resolution.ticketId)!;
    const filePath = path.join(storeDir, `${resolution.ticketId}.md`);

    switch (resolution.strategy) {
      case 'use-remote':
        await fs.writeFile(filePath, conflict.remoteContent, 'utf-8');
        console.log(`[sync-watcher] Resolved ${resolution.ticketId}: used remote version`);
        break;

      case 'rename-local':
        // Allocate new ID for local version and accept remote at original ID
        const projectKey = resolution.ticketId.split('-')[0];
        const newId = await allocateNewTicketId(storeDir, projectKey);

        // Write remote version to original file
        await fs.writeFile(filePath, conflict.remoteContent, 'utf-8');

        // Parse local content, update ID in frontmatter properly, serialize
        const parsed = matter(conflict.localContent);
        parsed.data.id = newId;
        const renamedContent = matter.stringify(parsed.content, parsed.data);

        const newFilePath = path.join(storeDir, `${newId}.md`);
        await fs.writeFile(newFilePath, renamedContent, 'utf-8');
        console.log(`[sync-watcher] Resolved ${resolution.ticketId}: renamed local to ${newId}, accepted remote`);
        break;

      case 'manual':
        await fs.writeFile(filePath, resolution.newContent!, 'utf-8');
        console.log(`[sync-watcher] Resolved ${resolution.ticketId}: used manual merge`);
        break;
    }
  }

  // Clear pending conflicts and continue sync (will commit the resolutions)
  pendingConflicts = null;
  console.log('[sync-watcher] All conflicts resolved. Continuing sync...');
  await runSync(storeDir);
}

async function runSync(storeDir: string): Promise<void> {
  const workspaceRoot = path.dirname(storeDir);
  updateStatus({ state: 'syncing' });

  try {
    // First, fetch and merge remote changes (remote is source of truth)
    try {
      await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data']);
      // Check if there are remote changes to pull
      const { stdout: localCommit } = await execFileAsync('git', ['-C', storeDir, 'rev-parse', 'HEAD']);
      const { stdout: remoteCommit } = await execFileAsync('git', ['-C', storeDir, 'rev-parse', 'origin/flux-data']);

      if (localCommit.trim() !== remoteCommit.trim()) {
        // Check if we can fast-forward (no local commits ahead)
        const { stdout: mergeBase } = await execFileAsync('git', ['-C', storeDir, 'merge-base', 'HEAD', 'origin/flux-data']);

        if (mergeBase.trim() === localCommit.trim()) {
          // Clean fast-forward
          await execFileAsync('git', ['-C', storeDir, 'pull', '--ff-only', 'origin', 'flux-data']);
          console.log('[sync-watcher] Pulled remote changes from flux-data (fast-forward)');
        } else {
          // Diverged - check for conflicts
          console.warn('[sync-watcher] Local and remote have diverged. Detecting conflicts...');
          const conflicts = await detectConflicts(storeDir);

          if (conflicts.length > 0) {
            // Pause sync and emit conflict status
            console.log(`[sync-watcher] Found ${conflicts.length} conflicting tickets. Waiting for user resolution.`);
            pendingConflicts = conflicts;
            updateStatus({ state: 'conflict', conflicts });
            return; // Stop sync until conflicts are resolved
          } else {
            // No content conflicts - safe to reset
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const backupBranch = `flux-data-backup-${timestamp}`;

            console.log('[sync-watcher] No conflicts detected. Backing up local changes before reset.');

            // Create backup branch at current HEAD
            await execFileAsync('git', ['-C', storeDir, 'branch', backupBranch, 'HEAD']);
            console.log(`[sync-watcher] Created backup branch: ${backupBranch}`);

            // Reset to remote (source of truth)
            await execFileAsync('git', ['-C', storeDir, 'reset', '--hard', 'origin/flux-data']);
            console.log(`[sync-watcher] Reset to remote flux-data (source of truth). Local changes backed up to ${backupBranch}`);
          }
        }
      }
    } catch (fetchErr: any) {
      // If fetch fails, determine error type and emit status
      const errorMsg = fetchErr.message || String(fetchErr);
      let errorType: 'network' | 'auth' | 'unknown' = 'unknown';

      if (errorMsg.includes('Could not resolve host') || errorMsg.includes('network')) {
        errorType = 'network';
      } else if (errorMsg.includes('Authentication failed') || errorMsg.includes('Permission denied')) {
        errorType = 'auth';
      }

      console.log(`[sync-watcher] fetch failed (${errorType}): ${errorMsg}`);
      // Don't set error status yet - we can still commit locally
    }

    // Then commit and push local changes
    await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
    const { stdout } = await execFileAsync('git', ['-C', storeDir, 'status', '--porcelain']);
    if (!stdout.trim()) {
      // No local changes to commit - sync complete
      updateStatus({ state: 'synced', lastSyncTime: new Date().toISOString() });
      return;
    }

    // Try commit with retry on lock file error
    let commitAttempts = 0;
    while (commitAttempts < 3) {
      try {
        await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync']);
        break; // Success
      } catch (commitErr: any) {
        const errorMsg = commitErr.message || String(commitErr);
        if (errorMsg.includes('index.lock') && commitAttempts < 2) {
          // Lock file error - wait and retry
          console.log(`[sync-watcher] Git lock detected, retrying in 1s (attempt ${commitAttempts + 1}/3)...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          commitAttempts++;
        } else {
          // Non-lock error or final attempt failed
          throw commitErr;
        }
      }
    }
    try {
      await execFileAsync('git', ['-C', workspaceRoot, 'push', 'origin', 'flux-data']);
      console.log('[sync-watcher] Committed and pushed flux-data');
      updateStatus({ state: 'synced', lastSyncTime: new Date().toISOString() });
    } catch (pushErr: any) {
      // Distinguish push failure types
      const errorMsg = pushErr.message || String(pushErr);
      let errorType: 'network' | 'auth' | 'unknown' = 'unknown';

      if (errorMsg.includes('Could not resolve host') || errorMsg.includes('network')) {
        errorType = 'network';
      } else if (errorMsg.includes('Authentication failed') || errorMsg.includes('Permission denied')) {
        errorType = 'auth';
      }

      console.log(`[sync-watcher] push failed (${errorType}): ${errorMsg}`);
      updateStatus({ state: 'error', error: errorMsg, errorType });
    }
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    console.error(`[sync-watcher] sync failed: ${errorMsg}`);
    updateStatus({ state: 'error', error: errorMsg, errorType: 'unknown' });
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

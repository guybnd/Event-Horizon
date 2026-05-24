import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import matter from 'gray-matter';
import { isOrphanMode, getFluxStoreDir } from './workspace.js';
import { configCache } from './config.js';

const execFileAsyncRaw = promisify(execFile);
function execFileAsync(file: string, args: string[]) {
  return execFileAsyncRaw(file, args, { windowsHide: true });
}

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

export function triggerSync(): void {
  if (!isOrphanMode()) return;
  const storeDir = getFluxStoreDir();
  void runSync(storeDir);
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

// Called after a failed git merge to collect files with unresolvable conflicts.
// Returns local (HEAD) vs remote content for each conflicted file.
async function detectMergeConflicts(storeDir: string): Promise<ConflictInfo[]> {
  const conflicts: ConflictInfo[] = [];
  try {
    const { stdout: diffOut } = await execFileAsync('git', ['-C', storeDir, 'diff', '--name-only', '--diff-filter=U']);
    const files = diffOut.trim().split('\n').filter(f => f.endsWith('.md') && f);
    for (const file of files) {
      const ticketId = path.basename(file, '.md');
      try {
        const { stdout: localContent } = await execFileAsync('git', ['-C', storeDir, 'show', `HEAD:${file}`]);
        const { stdout: remoteContent } = await execFileAsync('git', ['-C', storeDir, 'show', `MERGE_HEAD:${file}`]);
        conflicts.push({ ticketId, localContent, remoteContent });
      } catch {
        console.log(`[sync-watcher] Skipping ${file} - error reading conflict content`);
      }
    }
  } catch (err: any) {
    console.error('[sync-watcher] Error reading merge conflicts:', err.message);
  }
  return conflicts;
}

export async function resolveConflicts(
  resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>
): Promise<void> {
  if (!pendingConflicts || pendingConflicts.length === 0) {
    throw new Error('No conflicts to resolve');
  }

  const storeDir = getFluxStoreDir();
  const workspaceRoot = path.dirname(storeDir);

  for (const resolution of resolutions) {
    const conflict = pendingConflicts.find(c => c.ticketId === resolution.ticketId)!;
    const filePath = path.join(storeDir, `${resolution.ticketId}.md`);

    switch (resolution.strategy) {
      case 'use-remote':
        await fs.writeFile(filePath, conflict.remoteContent, 'utf-8');
        console.log(`[sync-watcher] Resolved ${resolution.ticketId}: used remote version`);
        break;

      case 'rename-local': {
        const projectKey = resolution.ticketId.split('-')[0];
        const newId = await allocateNewTicketId(storeDir, projectKey);
        await fs.writeFile(filePath, conflict.remoteContent, 'utf-8');
        const parsed = matter(conflict.localContent);
        parsed.data.id = newId;
        const renamedContent = matter.stringify(parsed.content, parsed.data);
        await fs.writeFile(path.join(storeDir, `${newId}.md`), renamedContent, 'utf-8');
        console.log(`[sync-watcher] Resolved ${resolution.ticketId}: renamed local to ${newId}, accepted remote`);
        break;
      }

      case 'manual':
        await fs.writeFile(filePath, resolution.newContent!, 'utf-8');
        console.log(`[sync-watcher] Resolved ${resolution.ticketId}: used manual merge`);
        break;
    }
  }

  // Stage resolved files and commit the merge
  pendingConflicts = null;
  updateStatus({ state: 'syncing' });

  let addAttempts = 0;
  while (addAttempts < 3) {
    try {
      await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
      break;
    } catch (addErr: any) {
      const msg = addErr.message || String(addErr);
      if (msg.includes('index.lock') && addAttempts < 2) {
        console.log(`[sync-watcher] Git lock detected on add, retrying in 1s (attempt ${addAttempts + 1}/3)...`);
        await new Promise(r => setTimeout(r, 1000));
        addAttempts++;
      } else {
        throw addErr;
      }
    }
  }

  await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync (resolved conflicts)']);
  console.log('[sync-watcher] Committed merge with resolved conflicts');

  try {
    await execFileAsync('git', ['-C', storeDir, 'push', 'origin', 'flux-data']);
    updateStatus({ state: 'synced', lastSyncTime: new Date().toISOString() });
    console.log('[sync-watcher] Pushed resolved conflicts to remote');
  } catch (pushErr: any) {
    const errorMsg = pushErr.message || String(pushErr);
    updateStatus({ state: 'error', error: errorMsg, errorType: 'unknown' });
  }
}

async function runSync(storeDir: string): Promise<void> {
  const workspaceRoot = path.dirname(storeDir);
  updateStatus({ state: 'syncing' });

  try {
    // Step 1: commit any pending local changes first
    let addAttempts = 0;
    while (addAttempts < 3) {
      try {
        await execFileAsync('git', ['-C', storeDir, 'add', '-A']);
        break;
      } catch (addErr: any) {
        const msg = addErr.message || String(addErr);
        if (msg.includes('index.lock') && addAttempts < 2) {
          console.log(`[sync-watcher] Git lock detected on add, retrying in 1s (attempt ${addAttempts + 1}/3)...`);
          await new Promise(r => setTimeout(r, 1000));
          addAttempts++;
        } else {
          throw addErr;
        }
      }
    }

    const { stdout: porcelain } = await execFileAsync('git', ['-C', storeDir, 'status', '--porcelain']);
    if (porcelain.trim()) {
      let commitAttempts = 0;
      while (commitAttempts < 3) {
        try {
          await execFileAsync('git', ['-C', storeDir, 'commit', '-m', 'flux: sync']);
          console.log('[sync-watcher] Committed local changes');
          break;
        } catch (commitErr: any) {
          const msg = commitErr.message || String(commitErr);
          if (msg.includes('index.lock') && commitAttempts < 2) {
            console.log(`[sync-watcher] Git lock detected on commit, retrying in 1s (attempt ${commitAttempts + 1}/3)...`);
            await new Promise(r => setTimeout(r, 1000));
            commitAttempts++;
          } else {
            throw commitErr;
          }
        }
      }
    }

    // Step 2: fetch remote
    try {
      await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data']);
    } catch (fetchErr: any) {
      const errorMsg = fetchErr.message || String(fetchErr);
      const errorType: 'network' | 'auth' | 'unknown' =
        errorMsg.includes('Could not resolve host') || errorMsg.includes('network') ? 'network' :
        errorMsg.includes('Authentication failed') || errorMsg.includes('Permission denied') ? 'auth' :
        'unknown';
      console.log(`[sync-watcher] fetch failed (${errorType}): ${errorMsg}`);
      // Push what we have locally, remote will catch up later
      try {
        await execFileAsync('git', ['-C', storeDir, 'push', 'origin', 'flux-data']);
        updateStatus({ state: 'synced', lastSyncTime: new Date().toISOString() });
      } catch {
        updateStatus({ state: 'error', error: errorMsg, errorType });
      }
      return;
    }

    // Step 3: integrate remote changes
    const { stdout: localCommit } = await execFileAsync('git', ['-C', storeDir, 'rev-parse', 'HEAD']);
    const { stdout: remoteCommit } = await execFileAsync('git', ['-C', storeDir, 'rev-parse', 'origin/flux-data']);

    if (localCommit.trim() !== remoteCommit.trim()) {
      const { stdout: mergeBase } = await execFileAsync('git', ['-C', storeDir, 'merge-base', 'HEAD', 'origin/flux-data']);

      if (mergeBase.trim() === localCommit.trim()) {
        // Only remote has new commits — fast-forward
        await execFileAsync('git', ['-C', storeDir, 'merge', '--ff-only', 'origin/flux-data']);
        console.log('[sync-watcher] Fast-forwarded to remote');
      } else if (mergeBase.trim() !== remoteCommit.trim()) {
        // Both sides have commits — attempt auto-merge
        console.log('[sync-watcher] Diverged branches, attempting auto-merge...');
        try {
          await execFileAsync('git', ['-C', storeDir, 'merge', '--no-edit', '-m', 'flux: sync (merge)', 'origin/flux-data']);
          console.log('[sync-watcher] Auto-merged remote changes');
        } catch {
          // Merge failed — collect git-marked conflict files
          const conflicts = await detectMergeConflicts(storeDir);
          if (conflicts.length > 0) {
            console.log(`[sync-watcher] Merge conflict in ${conflicts.length} ticket(s). Waiting for user resolution.`);
            pendingConflicts = conflicts;
            updateStatus({ state: 'conflict', conflicts });
            return;
          }
          // No conflict markers — abort and continue with local state
          await execFileAsync('git', ['-C', storeDir, 'merge', '--abort']).catch(() => {});
          console.warn('[sync-watcher] Merge failed with no conflict markers, pushing local state');
        }
      }
      // If mergeBase === remoteCommit, remote is behind us — just push below
    }

    // Step 4: push
    try {
      // Push from the worktree directory
      await execFileAsync('git', ['-C', storeDir, 'push', 'origin', 'flux-data']);
      console.log('[sync-watcher] Pushed flux-data to remote');
      updateStatus({ state: 'synced', lastSyncTime: new Date().toISOString() });
    } catch (pushErr: any) {
      const errorMsg = pushErr.message || String(pushErr);
      const errorType: 'network' | 'auth' | 'unknown' =
        errorMsg.includes('Could not resolve host') || errorMsg.includes('network') ? 'network' :
        errorMsg.includes('Authentication failed') || errorMsg.includes('Permission denied') ? 'auth' :
        'unknown';
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

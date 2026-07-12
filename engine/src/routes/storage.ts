import express from 'express';
import { isOrphanMode, getWorkspaceRoot } from '../workspace.js';
import { migrateToOrphan, restoreToInRepo } from '../storage-sync.js';
import { activateWorkspace } from '../task-store.js';
import { startSyncWatcher, stopSyncWatcher, resolveConflicts, getSyncStatus, revalidateConflictState } from '../sync-watcher.js';
import { GIT_SYNC_TIMEOUT_MS } from '../git-sync-env.js';

const router = express.Router();

// FLUX-994: bound the resolve-conflicts round trip so the response never hangs. Applying a
// resolution runs up to three sequential git subprocesses under the lock (add -A, commit,
// push — see applyConflictResolutions), each individually timed out at GIT_SYNC_TIMEOUT_MS.
// The prior 90s backstop only budgeted for one of those calls (a single slow push), so a
// legitimately slow-but-succeeding sequence could exceed it and return a false 504 while
// resolveConflicts() kept running and later succeeded server-side. Budget for all three
// running back-to-back near their own timeout, plus slack for the index.lock retry sleeps.
const RESOLVE_CONFLICTS_TIMEOUT_MS = GIT_SYNC_TIMEOUT_MS * 3 + 15_000;

router.get('/mode', (_req, res) => {
  res.json({ mode: isOrphanMode() ? 'orphan' : 'in-repo' });
});

router.post('/migrate', async (_req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  if (isOrphanMode()) return res.status(400).json({ error: 'Already in orphan mode' });

  try {
    await migrateToOrphan(workspaceRoot);
    await activateWorkspace(workspaceRoot);
    startSyncWatcher();
    res.json({ ok: true, mode: 'orphan' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/restore', async (_req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  if (!isOrphanMode()) return res.status(400).json({ error: 'Not in orphan mode' });

  try {
    stopSyncWatcher();
    await restoreToInRepo(workspaceRoot);
    await activateWorkspace(workspaceRoot);
    res.json({ ok: true, mode: 'in-repo' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/resolve-conflicts', async (req, res) => {
  if (!getWorkspaceRoot()) return res.status(400).json({ error: 'No workspace active' });
  if (!isOrphanMode()) return res.status(400).json({ error: 'Not in orphan mode' });

  const { resolutions } = req.body;

  if (!Array.isArray(resolutions)) {
    return res.status(400).json({ error: 'resolutions must be an array' });
  }

  // Validate resolution shape
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution !== 'object') {
      return res.status(400).json({ error: 'Each resolution must be an object' });
    }
    if (!resolution.ticketId || typeof resolution.ticketId !== 'string') {
      return res.status(400).json({ error: 'Each resolution must have a ticketId string' });
    }
    if (!resolution.strategy || !['use-remote', 'use-local', 'rename-local', 'manual'].includes(resolution.strategy)) {
      return res.status(400).json({ error: `Invalid strategy for ${resolution.ticketId}: must be "use-remote", "use-local", "rename-local", or "manual"` });
    }
    if (resolution.strategy === 'manual' && (!resolution.newContent || typeof resolution.newContent !== 'string')) {
      return res.status(400).json({ error: `Manual resolution for ${resolution.ticketId} requires newContent string` });
    }
  }

  // Verify all conflicts have resolutions
  const currentStatus = getSyncStatus();
  if (currentStatus.state !== 'conflict') {
    return res.status(400).json({ error: 'No conflicts pending' });
  }

  const pendingConflictIds = new Set(currentStatus.conflicts.map(c => c.ticketId));
  const resolvedIds = new Set(resolutions.map(r => r.ticketId));

  const missingResolutions = [...pendingConflictIds].filter(id => !resolvedIds.has(id));
  const extraResolutions = resolutions.filter(r => !pendingConflictIds.has(r.ticketId));

  if (missingResolutions.length > 0) {
    return res.status(400).json({ error: `Missing resolutions for: ${missingResolutions.join(', ')}` });
  }

  if (extraResolutions.length > 0) {
    return res.status(400).json({ error: `Resolutions provided for non-conflicted tickets: ${extraResolutions.map(r => r.ticketId).join(', ')}` });
  }

  try {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Conflict resolution timed out after ${RESOLVE_CONFLICTS_TIMEOUT_MS / 1000}s`)),
        RESOLVE_CONFLICTS_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([resolveConflicts(resolutions), timeout]);
    } finally {
      clearTimeout(timer!);
    }
    res.json({ ok: true });
  } catch (err) {
    // On any failure/timeout, re-derive the real conflict state from the worktree so the
    // banner reflects reality rather than the stale in-memory conflict (FLUX-989). No-ops
    // while a resolution still holds the lock; the next status poll re-validates then.
    await revalidateConflictState().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timed out/i.test(message);
    res.status(timedOut ? 504 : 500).json({ error: message });
  }
});

export default router;

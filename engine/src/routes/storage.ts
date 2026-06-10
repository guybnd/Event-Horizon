import express from 'express';
import { workspaceRoot, isOrphanMode } from '../workspace.js';
import { migrateToOrphan, restoreToInRepo } from '../storage-sync.js';
import { activateWorkspace } from '../task-store.js';
import { startSyncWatcher, stopSyncWatcher, resolveConflicts, getSyncStatus } from '../sync-watcher.js';

const router = express.Router();

router.get('/mode', (_req, res) => {
  res.json({ mode: isOrphanMode() ? 'orphan' : 'in-repo' });
});

router.post('/migrate', async (_req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  if (isOrphanMode()) return res.status(400).json({ error: 'Already in orphan mode' });

  try {
    await migrateToOrphan(workspaceRoot);
    await activateWorkspace(workspaceRoot);
    startSyncWatcher();
    res.json({ ok: true, mode: 'orphan' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/restore', async (_req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  if (!isOrphanMode()) return res.status(400).json({ error: 'Not in orphan mode' });

  try {
    stopSyncWatcher();
    await restoreToInRepo(workspaceRoot);
    await activateWorkspace(workspaceRoot);
    res.json({ ok: true, mode: 'in-repo' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/resolve-conflicts', async (req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
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
    if (!resolution.strategy || !['use-remote', 'rename-local', 'manual'].includes(resolution.strategy)) {
      return res.status(400).json({ error: `Invalid strategy for ${resolution.ticketId}: must be "use-remote", "rename-local", or "manual"` });
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
    await resolveConflicts(resolutions);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

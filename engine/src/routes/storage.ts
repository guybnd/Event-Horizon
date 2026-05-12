import express from 'express';
import { workspaceRoot, isOrphanMode } from '../workspace.js';
import { migrateToOrphan, restoreToInRepo } from '../storage-sync.js';
import { activateWorkspace } from '../task-store.js';
import { startSyncWatcher, stopSyncWatcher } from '../sync-watcher.js';

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

export default router;

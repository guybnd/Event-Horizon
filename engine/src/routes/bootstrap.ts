import express from 'express';
import { scanWorkspaceForBootstrap, importBootstrapSelections } from '../project-scanner.js';
import { workspaceRoot } from '../workspace.js';
import { workspaceActivating } from '../task-store.js';

const router = express.Router();

router.get('/scan', async (_req, res) => {
  try {
    if (!workspaceRoot) {
      return res.status(400).json({ error: 'No workspace active' });
    }
    const result = await scanWorkspaceForBootstrap(workspaceRoot);
    res.json(result);
  } catch (err: any) {
    console.error('[bootstrap] Scan failed:', err);
    res.status(500).json({ error: err.message || 'Scan failed' });
  }
});

router.post('/import', async (req, res) => {
  if (workspaceActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });

  try {
    if (!workspaceRoot) {
      return res.status(400).json({ error: 'No workspace active' });
    }
    const { selectedDocs, selectedTasks } = req.body;
    if (!Array.isArray(selectedDocs) || !Array.isArray(selectedTasks)) {
      return res.status(400).json({ error: 'Request must include selectedDocs and selectedTasks arrays' });
    }

    for (const task of selectedTasks) {
      if (!task || typeof task.title !== 'string' || !task.title.trim()) {
        return res.status(400).json({ error: 'Each selectedTasks item must have a non-empty title string' });
      }
    }

    const result = await importBootstrapSelections(workspaceRoot, { selectedDocs, selectedTasks });
    res.json(result);
  } catch (err: any) {
    console.error('[bootstrap] Import failed:', err);
    res.status(500).json({ error: err.message || 'Import failed' });
  }
});

export default router;

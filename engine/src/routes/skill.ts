import { log } from '../log.js';
import express from 'express';
import { resolveSkillSourceRoot, workspaceRoot } from '../workspace.js';
import { getWorkflowInstallStatus, installWorkspaceWorkflow } from '../workflow-installer.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const framework = (req.query.framework as any) || 'auto';
    const status = await getWorkflowInstallStatus({ sourceRoot: resolveSkillSourceRoot(), targetDir: workspaceRoot!, framework });
    res.json(status);
  } catch (error) {
    console.error('Failed to load skill status:', error);
    res.status(500).json({ error: 'Failed to load skill status' });
  }
});

router.post('/install', async (req, res) => {
  try {
    const framework = req.body?.framework || 'auto';
    log.info(`[skill] Installing workflow for framework: ${framework}`);
    const result = await installWorkspaceWorkflow({ sourceRoot: resolveSkillSourceRoot(), targetDir: workspaceRoot!, framework });
    log.info(`[skill] Installation successful:`, result);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[skill] Failed to install skill:', error);
    res.status(500).json({ error: 'Failed to install skill' });
  }
});

export default router;

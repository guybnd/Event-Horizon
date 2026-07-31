import { log } from '../log.js';
import express from 'express';
import { resolveSkillSourceRoot, getWorkspaceRoot } from '../workspace.js';
import { getWorkflowInstallStatus, installWorkspaceWorkflow, installGlobalMcpConfig, resolveFramework, type Framework } from '../workflow-installer.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const framework = (req.query.framework as Framework) || 'auto';
    const status = await getWorkflowInstallStatus({ sourceRoot: resolveSkillSourceRoot(), targetDir: getWorkspaceRoot()!, framework });
    res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[skill] Failed to load skill status:', error);
    res.status(500).json({ error: message });
  }
});

router.post('/install', async (req, res) => {
  try {
    const framework = req.body?.framework || 'auto';
    log.info(`[skill] Installing workflow for framework: ${framework}`);
    const result = await installWorkspaceWorkflow({ sourceRoot: resolveSkillSourceRoot(), targetDir: getWorkspaceRoot()!, framework });
    log.info(`[skill] Installation successful:`, result);
    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[skill] Failed to install skill:', error);
    res.status(500).json({ error: message });
  }
});

router.post('/install-global-mcp', async (req, res) => {
  try {
    const framework = (req.body?.framework as Framework) || 'auto';
    const resolvedFramework = resolveFramework(getWorkspaceRoot()!, framework);
    log.info(`[skill] Installing global MCP config for framework: ${resolvedFramework}`);
    const result = await installGlobalMcpConfig(resolvedFramework);
    log.info(`[skill] Global MCP install successful:`, result);
    res.json({ success: true, framework: resolvedFramework, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[skill] Failed to install global MCP config:', error);
    if (message.startsWith('Global MCP install is not supported for framework:')) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

export default router;

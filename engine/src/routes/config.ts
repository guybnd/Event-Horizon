import express from 'express';
import { configCache, saveConfig } from '../config.js';
import { BUILTIN_MODULES } from '../modules.js';
import { probeModule, probeAllEnabled, getAllProbeStatuses } from '../module-probe.js';
import { scaffoldModuleDirs } from '../storage-sync.js';
import { isOrphanMode, getFluxStoreDir } from '../workspace.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json(configCache);
});

router.put('/', async (req, res) => {
  try {
    const prevModules: any[] = Array.isArray((configCache as any).modules) ? (configCache as any).modules : [];
    const prevEnabledIds = new Set(prevModules.filter(m => m.enabled && m.mcpServer).map((m: any) => m.id));

    await saveConfig(req.body);

    const nextModules: any[] = Array.isArray((configCache as any).modules) ? (configCache as any).modules : [];
    const newlyEnabled = nextModules.filter(m => m.enabled && m.mcpServer && !prevEnabledIds.has(m.id));
    if (newlyEnabled.length > 0) {
      probeAllEnabled(newlyEnabled).catch(() => {});
      if (isOrphanMode()) {
        const storeDir = getFluxStoreDir();
        const dirsToScaffold = newlyEnabled
          .flatMap(m => BUILTIN_MODULES.find(b => b.id === m.id)?.scaffold?.dirs ?? []);
        if (dirsToScaffold.length > 0) {
          scaffoldModuleDirs(storeDir, dirsToScaffold).catch((err) =>
            console.error('[config] scaffoldModuleDirs failed:', err)
          );
        }
      }
    }

    res.json(configCache);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

router.get('/modules/catalog', (_req, res) => {
  res.json(BUILTIN_MODULES);
});

router.get('/modules/status', (_req, res) => {
  res.json(getAllProbeStatuses());
});

router.post('/modules/:id/probe', (req, res) => {
  const modules: any[] = Array.isArray((configCache as any).modules) ? (configCache as any).modules : [];
  const module = modules.find((m: any) => m.id === req.params.id);
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (!module.mcpServer) {
    return res.status(400).json({ error: 'Module has no MCP server' });
  }
  probeModule(module).catch(() => {});
  res.status(202).json({ queued: true });
});

export default router;

import express from 'express';
import { configCache, saveConfig } from '../config.js';
import { BUILTIN_MODULES, getWorkspaceMcpServers, getModuleMcpServers } from '../modules.js';
import { probeModule, probeAllEnabled, getAllProbeStatuses } from '../module-probe.js';
import { scaffoldModuleDirs } from '../storage-sync.js';
import { isOrphanMode, getFluxStoreDir } from '../workspace.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json(configCache);
});

const SCOPE_PHASES = ['grooming', 'implementation', 'review', 'release'];

// Per-phase MCP server scoping (FLUX-490 UI). Lists every server the user could
// scope (workspace .mcp.json ∪ module servers ∪ already-configured) and the
// current mapping. Fast — no server spawning.
router.get('/mcp-phases', (_req, res) => {
  const ids = new Set<string>([
    ...Object.keys(getWorkspaceMcpServers()),
    ...Object.keys(getModuleMcpServers()),
    ...Object.keys(((configCache as any).mcpServerPhases as Record<string, string[]>) ?? {}),
  ]);
  res.json({
    servers: [...ids].sort(),
    phases: SCOPE_PHASES,
    mcpServerPhases: ((configCache as any).mcpServerPhases as Record<string, string[]>) ?? {},
  });
});

// Targeted update of only `mcpServerPhases` (avoids the full-config PUT which
// replaces everything). A server mapped to a non-empty phase list loads ONLY in
// those phases; an empty/absent mapping loads it everywhere. Any non-empty
// mapping flips the engine to strict mode at spawn.
router.put('/mcp-phases', async (req, res) => {
  const raw = req.body?.mcpServerPhases;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: 'Body must be { mcpServerPhases: { [serverId]: string[] } }' });
  }
  const clean: Record<string, string[]> = {};
  for (const [id, phases] of Object.entries(raw)) {
    if (Array.isArray(phases)) {
      const valid = phases.filter((p) => typeof p === 'string' && SCOPE_PHASES.includes(p));
      if (valid.length > 0) clean[id] = valid;
    }
  }
  (configCache as any).mcpServerPhases = clean;
  await saveConfig(configCache);
  res.json({ mcpServerPhases: clean });
});

router.put('/', async (req, res) => {
  try {
    const prevModules: any[] = Array.isArray((configCache as any).modules) ? (configCache as any).modules : [];
    const prevEnabledIds = new Set(prevModules.filter(m => m.enabled && m.mcpServer).map((m: any) => m.id));

    // FLUX-744: merge over the existing config rather than replacing it wholesale, so engine-managed
    // fields the portal doesn't echo back (e.g. the `chatOpenDefaultMigrated` migration marker) survive
    // a Settings save. The portal always sends complete values for the fields it owns, so a shallow
    // merge is equivalent for those and only ADDS preservation of engine-only keys.
    await saveConfig({ ...configCache, ...req.body });

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

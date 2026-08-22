import express from 'express';
import { getConfig, patchConfig, GET_COMPUTED_CONFIG_KEYS, isDocsCommitOnSaveEnabled } from '../config.js';
import { BUILTIN_MODULES, getWorkspaceMcpServers, getModuleMcpServers, getConnectors, type ModuleDeclaration } from '../modules.js';
import { probeModule, probeAllEnabled, getAllProbeStatuses, probeConnector, getAllConnectorProbeStatuses } from '../module-probe.js';
import { scaffoldModuleDirs } from '../storage-sync.js';
import { isOrphanMode, getFluxStoreDir } from '../workspace.js';
import { CLI_CAPABILITIES, type LaunchPhase } from '../agents/types.js';
import type { McpReadOnlyRule, McpServerReadOnlyConfig } from '../mcp-readonly.js';
import { resolveDefaultFramework, getRuntimeFrameworks } from '../agents/index.js';
import { BOARD_CONVERSATION_ID, FURNACE_CONVERSATION_ID } from '../agents/board.js';
import { getWorkspace } from '../workspace-context.js';

const router = express.Router();

router.get('/', (req, res) => {
  // FLUX-1460-style activation guard (FLUX-1492): getConfig() serves the CONFIG_DEFAULTS clone
  // mid-activation, and a GET in that window would hand the portal defaults (gate 'auto'/'auto')
  // for a board with a perfectly readable config.json. The portal already retries on 503.
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  // FLUX-901: ship the resolved per-framework capability table alongside the config so the
  // portal can gate features off capability (FLUX-906) instead of `framework === 'claude'`.
  // FLUX-906: also expose the two values the portal otherwise hardcodes as Claude:
  //   - defaultFramework: the engine-resolved 'auto' framework (resolveDefaultFramework is the
  //     single source of truth) so the portal stops flooring 'auto' to 'claude' itself.
  //   - boardConversationId / furnaceConversationId: the orchestrator + Furnace-chat sentinels
  //     (FLUX-1209), so the portal's sync constants can be cross-checked against the engine
  //     instead of independently re-declaring '__board__' / '__furnace__'.
  // FLUX-907 (audit F — split semantics): also expose `runtimeFrameworks` — the frameworks EH can
  // actually LAUNCH (the adapter registry), which is narrower than the skill installer's 8-framework
  // list. The portal surfaces the gap by badging install-only frameworks "Skills only".
  // FLUX-1492: these 5 keys are GET_COMPUTED_CONFIG_KEYS — computed here, never real config.json
  // content. PUT / strips them from the request body before persisting (see below).
  res.json({
    ...getConfig(),
    cliCapabilities: CLI_CAPABILITIES,
    defaultFramework: resolveDefaultFramework(),
    boardConversationId: BOARD_CONVERSATION_ID,
    furnaceConversationId: FURNACE_CONVERSATION_ID,
    runtimeFrameworks: getRuntimeFrameworks(),
    // FLUX-1655: resolves the repo-backed-workspace default when the user hasn't made an explicit
    // choice yet — NOT a GET_COMPUTED_CONFIG_KEYS entry, since an explicit true/false the user saved
    // still round-trips through here unchanged and IS real config.json content.
    docsCommitOnSave: isDocsCommitOnSaveEnabled(),
  });
});

const SCOPE_PHASES = ['grooming', 'implementation', 'review', 'release'];

// Per-phase MCP server scoping (FLUX-490 UI). Lists every server the user could
// scope (workspace .mcp.json ∪ module servers ∪ already-configured) and the
// current mapping. Fast — no server spawning.
router.get('/mcp-phases', (_req, res) => {
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const ids = new Set<string>([
    ...Object.keys(getWorkspaceMcpServers()),
    ...Object.keys(getModuleMcpServers()),
    ...Object.keys((getConfig().mcpServerPhases as Record<string, string[]>) ?? {}),
  ]);
  res.json({
    servers: [...ids].sort(),
    phases: SCOPE_PHASES,
    mcpServerPhases: (getConfig().mcpServerPhases as Record<string, string[]>) ?? {},
  });
});

// Targeted update of only `mcpServerPhases` (avoids the full-config PUT which
// replaces everything). A server mapped to a non-empty phase list loads ONLY in
// those phases; an empty/absent mapping loads it everywhere. Any non-empty
// mapping flips the engine to strict mode at spawn.
router.put('/mcp-phases', async (req, res) => {
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
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
  // FLUX-1492: patch only `mcpServerPhases` (merge-on-save over a fresh disk read) instead of
  // writing the full in-memory config — this route used to be the "targeted update" exception
  // that still leaked the whole-file clobber (comment above predates the fix).
  await patchConfig({ mcpServerPhases: clean });
  res.json({ mcpServerPhases: clean });
});

const ALL_LAUNCH_PHASES: LaunchPhase[] = ['grooming', 'implementation', 'review', 'finalize', 'chat', 'fast-path', 'batch-grooming'];

// Per-connector read/write scoping for agent sessions (FLUX-1657). Deliberately keyed off the full
// `LaunchPhase` set, NOT `SCOPE_PHASES` above — `SCOPE_PHASES` omits `finalize`, which would make
// the headline "read-only except in finalize" use case unvalidatable. See engine/src/mcp-readonly.ts
// for the enforcement (deny-list) side; this route only persists the config.
router.get('/mcp-readonly', (_req, res) => {
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const ids = new Set<string>([
    ...getConnectors().map((c) => c.id),
    ...Object.keys((getConfig().mcpServerReadOnly as McpServerReadOnlyConfig) ?? {}),
  ]);
  res.json({
    servers: [...ids].sort(),
    phases: ALL_LAUNCH_PHASES,
    mcpServerReadOnly: (getConfig().mcpServerReadOnly as McpServerReadOnlyConfig) ?? {},
  });
});

const ALL_LAUNCH_PHASES_SET = new Set<string>(ALL_LAUNCH_PHASES);

function isValidReadOnlyRule(value: unknown): value is McpReadOnlyRule {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  for (const key of ['exceptPhases', 'allow', 'deny']) {
    if (key in rule && rule[key] !== undefined && !Array.isArray(rule[key])) return false;
  }
  if (Array.isArray(rule.exceptPhases) && !rule.exceptPhases.every((p) => typeof p === 'string' && ALL_LAUNCH_PHASES_SET.has(p))) return false;
  if (Array.isArray(rule.allow) && !rule.allow.every((t) => typeof t === 'string')) return false;
  if (Array.isArray(rule.deny) && !rule.deny.every((t) => typeof t === 'string')) return false;
  return true;
}

// Targeted update of only `mcpServerReadOnly` (same "patch, don't clobber" shape as PUT
// /mcp-phases). A server entry is either `true` (read-only, no exceptions) or a rule object;
// anything else is dropped rather than persisted malformed.
router.put('/mcp-readonly', async (req, res) => {
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const raw = req.body?.mcpServerReadOnly;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: 'Body must be { mcpServerReadOnly: { [serverId]: true | { exceptPhases?, allow?, deny? } } }' });
  }
  const clean: McpServerReadOnlyConfig = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (entry === true) clean[id] = true;
    else if (isValidReadOnlyRule(entry)) clean[id] = entry;
  }
  await patchConfig({ mcpServerReadOnly: clean });
  res.json({ mcpServerReadOnly: clean });
});

router.put('/', async (req, res) => {
  if (getWorkspace().isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  try {
    const prevModules: ModuleDeclaration[] = Array.isArray(getConfig().modules) ? getConfig().modules : [];
    const prevEnabledIds = new Set(prevModules.filter(m => m.enabled && m.mcpServer).map((m) => m.id));

    // FLUX-1492: strip GET-computed keys (see GET_COMPUTED_CONFIG_KEYS) before persisting — the
    // portal caches the full GET response (which includes them) and echoes it back wholesale on
    // Settings save, so without this every save would freeze that snapshot into config.json.
    const patch: Record<string, unknown> = { ...req.body };
    for (const key of GET_COMPUTED_CONFIG_KEYS) delete patch[key];

    // FLUX-744/FLUX-1492: merge over a FRESH DISK READ rather than the in-memory config, so
    // engine-managed fields a stale in-memory copy doesn't know about (e.g. a `gatePolicy` edit
    // persisted by another process since this one loaded) survive a Settings save instead of
    // being silently reverted. The portal always sends complete values for the fields it owns, so
    // this is equivalent to the old in-memory merge for those and only ADDS staleness protection.
    await patchConfig(patch);

    const nextModules: ModuleDeclaration[] = Array.isArray(getConfig().modules) ? getConfig().modules : [];
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

    // FLUX-1492: mirror the GET / response shape — the computed keys are stripped from what's
    // persisted (above) but the portal's saveConfig() replaces its live config with this response
    // wholesale (AppContext.tsx), so omitting them here would blank cliCapabilities/defaultFramework/
    // runtimeFrameworks/boardConversationId/furnaceConversationId for the rest of the session.
    res.json({
      ...getConfig(),
      cliCapabilities: CLI_CAPABILITIES,
      defaultFramework: resolveDefaultFramework(),
      boardConversationId: BOARD_CONVERSATION_ID,
      furnaceConversationId: FURNACE_CONVERSATION_ID,
      runtimeFrameworks: getRuntimeFrameworks(),
      docsCommitOnSave: isDocsCommitOnSaveEnabled(),
    });
  } catch {
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
  const modules: ModuleDeclaration[] = Array.isArray(getConfig().modules) ? getConfig().modules : [];
  const module = modules.find((m) => m.id === req.params.id);
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (!module.mcpServer) {
    return res.status(400).json({ error: 'Module has no MCP server' });
  }
  probeModule(module).catch(() => {});
  res.status(202).json({ queued: true });
});

// FLUX-1656: Connectors settings panel — union of configured module servers + workspace
// `.mcp.json` servers (see getConnectors), each with a live auth probe + env-var presence check.
// A separate id-space and cache from /modules/* above (see module-probe.ts comment) so a workspace
// server sharing a bare name with a module never collides with it.
router.get('/connectors', (_req, res) => {
  const connectors = getConnectors();
  const statuses = getAllConnectorProbeStatuses();
  res.json(connectors.map((c) => ({
    id: c.id,
    name: c.name,
    source: c.source,
    requiredEnv: c.requiredEnv,
    probe: statuses[c.id],
  })));
});

router.post('/connectors/:id/probe', (req, res) => {
  const connector = getConnectors().find((c) => c.id === req.params.id);
  if (!connector) {
    return res.status(404).json({ error: 'Connector not found' });
  }
  probeConnector(connector).catch(() => {});
  res.status(202).json({ queued: true });
});

export default router;

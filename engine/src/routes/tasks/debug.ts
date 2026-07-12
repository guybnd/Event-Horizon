// Debug/metrics routes (FLUX-349 split): parse errors + the MCP-schema/spawn-server/size/budget
// endpoints added by the FLUX-477/488 measurement work. Mounted by the ../tasks.ts barrel BEFORE
// the crud router so the literal paths (/errors, /debug/*) win over GET /:id.
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';

import { computeAgentPayloadMetrics } from '../../agent-payload-metrics.js';
import { computeContextBudget } from '../../context-budget-metrics.js';
import { probeAllMcpSchemas } from '../../mcp-schema-probe.js';
import { getEffectiveSpawnServers } from '../../agents/claude-code.js';
import { errorMessage } from './helpers.js';

const router = express.Router();

router.get('/errors', (req, res) => {
  res.json(Object.values(getWorkspace().parseErrors));
});

// Debug-only: spawn each module MCP server EH injects (serena, context7, …),
// list its tools, and measure per-server tool-schema cost. On-demand (slow —
// it starts real servers). Registered before /:id so the literal path wins.
router.get('/debug/mcp-schemas', async (req, res) => {
  try {
    res.json(await probeAllMcpSchemas());
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err, 'Failed to probe MCP schemas') });
  }
});

// Debug-only: the effective MCP server set per phase (FLUX-490 visibility). Cheap
// (config logic, no server spawning) — shows what each phase's agent would get.
router.get('/debug/spawn-servers', (_req, res) => {
  const phases = ['grooming', 'implementation', 'review', 'release'];
  const byPhase: Record<string, string[]> = {};
  let strict = false;
  let note = '';
  for (const p of phases) {
    const r = getEffectiveSpawnServers(p);
    byPhase[p] = r.servers;
    strict = r.strict;
    note = r.note;
  }
  res.json({ strict, phases: byPhase, note });
});

// Debug-only: byte/token breakdown of the agent-facing get_ticket payload by
// section. Separate from the agent surfaces, so measuring never inflates what an
// agent reads. Powers the portal "Agent payload size" panel.
router.get('/:id/debug/sizes', (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const historyLimit = Number.parseInt(String(req.query.historyLimit ?? ''), 10);
  res.json(computeAgentPayloadMetrics(task, Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : undefined));
});

// Debug-only: the broader "where does the agent context budget go" view —
// get_ticket payload + the launch prompt EH builds + the fixed skill modules,
// with explicit caveats about what the engine cannot measure (host system
// prompt, external MCP schemas, session accumulation).
router.get('/:id/debug/budget', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  try {
    res.json(await computeContextBudget(task));
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err, 'Failed to compute context budget') });
  }
});

export default router;

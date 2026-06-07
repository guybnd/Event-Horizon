import express from 'express';
import { workspaceRoot } from '../workspace.js';
import { planGroupSetup, applyGroupSetup, type GroupSetupInput } from '../group-setup.js';
import { syncGroup } from '../group-sync.js';
import { summarizeGroup, getGroupContext, type GroupMember } from '../group.js';

const router = express.Router();

/** Current group status (mirrors the get_project_group MCP tool). */
router.get('/', (_req, res) => {
  res.json(summarizeGroup(getGroupContext()));
});

function parseBody(body: any): GroupSetupInput | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { name, members, force, allowLocalRemotes } = body;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name must be a non-empty string' };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return { error: 'members must be a non-empty array' };
  }
  const parsed: GroupMember[] = [];
  for (const m of members) {
    if (!m || typeof m !== 'object') return { error: 'each member must be an object' };
    if (typeof m.name !== 'string' || typeof m.role !== 'string' || typeof m.remote !== 'string') {
      return { error: 'each member needs name, role, and remote strings' };
    }
    parsed.push({
      name: m.name,
      role: m.role,
      remote: m.remote,
      ...(typeof m.testCommand === 'string' ? { testCommand: m.testCommand } : {}),
    });
  }
  return {
    parentRoot: workspaceRoot!,
    groupName: name,
    members: parsed,
    force: Boolean(force),
    allowLocalRemotes: Boolean(allowLocalRemotes),
  };
}

/** Dry-run: compute the intrusive actions without writing anything. */
router.post('/plan', async (req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  const input = parseBody(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  try {
    const plan = await planGroupSetup(input);
    res.json(plan);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** Apply: perform the writes (group.json, .gitignore, store, member register). */
router.post('/apply', async (req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  const input = parseBody(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  try {
    const result = await applyGroupSetup(input);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** Fan out canonical group docs to every member's flux-group-docs branch. */
router.post('/sync', async (_req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  const group = getGroupContext();
  if (!group) return res.status(400).json({ error: 'No multi-repo group is configured' });
  try {
    const result = await syncGroup(group);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

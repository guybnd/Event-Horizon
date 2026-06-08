import express from 'express';
import { workspaceRoot } from '../workspace.js';
import { planGroupSetup, applyGroupSetup, type GroupSetupInput } from '../group-setup.js';
import { syncGroup } from '../group-sync.js';
import { submitGroupEdit, type GroupEditFile } from '../group-edit.js';
import { summarizeGroup, getGroupContext, getMemberBinding, type GroupMember } from '../group.js';

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

function parseEdits(body: any): GroupEditFile[] | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'files must be a non-empty array' };
  }
  const parsed: GroupEditFile[] = [];
  for (const f of files) {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string') {
      return { error: 'each file needs a path string' };
    }
    const del = Boolean(f.delete);
    if (!del && typeof f.content !== 'string') {
      return { error: `file ${f.path} needs string content (or delete: true)` };
    }
    parsed.push({ path: f.path, ...(del ? { delete: true } : { content: f.content }) });
  }
  return parsed;
}

/** Apply a sub-repo doc edit through the parent, commit, and re-fan-out. */
router.post('/submit-edit', async (req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  // The parent edits its own group; a bound member (Case 1) routes through the parent's context.
  const group = getGroupContext() ?? getMemberBinding()?.parentGroup;
  if (!group) {
    return res.status(400).json({ error: "These docs are owned by a multi-repo group. Open the group's parent workspace to edit them." });
  }
  const edits = parseEdits(req.body);
  if ('error' in edits) return res.status(400).json({ error: edits.error });
  try {
    const result = await submitGroupEdit(group, edits);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

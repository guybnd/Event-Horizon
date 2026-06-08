import express from 'express';
import { workspaceRoot, getWorkspacesList } from '../workspace.js';
import { planGroupSetup, applyGroupSetup, ensureGroupRegistered, type GroupSetupInput } from '../group-setup.js';
import { scanFolderForRepos, discoverFromRegistry, createDedicatedParent, type CreateParentInput } from '../group-discovery.js';
import { syncGroup } from '../group-sync.js';
import { submitGroupEdit, type GroupEditFile } from '../group-edit.js';
import { planDocsPromotion, applyDocsPromotion, type PromotionSelection } from '../group-promote.js';
import { summarizeGroup, getGroupContext, getMemberBinding, type GroupMember } from '../group.js';

const router = express.Router();

/** Current group status (mirrors the get_project_group MCP tool). */
router.get('/', async (_req, res) => {
  const registeredPaths = (await getWorkspacesList()).map((w) => w.path);
  res.json(summarizeGroup(getGroupContext(), registeredPaths));
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

/**
 * Backfill: register the dedicated parent + present members as workspaces so the
 * Case-1 member binding can resolve, without re-running setup. Runs only on
 * explicit consent (the detect-on-activation prompt drives this). Resolves the
 * group from the active parent context or a bound member's parent.
 *
 * Limitation: a member can only reach `getMemberBinding()` once the parent is
 * ALREADY registered (the binding is discovered by reverse-lookup over the
 * registry). So from a member workspace this can backfill missing *sibling*
 * members but never an unregistered parent — an orphaned parent self-heals only
 * when the parent workspace itself is activated (`getGroupContext()`), or via
 * the folder-scan wizard (FLUX-407).
 */
router.post('/ensure-registered', async (_req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  const group = getGroupContext() ?? getMemberBinding()?.parentGroup;
  if (!group) {
    return res.status(400).json({ error: 'No multi-repo group is configured for this workspace.' });
  }
  try {
    const result = await ensureGroupRegistered(group.parentRoot);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── onboarding/migration wizard (FLUX-407) ──────────────────────────────────

/**
 * Discovery source: the repos EH already knows (workspace registry), each with
 * its origin remote and whether it already hosts a group.json. Read-only.
 */
router.get('/discover/registry', async (_req, res) => {
  try {
    const repos = await discoverFromRegistry();
    res.json({ repos });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Discovery source: scan a folder for immediate-child git repos (the "folder of
 * repos" layout), each with its origin remote + registration state. Read-only.
 */
router.post('/discover/folder', async (req, res) => {
  const folder = req.body?.folder;
  if (typeof folder !== 'string' || folder.trim().length === 0) {
    return res.status(400).json({ error: 'folder must be a non-empty string' });
  }
  try {
    const result = await scanFolderForRepos(folder);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

function parseCreateParent(body: any): CreateParentInput | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { parentPath, name, members } = body;
  if (typeof parentPath !== 'string' || parentPath.trim().length === 0) {
    return { error: 'parentPath must be a non-empty string' };
  }
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
  return { parentPath, groupName: name, members: parsed };
}

/**
 * Create a brand-new dedicated parent repo to host a group (git init + scaffold
 * store + group.json + register). The dedicated-parent model forbids reusing a
 * member repo, so this is how the wizard lands a new group. Refuses to clobber
 * an existing group.json (caller routes to repair instead).
 */
router.post('/create-parent', async (req, res) => {
  const input = parseCreateParent(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  try {
    const result = await createDedicatedParent(input);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});


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

// ─── promote existing .docs/ into the group store (FLUX-404) ─────────────────

/**
 * Promotion is **parent-only** — only the parent owns the canonical store.
 * Resolving `getGroupContext()` (unset on a member workspace) enforces this:
 * a member-origin promotion gets "no group" instead of a special-cased branch.
 */
function requireParentGroup(res: express.Response) {
  if (!workspaceRoot) {
    res.status(400).json({ error: 'No workspace active' });
    return null;
  }
  const group = getGroupContext();
  if (!group) {
    res.status(400).json({ error: 'Doc promotion runs at the group parent. Open the parent workspace.' });
    return null;
  }
  return group;
}

/** Dry-run: walk `.docs/` and propose a store target per file. No mutation. */
router.post('/promote-docs/plan', async (_req, res) => {
  const group = requireParentGroup(res);
  if (!group) return;
  try {
    const plan = await planDocsPromotion(group.parentRoot);
    res.json(plan);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

function parseSelections(body: any): PromotionSelection[] | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { selections } = body;
  if (!Array.isArray(selections) || selections.length === 0) {
    return { error: 'selections must be a non-empty array' };
  }
  const parsed: PromotionSelection[] = [];
  for (const s of selections) {
    if (!s || typeof s !== 'object' || typeof s.source !== 'string' || typeof s.target !== 'string') {
      return { error: 'each selection needs source and target strings' };
    }
    parsed.push({ source: s.source, target: s.target });
  }
  return parsed;
}

/** Apply: move selected docs into the store, remove from main, commit, fan out. */
router.post('/promote-docs/apply', async (req, res) => {
  const group = requireParentGroup(res);
  if (!group) return;
  const selections = parseSelections(req.body);
  if ('error' in selections) return res.status(400).json({ error: selections.error });
  try {
    const result = await applyDocsPromotion(group, selections);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;

import fs from 'fs/promises';
import express from 'express';
import { getWorkspacesList, getWorkspaceRoot } from '../workspace.js';
import { getWorkspace, type Workspace } from '../workspace-context.js';
import { planGroupSetup, applyGroupSetup, ensureGroupRegistered, type GroupSetupInput } from '../group-setup.js';
import { scanFolderForRepos, discoverFromRegistry, createDedicatedParent, type CreateParentInput, type CreateParentMember } from '../group-discovery.js';
import { syncGroup } from '../group-sync.js';
import { submitGroupEdit, type GroupEditFile } from '../group-edit.js';
import { planDocsPromotion, applyDocsPromotion, applyMemberDocsPromotion, type PromotionSelection } from '../group-promote.js';
import { summarizeGroup, groupDocsLabel, activateGroup, getGroupConfigFile, validateGroupConfig, type GroupContext, type GroupMember } from '../group.js';

const router = express.Router();

/**
 * FLUX-1565: the workspace this request is bound to — mirrors `routes/docs.ts`'s
 * `reqWorkspace` (kept local; this file isn't part of the `routes/tasks/*` split
 * either). Reading group state off this `Workspace` instead of the `getGroupContext()`/
 * `getMemberBinding()` singletons is what actually fixes the cross-board leak: those
 * singletons hold whichever workspace activated last, not the one this request targets.
 */
function reqWorkspace(req: express.Request): Workspace {
  return req.workspace ?? getWorkspace();
}

/** Current group status (mirrors the get_project_group MCP tool). */
router.get('/', async (req, res) => {
  const registeredPaths = (await getWorkspacesList()).map((w) => w.path);
  const ws = reqWorkspace(req);
  const ctx = ws.groupContext;
  if (ctx) {
    // Parent workspace: full summary plus a parent membership marker.
    const summary = summarizeGroup(ctx, registeredPaths);
    summary.membership = { role: 'parent', groupName: ctx.config.name, parentRoot: ctx.parentRoot };
    return res.json(summary);
  }
  // Member workspace (Case 1): no parent context, but a reverse-lookup binding.
  // Keep `configured: false` (parent-only operations stay parent-only) and just
  // surface that this repo belongs to a group so the UI can show it (FLUX-412).
  const binding = ws.memberBinding;
  if (binding) {
    const summary = summarizeGroup(null, registeredPaths);
    summary.docsLabel = groupDocsLabel(binding.parentGroup);
    const self = binding.parentGroup.config.members.find((m) => m.name === binding.memberName);
    summary.membership = {
      role: 'member',
      groupName: binding.parentGroup.config.name,
      parentRoot: binding.parentRoot,
      memberName: binding.memberName,
      ...(self?.role ? { memberRole: self.role } : {}),
    };
    return res.json(summary);
  }
  res.json(summarizeGroup(null, registeredPaths));
});

function parseBody(body: unknown): GroupSetupInput | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { name, members, force, allowLocalRemotes } = body as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name must be a non-empty string' };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return { error: 'members must be a non-empty array' };
  }
  const parsed: GroupMember[] = [];
  for (const raw of members) {
    if (!raw || typeof raw !== 'object') return { error: 'each member must be an object' };
    const m = raw as Record<string, unknown>;
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
    parentRoot: getWorkspaceRoot()!,
    groupName: name,
    members: parsed,
    force: Boolean(force),
    allowLocalRemotes: Boolean(allowLocalRemotes),
  };
}

/** Dry-run: compute the intrusive actions without writing anything. */
router.post('/plan', async (req, res) => {
  if (!getWorkspaceRoot()) return res.status(400).json({ error: 'No workspace active' });
  const input = parseBody(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  try {
    const plan = await planGroupSetup(input);
    res.json(plan);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Apply: perform the writes (group.json, .gitignore, store, member register). */
router.post('/apply', async (req, res) => {
  if (!getWorkspaceRoot()) return res.status(400).json({ error: 'No workspace active' });
  const input = parseBody(req.body);
  if ('error' in input) return res.status(400).json({ error: input.error });
  try {
    const result = await applyGroupSetup(input);
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Backfill: register the dedicated parent + present members as workspaces so the
 * Case-1 member binding can resolve, without re-running setup. Runs only on
 * explicit consent (the detect-on-activation prompt drives this). Resolves the
 * group from the active parent context or a bound member's parent.
 *
 * Limitation: a member can only reach its `ws.memberBinding` once the parent is
 * ALREADY registered (the binding is discovered by reverse-lookup over the
 * registry). So from a member workspace this can backfill missing *sibling*
 * members but never an unregistered parent — an orphaned parent self-heals only
 * when the parent workspace itself is activated (populating `ws.groupContext`),
 * or via the folder-scan wizard (FLUX-407).
 */
router.post('/ensure-registered', async (req, res) => {
  if (!getWorkspaceRoot()) return res.status(400).json({ error: 'No workspace active' });
  const ws = reqWorkspace(req);
  const group = ws.groupContext ?? ws.memberBinding?.parentGroup;
  if (!group) {
    return res.status(400).json({ error: 'No multi-repo group is configured for this workspace.' });
  }
  try {
    const result = await ensureGroupRegistered(group.parentRoot);
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function parseCreateParent(body: unknown): CreateParentInput | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { parentPath, name, members } = body as Record<string, unknown>;
  if (typeof parentPath !== 'string' || parentPath.trim().length === 0) {
    return { error: 'parentPath must be a non-empty string' };
  }
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: 'name must be a non-empty string' };
  }
  if (!Array.isArray(members) || members.length === 0) {
    return { error: 'members must be a non-empty array' };
  }
  const parsed: CreateParentMember[] = [];
  for (const raw of members) {
    if (!raw || typeof raw !== 'object') return { error: 'each member must be an object' };
    const m = raw as Record<string, unknown>;
    if (typeof m.name !== 'string' || typeof m.role !== 'string' || typeof m.remote !== 'string') {
      return { error: 'each member needs name, role, and remote strings' };
    }
    parsed.push({
      name: m.name,
      role: m.role,
      remote: m.remote,
      ...(typeof m.testCommand === 'string' ? { testCommand: m.testCommand } : {}),
      ...(typeof m.path === 'string' && m.path.trim().length > 0 ? { path: m.path } : {}),
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
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});


router.post('/sync', async (req, res) => {
  if (!getWorkspaceRoot()) return res.status(400).json({ error: 'No workspace active' });
  const group = reqWorkspace(req).groupContext;
  if (!group) return res.status(400).json({ error: 'No multi-repo group is configured' });
  try {
    const result = await syncGroup(group);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function parseEdits(body: unknown): GroupEditFile[] | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { files } = body as Record<string, unknown>;
  if (!Array.isArray(files) || files.length === 0) {
    return { error: 'files must be a non-empty array' };
  }
  const parsed: GroupEditFile[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).path !== 'string') {
      return { error: 'each file needs a path string' };
    }
    const f = raw as Record<string, unknown> & { path: string };
    const del = Boolean(f.delete);
    if (!del && typeof f.content !== 'string') {
      return { error: `file ${f.path} needs string content (or delete: true)` };
    }
    parsed.push({ path: f.path, ...(del ? { delete: true } : { content: f.content as string }) });
  }
  return parsed;
}

/** Apply a sub-repo doc edit through the parent, commit, and re-fan-out. */
router.post('/submit-edit', async (req, res) => {
  if (!getWorkspaceRoot()) return res.status(400).json({ error: 'No workspace active' });
  // The parent edits its own group; a bound member (Case 1) routes through the parent's context.
  const ws = reqWorkspace(req);
  const group = ws.groupContext ?? ws.memberBinding?.parentGroup;
  if (!group) {
    return res.status(400).json({ error: "These docs are owned by a multi-repo group. Open the group's parent workspace to edit them." });
  }
  const edits = parseEdits(req.body);
  if ('error' in edits) return res.status(400).json({ error: edits.error });
  try {
    const result = await submitGroupEdit(group, edits);
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── promote existing .docs/ into the group store (FLUX-404) ─────────────────

/**
 * Resolve where a promotion runs from. Both sides of a group can promote:
 * - **parent** owns the canonical store and writes into it directly;
 * - **member** reads its own `.docs/` and pushes into the store *through the
 *   parent* (`applyMemberDocsPromotion`).
 *
 * A standalone workspace (neither parent nor bound member) gets `null` + a 400.
 */
type PromotionOrigin =
  | { kind: 'parent'; group: GroupContext }
  | { kind: 'member'; memberRoot: string; parentGroup: GroupContext };

function resolvePromotionOrigin(req: express.Request, res: express.Response): PromotionOrigin | null {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    res.status(400).json({ error: 'No workspace active' });
    return null;
  }
  const ws = reqWorkspace(req);
  const group = ws.groupContext;
  if (group) return { kind: 'parent', group };
  const binding = ws.memberBinding;
  if (binding) return { kind: 'member', memberRoot: workspaceRoot, parentGroup: binding.parentGroup };
  res.status(400).json({ error: 'Doc promotion needs a group — open a group parent or a bound member workspace.' });
  return null;
}

/** Dry-run: walk the local `.docs/` and propose a store target per file. No mutation. */
router.post('/promote-docs/plan', async (req, res) => {
  const origin = resolvePromotionOrigin(req, res);
  if (!origin) return;
  try {
    const plan = await planDocsPromotion(getWorkspaceRoot()!);
    res.json(plan);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function parseSelections(body: unknown): PromotionSelection[] | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be an object' };
  const { selections } = body as Record<string, unknown>;
  if (!Array.isArray(selections) || selections.length === 0) {
    return { error: 'selections must be a non-empty array' };
  }
  const parsed: PromotionSelection[] = [];
  for (const raw of selections) {
    if (!raw || typeof raw !== 'object') {
      return { error: 'each selection needs source and target strings' };
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.source !== 'string' || typeof s.target !== 'string') {
      return { error: 'each selection needs source and target strings' };
    }
    parsed.push({ source: s.source, target: s.target });
  }
  return parsed;
}

/**
 * Apply: move selected docs into the store, remove from the originating repo's
 * main, commit, fan out. Parent writes the store directly; member routes through
 * the parent (`applyMemberDocsPromotion`).
 */
router.post('/promote-docs/apply', async (req, res) => {
  const origin = resolvePromotionOrigin(req, res);
  if (!origin) return;
  const selections = parseSelections(req.body);
  if ('error' in selections) return res.status(400).json({ error: selections.error });
  try {
    const result =
      origin.kind === 'parent'
        ? await applyDocsPromotion(origin.group, selections)
        : await applyMemberDocsPromotion(origin.memberRoot, origin.parentGroup, selections);
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Update the docs label (the prefix under which group docs surface in the wiki
 * and MCP tools). Parent workspace only — changes group.json and reloads the
 * group context so the new label takes effect immediately.
 */
router.patch('/docs-label', async (req, res) => {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return res.status(400).json({ error: 'No workspace active' });
  const ws = reqWorkspace(req);
  const ctx = ws.groupContext;
  if (!ctx) return res.status(400).json({ error: 'No group configured — only the parent workspace can update the docs label.' });
  const { label } = req.body ?? {};
  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label must be a non-empty string' });
  }
  const trimmed = label.trim();
  const errors = validateGroupConfig({ ...ctx.config, docsLabel: trimmed });
  const labelError = errors.find((e) => e.path === 'docsLabel');
  if (labelError) return res.status(400).json({ error: labelError.message });
  const configPath = getGroupConfigFile(workspaceRoot);
  const updated = { ...ctx.config, docsLabel: trimmed };
  await fs.writeFile(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  // FLUX-1565: `activateGroup` still refreshes the `getGroupContext()` singleton (other
  // not-yet-migrated consumers still read it), but this route now resolves the docs label
  // from `ws.groupContext` — assign the reload's result there too, or the bound workspace's
  // own field goes stale even though the singleton reflects the new label.
  ws.groupContext = await activateGroup(workspaceRoot);
  res.json({ ok: true, docsLabel: trimmed });
});

export default router;

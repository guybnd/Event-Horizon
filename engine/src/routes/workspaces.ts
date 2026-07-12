import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { getWorkspacesList, addWorkspaceEntry, removeWorkspaceEntry, updateWorkspaceLabel, saveAppSettings, loadAppSettings, autoRegisterWorkspace, getWorkspaceRoot } from '../workspace.js';
import { activateWorkspace } from '../task-store.js';
import { getLiveProcessSessionCount, stopAllCliSessions } from '../session-store.js';
import { resolveWorkspaceGroups, type WorkspaceGroupInfo } from '../group.js';

const router = express.Router();

export interface WorkspaceInfo {
  path: string;
  label?: string;
  displayName: string;
  active: boolean;
  available: boolean;
  /** Multi-repo group this workspace belongs to, if any (FLUX-415). Presentation-only. */
  group?: WorkspaceGroupInfo;
}

function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function enrichEntry(entry: { path: string; label?: string }, groups: Map<string, WorkspaceGroupInfo>): WorkspaceInfo {
  const normalized = path.resolve(entry.path);
  const workspaceRoot = getWorkspaceRoot();
  const info: WorkspaceInfo = {
    path: normalized,
    displayName: entry.label || path.basename(normalized),
    active: workspaceRoot !== null && pathsEqual(workspaceRoot, normalized),
    available: existsSync(normalized),
  };
  if (entry.label) info.label = entry.label;
  const group = groups.get(normalized);
  if (group) info.group = group;
  return info;
}

async function enrichList(list: { path: string; label?: string }[]): Promise<WorkspaceInfo[]> {
  const groups = await resolveWorkspaceGroups(list.map((w) => w.path));
  return list.map((entry) => enrichEntry(entry, groups));
}

router.get('/', async (_req, res) => {
  const list = await getWorkspacesList();
  res.json(await enrichList(list));
});

router.post('/', async (req, res) => {
  const { path: wsPath, label } = req.body ?? {};
  if (typeof wsPath !== 'string' || !wsPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const resolved = path.resolve(wsPath.trim());
  if (!existsSync(resolved)) {
    return res.status(400).json({ error: `Folder not found: ${resolved}` });
  }
  const list = await addWorkspaceEntry({ path: resolved, label });
  res.json(await enrichList(list));
});

router.delete('/:index', async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index)) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const list = await removeWorkspaceEntry(index);
  res.json(await enrichList(list));
});

router.put('/:index', async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (isNaN(index)) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const { label } = req.body ?? {};
  const list = await updateWorkspaceLabel(index, label || undefined);
  res.json(await enrichList(list));
});

router.post('/switch', async (req, res) => {
  const { path: wsPath, force } = req.body ?? {};
  if (typeof wsPath !== 'string' || !wsPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const resolved = path.resolve(wsPath.trim());
  if (!existsSync(resolved)) {
    return res.status(400).json({ error: `Folder not found: ${resolved}` });
  }

  // FLUX-1338: count only sessions with a live OS process — the ones a force-switch could actually
  // stop. getActiveSessionCount() also counts `waiting-input` sessions, which include resumable
  // resting sessions rehydrated from disk stubs (no proc) at boot, so it warned "N sessions running"
  // when nothing was actually running.
  const activeSessions = getLiveProcessSessionCount();
  if (activeSessions > 0 && !force) {
    return res.status(409).json({
      error: 'active_sessions',
      activeSessions,
      message: `${activeSessions} agent session${activeSessions > 1 ? 's are' : ' is'} still running. Force switch to stop them?`,
    });
  }

  if (activeSessions > 0 && force) {
    stopAllCliSessions('workspace-switch');
  }

  try {
    const bound = await activateWorkspace(resolved); // canonical bound root (FLUX-711)
    const settings = await loadAppSettings();
    settings.workspace = bound;
    await saveAppSettings(settings);
    await autoRegisterWorkspace(bound);
    res.json({ ok: true, path: bound });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : undefined });
  }
});

export default router;

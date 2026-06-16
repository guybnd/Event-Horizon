import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import {
  workspaceRoot,
  getWorkspacesList,
  addWorkspaceEntry,
  removeWorkspaceEntry,
  updateWorkspaceLabel,
  saveAppSettings,
  loadAppSettings,
  autoRegisterWorkspace,
} from '../workspace.js';
import { activateWorkspace } from '../task-store.js';
import { getActiveSessionCount, stopAllCliSessions } from '../session-store.js';
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

function isValidWorkspaceRoot(dir: string): boolean {
  return existsSync(path.join(dir, '.flux')) || existsSync(path.join(dir, '.flux-store'));
}

function pathsEqual(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') return na.toLowerCase() === nb.toLowerCase();
  return na === nb;
}

function enrichEntry(entry: { path: string; label?: string }, groups: Map<string, WorkspaceGroupInfo>): WorkspaceInfo {
  const normalized = path.resolve(entry.path);
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

  const activeSessions = getActiveSessionCount();
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
    await activateWorkspace(resolved);
    const settings = await loadAppSettings();
    settings.workspace = resolved;
    await saveAppSettings(settings);
    await autoRegisterWorkspace(resolved);
    res.json({ ok: true, path: resolved });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

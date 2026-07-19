import express from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { getWorkspacesList, addWorkspaceEntry, removeWorkspaceEntry, updateWorkspaceLabel, saveAppSettings, loadAppSettings, autoRegisterWorkspace, getWorkspaceRoot, pathsEqual } from '../workspace.js';
import { activateWorkspace, openWorkspaceLive } from '../task-store.js';
import { getLiveProcessSessionCountForWorkspace, stopCliSessionsForWorkspace } from '../session-store.js';
import { resolveWorkspaceGroups, type WorkspaceGroupInfo } from '../group.js';
import { getDefaultWorkspace, getWorkspaceByRoot, closeWorkspace, canonicalizeWorkspaceRoot } from '../workspace-context.js';

const router = express.Router();

export interface WorkspaceInfo {
  path: string;
  label?: string;
  displayName: string;
  active: boolean;
  available: boolean;
  /** Multi-repo group this workspace belongs to, if any (FLUX-415). Presentation-only. */
  group?: WorkspaceGroupInfo;
  /** S10 (epic FLUX-1230): live right now — either the legacy single-active `defaultWorkspace`
   *  binding (`active`) or a S1-registry entry brought up via `openWorkspaceLive`. Powers the
   *  switcher's tab strip: only `open` boards get a tab, everything else stays in the dropdown. */
  open: boolean;
  /** S10: safe to evict via `POST /workspaces/close` — true only for S1-registry-backed entries.
   *  The legacy `defaultWorkspace` binding isn't itself a registry entry (that reconciliation is
   *  deferred engine work beyond this epic's S1-S13), so it can never be closed from the tab strip;
   *  only reachable via the destructive `/workspaces/switch` rebind. */
  closable: boolean;
  /** S10: live agent session count scoped to this workspace root (FLUX-1531 tagging), for the tab
   *  strip's live-session indicator. */
  liveSessionCount: number;
}

/**
 * FLUX-1455 review fix: `active`/`getWorkspaceRoot()` alone used to gate `open`, but
 * `getWorkspaceRoot()` moves to whatever board was most recently brought up via
 * `openWorkspaceLive` (it reads `activeKey`, workspace-context.ts). Opening a second board B thus
 * made the boot/default board A — which is never itself a registry entry (see `defaultWorkspace`'s
 * doc comment in workspace-context.ts) — report `open:false`, dropping it out of the tab strip and
 * making it falsely `closable`. The legacy default binding must stay `open`/non-`closable`
 * independent of `activeKey`, so it's tested here against `getDefaultWorkspace().root` directly.
 */
export function enrichEntry(entry: { path: string; label?: string }, groups: Map<string, WorkspaceGroupInfo>): WorkspaceInfo {
  const normalized = path.resolve(entry.path);
  const canonical = canonicalizeWorkspaceRoot(normalized);
  const workspaceRoot = getWorkspaceRoot();
  const active = workspaceRoot !== null && pathsEqual(workspaceRoot, normalized);
  const registryWs = getWorkspaceByRoot(canonical);
  const defaultRoot = getDefaultWorkspace().root;
  const isDefaultRoot = defaultRoot !== null && pathsEqual(defaultRoot, normalized);
  const info: WorkspaceInfo = {
    path: normalized,
    displayName: entry.label || path.basename(normalized),
    active,
    available: existsSync(normalized),
    open: active || isDefaultRoot || registryWs !== undefined,
    closable: registryWs !== undefined && !isDefaultRoot,
    // FLUX-1531 tags sessions with the canonical (realpath'd) root, matching `getWorkspaceRoot()`
    // for the legacy default board and the S1 registry key for a board opened via `openWorkspaceLive`.
    liveSessionCount: getLiveProcessSessionCountForWorkspace(canonical, defaultRoot),
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
  // FLUX-1531: scoped to the workspace being switched AWAY FROM (the current root) — a switch must
  // only warn about / stop sessions it would actually strand, not sessions owned by other boards.
  const wsRoot = getWorkspaceRoot();
  const defaultRoot = getDefaultWorkspace().root;
  const activeSessions = getLiveProcessSessionCountForWorkspace(wsRoot, defaultRoot);
  if (activeSessions > 0 && !force) {
    return res.status(409).json({
      error: 'active_sessions',
      activeSessions,
      message: `${activeSessions} agent session${activeSessions > 1 ? 's are' : ' is'} still running. Force switch to stop them?`,
    });
  }

  if (activeSessions > 0 && force) {
    stopCliSessionsForWorkspace(wsRoot, defaultRoot, 'workspace-switch');
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

/**
 * S10 (epic FLUX-1230): non-destructive counterpart to `/switch` — brings a registered-but-not-live
 * board up via the S1 registry (`openWorkspaceLive`) WITHOUT rebinding the legacy single-active
 * root or touching any other workspace's sessions/watchers. Idempotent: a call for an already-open
 * board is a no-op read (see `openWorkspaceLive`).
 */
router.post('/open', async (req, res) => {
  const { path: wsPath } = req.body ?? {};
  if (typeof wsPath !== 'string' || !wsPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const resolved = path.resolve(wsPath.trim());
  if (!existsSync(resolved)) {
    return res.status(400).json({ error: `Folder not found: ${resolved}` });
  }
  try {
    await openWorkspaceLive(resolved);
    const list = await getWorkspacesList();
    res.json(await enrichList(list));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : undefined });
  }
});

/**
 * S10: evicts a S1-registry-backed open board (a tab opened via `/open`). Refuses to close the
 * legacy single-active `defaultWorkspace` binding (`closable: false` in `GET /` — reconciling that
 * with the registry is deferred engine work beyond this epic's S1-S13) — the only way to move off
 * it today is the destructive `/switch` rebind. Mirrors `/switch`'s live-session guard: 409 unless
 * `force`, in which case sessions owned by this board are stopped before teardown.
 */
router.post('/close', async (req, res) => {
  const { path: wsPath, force } = req.body ?? {};
  if (typeof wsPath !== 'string' || !wsPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const resolved = canonicalizeWorkspaceRoot(path.resolve(wsPath.trim()));
  if (!getWorkspaceByRoot(resolved)) {
    return res.status(400).json({ error: 'not_closable', message: 'This board is not a registry-backed open board and cannot be closed here.' });
  }

  const defaultRoot = getDefaultWorkspace().root;
  const activeSessions = getLiveProcessSessionCountForWorkspace(resolved, defaultRoot);
  if (activeSessions > 0 && !force) {
    return res.status(409).json({
      error: 'active_sessions',
      activeSessions,
      message: `${activeSessions} agent session${activeSessions > 1 ? 's are' : ' is'} still running on this board. Close and stop them?`,
    });
  }
  if (activeSessions > 0 && force) {
    stopCliSessionsForWorkspace(resolved, defaultRoot, 'workspace-close');
  }

  await closeWorkspace(resolved);
  const list = await getWorkspacesList();
  res.json(await enrichList(list));
});

export default router;

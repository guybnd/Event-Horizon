// Task CRUD routes (FLUX-349 split): list, read, create, subtask creation, delete, plus the
// bulk-rename handler mounted separately by engine/src/index.ts. The update path (PUT /:id)
// lives in update.ts — it carries the FLUX-1044 shared-service logic and is a concern of its own.
// Mounted by the ../tasks.ts barrel AFTER the literal-path routers (debug/worktree/branch) so
// GET /:id never shadows /errors, /worktrees, /uncommitted-count, /branches.
import { getWorkspace } from '../../workspace-context.js';
import { log } from '../../log.js';
import express from 'express';
import fs from 'fs/promises';
import matter from 'gray-matter';
import { existsSync } from 'fs';
import { getWorkspaceRoot } from '../../workspace.js';
import { normalizeHistoryEntries } from '../../history.js';
import { serializeTaskForApi, serializeTaskForAgent, serializeTaskForList, atomicWriteFile, createTask, getTerminalStatuses, subtaskIds } from '../../task-store.js';
import { stopAllSessionsForTask, reconcileDeadSessions } from '../../session-store.js';
import { detachTaskWorktree, taskWorktreeDir } from '../../task-worktree.js';
import { broadcastEvent, getTasksVersion } from '../../events.js';
import { errorMessage, reqWorkspace } from './helpers.js';
import type { HistoryEntry } from './helpers.js';

const router = express.Router();

// FLUX-1338: compact, ETag-safe key for the active workspace root. A tiny djb2 hash keeps the value
// short and free of characters (spaces, quotes) that are invalid inside an ETag opaque-tag. `null`
// (no workspace bound) collapses to a stable sentinel so the tag is still well-formed.
function hashWorkspaceKey(root: string | null): string {
  if (!root) return 'none';
  let h = 5381;
  for (let i = 0; i < root.length; i++) h = ((h << 5) + h + root.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

router.get('/', (req, res) => {
  // FLUX-1455 (epic FLUX-1230 S10): resolve against the request's own workspace (`req.workspace`,
  // set by `attachWorkspace` from `X-EH-Workspace`/registry — S12) instead of the bare `getWorkspace()`
  // singleton. This is the primary read the portal's board rendering depends on (`fetchTasks`); the
  // singleton's `activeKey` moves whenever ANY board is opened live (`openWorkspace`, S1) — including
  // by a DIFFERENT client tab — so once a second board exists, `getWorkspace()` alone can silently
  // serve the wrong board's tickets to a request that asked for a specific one via the header.
  const workspace = req.workspace ?? getWorkspace();
  // FLUX-1460: refuse to serve a partial task list while the cold-boot/workspace-switch scan
  // (doActivateWorkspace -> initDir) is still populating getWorkspace().tasks. Mirrors the
  // existing POST guard below. Returning before the ETag is set is essential: a 503 is never
  // cached by fetchTasks (it throws before reading headers), whereas a 200 here would hand out a
  // cacheable ETag for a partial snapshot that later polls would 304 onto forever. Written via raw
  // res.end() rather than res.json() so Express's own auto-ETag (generated for any JSON body by
  // default, independent of the version-keyed ETag below) never lands on this response either.
  if (workspace.isActivating) {
    res.status(503).type('application/json');
    return res.end(JSON.stringify({ error: 'Workspace is activating, please retry' }));
  }
  const activeOnly = req.query.active === 'true';
  // FLUX-846: self-heal any session stuck 'running' after a missed terminal event BEFORE computing
  // the ETag. This must run unconditionally, ahead of the If-None-Match check below: a missed exit
  // is precisely the case where no broadcastEvent ever fired on its own, so it's only
  // reconcileDeadSessions (via its own broadcastEvent, FLUX-1144) that can bump `tasksVersion` and
  // invalidate a poller's cached ETag. Reordering this after the 304 short-circuit would let a
  // settled ETag mask a reap forever, leaving the card stuck 'running' until unrelated board
  // activity happens to bump the version.
  reconcileDeadSessions();
  // FLUX-1144: conditional GET. `tasksVersion` bumps on every task mutation (broadcastEvent in
  // events.ts); the two query variants (full vs ?active=true) serialize different sets, so the
  // ETag is keyed on both. A match means nothing has changed since the client's last fetch —
  // answer with a bodyless 304 and skip serialization entirely, so a routine unchanged poll (the
  // common case on the 3s interval) costs a header round-trip instead of re-transferring/re-parsing
  // the whole list.
  // FLUX-1338: key the ETag by this request's workspace root too, so two workspaces can never
  // collide on a shared `tasksVersion` counter (it's a module-global that survives a workspace
  // switch). Hashed rather than inlined because a raw path can contain spaces (invalid in an ETag
  // opaque-tag) and is needlessly long. `doActivateWorkspace` also bumps the version on switch —
  // belt and suspenders.
  const wsKey = hashWorkspaceKey(workspace.root ?? getWorkspaceRoot());
  const etag = `"tasks-${wsKey}-${activeOnly ? 'active' : 'all'}-${getTasksVersion()}"`;
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  let tasks = Object.values(workspace.tasks);
  // FLUX-970: the live 3s poll only needs non-terminal tickets — the board already filters
  // Released/Archived out client-side (Board.tsx). Opt in with ?active=true so the hot poll
  // path stops shipping/parsing/diffing thousands of resting tickets on every tick; default
  // (no param) stays the full set for callers that still need everything (Releases, search).
  if (activeOnly) {
    const terminalStatuses = getTerminalStatuses();
    tasks = tasks.filter((task) => !terminalStatuses.includes(task.status));
  }
  res.json(tasks.map(serializeTaskForList));
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  // FLUX-1455 (S10): same `req.workspace` reasoning as the list route above.
  const task = (req.workspace ?? getWorkspace()).tasks[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // ?view=agent serves the digested surface (same as MCP get_ticket) for
  // agents reading via the REST fallback; the portal default stays full.
  if (req.query.view === 'agent') {
    const historyLimit = Number.parseInt(String(req.query.historyLimit ?? ''), 10);
    const expand = typeof req.query.expand === 'string' && req.query.expand.trim()
      ? req.query.expand.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const fullHistory = req.query.fullHistory === 'true';
    const fullBody = req.query.fullBody === 'true';
    return res.json(serializeTaskForAgent(task, Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : undefined, { expand, fullHistory, fullBody }));
  }
  // FLUX-1505: ?view=list serves the SAME shape GET /api/tasks (list) uses —
  // capped inline history, derived historyDigest, truncated liveOutput. The
  // patch-first `taskUpdated` SSE handler fetches a single task with this view
  // so it can merge the result straight into the list-shaped `tasks` store
  // without producing an internally-inconsistent detail/list hybrid record.
  if (req.query.view === 'list') {
    return res.json(serializeTaskForList(task));
  }
  res.json(serializeTaskForApi(task));
});

router.post('/', async (req, res) => {
  if (reqWorkspace(req).isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const { projectKey, status, author, title, body, ...rest } = req.body;

  try {
    const { task } = await createTask({
      // FLUX-1417: don't default here — createTask applies its own default, and for
      // `kind:'scratch'` needs to see an empty/placeholder title to name it `Scratch <n>`.
      title: title || '',
      status: status || 'Todo',
      priority: rest.priority || 'None',
      effort: rest.effort || 'None',
      assignee: rest.assignee || 'unassigned',
      tags: rest.tags || [],
      body: body || '',
      author: author || 'Unknown',
      projectKey,
      // FLUX-1225: forward the ticket kind (e.g. 'scratch' from the ChatDock spawn). createTask
      // routes 'scratch' into its own SCRATCH-n id namespace and persists the kind to frontmatter.
      ...(typeof rest.kind === 'string' ? { kind: rest.kind } : {}),
    }, req.workspace);
    res.json(serializeTaskForApi(task));
  } catch (err: unknown) {
    const message = errorMessage(err, '');
    if (message.startsWith('Schema validation failed')) {
      return res.status(400).json({
        error: 'SCHEMA_VALIDATION_FAILED',
        message,
      });
    }
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ─── Create subtask and link to parent ───────────────────────────────────────

router.post('/:parentId/subtasks', async (req, res) => {
  if (reqWorkspace(req).isActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });

  const { parentId } = req.params;
  const parent = reqWorkspace(req).tasks[parentId];
  if (!parent) return res.status(404).json({ error: 'Parent task not found' });

  const { title, status, priority, effort, body, tags, assignee, author } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const actor = author || 'Agent';

  try {
    const { id: childId, task: childTask } = await createTask({
      title,
      status: status || 'Todo',
      priority: priority || 'None',
      effort: effort || 'None',
      assignee: assignee || 'unassigned',
      tags: tags || [],
      body: body || '',
      author: actor,
      parentId,
    }, req.workspace);

    // Link child to parent — derive subtasks from disk to avoid TOCTOU race
    const parentRaw = await fs.readFile(parent._path, 'utf-8');
    const parentParsed = matter(parentRaw);
    const parentSubtasks: string[] = subtaskIds(parentParsed.data.subtasks);
    parentSubtasks.push(childId);
    parentParsed.data.subtasks = parentSubtasks;
    parentParsed.data.updatedBy = actor;
    const parentContent = matter.stringify(parentParsed.content, parentParsed.data);
    await atomicWriteFile(parent._path, parentContent);

    // Update cache
    reqWorkspace(req).tasks[parentId] = { ...reqWorkspace(req).tasks[parentId], subtasks: parentSubtasks, updatedBy: actor };

    log.info(`[subtasks] Created ${childId} as subtask of ${parentId}`);
    res.json(serializeTaskForApi(childTask));
  } catch (err: unknown) {
    const message = errorMessage(err, '');
    if (message.startsWith('Schema validation failed')) {
      return res.status(400).json({
        error: 'SCHEMA_VALIDATION_FAILED',
        message,
      });
    }
    console.error(`Failed to create subtask for ${parentId}:`, err);
    res.status(500).json({ error: 'Failed to create subtask' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];

  if (!task) return res.status(404).json({ error: 'Task not found' });

  try {
    // Tear down the ticket's dedicated worktree first so deleting the ticket doesn't orphan
    // it (FLUX-577). Abandon path (applyToMain:false): uncommitted work is preserved as a
    // recoverable stash ref, NOT applied to master. Only this ticket's own worktree is
    // touched (taskWorktreeDir by id) — a shared/joined worktree another ticket holds is
    // left alone. Best-effort: a teardown failure must not block the delete.
    if (task.branch) {
      const wtPath = taskWorktreeDir(getWorkspaceRoot()!, id);
      if (existsSync(wtPath)) {
        stopAllSessionsForTask(id, 'Deleting ticket — detaching worktree');
        await detachTaskWorktree(getWorkspaceRoot()!, wtPath, { ticketId: id, applyToMain: false }).catch((e) => {
          console.error(`Worktree teardown failed while deleting ${id}:`, e?.message);
        });
      }
    }
    await fs.unlink(task._path);
    delete getWorkspace().tasks[id];
    broadcastEvent('taskDeleted', { id }); // FLUX-753: drop the card on connected portals
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

export async function bulkRenameHandler(req: express.Request, res: express.Response) {
  const { tags = {}, statuses = {}, users = {}, priorities = {} } = req.body;
  let modifiedCount = 0;

  try {
    for (const id in getWorkspace().tasks) {
      const task = getWorkspace().tasks[id];
      let changed = false;
      const { body, _path, id: _id, ...frontmatter } = task;
      const normalizedHistory = normalizeHistoryEntries(frontmatter.history || []);

      if (normalizedHistory.changed) {
        frontmatter.history = normalizedHistory.history;
        changed = true;
      }

      if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
        const newTags = frontmatter.tags.map((t: string) => tags[t] || t);
        if (JSON.stringify(newTags) !== JSON.stringify(frontmatter.tags)) {
          frontmatter.tags = newTags;
          changed = true;
        }
      }

      if (frontmatter.status && statuses[frontmatter.status]) { frontmatter.status = statuses[frontmatter.status]; changed = true; }
      if (frontmatter.assignee && users[frontmatter.assignee]) { frontmatter.assignee = users[frontmatter.assignee]; changed = true; }
      if (frontmatter.priority && priorities[frontmatter.priority]) { frontmatter.priority = priorities[frontmatter.priority]; changed = true; }
      if (frontmatter.author && users[frontmatter.author]) { frontmatter.author = users[frontmatter.author]; changed = true; }
      if (frontmatter.updatedBy && users[frontmatter.updatedBy]) { frontmatter.updatedBy = users[frontmatter.updatedBy]; changed = true; }

      if (frontmatter.history && Array.isArray(frontmatter.history)) {
        let historyChanged = false;
        frontmatter.history.forEach((entry: HistoryEntry) => {
          if (entry.user && users[entry.user]) { entry.user = users[entry.user]; historyChanged = true; }
          if (entry.type === 'status_change') {
            if (entry.from && statuses[entry.from]) { entry.from = statuses[entry.from]; historyChanged = true; }
            if (entry.to && statuses[entry.to]) { entry.to = statuses[entry.to]; historyChanged = true; }
          }
        });
        if (historyChanged) changed = true;
      }

      if (changed) {
        const fileContent = matter.stringify(body || '', frontmatter);
        await atomicWriteFile(_path, fileContent);
        getWorkspace().tasks[id] = { ...frontmatter, body, id, _path };
        modifiedCount += 1;
      }
    }
    res.json({ success: true, modifiedCount });
  } catch (err) {
    console.error('Failed bulk rename:', err);
    res.status(500).json({ error: 'Failed bulk rename' });
  }
}

export default router;

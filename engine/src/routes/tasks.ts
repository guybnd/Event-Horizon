import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getFluxDir, getActiveFluxDir, getTaskAssetsDir, isOrphanMode, getFluxStoreDir } from '../workspace.js';
import { configCache, autoRegisterUnknownTags } from '../config.js';
import {
  normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry,
  summarizeFieldChanges, hasAppendedStatusChange, findEarliestHistoryDate,
} from '../history.js';
import { tasksCache, serializeTaskForApi, updateTaskWithHistory, workspaceActivating, parseErrors } from '../task-store.js';
import {
  resolveSupportedImageExtension, sanitizeAssetBaseName, normalizeBase64Content,
  normalizeRelativePath, encodeAssetPath, createUniqueAssetFileName,
} from '../file-utils.js';
import { cliSessionIdByTaskId, cliSessionsById } from '../session-store.js';
import { getAdapter } from '../agents/index.js';

const execFileAsync = promisify(execFile);
const router = express.Router();

/**
 * Get the max ticket ID from the remote flux-data branch.
 * This prevents ID collisions when multiple instances create tickets before syncing.
 * Returns 0 if remote check fails (network issue, no remote, etc.)
 */
async function getMaxIdFromRemote(projectKey: string): Promise<number> {
  if (!isOrphanMode()) return 0;

  const storeDir = getFluxStoreDir();
  try {
    // Fetch latest remote state
    await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data']);

    // List files on remote branch
    const { stdout } = await execFileAsync('git', [
      '-C', storeDir, 'ls-tree', '-r', '--name-only', 'origin/flux-data'
    ]);

    let maxId = 0;
    stdout.split('\n').forEach(file => {
      const fileName = path.basename(file);
      if (fileName.startsWith(`${projectKey}-`) && fileName.endsWith('.md')) {
        const idPart = fileName.replace(`${projectKey}-`, '').replace('.md', '');
        const num = parseInt(idPart, 10);
        if (!isNaN(num) && num > maxId) maxId = num;
      }
    });

    return maxId;
  } catch (err: any) {
    // Network failure, no remote, or auth issue - fall back to local only
    console.warn(`[tasks] Could not check remote for max ticket ID: ${err.message}`);
    return 0;
  }
}

router.get('/', (req, res) => {
  res.json(Object.values(tasksCache).map(serializeTaskForApi));
});

router.get('/errors', (req, res) => {
  res.json(Object.values(parseErrors));
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(serializeTaskForApi(task));
});

router.post('/', async (req, res) => {
  if (workspaceActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const { projectKey, status, author, title, body, ...rest } = req.body;
  const pKey = projectKey || configCache.projects?.[0] || 'PROJECT';

  // Check local cache for max ID
  let maxId = 0;
  Object.keys(tasksCache).forEach((key) => {
    if (key.startsWith(`${pKey}-`)) {
      const num = parseInt(key.replace(`${pKey}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });

  // In orphan mode, also check remote to prevent ID collisions across instances
  if (isOrphanMode()) {
    const remoteMaxId = await getMaxIdFromRemote(pKey);
    maxId = Math.max(maxId, remoteMaxId);
    if (remoteMaxId > 0) {
      console.log(`[tasks] Remote max ID for ${pKey}: ${remoteMaxId}, using ${maxId + 1}`);
    }
  }

  const nextId = `${pKey}-${maxId + 1}`;
  const filePath = path.join(getActiveFluxDir(), `${nextId}.md`);
  const createdAt = new Date().toISOString();
  const normalizedHistory = normalizeHistoryEntries((rest.history || []).map((e: any) => ({ ...e, date: createdAt })));
  const historyWithCreation = ensureCreationActivity(normalizedHistory.history, author || 'Unknown', createdAt);
  const frontmatter = {
    ...rest,
    id: nextId,
    title: title || 'New Task',
    status: status || 'Todo',
    priority: rest.priority || 'None',
    createdBy: author || 'Unknown',
    updatedBy: author || 'Unknown',
    assignee: rest.assignee || 'unassigned',
    tags: rest.tags || [],
    history: historyWithCreation.history,
  };

  try {
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      await autoRegisterUnknownTags(frontmatter.tags);
    }
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(filePath, fileContent, 'utf-8');
    tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
    res.json(serializeTaskForApi(tasksCache[nextId]));
  } catch (err) {
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

router.put('/:id', async (req, res) => {
  if (workspaceActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });
  const { id } = req.params;
  const { updatedBy, ...updates } = req.body;
  const task = tasksCache[id];

  if (!task) return res.status(404).json({ error: 'Task not found' });

  const actor = updatedBy || task.updatedBy || 'Unknown';

  const appendHistoryEntries: any[] = Array.isArray(updates.appendHistory) ? updates.appendHistory : [];
  delete updates.appendHistory;

  if (updates.requireInput === true) {
    updates.status = configCache.requireInputStatus || 'Require Input';
    delete updates.requireInput;
  }

  const requireInputStatus = configCache.requireInputStatus || 'Require Input';
  if (updates.status === requireInputStatus && task.status !== requireInputStatus) {
    const submittedHistory: any[] = Array.isArray(updates.history) ? updates.history : [];
    const existingLen = (task.history || []).length;
    const hasNewComment =
      submittedHistory.slice(existingLen).some((e: any) => e?.type === 'comment') ||
      appendHistoryEntries.some((e: any) => e?.type === 'comment');
    if (!hasNewComment) {
      return res.status(400).json({
        error: 'REQUIRE_INPUT_MISSING_COMMENT',
        message: 'Transitioning to Require Input requires a question comment in the same request.',
      });
    }
  }

  const readyStatus = configCache.readyForMergeStatus || 'Ready';
  if (updates.status === readyStatus && task.status !== readyStatus) {
    const submittedHistory: any[] = Array.isArray(updates.history) ? updates.history : [];
    const existingLen = (task.history || []).length;
    const hasNewComment =
      submittedHistory.slice(existingLen).some((e: any) => e?.type === 'comment') ||
      appendHistoryEntries.some((e: any) => e?.type === 'comment');
    if (!hasNewComment) {
      return res.status(400).json({
        error: 'READY_MISSING_COMMENT',
        message: 'Transitioning to Ready requires a completion comment in the same request.',
      });
    }

    // Auto-stop the CLI session when ticket moves to Ready
    const sessionId = cliSessionIdByTaskId.get(id);
    if (sessionId) {
      const session = cliSessionsById.get(sessionId);
      if (session && (session.status === 'running' || session.status === 'waiting-input')) {
        console.log(`[tasks] Auto-stopping session ${sessionId} for ticket ${id} (moved to ${readyStatus})`);
        session.requestedStop = true;
        session.status = 'completed';
        session.endedAt = new Date().toISOString();
        try {
          const adapter = getAdapter(session.framework);
          adapter.stop(session);
        } catch (err: any) {
          console.warn(`[tasks] Failed to stop session ${sessionId}:`, err.message);
        }
      }
    }
  }

  const normalizedExistingHistory = normalizeHistoryEntries(task.history || []);
  const existingHistory = ensureCreationActivity(
    normalizedExistingHistory.history,
    task.createdBy || actor,
    findEarliestHistoryDate(normalizedExistingHistory.history),
  ).history;
  const { body, _path, id: _id, ...frontmatter } = { ...task, ...updates };
  if (updatedBy) {
    frontmatter.updatedBy = updatedBy;
  }
  let nextHistory = normalizeHistoryEntries(frontmatter.history || []).history;
  nextHistory = ensureCreationActivity(
    nextHistory,
    task.createdBy || actor,
    findEarliestHistoryDate(existingHistory),
  ).history;

  const activityTimestamp = new Date().toISOString();
  const novelEntries = nextHistory.slice(existingHistory.length).map((entry) => ({
    ...entry,
    date: activityTimestamp,
  }));
  nextHistory = [...existingHistory, ...novelEntries];
  if (task.status !== frontmatter.status && !hasAppendedStatusChange(existingHistory, nextHistory, task.status, frontmatter.status)) {
    nextHistory.push({
      type: 'status_change',
      from: task.status,
      to: frontmatter.status,
      user: actor,
      date: activityTimestamp,
    });
  }

  const fieldChangeMessages = summarizeFieldChanges(task, frontmatter, body);
  if (fieldChangeMessages.length > 0) {
    nextHistory.push(buildActivityEntry(fieldChangeMessages.join(' '), actor, activityTimestamp));
  }

  for (const entry of appendHistoryEntries) {
    nextHistory.push({ ...entry, date: activityTimestamp });
  }

  frontmatter.history = normalizeHistoryEntries(nextHistory).history;

  try {
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      await autoRegisterUnknownTags(frontmatter.tags);
    }
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(_path, fileContent, 'utf-8');
    tasksCache[id] = { ...frontmatter, body, id, _path };
    res.json(serializeTaskForApi(tasksCache[id]));
  } catch (err) {
    console.error('Failed to update task:', err);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];

  if (!task) return res.status(404).json({ error: 'Task not found' });

  try {
    await fs.unlink(task._path);
    delete tasksCache[id];
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
    for (const id in tasksCache) {
      const task = tasksCache[id];
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
        frontmatter.history.forEach((entry: any) => {
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
        await fs.writeFile(_path, fileContent, 'utf-8');
        tasksCache[id] = { ...frontmatter, body, id, _path };
        modifiedCount += 1;
      }
    }
    res.json({ success: true, modifiedCount });
  } catch (err) {
    console.error('Failed bulk rename:', err);
    res.status(500).json({ error: 'Failed bulk rename' });
  }
}

router.post('/:id/assets', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];

  if (!task) return res.status(404).json({ error: 'Task not found' });

  const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
  const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const normalizedContent = normalizeBase64Content(content);

  if (!normalizedContent) return res.status(400).json({ error: 'Missing asset content' });

  const extension = resolveSupportedImageExtension(fileName, mimeType);
  if (!extension) {
    return res.status(400).json({ error: 'Only PNG, JPG, and SVG images are supported in this first version.' });
  }

  const safeBaseName = sanitizeAssetBaseName(fileName || 'image');
  const taskAssetDirectory = path.join(getTaskAssetsDir(), id);

  try {
    await fs.mkdir(taskAssetDirectory, { recursive: true });

    const requestedFileName = `${safeBaseName}${extension}`;
    const storedFileName = await createUniqueAssetFileName(taskAssetDirectory, requestedFileName);
    const filePath = path.join(taskAssetDirectory, storedFileName);
    const fileBuffer = Buffer.from(normalizedContent, 'base64');

    if (fileBuffer.length === 0) return res.status(400).json({ error: 'Invalid asset content' });

    await fs.writeFile(filePath, fileBuffer);

    const assetPath = normalizeRelativePath(path.relative(getActiveFluxDir(), filePath));
    const apiAssetPath = normalizeRelativePath(path.relative(getTaskAssetsDir(), filePath));
    res.status(201).json({
      path: assetPath,
      fileName: storedFileName,
      url: `/api/assets/${encodeAssetPath(apiAssetPath)}`,
    });
  } catch (error) {
    console.error(`Failed to write asset for task ${id}:`, error);
    res.status(500).json({ error: 'Failed to save asset' });
  }
});

export default router;

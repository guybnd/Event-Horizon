import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getFluxDir, getActiveFluxDir, getTaskAssetsDir } from '../workspace.js';
import { configCache, autoRegisterUnknownTags } from '../config.js';
import {
  normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry,
  summarizeFieldChanges, hasAppendedStatusChange, findEarliestHistoryDate,
} from '../history.js';
import { tasksCache, serializeTaskForApi, serializeTaskForList, updateTaskWithHistory, workspaceActivating, parseErrors, atomicWriteFile, createTask } from '../task-store.js';
import { generatePromptNotification, generateCompletionNotification } from '../notifications.js';
import { validateTicketFrontmatter, formatValidationErrors } from '../schema.js';
import {
  resolveSupportedImageExtension, sanitizeAssetBaseName, normalizeBase64Content,
  normalizeRelativePath, encodeAssetPath, createUniqueAssetFileName,
} from '../file-utils.js';
import { cliSessionIdByTaskId, cliSessionsById, stopAllSessionsForTask } from '../session-store.js';
import { getAdapter } from '../agents/index.js';

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Object.values(tasksCache).map(serializeTaskForList));
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

  try {
    const { task } = await createTask({
      title: title || 'New Task',
      status: status || 'Todo',
      priority: rest.priority || 'None',
      effort: rest.effort || 'None',
      assignee: rest.assignee || 'unassigned',
      tags: rest.tags || [],
      body: body || '',
      author: author || 'Unknown',
      projectKey,
    });
    res.json(serializeTaskForApi(task));
  } catch (err: any) {
    if (err.message?.startsWith('Schema validation failed')) {
      return res.status(400).json({
        error: 'SCHEMA_VALIDATION_FAILED',
        message: err.message,
      });
    }
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// ─── Create subtask and link to parent ───────────────────────────────────────

router.post('/:parentId/subtasks', async (req, res) => {
  if (workspaceActivating) return res.status(503).json({ error: 'Workspace is activating, please retry' });

  const { parentId } = req.params;
  const parent = tasksCache[parentId];
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
    });

    // Link child to parent's subtasks array
    const parentSubtasks: string[] = Array.isArray(parent.subtasks)
      ? parent.subtasks.map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean)
      : [];
    parentSubtasks.push(childId);

    // Re-read parent from disk to avoid clobbering
    const parentRaw = await fs.readFile(parent._path, 'utf-8');
    const parentParsed = matter(parentRaw);
    parentParsed.data.subtasks = parentSubtasks;
    parentParsed.data.updatedBy = actor;
    const parentContent = matter.stringify(parentParsed.content, parentParsed.data);
    await atomicWriteFile(parent._path, parentContent);

    // Update cache
    tasksCache[parentId] = { ...tasksCache[parentId], subtasks: parentSubtasks, updatedBy: actor };

    console.log(`[subtasks] Created ${childId} as subtask of ${parentId}`);
    res.json(serializeTaskForApi(childTask));
  } catch (err: any) {
    if (err.message?.startsWith('Schema validation failed')) {
      return res.status(400).json({
        error: 'SCHEMA_VALIDATION_FAILED',
        message: err.message,
      });
    }
    console.error(`Failed to create subtask for ${parentId}:`, err);
    res.status(500).json({ error: 'Failed to create subtask' });
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
      submittedHistory.slice(existingLen).some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === requireInputStatus && e?.comment))) ||
      appendHistoryEntries.some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === requireInputStatus && e?.comment)));
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
      submittedHistory.slice(existingLen).some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment))) ||
      appendHistoryEntries.some((e: any) => (e?.type === 'comment' || (e?.type === 'status_change' && e?.to === readyStatus && e?.comment)));
    if (!hasNewComment && configCache.requireCommentOnStatusChange !== false) {
      return res.status(400).json({
        error: 'READY_MISSING_COMMENT',
        message: 'Transitioning to Ready requires a completion comment in the same request.',
      });
    }

    // Auto-stop all CLI sessions when ticket moves to Ready
    stopAllSessionsForTask(id, `ticket moved to ${readyStatus}`);
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

  const validationErrors = validateTicketFrontmatter(frontmatter);
  if (validationErrors.length > 0) {
    return res.status(400).json({
      error: 'SCHEMA_VALIDATION_FAILED',
      message: `Ticket schema validation failed:\n${formatValidationErrors(validationErrors)}`,
      details: validationErrors,
    });
  }

  // Bidirectional parentId sync
  const oldParentId = task.parentId || null;
  const newParentId = frontmatter.parentId !== undefined ? (frontmatter.parentId || null) : oldParentId;
  if (newParentId) {
    frontmatter.parentId = newParentId;
  } else {
    delete frontmatter.parentId;
  }

  try {
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      await autoRegisterUnknownTags(frontmatter.tags);
    }
    const fileContent = matter.stringify(body || '', frontmatter);
    await atomicWriteFile(_path, fileContent);
    tasksCache[id] = { ...frontmatter, body, id, _path };

    if (task.status !== frontmatter.status) {
      if (frontmatter.status === requireInputStatus || frontmatter.status === readyStatus) {
        generatePromptNotification(id, frontmatter.title || id, frontmatter.status);
      } else if (frontmatter.status === 'Done') {
        generateCompletionNotification(id, frontmatter.title || id);
      }
    }

    // Sync parent's subtasks array when parentId changes
    if (newParentId !== oldParentId) {
      // Remove from old parent's subtasks
      if (oldParentId && tasksCache[oldParentId]) {
        const oldParent = tasksCache[oldParentId];
        const oldParentSubtasks: string[] = (Array.isArray(oldParent.subtasks) ? oldParent.subtasks : [])
          .map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean);
        const filtered = oldParentSubtasks.filter((sid: string) => sid !== id);
        if (filtered.length !== oldParentSubtasks.length) {
          const parentRaw = await fs.readFile(oldParent._path, 'utf-8');
          const parentParsed = matter(parentRaw);
          parentParsed.data.subtasks = filtered;
          parentParsed.data.updatedBy = actor;
          await atomicWriteFile(oldParent._path, matter.stringify(parentParsed.content, parentParsed.data));
          tasksCache[oldParentId] = { ...tasksCache[oldParentId], subtasks: filtered, updatedBy: actor };
        }
      }
      // Add to new parent's subtasks
      if (newParentId && tasksCache[newParentId]) {
        const newParent = tasksCache[newParentId];
        const newParentSubtasks: string[] = (Array.isArray(newParent.subtasks) ? newParent.subtasks : [])
          .map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean);
        if (!newParentSubtasks.includes(id)) {
          newParentSubtasks.push(id);
          const parentRaw = await fs.readFile(newParent._path, 'utf-8');
          const parentParsed = matter(parentRaw);
          parentParsed.data.subtasks = newParentSubtasks;
          parentParsed.data.updatedBy = actor;
          await atomicWriteFile(newParent._path, matter.stringify(parentParsed.content, parentParsed.data));
          tasksCache[newParentId] = { ...tasksCache[newParentId], subtasks: newParentSubtasks, updatedBy: actor };
        }
      }
    }

    // When subtasks array changes, sync children's parentId
    const oldSubtasks: string[] = (Array.isArray(task.subtasks) ? task.subtasks : [])
      .map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean);
    const newSubtasks: string[] = (Array.isArray(frontmatter.subtasks) ? frontmatter.subtasks : [])
      .map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean);
    const removedChildren = oldSubtasks.filter((sid: string) => !newSubtasks.includes(sid));
    const addedChildren = newSubtasks.filter((sid: string) => !oldSubtasks.includes(sid));

    for (const childId of removedChildren) {
      const child = tasksCache[childId];
      if (child && child.parentId === id) {
        const childRaw = await fs.readFile(child._path, 'utf-8');
        const childParsed = matter(childRaw);
        delete childParsed.data.parentId;
        childParsed.data.updatedBy = actor;
        await atomicWriteFile(child._path, matter.stringify(childParsed.content, childParsed.data));
        tasksCache[childId] = { ...tasksCache[childId], parentId: undefined, updatedBy: actor };
      }
    }
    for (const childId of addedChildren) {
      const child = tasksCache[childId];
      if (child && child.parentId !== id) {
        // Remove child from its previous parent if any
        if (child.parentId && tasksCache[child.parentId]) {
          const prevParent = tasksCache[child.parentId];
          const prevSubs: string[] = (Array.isArray(prevParent.subtasks) ? prevParent.subtasks : [])
            .map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean)
            .filter((sid: string) => sid !== childId);
          const prevRaw = await fs.readFile(prevParent._path, 'utf-8');
          const prevParsed = matter(prevRaw);
          prevParsed.data.subtasks = prevSubs;
          prevParsed.data.updatedBy = actor;
          await atomicWriteFile(prevParent._path, matter.stringify(prevParsed.content, prevParsed.data));
          tasksCache[child.parentId] = { ...tasksCache[child.parentId], subtasks: prevSubs, updatedBy: actor };
        }
        const childRaw = await fs.readFile(child._path, 'utf-8');
        const childParsed = matter(childRaw);
        childParsed.data.parentId = id;
        childParsed.data.updatedBy = actor;
        await atomicWriteFile(child._path, matter.stringify(childParsed.content, childParsed.data));
        tasksCache[childId] = { ...tasksCache[childId], parentId: id, updatedBy: actor };
      }
    }

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
        await atomicWriteFile(_path, fileContent);
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

// ─── Branch routes ────────────────────────────────────────────────────────────

import { createTicketBranch, getTicketBranchStatus, deleteTicketBranch, extractFileFromDiff } from '../branch-manager.js';

router.post('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const title: string = task.title || id;
  const baseBranch: string | undefined = req.body?.baseBranch;

  try {
    const branch = await createTicketBranch(id, title, baseBranch);
    await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
    res.json({ branch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const name: string | undefined = task.branch;
  if (!name) return res.json({ name: null, exists: false, aheadCount: 0, behindCount: 0 });

  try {
    const status = await getTicketBranchStatus(name);
    res.json({ name, ...status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const name: string | undefined = task.branch;
  if (!name) return res.status(400).json({ error: 'No branch associated with this ticket' });

  const force: boolean = req.body?.force === true;

  try {
    await deleteTicketBranch(name, force);
    await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch: null } });
    res.json({ deleted: name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Diff sidecar route ────────────────────────────────────────────────────────

router.get('/:id/diff', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const diffPath = path.join(getActiveFluxDir(), `${id}.diff`);
  let fullDiff: string;
  try {
    fullDiff = await fs.readFile(diffPath, 'utf-8');
  } catch {
    return res.status(404).json({ error: 'No diff stored for this ticket' });
  }

  const file = typeof req.query.file === 'string' ? req.query.file : null;
  if (file) {
    const hunk = extractFileFromDiff(fullDiff, file);
    if (!hunk) return res.status(404).json({ error: `File ${file} not present in diff` });
    res.type('text/plain').send(hunk);
    return;
  }
  res.type('text/plain').send(fullDiff);
});

export default router;

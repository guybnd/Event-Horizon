import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getWorkflowInstallStatus, installWorkspaceWorkflow } from './workflow-installer';

const app = express();
app.use(cors());
app.use(express.json());

const FLUX_DIR = path.join(__dirname, '../../.flux');
const CONFIG_FILE = path.join(FLUX_DIR, 'config.json');
const REPO_ROOT = path.resolve(FLUX_DIR, '..');

let tasksCache: Record<string, any> = {};
let configCache: any = {
  columns: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Done' }],
  hiddenStatuses: [{ name: 'Backlog' }],
  projects: ['FLUX'],
  users: [{ name: 'Guy' }, { name: 'Agent' }],
  tags: [
    { name: 'bug', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
    { name: 'feature', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    { name: 'docs', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' }
  ],
  priorities: [
    { name: 'Critical', icon: 'AlertCircle', color: 'text-red-500' },
    { name: 'High', icon: 'ChevronUp', color: 'text-orange-500' },
    { name: 'Medium', icon: 'Equal', color: 'text-amber-500' },
    { name: 'Low', icon: 'ChevronDown', color: 'text-emerald-500' },
    { name: 'None', icon: 'Equal', color: 'text-gray-400' }
  ],
  enableBacklogScreen: true,
  requireCommentOnStatusChange: true,
  readyForMergeStatus: 'Ready'
};

function buildCommentId(seed: string, usedIds: Set<string>) {
  const normalizedSeed = seed.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'comment';
  let candidate = `c-${normalizedSeed}`;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `c-${normalizedSeed}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

function buildActivityEntry(comment: string, user: string, date: string) {
  return {
    type: 'activity',
    user: user || 'Unknown',
    date,
    comment,
  };
}

function getHistoryTimestamp(entry: any) {
  if (!entry?.date) {
    return 0;
  }

  const timestamp = new Date(entry.date).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function findEarliestHistoryDate(history: any[] = []) {
  const timestamps = history
    .map((entry) => getHistoryTimestamp(entry))
    .filter((timestamp) => timestamp > 0);

  if (timestamps.length === 0) {
    return undefined;
  }

  return new Date(Math.min(...timestamps)).toISOString();
}

function ensureCreationActivity(history: any[] = [], user: string, fallbackDate?: string) {
  const hasCreationActivity = history.some((entry) => entry?.type === 'activity' && entry?.comment === 'Created ticket.');

  if (hasCreationActivity) {
    return { history, changed: false };
  }

  const createdAt = findEarliestHistoryDate(history) || fallbackDate || new Date().toISOString();
  return {
    history: [buildActivityEntry('Created ticket.', user || 'Unknown', createdAt), ...history],
    changed: true,
  };
}

function valuesMatch(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function formatValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : 'none';
  }

  if (typeof value === 'string') {
    return value.trim() || 'none';
  }

  if (value == null) {
    return 'none';
  }

  return String(value);
}

function summarizeFieldChanges(previousTask: any, nextFrontmatter: any, nextBody: string | undefined) {
  const messages: string[] = [];
  const previousBody = typeof previousTask.body === 'string' ? previousTask.body : '';
  const normalizedNextBody = typeof nextBody === 'string' ? nextBody : '';

  if ((previousTask.title || '') !== (nextFrontmatter.title || '')) {
    messages.push('Updated title.');
  }

  if (previousBody !== normalizedNextBody) {
    messages.push('Updated description.');
  }

  if ((previousTask.assignee || 'unassigned') !== (nextFrontmatter.assignee || 'unassigned')) {
    messages.push(`Changed assignee from ${formatValue(previousTask.assignee || 'unassigned')} to ${formatValue(nextFrontmatter.assignee || 'unassigned')}.`);
  }

  if (!valuesMatch(previousTask.tags || [], nextFrontmatter.tags || [])) {
    messages.push(`Updated tags to ${formatValue(nextFrontmatter.tags || [])}.`);
  }

  if ((previousTask.priority || 'None') !== (nextFrontmatter.priority || 'None')) {
    messages.push(`Changed priority from ${formatValue(previousTask.priority || 'None')} to ${formatValue(nextFrontmatter.priority || 'None')}.`);
  }

  if ((previousTask.effort || 'None') !== (nextFrontmatter.effort || 'None')) {
    messages.push(`Changed effort from ${formatValue(previousTask.effort || 'None')} to ${formatValue(nextFrontmatter.effort || 'None')}.`);
  }

  if ((previousTask.implementationLink || '') !== (nextFrontmatter.implementationLink || '')) {
    messages.push(nextFrontmatter.implementationLink ? 'Updated implementation link.' : 'Cleared implementation link.');
  }

  if (!valuesMatch(previousTask.subtasks || [], nextFrontmatter.subtasks || [])) {
    messages.push('Updated subtasks.');
  }

  return messages;
}

function historyPrefixMatches(existingHistory: any[] = [], nextHistory: any[] = []) {
  if (nextHistory.length < existingHistory.length) {
    return false;
  }

  return existingHistory.every((entry, index) => JSON.stringify(entry) === JSON.stringify(nextHistory[index]));
}

function hasAppendedStatusChange(existingHistory: any[] = [], nextHistory: any[] = [], from?: string, to?: string) {
  if (!from || !to || !historyPrefixMatches(existingHistory, nextHistory)) {
    return false;
  }

  return nextHistory.slice(existingHistory.length).some(
    (entry) => entry?.type === 'status_change' && entry?.from === from && entry?.to === to,
  );
}

function normalizeHistoryEntries(history: any[] = []) {
  let changed = false;
  const usedIds = new Set<string>();

  const normalized = history.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const nextEntry = { ...entry };

    if (typeof nextEntry.id === 'string' && nextEntry.id.trim()) {
      const trimmedId = nextEntry.id.trim();
      if (trimmedId !== nextEntry.id) {
        nextEntry.id = trimmedId;
        changed = true;
      }
      usedIds.add(nextEntry.id);
    }

    if (nextEntry.type === 'comment') {
      if (!nextEntry.id) {
        const seed = nextEntry.date || `${Date.now()}-${index + 1}`;
        nextEntry.id = buildCommentId(seed, usedIds);
        changed = true;
      }

      if (nextEntry.replyTo != null && typeof nextEntry.replyTo !== 'string') {
        delete nextEntry.replyTo;
        changed = true;
      }
    }

    return nextEntry;
  });

  return { history: normalized, changed };
}

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    const loaded = JSON.parse(data);

    if (loaded.columns?.length && typeof loaded.columns[0] === 'string') loaded.columns = loaded.columns.map((s: string) => ({ name: s }));
    if (loaded.hiddenStatuses?.length && typeof loaded.hiddenStatuses[0] === 'string') loaded.hiddenStatuses = loaded.hiddenStatuses.map((s: string) => ({ name: s }));
    if (loaded.users?.length && typeof loaded.users[0] === 'string') loaded.users = loaded.users.map((s: string) => ({ name: s }));
    if (loaded.tags?.length && typeof loaded.tags[0] === 'string') {
      loaded.tags = loaded.tags.map((s: string) => ({
        name: s,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      }));
    }
    if (!loaded.priorities || !Array.isArray(loaded.priorities) || loaded.priorities.length === 0) {
      loaded.priorities = configCache.priorities;
    }
    if (loaded.priorities?.length && typeof loaded.priorities[0] === 'string') {
      loaded.priorities = loaded.priorities.map((name: string) => ({
        name,
        icon: 'Equal',
        color: 'text-gray-400'
      }));
    }

    configCache = { ...configCache, ...loaded };
    console.log('Loaded config');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      await saveConfig(configCache);
    } else {
      console.error('Failed to load config:', error);
    }
  }
}

async function saveConfig(newConfig: any) {
  configCache = newConfig;
  await fs.writeFile(CONFIG_FILE, JSON.stringify(configCache, null, 2), 'utf-8');
}

function isTopLevelTaskFile(filePath: string) {
  return filePath.endsWith('.md') && path.dirname(filePath) === FLUX_DIR;
}

async function loadTask(filePath: string) {
  if (!isTopLevelTaskFile(filePath)) return;

  try {
    const fileStats = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const id = parsed.data.id || path.basename(filePath, '.md');
    const normalizedHistory = normalizeHistoryEntries(parsed.data.history);
    const fallbackCreatedAt = fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();
    const { history } = ensureCreationActivity(
      normalizedHistory.history,
      parsed.data.createdBy || parsed.data.updatedBy || 'Unknown',
      fallbackCreatedAt,
    );
    const normalizedFrontmatter = {
      ...parsed.data,
      history,
    };

    tasksCache[id] = {
      ...normalizedFrontmatter,
      id,
      body: parsed.content,
      _path: filePath
    };

    if (normalizedHistory.changed) {
      const normalizedContent = matter.stringify(parsed.content, normalizedFrontmatter);
      await fs.writeFile(filePath, normalizedContent, 'utf-8');
    }

    console.log(`Loaded task: ${id}`);
  } catch (error) {
    console.error(`Failed to load ${filePath}:`, error);
  }
}

async function initDir() {
  try {
    await fs.mkdir(FLUX_DIR, { recursive: true });
  } catch {
    // ignore
  }
  await loadConfig();
}

initDir().then(() => {
  const watcher = chokidar.watch(FLUX_DIR, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.flux';
    },
    persistent: true
  });

  watcher
    .on('add', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        void loadTask(filePath);
      }
      if (filePath === CONFIG_FILE) {
        void loadConfig();
      }
    })
    .on('change', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        void loadTask(filePath);
      }
      if (filePath === CONFIG_FILE) {
        void loadConfig();
      }
    })
    .on('unlink', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        const taskEntry = Object.entries(tasksCache).find(([, task]) => task._path === filePath);
        const id = taskEntry?.[0] || path.basename(filePath, '.md');
        delete tasksCache[id];
        console.log(`Removed task: ${id}`);
      }
    });
});

app.get('/api/tasks', (req, res) => {
  res.json(Object.values(tasksCache));
});

app.get('/api/skill/status', async (req, res) => {
  try {
    const status = await getWorkflowInstallStatus({ sourceRoot: REPO_ROOT, targetDir: REPO_ROOT, framework: 'copilot' });
    res.json(status);
  } catch (error) {
    console.error('Failed to load skill status:', error);
    res.status(500).json({ error: 'Failed to load skill status' });
  }
});

app.post('/api/skill/install', async (req, res) => {
  try {
    const result = await installWorkspaceWorkflow({ sourceRoot: REPO_ROOT, targetDir: REPO_ROOT, framework: 'copilot' });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Failed to install skill:', error);
    res.status(500).json({ error: 'Failed to install skill' });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { projectKey, status, author, title, body, ...rest } = req.body;
  const pKey = projectKey || 'FLUX';

  let maxId = 0;
  Object.keys(tasksCache).forEach((key) => {
    if (key.startsWith(`${pKey}-`)) {
      const num = parseInt(key.replace(`${pKey}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });

  const nextId = `${pKey}-${maxId + 1}`;
  const filePath = path.join(FLUX_DIR, `${nextId}.md`);
  const normalizedHistory = normalizeHistoryEntries(rest.history || []);
  const createdAt = new Date().toISOString();
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
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(filePath, fileContent, 'utf-8');

    tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
    res.json(tasksCache[nextId]);
  } catch (err) {
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { updatedBy, ...updates } = req.body;
  const task = tasksCache[id];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const actor = updatedBy || task.updatedBy || 'Unknown';
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

  frontmatter.history = normalizeHistoryEntries(nextHistory).history;

  try {
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(_path, fileContent, 'utf-8');

    tasksCache[id] = { ...frontmatter, body, id, _path };
    res.json(tasksCache[id]);
  } catch (err) {
    console.error('Failed to update task:', err);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    await fs.unlink(task._path);
    delete tasksCache[id];
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.post('/api/bulk-rename', async (req, res) => {
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

      if (frontmatter.status && statuses[frontmatter.status]) {
        frontmatter.status = statuses[frontmatter.status];
        changed = true;
      }

      if (frontmatter.assignee && users[frontmatter.assignee]) {
        frontmatter.assignee = users[frontmatter.assignee];
        changed = true;
      }
      if (frontmatter.priority && priorities[frontmatter.priority]) {
        frontmatter.priority = priorities[frontmatter.priority];
        changed = true;
      }
      if (frontmatter.author && users[frontmatter.author]) {
        frontmatter.author = users[frontmatter.author];
        changed = true;
      }
      if (frontmatter.updatedBy && users[frontmatter.updatedBy]) {
        frontmatter.updatedBy = users[frontmatter.updatedBy];
        changed = true;
      }

      if (frontmatter.history && Array.isArray(frontmatter.history)) {
        let historyChanged = false;
        frontmatter.history.forEach((entry: any) => {
          if (entry.user && users[entry.user]) {
            entry.user = users[entry.user];
            historyChanged = true;
          }
          if (entry.type === 'status_change') {
            if (entry.from && statuses[entry.from]) {
              entry.from = statuses[entry.from];
              historyChanged = true;
            }
            if (entry.to && statuses[entry.to]) {
              entry.to = statuses[entry.to];
              historyChanged = true;
            }
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
});

app.get('/api/config', (req, res) => {
  res.json(configCache);
});

app.put('/api/config', async (req, res) => {
  try {
    await saveConfig(req.body);
    res.json(configCache);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Event Horizon Engine running on port ${PORT}`);
});

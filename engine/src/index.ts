import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { getWorkflowInstallStatus, installWorkspaceWorkflow } from './workflow-installer';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const FLUX_DIR = path.join(__dirname, '../../.flux');
const CONFIG_FILE = path.join(FLUX_DIR, 'config.json');
const REPO_ROOT = path.resolve(FLUX_DIR, '..');
const DOCS_DIR = path.join(REPO_ROOT, '.docs');
const TASK_ASSETS_DIR = path.join(FLUX_DIR, 'assets');

const SUPPORTED_IMAGE_TYPES = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/svg+xml', '.svg'],
]);

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.svg']);

interface DocRecord {
  path: string;
  title: string;
  body: string;
  slug: string;
  directory: string;
  order?: number;
}

interface StoredDoc extends DocRecord {
  _path: string;
}

let tasksCache: Record<string, any> = {};
let docsCache: Record<string, StoredDoc> = {};
let configCache: any = {
  columns: [
    { name: 'Todo', color: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300' },
    { name: 'In Progress', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
    { name: 'Done', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' },
  ],
  hiddenStatuses: [{ name: 'Backlog', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' }],
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
  boardCardOpenMode: 'full',
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  docsEditPermissions: 'all',
  docsAllowedUsers: [],
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

function normalizeTextContent(value: unknown) {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trimEnd() : '';
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item != null && String(item).trim() !== '')
    .map((item) => String(item));
}

function summarizeFieldChanges(previousTask: any, nextFrontmatter: any, nextBody: string | undefined) {
  const messages: string[] = [];
  const previousBody = normalizeTextContent(previousTask.body);
  const normalizedNextBody = normalizeTextContent(nextBody);
  const previousTags = normalizeStringList(previousTask.tags);
  const nextTags = normalizeStringList(nextFrontmatter.tags);
  const previousSubtasks = normalizeStringList(previousTask.subtasks);
  const nextSubtasks = normalizeStringList(nextFrontmatter.subtasks);

  if ((previousTask.title || '') !== (nextFrontmatter.title || '')) {
    messages.push('Updated title.');
  }

  if (previousBody !== normalizedNextBody) {
    messages.push('Updated description.');
  }

  if ((previousTask.assignee || 'unassigned') !== (nextFrontmatter.assignee || 'unassigned')) {
    messages.push(`Changed assignee from ${formatValue(previousTask.assignee || 'unassigned')} to ${formatValue(nextFrontmatter.assignee || 'unassigned')}.`);
  }

  if (!valuesMatch(previousTags, nextTags)) {
    messages.push(`Updated tags to ${formatValue(nextTags)}.`);
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

  if (!valuesMatch(previousSubtasks, nextSubtasks)) {
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

function normalizeRelativePath(filePath: string) {
  return filePath.split(path.sep).join('/');
}

function encodeAssetPath(assetPath: string) {
  return assetPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function normalizeAssetPathInput(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return segments.join('/');
}

function getAssetPathFromRequestPath(requestPath: string) {
  const prefix = '/api/assets/';

  if (!requestPath.startsWith(prefix)) {
    return null;
  }

  try {
    return normalizeAssetPathInput(decodeURIComponent(requestPath.slice(prefix.length)));
  } catch {
    return null;
  }
}

function getAssetFilePath(assetPath: string) {
  return path.join(TASK_ASSETS_DIR, ...assetPath.split('/'));
}

function isPathInsideRoot(rootPath: string, targetPath: string) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getExtensionFromFileName(fileName: string) {
  const extension = path.extname(fileName || '').toLowerCase();
  if (extension === '.jpeg') {
    return '.jpg';
  }
  return extension;
}

function sanitizeAssetBaseName(fileName: string) {
  const baseName = path.basename(fileName, path.extname(fileName));
  const normalized = baseName
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');

  return normalized || 'image';
}

function resolveSupportedImageExtension(fileName: string, mimeType: string) {
  const normalizedMimeType = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (SUPPORTED_IMAGE_TYPES.has(normalizedMimeType)) {
    return SUPPORTED_IMAGE_TYPES.get(normalizedMimeType)!;
  }

  const extension = getExtensionFromFileName(fileName);
  if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return extension === '.jpeg' ? '.jpg' : extension;
  }

  return null;
}

function normalizeBase64Content(content: string) {
  const trimmedContent = content.trim();
  const match = trimmedContent.match(/^data:[^;]+;base64,(.+)$/i);
  return (match ? match[1] : trimmedContent).replace(/\s+/g, '');
}

async function createUniqueAssetFileName(directoryPath: string, requestedFileName: string) {
  const extension = path.extname(requestedFileName);
  const baseName = path.basename(requestedFileName, extension);
  let suffix = 1;
  let candidate = requestedFileName;

  while (true) {
    const candidatePath = path.join(directoryPath, candidate);

    try {
      await fs.access(candidatePath);
      suffix += 1;
      candidate = `${baseName}-${suffix}${extension}`;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return candidate;
      }
      throw error;
    }
  }
}

function normalizeDocPathInput(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return null;
  }

  const withoutExtension = normalized.toLowerCase().endsWith('.md')
    ? normalized.slice(0, -3)
    : normalized;
  const segments = withoutExtension.split('/').filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  return segments.join('/');
}

function getDocPathFromFile(filePath: string) {
  const relativePath = normalizeRelativePath(path.relative(DOCS_DIR, filePath));

  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }

  return normalizeDocPathInput(relativePath);
}

function getDocFilePath(docPath: string) {
  return path.join(DOCS_DIR, ...docPath.split('/')) + '.md';
}

function isDocFile(filePath: string) {
  return filePath.toLowerCase().endsWith('.md') && getDocPathFromFile(filePath) !== null;
}

function titleFromDocPath(docPath: string) {
  const basename = docPath.split('/').filter(Boolean).pop() || 'untitled';
  return basename
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function slugifyDocValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseDocOrder(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return undefined;
}

function serializeDoc(doc: StoredDoc): DocRecord {
  const { _path, ...publicDoc } = doc;
  return publicDoc;
}

function getDocPathFromRequestPath(requestPath: string) {
  const prefix = '/api/docs/';

  if (!requestPath.startsWith(prefix)) {
    return null;
  }

  try {
    return normalizeDocPathInput(decodeURIComponent(requestPath.slice(prefix.length)));
  } catch {
    return null;
  }
}

function buildDocFrontmatter(title: string, order: number | undefined) {
  return {
    title,
    ...(order !== undefined ? { order } : {}),
  };
}

function sortDocs(docs: DocRecord[]) {
  return [...docs].sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
}

async function writeDocFile(filePath: string, title: string, order: number | undefined, body: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const fileContent = matter.stringify(body, buildDocFrontmatter(title, order));
  await fs.writeFile(filePath, fileContent, 'utf-8');
}

async function removeEmptyDocDirectories(startingFilePath: string) {
  let currentDirectory = path.dirname(startingFilePath);
  const docsRoot = path.resolve(DOCS_DIR);

  while (path.resolve(currentDirectory) !== docsRoot) {
    const entries = await fs.readdir(currentDirectory);
    if (entries.length > 0) {
      return;
    }

    await fs.rmdir(currentDirectory);
    currentDirectory = path.dirname(currentDirectory);
  }
}

async function loadDoc(filePath: string) {
  if (!isDocFile(filePath)) return;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const docPath = getDocPathFromFile(filePath);

    if (!docPath) {
      return;
    }

    const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : titleFromDocPath(docPath);
    const order = parseDocOrder(parsed.data.order);
    const directory = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
    const slugSource = docPath.split('/').filter(Boolean).pop() || docPath;

    docsCache[docPath] = {
      path: docPath,
      title,
      body: parsed.content.replace(/\r\n/g, '\n'),
      slug: slugifyDocValue(slugSource),
      directory,
      ...(order !== undefined ? { order } : {}),
      _path: filePath,
    };

    console.log(`Loaded doc: ${docPath}`);
  } catch (error) {
    console.error(`Failed to load doc ${filePath}:`, error);
  }
}

async function loadDocsDirectory(directoryPath: string) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await loadDocsDirectory(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        await loadDoc(entryPath);
      }
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to read docs directory ${directoryPath}:`, error);
    }
  }
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
    await fs.mkdir(DOCS_DIR, { recursive: true });
    await fs.mkdir(TASK_ASSETS_DIR, { recursive: true });
    await loadDocsDirectory(DOCS_DIR);
  } catch {
    // ignore
  }
  await loadConfig();
}

initDir().then(() => {
  const fluxWatcher = chokidar.watch(FLUX_DIR, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.flux';
    },
    persistent: true
  });

  fluxWatcher
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

  const docsWatcher = chokidar.watch(DOCS_DIR, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.docs';
    },
    persistent: true
  });

  docsWatcher
    .on('add', (filePath) => {
      if (isDocFile(filePath)) {
        void loadDoc(filePath);
      }
    })
    .on('change', (filePath) => {
      if (isDocFile(filePath)) {
        void loadDoc(filePath);
      }
    })
    .on('unlink', (filePath) => {
      const docPath = getDocPathFromFile(filePath);
      if (!docPath) {
        return;
      }

      delete docsCache[docPath];
      console.log(`Removed doc: ${docPath}`);
    });
});

app.get('/api/tasks', (req, res) => {
  res.json(Object.values(tasksCache));
});

app.get('/api/docs', (req, res) => {
  res.json(sortDocs(Object.values(docsCache).map(serializeDoc)));
});

app.post('/api/docs', async (req, res) => {
  const docPath = normalizeDocPathInput(req.body?.path);

  if (!docPath) {
    return res.status(400).json({ error: 'Invalid doc path' });
  }

  if (docsCache[docPath]) {
    return res.status(409).json({ error: 'Doc already exists' });
  }

  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : titleFromDocPath(docPath);
  const order = parseDocOrder(req.body?.order);
  const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : '';
  const filePath = getDocFilePath(docPath);

  try {
    await writeDocFile(filePath, title, order, body);
    await loadDoc(filePath);

    const createdDoc = docsCache[docPath];
    if (!createdDoc) {
      throw new Error('Doc was not loaded after creation');
    }

    res.status(201).json(serializeDoc(createdDoc));
  } catch (error) {
    console.error('Failed to create doc:', error);
    res.status(500).json({ error: 'Failed to create doc' });
  }
});

app.get(/^\/api\/docs\/.+$/, (req, res) => {
  const docPath = getDocPathFromRequestPath(req.path);

  if (!docPath) {
    return res.status(400).json({ error: 'Invalid doc path' });
  }

  const doc = docsCache[docPath];
  if (!doc) {
    return res.status(404).json({ error: 'Doc not found' });
  }

  res.json(serializeDoc(doc));
});

app.put(/^\/api\/docs\/.+$/, async (req, res) => {
  const docPath = getDocPathFromRequestPath(req.path);

  if (!docPath) {
    return res.status(400).json({ error: 'Invalid doc path' });
  }

  const existingDoc = docsCache[docPath];
  if (!existingDoc) {
    return res.status(404).json({ error: 'Doc not found' });
  }

  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : existingDoc.title;
  const order = req.body?.order === null ? undefined : parseDocOrder(req.body?.order) ?? existingDoc.order;
  const body = typeof req.body?.body === 'string' ? req.body.body.replace(/\r\n/g, '\n') : existingDoc.body;

  try {
    await writeDocFile(existingDoc._path, title, order, body);
    await loadDoc(existingDoc._path);

    const updatedDoc = docsCache[docPath];
    if (!updatedDoc) {
      throw new Error('Doc was not loaded after update');
    }

    res.json(serializeDoc(updatedDoc));
  } catch (error) {
    console.error(`Failed to save doc ${docPath}:`, error);
    res.status(500).json({ error: 'Failed to save doc' });
  }
});

app.delete(/^\/api\/docs\/.+$/, async (req, res) => {
  const docPath = getDocPathFromRequestPath(req.path);

  if (!docPath) {
    return res.status(400).json({ error: 'Invalid doc path' });
  }

  const doc = docsCache[docPath];
  if (!doc) {
    return res.status(404).json({ error: 'Doc not found' });
  }

  try {
    await fs.unlink(doc._path);
    delete docsCache[docPath];
    await removeEmptyDocDirectories(doc._path);
    res.json({ success: true });
  } catch (error) {
    console.error(`Failed to delete doc ${docPath}:`, error);
    res.status(500).json({ error: 'Failed to delete doc' });
  }
});

app.get(/^\/api\/assets\/.+$/, async (req, res) => {
  const assetPath = getAssetPathFromRequestPath(req.path);

  if (!assetPath) {
    return res.status(400).json({ error: 'Invalid asset path' });
  }

  const filePath = getAssetFilePath(assetPath);
  if (!isPathInsideRoot(TASK_ASSETS_DIR, filePath)) {
    return res.status(400).json({ error: 'Invalid asset path' });
  }

  try {
    const fileStats = await fs.stat(filePath);
    if (!fileStats.isFile()) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const fileBuffer = await fs.readFile(filePath);
    res.type(path.extname(filePath));
    res.send(fileBuffer);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Asset not found' });
    }

    console.error(`Failed to read asset ${assetPath}:`, error);
    res.status(500).json({ error: 'Failed to read asset' });
  }
});

app.post('/api/tasks/:id/assets', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
  const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim() : '';
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const normalizedContent = normalizeBase64Content(content);

  if (!normalizedContent) {
    return res.status(400).json({ error: 'Missing asset content' });
  }

  const extension = resolveSupportedImageExtension(fileName, mimeType);
  if (!extension) {
    return res.status(400).json({ error: 'Only PNG, JPG, and SVG images are supported in this first version.' });
  }

  const safeBaseName = sanitizeAssetBaseName(fileName || 'image');
  const taskAssetDirectory = path.join(TASK_ASSETS_DIR, id);

  try {
    await fs.mkdir(taskAssetDirectory, { recursive: true });

    const requestedFileName = `${safeBaseName}${extension}`;
    const storedFileName = await createUniqueAssetFileName(taskAssetDirectory, requestedFileName);
    const filePath = path.join(taskAssetDirectory, storedFileName);
    const fileBuffer = Buffer.from(normalizedContent, 'base64');

    if (fileBuffer.length === 0) {
      return res.status(400).json({ error: 'Invalid asset content' });
    }

    await fs.writeFile(filePath, fileBuffer);

    const assetPath = normalizeRelativePath(path.relative(FLUX_DIR, filePath));
    const apiAssetPath = normalizeRelativePath(path.relative(TASK_ASSETS_DIR, filePath));
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

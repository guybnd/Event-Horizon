import express from 'express';
import cors from 'cors';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execFile, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { getWorkflowInstallStatus, installWorkspaceWorkflow } from './workflow-installer';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Workspace state ───────────────────────────────────────────────────────────
// workspaceRoot is null until the user selects a project folder. All workspace-
// dependent routes check this via requireWorkspace() and return 503 otherwise.
let workspaceRoot: string | null = null;

function getFluxDir()       { return path.join(workspaceRoot!, '.flux'); }
function getConfigFile()    { return path.join(getFluxDir(), 'config.json'); }
function getTaskAssetsDir() { return path.join(getFluxDir(), 'assets'); }
function getReadStateFile() { return path.join(getFluxDir(), 'read-state.json'); }
function getDocsDir()       { return path.join(workspaceRoot!, configCache.docsRoot || '.docs'); }

// Persisted app settings live in ~/.event-horizon/settings.json (not per-project).
const APP_SETTINGS_DIR  = path.join(os.homedir(), '.event-horizon');
const APP_SETTINGS_FILE = path.join(APP_SETTINGS_DIR, 'settings.json');

async function loadAppSettings(): Promise<{ workspace?: string }> {
  try {
    const raw = await fs.readFile(APP_SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveAppSettings(settings: { workspace?: string }) {
  await fs.mkdir(APP_SETTINGS_DIR, { recursive: true });
  await fs.writeFile(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// Returns the --workspace arg if provided, null otherwise.
function getCliWorkspace(): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--workspace');
  if (idx !== -1 && args[idx + 1]) return path.resolve(args[idx + 1]);
  return null;
}

// Middleware: rejects requests that need a workspace when none is configured.
function requireWorkspace(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!workspaceRoot) {
    res.status(503).json({ error: 'No workspace configured', code: 'NO_WORKSPACE' });
    return;
  }
  next();
}

// Resolve the root that contains the bundled skill source files (.docs/skills, .flux/skills).
// In pkg-packaged binaries these are embedded in the snapshot at __dirname.
// In dev/compiled mode __dirname is engine/src or engine/dist — walk up to repo root.
function resolveSkillSourceRoot(): string {
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) {
    return __dirname;
  }
  // engine/src → ../../   or   engine/dist → ../../
  return path.resolve(__dirname, '..', '..');
}

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
  hiddenStatuses: [
    { name: 'Backlog', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
    { name: 'Released', color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300' }
  ],
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
  animationsEnabled: true,
  enableFireworks: true,
  requireInputStatus: 'Require Input',
  readyForMergeStatus: 'Ready',
  archiveStatus: 'Archived',
  docsEditPermissions: 'all',
  docsAllowedUsers: [],
  releaseSettings: {
    generateDistinctFiles: true,
    releaseNotesPath: 'release-notes'
  }
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
    const data = await fs.readFile(getConfigFile(), 'utf-8');
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
  await fs.writeFile(getConfigFile(), JSON.stringify(configCache, null, 2), 'utf-8');
}

async function autoRegisterUnknownTags(tags: string[]) {
  if (!tags || !Array.isArray(tags) || tags.length === 0) return;
  
  if (!configCache.tags) {
    configCache.tags = [];
  }
  
  const existingTagsLower = new Set(configCache.tags.map((t: any) => t.name?.toLowerCase() || ''));
  let configChanged = false;
  
  for (const tag of tags) {
    if (tag && typeof tag === 'string' && !existingTagsLower.has(tag.toLowerCase())) {
      configCache.tags.push({
        name: tag,
        color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
      });
      existingTagsLower.add(tag.toLowerCase());
      configChanged = true;
    }
  }
  
  if (configChanged) {
    await saveConfig(configCache);
  }
}

function isTopLevelTaskFile(filePath: string) {
  return filePath.endsWith('.md') && path.dirname(filePath) === getFluxDir();
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
  return path.join(getTaskAssetsDir(), ...assetPath.split('/'));
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
  const relativePath = normalizeRelativePath(path.relative(getDocsDir(), filePath));

  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }

  return normalizeDocPathInput(relativePath);
}

function getDocFilePath(docPath: string) {
  return path.join(getDocsDir(), ...docPath.split('/')) + '.md';
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
  const docsRoot = path.resolve(getDocsDir());

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
    
    if (normalizedFrontmatter.tags && Array.isArray(normalizedFrontmatter.tags)) {
      await autoRegisterUnknownTags(normalizedFrontmatter.tags);
    }

    console.log(`Loaded task: ${id}`);
  } catch (error) {
    console.error(`Failed to load ${filePath}:`, error);
  }
}

async function initDir() {
  try {
    await fs.mkdir(getFluxDir(), { recursive: true });
    await fs.mkdir(getDocsDir(), { recursive: true });
    await fs.mkdir(getTaskAssetsDir(), { recursive: true });
    await loadDocsDirectory(getDocsDir());
  } catch {
    // ignore
  }
  await loadConfig();
}

// Active chokidar watchers — torn down and recreated when workspace changes.
let activeFluxWatcher: ReturnType<typeof chokidar.watch> | null = null;
let activeDocsWatcher: ReturnType<typeof chokidar.watch> | null = null;

async function startWatchers() {
  // Tear down previous watchers if workspace is being switched.
  if (activeFluxWatcher) { await activeFluxWatcher.close(); activeFluxWatcher = null; }
  if (activeDocsWatcher) { await activeDocsWatcher.close(); activeDocsWatcher = null; }

  const fluxDir = getFluxDir();
  const configFile = getConfigFile();

  activeFluxWatcher = chokidar.watch(fluxDir, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.flux';
    },
    persistent: true
  });

  activeFluxWatcher
    .on('add', (filePath) => {
      if (isTopLevelTaskFile(filePath)) void loadTask(filePath);
      if (filePath === configFile) void loadConfig();
    })
    .on('change', (filePath) => {
      if (isTopLevelTaskFile(filePath)) void loadTask(filePath);
      if (filePath === configFile) void loadConfig();
    })
    .on('unlink', (filePath) => {
      if (isTopLevelTaskFile(filePath)) {
        const taskEntry = Object.entries(tasksCache).find(([, task]) => task._path === filePath);
        const id = taskEntry?.[0] || path.basename(filePath, '.md');
        delete tasksCache[id];
        console.log(`Removed task: ${id}`);
      }
    });

  activeDocsWatcher = chokidar.watch(getDocsDir(), {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== '.docs';
    },
    persistent: true
  });

  activeDocsWatcher
    .on('add', (filePath) => { if (isDocFile(filePath)) void loadDoc(filePath); })
    .on('change', (filePath) => { if (isDocFile(filePath)) void loadDoc(filePath); })
    .on('unlink', (filePath) => {
      const docPath = getDocPathFromFile(filePath);
      if (docPath) { delete docsCache[docPath]; console.log(`Removed doc: ${docPath}`); }
    });
}

// Activate a workspace: set the root, reset caches, load data, start watchers.
async function activateWorkspace(newRoot: string) {
  workspaceRoot = newRoot;
  tasksCache = {};
  docsCache = {};
  configCache = { ...configCache }; // keep defaults, will be overwritten by loadConfig
  console.log(`Workspace: ${newRoot}`);
  await initDir();
  await startWatchers();
}

app.get('/api/tasks', requireWorkspace, (req, res) => {
  res.json(Object.values(tasksCache));
});

app.get('/api/read-state', requireWorkspace, async (req, res) => {
  try {
    const raw = await fs.readFile(getReadStateFile(), 'utf-8').catch(() => '{}');
    res.json(JSON.parse(raw));
  } catch {
    res.json({});
  }
});

app.put('/api/read-state', requireWorkspace, async (req, res) => {
  try {
    const body = req.body as Record<string, Record<string, string[]>>;
    // Merge with existing state so concurrent users don't overwrite each other
    let existing: Record<string, Record<string, string[]>> = {};
    try {
      const raw = await fs.readFile(getReadStateFile(), 'utf-8');
      existing = JSON.parse(raw);
    } catch { /* file may not exist yet */ }
    for (const [user, tickets] of Object.entries(body)) {
      existing[user] = existing[user] || {};
      for (const [ticketId, ids] of Object.entries(tickets)) {
        const merged = new Set([...(existing[user][ticketId] || []), ...ids]);
        existing[user][ticketId] = [...merged];
      }
    }
    await fs.writeFile(getReadStateFile(), JSON.stringify(existing, null, 2), 'utf-8');
    res.json(existing);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/docs', requireWorkspace, (req, res) => {
  res.json(sortDocs(Object.values(docsCache).map(serializeDoc)));
});

app.post('/api/docs', requireWorkspace, async (req, res) => {
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
  if (!isPathInsideRoot(getTaskAssetsDir(), filePath)) {
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

app.post('/api/tasks/:id/assets', requireWorkspace, async (req, res) => {
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
  const taskAssetDirectory = path.join(getTaskAssetsDir(), id);

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

    const assetPath = normalizeRelativePath(path.relative(getFluxDir(), filePath));
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

app.get('/api/skill/status', requireWorkspace, async (req, res) => {
  try {
    const framework = (req.query.framework as any) || 'auto';
    const status = await getWorkflowInstallStatus({ sourceRoot: resolveSkillSourceRoot(), targetDir: workspaceRoot!, framework });
    res.json(status);
  } catch (error) {
    console.error('Failed to load skill status:', error);
    res.status(500).json({ error: 'Failed to load skill status' });
  }
});

app.post('/api/skill/install', requireWorkspace, async (req, res) => {
  try {
    const framework = req.body?.framework || 'auto';
    const result = await installWorkspaceWorkflow({ sourceRoot: resolveSkillSourceRoot(), targetDir: workspaceRoot!, framework });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Failed to install skill:', error);
    res.status(500).json({ error: 'Failed to install skill' });
  }
});

app.post('/api/tasks', requireWorkspace, async (req, res) => {
  const { projectKey, status, author, title, body, ...rest } = req.body;
  const pKey = projectKey || 'PROJECT';

  let maxId = 0;
  Object.keys(tasksCache).forEach((key) => {
    if (key.startsWith(`${pKey}-`)) {
      const num = parseInt(key.replace(`${pKey}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });

  const nextId = `${pKey}-${maxId + 1}`;
  const filePath = path.join(getFluxDir(), `${nextId}.md`);
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
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      await autoRegisterUnknownTags(frontmatter.tags);
    }
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(filePath, fileContent, 'utf-8');

    tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
    res.json(tasksCache[nextId]);
  } catch (err) {
    console.error('Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.put('/api/tasks/:id', requireWorkspace, async (req, res) => {
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
    if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
      await autoRegisterUnknownTags(frontmatter.tags);
    }
    const fileContent = matter.stringify(body || '', frontmatter);
    await fs.writeFile(_path, fileContent, 'utf-8');

    tasksCache[id] = { ...frontmatter, body, id, _path };
    res.json(tasksCache[id]);
  } catch (err) {
    console.error('Failed to update task:', err);
    res.status(500).json({ error: 'Failed to save task' });
  }
});

app.delete('/api/tasks/:id', requireWorkspace, async (req, res) => {
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

app.post('/api/bulk-rename', requireWorkspace, async (req, res) => {
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', workspace: workspaceRoot });
});

// ─── Native folder picker ────────────────────────────────────────────────────
// Spawns an OS-native folder browser dialog and returns the chosen path.
// POST /api/workspace/pick → { path: string } | { path: null } | 500 error
function spawnFolderPicker(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;

    if (platform === 'win32') {
      // PowerShell FolderBrowserDialog — works headless as long as a desktop session exists.
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$d.Description = "Select your Event Horizon project folder";',
        '$d.ShowNewFolderButton = $true;',
        'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }',
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-Command', script], (err, stdout) => {
        if (err) return reject(err);
        const picked = stdout.trim();
        resolve(picked || null);
      });
    } else if (platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Select your Event Horizon project folder")';
      execFile('osascript', ['-e', script], (err, stdout) => {
        if (err) return resolve(null); // user cancelled
        const picked = stdout.trim().replace(/\/$/, '');
        resolve(picked || null);
      });
    } else {
      // Linux — try zenity, fall back to kdialog
      execFile('zenity', ['--file-selection', '--directory', '--title=Select project folder'], (err, stdout) => {
        if (!err) return resolve(stdout.trim() || null);
        execFile('kdialog', ['--getexistingdirectory', process.env.HOME || '/'], (err2, stdout2) => {
          if (err2) return resolve(null);
          resolve(stdout2.trim() || null);
        });
      });
    }
  });
}

app.post('/api/workspace/pick', async (_req, res) => {
  try {
    const picked = await spawnFolderPicker();
    res.json({ path: picked });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to open folder picker' });
  }
});

// ─── Workspace selection API ────────────────────────────────────────────────
// GET  /api/workspace  → current workspace state
// POST /api/workspace  → switch to a new workspace folder
app.get('/api/workspace', (_req, res) => {
  res.json({ configured: workspaceRoot !== null, path: workspaceRoot });
});

app.post('/api/workspace', async (req, res) => {
  const raw = req.body?.path;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const newRoot = path.resolve(raw.trim());

  // Validate the folder exists.
  try { await fs.access(newRoot); } catch {
    return res.status(400).json({ error: `Folder not found: ${newRoot}` });
  }

  // Validate it has a .flux/ directory (or inform user to init).
  const fluxPath = path.join(newRoot, '.flux');
  if (!existsSync(fluxPath)) {
    return res.status(400).json({
      error: `No .flux/ directory found in ${newRoot}. Run event-horizon init in your project root first, or choose a different folder.`,
      code: 'NO_FLUX_DIR',
    });
  }

  try {
    await activateWorkspace(newRoot);
    await saveAppSettings({ workspace: newRoot });
    res.json({ ok: true, path: newRoot });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', requireWorkspace, (req, res) => {
  res.json(configCache);
});

app.put('/api/config', requireWorkspace, async (req, res) => {
  try {
    await saveConfig(req.body);
    res.json(configCache);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// Static portal serving — only active when portal/dist has been built.
// API routes above take priority; this catches everything else.

// Resolve portal dist path for static serving.
// Priority: --portal-dist <path> CLI arg, then location relative to binary or engine source.
function resolvePortalDist(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--portal-dist');
  if (idx !== -1 && args[idx + 1]) {
    return path.resolve(args[idx + 1]);
  }
  // When running as a pkg-packaged binary, process.pkg is defined.
  // __dirname inside pkg points to the virtual snapshot directory,
  // where portal/dist is embedded as an asset alongside index.js.
  const isPkg = (process as any).pkg !== undefined;
  if (isPkg) {
    return path.join(__dirname, 'portal', 'dist');
  }
  // Dev (tsx) or compiled (tsc/esbuild): engine/src or engine/dist → ../../portal/dist
  return path.resolve(__dirname, '..', '..', 'portal', 'dist');
}

const PORTAL_DIST = resolvePortalDist();
const PORTAL_DIST_EXISTS = existsSync(PORTAL_DIST);

if (PORTAL_DIST_EXISTS) {
  app.use(express.static(PORTAL_DIST));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(PORTAL_DIST, 'index.html'));
  });
}

// Graceful shutdown — lets the portal's Stop button cleanly exit the process.
app.post('/api/shutdown', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => process.exit(0), 150);
});

// ─── App config (port) ────────────────────────────────────────────────────────
// When running as a pkg binary, read/create event-horizon.config.json adjacent
// to the executable so users can change the port before launching.
async function readPortConfig(): Promise<number> {
  const isPkg = (process as any).pkg !== undefined;
  if (!isPkg) return parseInt(process.env.PORT || '3001', 10);

  const cfgPath = path.join(path.dirname(process.execPath), 'event-horizon.config.json');
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536) return cfg.port;
  } catch {
    // Create a default config file so users know it exists and can edit it.
    try {
      await fs.writeFile(cfgPath, JSON.stringify({ port: 3001 }, null, 2), 'utf-8');
    } catch {}
  }
  return 3001;
}

// ─── Open browser ─────────────────────────────────────────────────────────────
function openBrowser(url: string) {
  try {
    if (process.platform === 'win32') {
      // windowsHide suppresses the CMD flash that would otherwise appear briefly.
      execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      execFile('open', [url]);
    } else {
      execFile('xdg-open', [url]);
    }
  } catch {}
}

// ─── System tray ──────────────────────────────────────────────────────────────
// Uses the pre-compiled Go tray binary from the `systray` npm package.
// In pkg mode, the binary is embedded as an asset; we extract it to the OS
// temp dir before spawning (pkg virtual FS cannot directly execFile).
// The binary communicates via stdin/stdout JSON — we implement the protocol
// directly without importing the systray JS module.

const TRAY_BINARIES: Partial<Record<NodeJS.Platform, string>> = {
  win32:  'tray_windows_release.exe',
  darwin: 'tray_darwin_release',
  linux:  'tray_linux_release',
};

async function initTray(port: number): Promise<void> {
  const isPkg = (process as any).pkg !== undefined;
  const binaryName = TRAY_BINARIES[process.platform];
  if (!binaryName) return; // unsupported platform

  let binaryPath: string;

  if (isPkg) {
    // Binary is embedded in the pkg virtual snapshot alongside index.js.
    // Extract to a real temp-dir path so the OS can execute it.
    const embeddedPath = path.join(__dirname, 'traybin', binaryName);
    const tmpPath = path.join(os.tmpdir(), `eh-tray-${binaryName}`);

    // Only extract if the file doesn't already exist (avoid re-copy on restart).
    if (!existsSync(tmpPath)) {
      const data = await fs.readFile(embeddedPath);
      await fs.writeFile(tmpPath, data, { mode: 0o755 });
    }
    binaryPath = tmpPath;
  } else {
    // Dev/compiled: look for the binary in root node_modules (npm workspaces hoist).
    const candidates = [
      path.resolve(__dirname, '..', '..', 'node_modules', 'systray', 'traybin', binaryName),
      path.resolve(__dirname, '..', 'node_modules', 'systray', 'traybin', binaryName),
    ];
    const found = candidates.find(p => existsSync(p));
    if (!found) {
      console.warn('Tray binary not found — skipping tray init.');
      return;
    }
    binaryPath = found;
  }

  if (process.platform !== 'win32') {
    try { await fs.chmod(binaryPath, 0o755); } catch {}
  }

  const trayProc = spawn(binaryPath, [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,  // prevents the spawned tray process from allocating a console window
  });

  const projectName = workspaceRoot ? path.basename(workspaceRoot) : 'No project open';
  const menu = {
    icon: buildTrayIconPng(),
    title: 'Event Horizon',
    tooltip: 'Event Horizon',
    items: [
      { title: 'Event Horizon',       tooltip: '', checked: false, enabled: false },
      { title: projectName,           tooltip: '', checked: false, enabled: false },
      { title: 'Open in Browser',     tooltip: '', checked: false, enabled: true },
      { title: 'Quit Event Horizon',  tooltip: '', checked: false, enabled: true },
    ],
  };

  // The Go tray binary sends {"type":"ready"} before it can accept the menu JSON.
  let lineBuf = '';
  let menuSent = false;
  trayProc.stdout!.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (!menuSent && evt.type === 'ready') {
          menuSent = true;
          trayProc.stdin!.write(JSON.stringify(menu) + '\n');
        } else if (evt.type === 'clicked') {
          const title: string = evt.item?.title || '';
          if (title === 'Open in Browser') openBrowser(`http://localhost:${port}`);
          else if (title === 'Quit Event Horizon') process.exit(0);
        }
      } catch {}
    }
  });

  trayProc.on('exit', () => { process.exit(0); });
  process.on('exit', () => { try { trayProc.kill(); } catch {} });
}

// ─── Server startup ───────────────────────────────────────────────────────────
async function startServer() {
  const PORT = await readPortConfig();
  const isPkg = (process as any).pkg !== undefined;

  app.listen(PORT, async () => {
    console.log(`Event Horizon Engine running on port ${PORT}`);
    if (PORTAL_DIST_EXISTS) {
      console.log(`Portal:   http://localhost:${PORT}`);
    }

    // Try to restore workspace: --workspace arg wins, then persisted settings.
    const cliWorkspace = getCliWorkspace();
    const settings = await loadAppSettings();
    const initial = cliWorkspace || settings.workspace || null;

    if (initial && existsSync(path.join(initial, '.flux'))) {
      await activateWorkspace(initial);
    } else if (initial) {
      console.warn(`Saved workspace not found: ${initial} — open the portal to select a folder.`);
    } else {
      console.log('No workspace configured. Open the portal to select your project folder.');
    }

    if (isPkg) {
      // Auto-open the browser after a short delay to let the engine fully bind.
      setTimeout(() => openBrowser(`http://localhost:${PORT}`), 800);
      // Start the system tray icon (non-fatal if it fails).
      initTray(PORT).catch(e => console.warn('Tray init failed:', e.message));
    }
  });
}

startServer().catch(err => {
  console.error('Failed to start Event Horizon:', err);
  process.exit(1);
});

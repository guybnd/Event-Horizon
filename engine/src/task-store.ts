import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import chokidar from 'chokidar';
import { getFluxDir, getFluxStoreDir, getActiveFluxDir, getTaskAssetsDir, setWorkspaceRoot, workspaceRoot, isOrphanMode } from './workspace.js';
import { attachWorktreeIfPresent } from './storage-sync.js';
import { startSyncWatcher } from './sync-watcher.js';
import { configCache, loadConfig, autoRegisterUnknownTags } from './config.js';
import { normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry, findEarliestHistoryDate } from './history.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { getCliSessionSummaryForTask } from './session-store.js';
import { isTopLevelTaskFile, getDocsDir, isDocFile, getDocPathFromFile, titleFromDocPath, slugifyDocValue, parseDocOrder } from './file-utils.js';
import type { StoredDoc } from './file-utils.js';
import { resolveEmbeddedDocsRoot, copyDir, buildStarterProjectOverview } from './docs-seeder.js';

export let tasksCache: Record<string, any> = {};
export let docsCache: Record<string, StoredDoc> = {};
export let parseErrors: Record<string, { id: string; path: string; error: string }> = {};
export let workspaceActivating = false;

export function serializeTaskForApi(task: any) {
  return {
    ...task,
    cliSession: getCliSessionSummaryForTask(task.id),
  };
}

export async function updateAgentSession(taskId: string, sessionId: string, updater: (session: any) => void) {
  const task = tasksCache[taskId];
  if (!task) return null;

  const { _path } = task;

  // Re-read the FULL file from disk to preserve any changes the agent made
  let frontmatter: any;
  let body: string;
  try {
    const rawFile = await fs.readFile(_path, 'utf-8');
    const parsed = matter(rawFile);
    const { content, data } = parsed;
    body = content || '';
    frontmatter = { ...data };
  } catch {
    // Fall back to cache if file read fails
    const { body: cachedBody, _path: _p, id: _id, ...cachedFm } = task;
    body = cachedBody || '';
    frontmatter = { ...cachedFm };
  }

  const history = frontmatter.history || [];
  const sessionIndex = history.findIndex((entry: any) => entry?.type === 'agent_session' && entry?.sessionId === sessionId);

  if (sessionIndex === -1) {
    console.warn(`updateAgentSession: session ${sessionId} not found in task ${taskId}`);
    return null;
  }

  // Apply the update function
  updater(history[sessionIndex]);
  frontmatter.history = history;
  frontmatter.updatedBy = 'Agent';

  const fileContent = matter.stringify(body, frontmatter);
  await fs.writeFile(_path, fileContent, 'utf-8');
  tasksCache[taskId] = { ...frontmatter, body, id: taskId, _path };
  return tasksCache[taskId];
}

export async function updateTaskWithHistory(taskId: string, options: {
  entries?: any[];
  updatedBy?: string;
  nextStatus?: string;
  tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated: boolean; cacheReadTokens?: number; cacheCreationTokens?: number };
}) {
  const task = tasksCache[taskId];
  if (!task) return null;

  const actor = options.updatedBy || task.updatedBy || 'Agent';
  const activityTimestamp = new Date().toISOString();
  const entries = Array.isArray(options.entries) ? [...options.entries] : [];
  const { _path } = task;

  // Re-read the FULL file from disk to preserve any changes the agent made
  let frontmatter: any;
  let body: string;
  try {
    const rawFile = await fs.readFile(_path, 'utf-8');
    const parsed = matter(rawFile);
    body = parsed.content || '';
    frontmatter = { ...parsed.data };
  } catch {
    // Fall back to cache if file read fails
    const { body: cachedBody, _path: _p, id: _id, ...cachedFm } = task;
    body = cachedBody || '';
    frontmatter = { ...cachedFm };
  }

  const normalizedExistingHistory = normalizeHistoryEntries(frontmatter.history || []);
  let nextHistory = ensureCreationActivity(
    normalizedExistingHistory.history,
    frontmatter.createdBy || actor,
    findEarliestHistoryDate(normalizedExistingHistory.history),
  ).history;

  if (options.nextStatus && frontmatter.status !== options.nextStatus) {
    entries.push({
      type: 'status_change',
      from: frontmatter.status,
      to: options.nextStatus,
      user: actor,
      date: activityTimestamp,
    });
    frontmatter.status = options.nextStatus;
  }

  nextHistory = normalizeHistoryEntries([...nextHistory, ...entries]).history;
  frontmatter.history = nextHistory;
  frontmatter.updatedBy = actor;

  if (options.tokenMetadata) {
    frontmatter.tokenMetadata = options.tokenMetadata;
  }

  const fileContent = matter.stringify(body || '', frontmatter);
  await fs.writeFile(_path, fileContent, 'utf-8');
  tasksCache[taskId] = { ...frontmatter, body, id: taskId, _path };
  return tasksCache[taskId];
}

/**
 * Detect inline subtask objects in a ticket's subtasks array and normalize them
 * into separate ticket files. Returns the normalized string[] of IDs if changes
 * were made, or null if no normalization needed.
 */
async function normalizeInlineSubtasks(frontmatter: any, parentPath: string): Promise<string[] | null> {
  const subtasks = frontmatter.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) return null;

  const hasInlineObjects = subtasks.some((entry: any) => typeof entry === 'object' && entry !== null && entry.id);
  if (!hasInlineObjects) return null;

  const fluxDir = path.dirname(parentPath);
  const parentId = frontmatter.id || path.basename(parentPath, '.md');
  const normalizedIds: string[] = [];
  const createdAt = new Date().toISOString();

  for (const entry of subtasks) {
    if (typeof entry === 'string') {
      normalizedIds.push(entry);
      continue;
    }

    if (typeof entry !== 'object' || !entry || !entry.id) continue;

    const childId = entry.id as string;
    const childPath = path.join(fluxDir, `${childId}.md`);

    // Don't overwrite existing ticket files
    try {
      await fs.access(childPath);
      // File exists — just use the ID reference
      normalizedIds.push(childId);
      continue;
    } catch {
      // File doesn't exist — create it
    }

    const childFrontmatter: any = {
      id: childId,
      title: entry.title || childId,
      status: entry.status || 'Todo',
      priority: entry.priority || 'None',
      effort: entry.effort || 'None',
      assignee: entry.assignee || 'unassigned',
      tags: entry.tags || [],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [
        { type: 'activity', user: 'Agent', date: createdAt, comment: `Auto-created from inline subtask of ${parentId}.` },
      ],
    };

    const childBody = entry.body || `Subtask of ${parentId}.\n`;
    const childContent = matter.stringify(childBody, childFrontmatter);

    try {
      await fs.writeFile(childPath, childContent, 'utf-8');
      console.log(`[subtasks] Auto-created ${childId} from inline subtask of ${parentId}`);
    } catch (err) {
      console.error(`[subtasks] Failed to create ${childId}:`, err);
    }

    normalizedIds.push(childId);
  }

  console.log(`[subtasks] Normalized ${parentId}: ${subtasks.length} entries → ${normalizedIds.length} string IDs`);
  return normalizedIds;
}

export async function loadTask(filePath: string) {
  if (!isTopLevelTaskFile(filePath)) return;

  try {
    const fileStats = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(content);
    } catch (yamlErr) {
      const msg = yamlErr instanceof Error ? yamlErr.message : String(yamlErr);
      console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  YAML frontmatter is invalid: ${msg}\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
      const id = path.basename(filePath, '.md');
      delete tasksCache[id];
      parseErrors[id] = { id, path: filePath, error: `YAML frontmatter is invalid: ${msg}` };
      return;
    }

    if (!parsed.data || !parsed.data['title']) {
      console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  Frontmatter is missing required field: title\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
      const id = path.basename(filePath, '.md');
      delete tasksCache[id];
      parseErrors[id] = { id, path: filePath, error: 'Frontmatter is missing required field: title' };
      return;
    }

    const id = parsed.data['id'] || path.basename(filePath, '.md');
    const normalizedHistory = normalizeHistoryEntries(parsed.data.history);
    const fallbackCreatedAt = fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();
    const { history } = ensureCreationActivity(
      normalizedHistory.history,
      parsed.data.createdBy || parsed.data.updatedBy || 'Unknown',
      fallbackCreatedAt,
    );
    const normalizedFrontmatter = { ...parsed.data, history };

    // Normalize inline subtask objects → create separate ticket files and convert to string IDs
    const subtasksNormalized = await normalizeInlineSubtasks(normalizedFrontmatter, filePath);

    if (subtasksNormalized) {
      normalizedFrontmatter.subtasks = subtasksNormalized;
    }

    const validationErrors = validateTicketFrontmatter(normalizedFrontmatter);
    if (validationErrors.length > 0) {
      const summary = formatValidationErrors(validationErrors);
      console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  Schema validation failed:\n${summary}\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
      delete tasksCache[id];
      parseErrors[id] = { id, path: filePath, error: `Schema validation failed:\n${summary}` };
      return;
    }

    tasksCache[id] = {
      ...normalizedFrontmatter,
      id,
      body: parsed.content,
      _path: filePath
    };

    // Clear any previous parse error for this ticket
    delete parseErrors[id];

    if (normalizedHistory.changed || subtasksNormalized) {
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

export async function loadDoc(filePath: string) {
  if (!isDocFile(filePath)) return;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const docPath = getDocPathFromFile(filePath);

    if (!docPath) return;

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

export async function loadDocsDirectory(directoryPath: string) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
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

export async function reconcileOrphanedSessions() {
  const now = new Date().toISOString();
  let recoveredCount = 0;

  for (const task of Object.values(tasksCache)) {
    const history: any[] = Array.isArray(task.history) ? task.history : [];

    // Find all active agent_session entries
    const activeSessions = history.filter(
      (e) => e.type === 'agent_session' && e.status === 'active'
    );

    for (const session of activeSessions) {
      // Close the orphaned session
      await updateAgentSession(task.id, session.sessionId, (sessionEntry) => {
        sessionEntry.status = 'cancelled';
        sessionEntry.outcome = 'Session abandoned (engine restarted).';
        sessionEntry.endedAt = now;
      });
      recoveredCount++;
      console.log(`Recovered orphaned session ${session.sessionId} in task ${task.id}`);
    }

    // Also check for old-style activity-based sessions (legacy compatibility)
    const lastLaunch = [...history].reverse().find(
      (e) => e.type === 'activity' && typeof e.comment === 'string' && /Launched .+ session \(/.test(e.comment)
    );
    if (!lastLaunch) continue;
    const launchIdx = history.lastIndexOf(lastLaunch);
    const hasEnd = history.slice(launchIdx + 1).some(
      (e) => (e.type === 'activity' && typeof e.comment === 'string' &&
        /session ended|session stopped|session failed|session lost/i.test(e.comment)) ||
        (e.type === 'agent_session')
    );
    if (!hasEnd) {
      await updateTaskWithHistory(task.id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry('Claude Code session lost (engine restarted).', 'Agent', now)],
      });
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    console.log(`Session recovery: closed ${recoveredCount} orphaned session(s)`);
  }
}

let MODEL_PRICING: Array<{ match: RegExp; inputPer1M: number; outputPer1M: number; modelName: string }> = [];
const DEFAULT_INPUT_PER_1M = 3;
const DEFAULT_OUTPUT_PER_1M = 15;

function parsePricingDoc(markdown: string) {
  const rows: Array<{ match: RegExp; inputPer1M: number; outputPer1M: number; modelName: string }> = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map(s => s.trim()).filter(Boolean);
    if (cells.length < 3) continue;
    const [model, inputStr, outputStr] = cells;
    if (!model || model.startsWith('-') || model.toLowerCase() === 'model') continue;
    const inputPer1M = parseFloat(inputStr!);
    const outputPer1M = parseFloat(outputStr!);
    if (isNaN(inputPer1M) || isNaN(outputPer1M)) continue;
    rows.push({ match: new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), inputPer1M, outputPer1M, modelName: model });
  }
  rows.sort((a, b) => b.modelName.length - a.modelName.length);
  return rows;
}

export async function loadPricingDoc() {
  try {
    const docPath = path.join(getDocsDir(), 'event-horizon', 'model-pricing.md');
    const content = await fs.readFile(docPath, 'utf-8');
    const parsed = matter(content);
    const rows = parsePricingDoc(parsed.content);
    if (rows.length > 0) {
      MODEL_PRICING = rows;
      console.log(`Loaded ${rows.length} pricing entries from model-pricing.md`);
    }
  } catch {
    // File not present — keep whatever is already loaded
  }
}

export function estimateCostUSD(modelHint: string | undefined, inputTokens: number, outputTokens: number): number {
  const pricing = modelHint ? MODEL_PRICING.find((p) => p.match.test(modelHint)) : null;
  const inputRate = pricing ? pricing.inputPer1M : DEFAULT_INPUT_PER_1M;
  const outputRate = pricing ? pricing.outputPer1M : DEFAULT_OUTPUT_PER_1M;
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

async function seedStarterDocs(docsDir: string): Promise<void> {
  const entries = await fs.readdir(docsDir).catch(() => [] as string[]);
  if (entries.length > 0) return;

  const projects: string[] = Array.isArray(configCache.projects) ? configCache.projects : [];
  const projectKey = projects[0]
    || path.basename(workspaceRoot || 'PROJECT').toUpperCase().replace(/[^A-Z0-9_-]/g, '')
    || 'PROJECT';

  const overviewFile = path.join(docsDir, 'project-overview.md');
  await fs.writeFile(overviewFile, buildStarterProjectOverview(projectKey), 'utf-8');

  const ehDocsSrc = path.join(resolveEmbeddedDocsRoot(), '.docs', 'event-horizon');
  const ehDocsDest = path.join(docsDir, 'event-horizon');
  try {
    await fs.access(ehDocsSrc);
    try {
      await fs.access(ehDocsDest);
    } catch {
      await copyDir(ehDocsSrc, ehDocsDest);
    }
  } catch (err) {
    console.warn(`[FLUX] Failed to copy EH guide docs to ${ehDocsDest}:`, err);
  }
}

export async function initDir() {
  try {
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
    await fs.mkdir(getDocsDir(), { recursive: true });
    await fs.mkdir(getTaskAssetsDir(), { recursive: true });
    await seedStarterDocs(getDocsDir());
    await loadDocsDirectory(getDocsDir());
  } catch {
    // ignore
  }
  await loadConfig();
  await loadPricingDoc();
  const activeDir = getActiveFluxDir();
  const fluxFiles = await fs.readdir(activeDir).catch(() => [] as string[]);
  for (const name of fluxFiles) {
    if (isTopLevelTaskFile(path.join(activeDir, name))) {
      await loadTask(path.join(activeDir, name));
    }
  }
}

let activeFluxWatcher: ReturnType<typeof chokidar.watch> | null = null;
let activeDocsWatcher: ReturnType<typeof chokidar.watch> | null = null;

export async function startWatchers() {
  if (activeFluxWatcher) { await activeFluxWatcher.close(); activeFluxWatcher = null; }
  if (activeDocsWatcher) { await activeDocsWatcher.close(); activeDocsWatcher = null; }

  const fluxDir = getActiveFluxDir();
  const configFile = path.join(fluxDir, 'config.json');

  activeFluxWatcher = chokidar.watch(fluxDir, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      return basename.startsWith('.') && basename !== path.basename(getActiveFluxDir());
    },
    persistent: true,
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
    .on('ready', () => { void reconcileOrphanedSessions(); })
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
    persistent: true,
  });

  activeDocsWatcher
    .on('add', (filePath) => { if (isDocFile(filePath)) { void loadDoc(filePath); void loadPricingDoc(); } })
    .on('change', (filePath) => { if (isDocFile(filePath)) { void loadDoc(filePath); void loadPricingDoc(); } })
    .on('unlink', (filePath) => {
      const docPath = getDocPathFromFile(filePath);
      if (docPath) { delete docsCache[docPath]; console.log(`Removed doc: ${docPath}`); }
    });
}

async function recoverStrayFluxFiles(newRoot: string): Promise<void> {
  const fluxDir = path.join(newRoot, '.flux');
  const storeDir = getFluxStoreDir();
  let stray: string[] = [];
  try { stray = await fs.readdir(fluxDir); } catch { return; }
  for (const name of stray) {
    if (!name.endsWith('.md')) continue;
    const src = path.join(fluxDir, name);
    const dst = path.join(storeDir, name);
    try { await fs.access(dst); continue; } catch { /* not in store yet */ }
    try {
      const content = await fs.readFile(src, 'utf-8');
      const parsed = matter(content);
      if (!parsed.data || !parsed.data['title'] || !parsed.data['id']) continue;
    } catch { continue; }
    await fs.copyFile(src, dst);
    console.log(`[storage-sync] Recovered stray ticket: ${name}`);
  }
}

export async function activateWorkspace(newRoot: string) {
  workspaceActivating = true;
  try {
    setWorkspaceRoot(newRoot);
    tasksCache = {};
    docsCache = {};
    parseErrors = {};
    console.log(`Workspace: ${newRoot}`);
    await attachWorktreeIfPresent(newRoot);
    if (isOrphanMode()) await recoverStrayFluxFiles(newRoot);
    await initDir();
    await startWatchers();
    startSyncWatcher();
  } finally {
    workspaceActivating = false;
  }
}

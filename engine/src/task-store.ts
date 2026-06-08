import fs from 'fs/promises';
import { renameSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import chokidar from 'chokidar';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getActiveFluxDir, getTaskAssetsDir, getFluxStoreDir, isOrphanMode, setWorkspaceRoot, workspaceRoot, getWorkspacesList } from './workspace.js';
import { attachWorktreeIfPresent, migrateStrandedFluxTickets } from './storage-sync.js';
import { startSyncWatcher } from './sync-watcher.js';
import { configCache, loadConfig, autoRegisterUnknownTags } from './config.js';
import { loadCustomPersonas } from './orchestration-personas.js';
import { normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry, findEarliestHistoryDate, getHistoryTimestamp } from './history.js';
import { generatePromptNotification, generateCompletionNotification, clearNotifications, checkSkillStaleness } from './notifications.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { broadcastEvent } from './events.js';
import { getCliSessionSummaryForTask, getAllSessionSummariesForTask, getListSessionSummariesForTask, cliSessionsById, cliSessionIdByTaskId } from './session-store.js';
import { isTopLevelTaskFile, getDocsDir, isDocFile, getDocPathFromFile, titleFromDocPath, slugifyDocValue, parseDocOrder } from './file-utils.js';
import type { StoredDoc } from './file-utils.js';
import { resolveEmbeddedDocsRoot, copyDir, buildStarterProjectOverview } from './docs-seeder.js';
import { bootstrapNewWorkspace, installSkillsForWorkspace } from './bootstrap.js';
import { activateGroup, activateMemberBinding, getGroupContext, getMemberBinding, activeGroupDocsLabel } from './group.js';

export let tasksCache: Record<string, any> = {};
export let docsCache: Record<string, StoredDoc> = {};
export let parseErrors: Record<string, { id: string; path: string; error: string }> = {};
export let workspaceActivating = false;

const repairingPaths = new Set<string>();

/**
 * Write file atomically: write to a .tmp sibling then rename over the target.
 * Prevents partial/empty reads when another async operation reads mid-write.
 * Falls back to direct write if rename fails (e.g., cross-device).
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp';
  await fs.writeFile(tmpPath, content, 'utf-8');
  try {
    renameSync(tmpPath, filePath);
  } catch {
    // rename can fail on some FS setups; fall back to direct write
    await fs.writeFile(filePath, content, 'utf-8');
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export function serializeTaskForApi(task: any) {
  const cliSessions = getAllSessionSummariesForTask(task.id);
  return {
    ...task,
    cliSession: getCliSessionSummaryForTask(task.id),
    cliSessions: cliSessions.length > 0 ? cliSessions : undefined,
  };
}

/**
 * List-endpoint serializer. Like {@link serializeTaskForApi} but attaches a
 * capped `cliSessions[]` (active sessions + most-recent completed group, with
 * truncated `liveOutput`) so `GET /api/tasks` payload doesn't grow with session
 * history. The detail endpoint keeps {@link serializeTaskForApi}.
 */
export function serializeTaskForList(task: any) {
  const cliSessions = getListSessionSummariesForTask(task.id);
  return {
    ...task,
    cliSession: getCliSessionSummaryForTask(task.id),
    cliSessions: cliSessions.length > 0 ? cliSessions : undefined,
  };
}

export async function readTaskFromDisk(task: any): Promise<{ frontmatter: any; body: string }> {
  const fallbackFromCache = () => {
    const { body: cachedBody, _path: _p, id: _id, ...cachedFm } = task;
    return { frontmatter: { ...cachedFm }, body: cachedBody || '' };
  };

  try {
    const rawFile = await fs.readFile(task._path, 'utf-8');
    if (!rawFile || !rawFile.trim()) {
      console.warn(`[readTaskFromDisk] Empty file read for ${task.id}, using cache`);
      return fallbackFromCache();
    }
    const parsed = matter(rawFile);
    // Guard: if the file lost its title, it's a partial/corrupt read — use cache
    if (!parsed.data.title && task.title) {
      console.warn(`[readTaskFromDisk] Corrupt read for ${task.id} (missing title), using cache`);
      return fallbackFromCache();
    }
    return { frontmatter: { ...parsed.data }, body: parsed.content || '' };
  } catch {
    return fallbackFromCache();
  }
}

function recoverSessionEntry(taskId: string, sessionId: string, task: any): any | null {
  const liveSessionId = cliSessionIdByTaskId.get(taskId);
  const liveSession = liveSessionId ? cliSessionsById.get(liveSessionId) : undefined;
  if (liveSession?.sessionHistoryEntry?.sessionId === sessionId) {
    console.log(`updateAgentSession: re-injected session ${sessionId} (agent dropped it from file)`);
    return { ...liveSession.sessionHistoryEntry };
  }

  const cachedHistory: any[] = Array.isArray(task.history) ? task.history : [];
  const cachedEntry = cachedHistory.find((e: any) => e?.type === 'agent_session' && e?.sessionId === sessionId);
  if (cachedEntry) {
    console.log(`updateAgentSession: re-injected session ${sessionId} from cache`);
    return { ...cachedEntry };
  }

  return null;
}

export async function updateAgentSession(taskId: string, sessionId: string, updater: (session: any) => void) {
  const task = tasksCache[taskId];
  if (!task) return null;

  const { frontmatter, body } = await readTaskFromDisk(task);
  const history = frontmatter.history || [];
  let sessionIndex = history.findIndex((entry: any) => entry?.type === 'agent_session' && entry?.sessionId === sessionId);

  if (sessionIndex === -1) {
    const recovered = recoverSessionEntry(taskId, sessionId, task);
    if (!recovered) {
      console.warn(`updateAgentSession: session ${sessionId} not found in task ${taskId} (not recoverable)`);
      return null;
    }
    history.push(recovered);
    sessionIndex = history.length - 1;
  }

  updater(history[sessionIndex]);
  frontmatter.history = history;
  frontmatter.updatedBy = 'Agent';

  const fileContent = matter.stringify(body, frontmatter);
  await atomicWriteFile(task._path, fileContent);
  tasksCache[taskId] = { ...frontmatter, body, id: taskId, _path: task._path };
  return tasksCache[taskId];
}

export async function updateTaskWithHistory(taskId: string, options: {
  entries?: any[];
  updatedBy?: string;
  nextStatus?: string;
  extraFields?: Record<string, any>;
  tokenMetadata?: { inputTokens: number; outputTokens: number; costUSD: number; costIsEstimated: boolean; cacheReadTokens?: number; cacheCreationTokens?: number };
}) {
  const task = tasksCache[taskId];
  if (!task) return null;

  const actor = options.updatedBy || task.updatedBy || 'Agent';
  const activityTimestamp = new Date().toISOString();
  const entries = Array.isArray(options.entries) ? [...options.entries] : [];
  const { _path } = task;

  const { frontmatter, body } = await readTaskFromDisk(task);

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

  if (options.extraFields) {
    const { id: _i, title: _t, history: _h, _path: _pp, ...safeFields } = options.extraFields;
    Object.assign(frontmatter, safeFields);
  }

  if (options.tokenMetadata) {
    frontmatter.tokenMetadata = options.tokenMetadata;
  }

  // Ensure id is present — some tickets derive it from filename rather than frontmatter
  if (!frontmatter.id) frontmatter.id = taskId;

  if (!frontmatter.title) {
    console.error(`[FLUX] Refusing to write ${_path}: missing title in frontmatter. This indicates a bug or race condition.`);
    return null;
  }

  const fileContent = matter.stringify(body || '', frontmatter);
  await atomicWriteFile(_path, fileContent);
  tasksCache[taskId] = { ...frontmatter, body, id: taskId, _path };

  if (options.nextStatus) {
    const requireInputStatus = configCache.requireInputStatus || 'Require Input';
    const readyStatus = configCache.readyForMergeStatus || 'Ready';
    if (options.nextStatus === requireInputStatus || options.nextStatus === readyStatus) {
      generatePromptNotification(taskId, frontmatter.title || taskId, options.nextStatus);
    } else if (options.nextStatus === 'Done') {
      generateCompletionNotification(taskId, frontmatter.title || taskId);
    }
  }

  return tasksCache[taskId];
}

export interface CreateTaskOptions {
  title: string;
  status?: string;
  priority?: string;
  effort?: string;
  assignee?: string;
  tags?: string[];
  body?: string | undefined;
  author?: string;
  projectKey?: string;
}

export interface CreateTaskResult {
  id: string;
  task: any;
}

const execFileAsync = promisify(execFile);

async function getMaxIdFromRemote(projectKey: string): Promise<number> {
  if (!isOrphanMode()) return 0;

  const storeDir = getFluxStoreDir();
  try {
    await execFileAsync('git', ['-C', storeDir, 'fetch', 'origin', 'flux-data'], { windowsHide: true });
    const { stdout } = await execFileAsync('git', [
      '-C', storeDir, 'ls-tree', '-r', '--name-only', 'origin/flux-data'
    ], { windowsHide: true });

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
    console.warn(`[tasks] Could not check remote for max ticket ID: ${err.message}`);
    return 0;
  }
}

export async function createTask(options: CreateTaskOptions): Promise<CreateTaskResult> {
  const pKey = options.projectKey || configCache.projects?.[0] || 'PROJECT';
  let maxId = 0;
  Object.keys(tasksCache).forEach((key) => {
    if (key.startsWith(`${pKey}-`)) {
      const num = parseInt(key.replace(`${pKey}-`, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }
  });

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
  const actor = options.author || 'Unknown';

  const normalizedHistory = normalizeHistoryEntries([]);
  const historyWithCreation = ensureCreationActivity(normalizedHistory.history, actor, createdAt);

  const frontmatter: any = {
    id: nextId,
    title: options.title || 'New Task',
    status: options.status || 'Todo',
    priority: options.priority || 'None',
    effort: options.effort || 'None',
    assignee: options.assignee || 'unassigned',
    tags: options.tags || [],
    createdBy: actor,
    updatedBy: actor,
    history: historyWithCreation.history,
  };

  const validationErrors = validateTicketFrontmatter(frontmatter);
  if (validationErrors.length > 0) {
    throw new Error(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`);
  }

  if (frontmatter.tags.length > 0) {
    await autoRegisterUnknownTags(frontmatter.tags);
  }

  const body = options.body || '';
  const fileContent = matter.stringify(body, frontmatter);
  await atomicWriteFile(filePath, fileContent);
  tasksCache[nextId] = { ...frontmatter, body, id: nextId, _path: filePath };
  broadcastEvent('taskCreated', { id: nextId });

  return { id: nextId, task: tasksCache[nextId] };
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
      await atomicWriteFile(childPath, childContent);
      console.log(`[subtasks] Auto-created ${childId} from inline subtask of ${parentId}`);
    } catch (err) {
      console.error(`[subtasks] Failed to create ${childId}:`, err);
    }

    normalizedIds.push(childId);
  }

  console.log(`[subtasks] Normalized ${parentId}: ${subtasks.length} entries → ${normalizedIds.length} string IDs`);
  return normalizedIds;
}

/**
 * Attempt to repair common schema violations in-place before validation.
 * Returns a list of repairs made, or empty array if nothing was fixed.
 */
function repairTicket(frontmatter: any, filePath: string): string[] {
  const repairs: string[] = [];

  // Missing title → derive from filename
  if (!frontmatter.title || (typeof frontmatter.title === 'string' && !frontmatter.title.trim())) {
    const derived = path.basename(filePath, '.md');
    frontmatter.title = `${derived} (recovered)`;
    repairs.push(`Recovered missing title from filename → "${frontmatter.title}"`);
  }

  // Repair history entries
  if (Array.isArray(frontmatter.history)) {
    for (let i = 0; i < frontmatter.history.length; i++) {
      const entry = frontmatter.history[i];
      if (!entry || typeof entry !== 'object') continue;

      // oldStatus/newStatus → from/to
      if (entry.type === 'status_change') {
        if (entry.from == null && typeof entry.oldStatus === 'string') {
          entry.from = entry.oldStatus;
          delete entry.oldStatus;
          repairs.push(`history[${i}]: renamed oldStatus → from`);
        }
        if (entry.to == null && typeof entry.newStatus === 'string') {
          entry.to = entry.newStatus;
          delete entry.newStatus;
          repairs.push(`history[${i}]: renamed newStatus → to`);
        }
      }

      // Infer missing type from entry shape
      if (!entry.type || typeof entry.type !== 'string') {
        if (typeof entry.from === 'string' && typeof entry.to === 'string') {
          entry.type = 'status_change';
          repairs.push(`history[${i}]: inferred type "status_change" from from/to fields`);
        } else if (typeof entry.oldStatus === 'string' && typeof entry.newStatus === 'string') {
          entry.type = 'status_change';
          entry.from = entry.oldStatus;
          entry.to = entry.newStatus;
          delete entry.oldStatus;
          delete entry.newStatus;
          repairs.push(`history[${i}]: inferred type "status_change", renamed oldStatus/newStatus → from/to`);
        } else if (typeof entry.comment === 'string' && entry.comment.trim()) {
          entry.type = 'comment';
          repairs.push(`history[${i}]: inferred type "comment" from comment field`);
        } else if (typeof entry.sessionId === 'string') {
          entry.type = 'agent_session';
          repairs.push(`history[${i}]: inferred type "agent_session" from sessionId field`);
        }
      }

      // Fix malformed dates
      if (entry.date && typeof entry.date === 'string') {
        const parsed = new Date(entry.date);
        if (Number.isNaN(parsed.getTime())) {
          const relaxed = new Date(entry.date.replace(/[^\d\-T:.Z+]/g, ''));
          const relaxedYear = relaxed.getFullYear();
          if (!Number.isNaN(relaxed.getTime()) && relaxedYear >= 2020 && relaxedYear <= 2030) {
            entry.date = relaxed.toISOString();
            repairs.push(`history[${i}]: repaired malformed date`);
          } else {
            entry.date = new Date().toISOString();
            repairs.push(`history[${i}]: replaced unparseable date with current timestamp`);
          }
        }
      } else if (!entry.date) {
        entry.date = new Date().toISOString();
        repairs.push(`history[${i}]: added missing date`);
      }

      // Ensure user field
      if (!entry.user || typeof entry.user !== 'string') {
        entry.user = 'Unknown';
        repairs.push(`history[${i}]: set missing user to "Unknown"`);
      }
    }
  }

  // subtasks containing inline objects with id → extract to string array
  if (Array.isArray(frontmatter.subtasks)) {
    let subtasksRepaired = false;
    frontmatter.subtasks = frontmatter.subtasks
      .map((entry: any) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
          subtasksRepaired = true;
          return entry.id;
        }
        return null;
      })
      .filter((entry: any) => entry != null);
    if (subtasksRepaired) {
      repairs.push('Normalized inline subtask objects to string IDs');
    }
  }

  return repairs;
}

export async function loadTask(filePath: string) {
  if (!isTopLevelTaskFile(filePath)) return;
  if (repairingPaths.has(filePath)) return;

  try {
    const fileStats = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');

    // Guard: empty/truncated file is a sign of a partial write in progress — skip
    if (!content || !content.trim()) {
      console.warn(`[loadTask] Ignoring empty file: ${filePath}`);
      return;
    }

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

    // Guard: if we already have this ticket cached with a title but the incoming
    // file lost it (and other critical fields), this is a corrupt/partial write —
    // ignore it rather than repairing it into a "(recovered)" zombie.
    const existingId = parsed.data.id || path.basename(filePath, '.md');
    const existingCached = tasksCache[existingId];
    if (existingCached && existingCached.title && !parsed.data.title && !parsed.data.status) {
      console.warn(`[loadTask] Ignoring corrupt write for ${existingId}: file lost title+status while cache has "${existingCached.title}". Likely a partial write or unauthorized direct edit.`);
      return;
    }

    // Validate first; only attempt repair if validation fails
    const initialErrors = validateTicketFrontmatter(parsed.data);
    if (initialErrors.length > 0) {
      const repairs = repairTicket(parsed.data, filePath);
      if (repairs.length > 0) {
        console.log(`[FLUX AUTO-REPAIR] ${filePath}\n  ${repairs.join('\n  ')}`);
        if (!Array.isArray(parsed.data.history)) parsed.data.history = [];
        parsed.data.history.push({
          type: 'activity',
          user: 'System',
          date: new Date().toISOString(),
          comment: `Auto-repaired ticket: ${repairs.join('; ')}`,
        });
        repairingPaths.add(filePath);
        try {
          const repairedContent = matter.stringify(parsed.content, parsed.data);
          await atomicWriteFile(filePath, repairedContent);
        } finally {
          repairingPaths.delete(filePath);
        }
      }

      // Re-validate after repair
      const postRepairErrors = validateTicketFrontmatter(parsed.data);
      if (postRepairErrors.length > 0) {
        const summary = formatValidationErrors(postRepairErrors);
        console.error(`\n[FLUX VALIDATION ERROR] ${filePath}\n  Schema validation failed (auto-repair insufficient):\n${summary}\n  The ticket has been removed from the board. Fix the frontmatter and save again.\n`);
        const id = path.basename(filePath, '.md');
        delete tasksCache[id];
        parseErrors[id] = { id, path: filePath, error: `Schema validation failed (auto-repair attempted but insufficient):\n${summary}` };
        return;
      }
    }

    const id = parsed.data['id'] || path.basename(filePath, '.md');
    const normalizedHistory = normalizeHistoryEntries(parsed.data.history);
    const fallbackCreatedAt = fileStats.birthtimeMs > 0 ? fileStats.birthtime.toISOString() : fileStats.mtime.toISOString();
    const { history } = ensureCreationActivity(
      normalizedHistory.history,
      parsed.data.createdBy || parsed.data.updatedBy || 'Unknown',
      fallbackCreatedAt,
    );
    // Protect engine-owned history entries (agent_session, comments) from being
    // dropped when a spawned agent rewrites the ticket file. The agent only knows
    // about a subset of entry types and may silently discard the rest.
    let historyReinjected = false;
    const existingTask = tasksCache[id];
    if (existingTask && Array.isArray(existingTask.history)) {
      const fileSessionIds = new Set(
        history.filter((e: any) => e?.type === 'agent_session').map((e: any) => e.sessionId)
      );
      const fileCommentIds = new Set(
        history.filter((e: any) => e?.type === 'comment' && e?.id).map((e: any) => e.id)
      );
      const missingEntries: any[] = [];
      for (const entry of existingTask.history) {
        if (entry?.type === 'agent_session' && !fileSessionIds.has(entry.sessionId)) {
          missingEntries.push(entry);
        } else if (entry?.type === 'comment' && entry?.id && !fileCommentIds.has(entry.id)) {
          missingEntries.push(entry);
        }
      }
      if (missingEntries.length > 0) {
        history.push(...missingEntries);
        history.sort((a: any, b: any) => getHistoryTimestamp(a) - getHistoryTimestamp(b));
        historyReinjected = true;
        console.log(`[${id}] Re-injected ${missingEntries.length} history entries dropped by agent`);
      }
    }

    const normalizedFrontmatter: any = { ...parsed.data, history };

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

    if (normalizedHistory.changed || subtasksNormalized || historyReinjected) {
      const normalizedContent = matter.stringify(parsed.content, normalizedFrontmatter);
      await atomicWriteFile(filePath, normalizedContent);
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

// ─── Group docs (.flux-group) surfaced read-only under the Product prefix ──────

/** Map a `.flux-group` markdown file to its synthetic `Product/...` doc path. */
function groupDocPathFromFile(storeDir: string, filePath: string): string | null {
  const relative = path.relative(storeDir, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..') || !relative.toLowerCase().endsWith('.md')) return null;
  const withoutExt = relative.slice(0, -3);
  const segments = withoutExt.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return null;
  return [activeGroupDocsLabel(), ...segments].join('/');
}

/** Load a single group doc into the cache as a read-only Product entry. */
export async function loadGroupDoc(storeDir: string, filePath: string) {
  const docPath = groupDocPathFromFile(storeDir, filePath);
  if (!docPath) return;
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = matter(content);
    const title = typeof parsed.data.title === 'string' && parsed.data.title.trim()
      ? parsed.data.title.trim()
      : titleFromDocPath(docPath);
    const order = parseDocOrder(parsed.data.order);
    const directory = docPath.slice(0, docPath.lastIndexOf('/'));
    const slugSource = docPath.split('/').filter(Boolean).pop() || docPath;

    docsCache[docPath] = {
      path: docPath,
      title,
      body: parsed.content.replace(/\r\n/g, '\n'),
      slug: slugifyDocValue(slugSource),
      directory,
      ...(order !== undefined ? { order } : {}),
      // The parent owns the canonical store, so it edits its own group docs
      // inline (FLUX-414); a bound member keeps them read-only and routes edits
      // to the parent's writer.
      readOnly: getGroupContext() == null,
      group: true,
      _path: filePath,
    };
  } catch (error) {
    console.error(`Failed to load group doc ${filePath}:`, error);
  }
}

/** Walk the `.flux-group` store and load every markdown file read-only. */
async function loadGroupDocsDirectory(storeDir: string, directoryPath: string) {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip .git and dotfiles
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await loadGroupDocsDirectory(storeDir, entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        await loadGroupDoc(storeDir, entryPath);
      }
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error(`Failed to read group docs directory ${directoryPath}:`, error);
    }
  }
}

/**
 * The `.flux-group` store dir to surface read-only `Product/` docs from, or null
 * when neither a direct group (parent) nor a member binding is active. A parent
 * reads its own store; a bound member (Case 1) reads the parent's store in place.
 */
function activeGroupStoreDir(): string | null {
  return getGroupContext()?.groupStoreDir ?? getMemberBinding()?.parentGroup.groupStoreDir ?? null;
}

/** Load all group docs for the active group. No-op in single-repo mode. */
export async function loadGroupDocs() {
  const storeDir = activeGroupStoreDir();
  if (!storeDir) return;
  await loadGroupDocsDirectory(storeDir, storeDir);
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
  await loadCustomPersonas();
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
let activeGroupDocsWatcher: ReturnType<typeof chokidar.watch> | null = null;

export async function startWatchers() {
  if (activeFluxWatcher) { await activeFluxWatcher.close(); activeFluxWatcher = null; }
  if (activeDocsWatcher) { await activeDocsWatcher.close(); activeDocsWatcher = null; }
  if (activeGroupDocsWatcher) { await activeGroupDocsWatcher.close(); activeGroupDocsWatcher = null; }

  const fluxDir = getActiveFluxDir();
  const configFile = path.join(fluxDir, 'config.json');

  activeFluxWatcher = chokidar.watch(fluxDir, {
    ignored: (filePath: string) => {
      const basename = path.basename(filePath);
      if (basename.endsWith('.tmp')) return true;
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

/**
 * Watch the active group's `.flux-group` store so Product docs refresh after a
 * fan-out / mapping run. No-op in single-repo mode. Called after activateGroup.
 */
export async function startGroupDocsWatcher() {
  if (activeGroupDocsWatcher) { await activeGroupDocsWatcher.close(); activeGroupDocsWatcher = null; }
  const storeDir = activeGroupStoreDir();
  if (!storeDir) return;

  activeGroupDocsWatcher = chokidar.watch(storeDir, {
    ignored: (filePath: string) => path.basename(filePath) === '.git',
    ignoreInitial: true,
    persistent: true,
  });

  const reload = (filePath: string) => {
    if (filePath.toLowerCase().endsWith('.md')) void loadGroupDoc(storeDir, filePath);
  };
  activeGroupDocsWatcher
    .on('add', reload)
    .on('change', reload)
    .on('unlink', (filePath) => {
      const docPath = groupDocPathFromFile(storeDir, filePath);
      if (docPath) { delete docsCache[docPath]; console.log(`Removed group doc: ${docPath}`); }
    });
}


export async function activateWorkspace(newRoot: string) {
  workspaceActivating = true;
  try {
    setWorkspaceRoot(newRoot);
    tasksCache = {};
    docsCache = {};
    parseErrors = {};
    clearNotifications();
    console.log(`Workspace: ${newRoot}`);
    await bootstrapNewWorkspace();
    await attachWorktreeIfPresent(newRoot);
    await migrateStrandedFluxTickets(newRoot);
    await initDir();
    await installSkillsForWorkspace();
    await startWatchers();
    startSyncWatcher();
    await activateGroup(newRoot);
    await activateMemberBinding(newRoot, (await getWorkspacesList()).map((w) => w.path));
    await loadGroupDocs();
    await startGroupDocsWatcher();
    seedPromptNotifications();
  } finally {
    workspaceActivating = false;
  }
}

function seedPromptNotifications() {
  const requireInputStatus = configCache.requireInputStatus || 'Require Input';
  const readyStatus = configCache.readyForMergeStatus || 'Ready';
  for (const task of Object.values(tasksCache)) {
    if (task.status === requireInputStatus || task.status === readyStatus) {
      generatePromptNotification(task.id, task.title || task.id, task.status);
    }
  }
  // Check if installed agent skills match source version
  checkSkillStaleness('auto').catch(() => {});
}

import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { existsSync } from 'fs';
import { getFluxDir, getActiveFluxDir, getTaskAssetsDir, workspaceRoot } from '../workspace.js';
import { configCache, autoRegisterUnknownTags } from '../config.js';
import {
  normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry,
  summarizeFieldChanges, hasAppendedStatusChange, findEarliestHistoryDate,
} from '../history.js';
import { tasksCache, serializeTaskForApi, serializeTaskForAgent, serializeTaskForList, updateTaskWithHistory, upsertManagedTicket, workspaceActivating, parseErrors, atomicWriteFile, createTask } from '../task-store.js';
import { generatePromptNotification, generateCompletionNotification } from '../notifications.js';
import { validateTicketFrontmatter, formatValidationErrors } from '../schema.js';
import {
  resolveSupportedImageExtension, sanitizeAssetBaseName, normalizeBase64Content,
  normalizeRelativePath, encodeAssetPath, createUniqueAssetFileName,
} from '../file-utils.js';
import { cliSessionIdByTaskId, cliSessionsById, stopAllSessionsForTask, getActiveSessionsForTask } from '../session-store.js';
import { getAdapter } from '../agents/index.js';
import { computeAgentPayloadMetrics } from '../agent-payload-metrics.js';
import { computeContextBudget } from '../context-budget-metrics.js';
import { probeAllMcpSchemas } from '../mcp-schema-probe.js';
import { getEffectiveSpawnServers } from '../agents/claude-code.js';
import { diffFilesForBranch } from '../diff-aggregator.js';
import { selectMembers, sharedNonDoneSiblings } from '../pr-tickets.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Object.values(tasksCache).map(serializeTaskForList));
});

router.get('/errors', (req, res) => {
  res.json(Object.values(parseErrors));
});

// List active task worktrees (FLUX-516). Registered before /:id so the literal
// path wins. Maps each worktree to the ticket whose branch it holds (if any).
router.get('/worktrees', async (_req, res) => {
  try {
    const worktrees = await listTaskWorktrees(workspaceRoot!);
    const result = await Promise.all(
      worktrees.map(async (w) => {
        const ticket = Object.values(tasksCache).find((t: any) => t.branch === w.branch) as any;
        // Changed-file count vs master — drives the board chip's "N changed" badge.
        const changedFiles = await worktreeChangeCount(w.path).catch(() => 0);
        return {
          path: w.path,
          branch: w.branch,
          ticketId: ticket?.id ?? null,
          ticketTitle: ticket?.title ?? null,
          changedFiles,
        };
      }),
    );
    res.json({ worktrees: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Count of uncommitted files in the active workspace — working tree vs HEAD
// (tracked changes) plus untracked. Powers the board header "uncommitted
// changes" stoplight (FLUX-535). Registered before /:id so the literal path
// wins. Best-effort: 0 when not a git repo or git errors (worktreeChangeCount
// already swallows those).
router.get('/uncommitted-count', async (_req, res) => {
  if (!workspaceRoot) return res.json({ count: 0, branch: null });
  const [mainCount, branch, worktrees] = await Promise.all([
    worktreeChangeCount(workspaceRoot, 'HEAD').catch(() => 0),
    currentBranchName(workspaceRoot).catch(() => null),
    listTaskWorktrees(workspaceRoot).catch(() => [] as Array<{ path: string }>),
  ]);
  // Aggregate uncommitted work across EVERY active task worktree too, not just the main
  // tree — otherwise the badge reads 0 while 20+ files sit uncommitted in a worktree.
  const wtCounts = await Promise.all(
    worktrees.map((w) => worktreeChangeCount(w.path, 'HEAD').catch(() => 0)),
  );
  const count = mainCount + wtCounts.reduce((sum, n) => sum + n, 0);
  res.json({ count, branch });
});

// Open the active workspace root in a new VS Code window (FLUX-544). Best-effort:
// `opened` is false when the `code` CLI isn't on PATH (the portal surfaces that).
router.post('/open-editor', async (req, res) => {
  if (!workspaceRoot) return res.json({ opened: false });
  const available = await isEditorAvailable();
  if (!available) return res.json({ opened: false });
  const file = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : '';
  if (file) {
    // Repo-relative only — reject absolute / traversal paths before joining.
    if (file.startsWith('/') || file.includes('..') || /^[a-zA-Z]:/.test(file)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    // A worktree ref (branch) opens the file in that worktree's checkout;
    // 'main'/empty opens it in the engine workspace root.
    let root = workspaceRoot;
    if (ref && ref !== 'main') {
      const wt = await findWorktreeForBranch(workspaceRoot, ref).catch(() => null);
      if (wt) root = wt;
    }
    openEditorFile(path.join(root, file));
  } else {
    openEditorWindow(workspaceRoot);
  }
  res.json({ opened: true });
});

// Commit selected uncommitted files from the board panel (FLUX-554). Commit-ONLY —
// never pushes. Pathspec-scoped so only the listed files are committed even if the
// index held other staged changes. `ref` picks the checkout: 'main'/omitted →
// workspace root; a branch → that branch's worktree.
router.post('/commit', async (req, res) => {
  if (!workspaceRoot) return res.status(400).json({ error: 'No active workspace' });
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim() : 'main';
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const files: string[] = Array.isArray(req.body?.files)
    ? req.body.files.filter((f: any) => typeof f === 'string' && f.trim()).map((f: string) => f.trim())
    : [];
  if (!message) return res.status(400).json({ error: 'Commit message is required' });
  if (files.length === 0) return res.status(400).json({ error: 'No files selected' });
  for (const f of files) {
    if (f.startsWith('/') || f.includes('..') || /^[a-zA-Z]:/.test(f)) {
      return res.status(400).json({ error: `Invalid path: ${f}` });
    }
  }
  let root = workspaceRoot;
  if (ref && ref !== 'main') {
    const wt = await findWorktreeForBranch(workspaceRoot, ref).catch(() => null);
    if (wt) root = wt;
  }
  try {
    // Stage the selected paths (covers untracked + deletions), then commit only them.
    await execFileAsync('git', ['-C', root, 'add', '--', ...files], { windowsHide: true });
    await execFileAsync('git', ['-C', root, 'commit', '-m', message, '--', ...files], { windowsHide: true });
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { windowsHide: true });
    res.json({ hash: stdout.trim() });
  } catch (err: any) {
    const detail = (err?.stderr || err?.message || 'Commit failed').toString().trim();
    res.status(500).json({ error: detail });
  }
});

// Local branch names + whether each currently holds a worktree — powers the
// "Attach to branch" picker (FLUX-516). Registered before /:id so the literal
// path wins.
router.get('/branches', async (_req, res) => {
  try {
    const [names, worktrees] = await Promise.all([
      listLocalBranches(workspaceRoot!),
      listTaskWorktrees(workspaceRoot!),
    ]);
    const worktreeBranches = new Set(worktrees.map((w) => w.branch));
    const ticketBranches = new Set(
      Object.values(tasksCache).map((t: any) => t.branch).filter(Boolean),
    );
    res.json({
      branches: names.map((name) => ({
        name,
        hasWorktree: worktreeBranches.has(name),
        isTicketBranch: ticketBranches.has(name),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Debug-only: spawn each module MCP server EH injects (serena, context7, …),
// list its tools, and measure per-server tool-schema cost. On-demand (slow —
// it starts real servers). Registered before /:id so the literal path wins.
router.get('/debug/mcp-schemas', async (req, res) => {
  try {
    res.json(await probeAllMcpSchemas());
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to probe MCP schemas' });
  }
});

// Debug-only: the effective MCP server set per phase (FLUX-490 visibility). Cheap
// (config logic, no server spawning) — shows what each phase's agent would get.
router.get('/debug/spawn-servers', (_req, res) => {
  const phases = ['grooming', 'implementation', 'review', 'release'];
  const byPhase: Record<string, string[]> = {};
  let strict = false;
  let note = '';
  for (const p of phases) {
    const r = getEffectiveSpawnServers(p);
    byPhase[p] = r.servers;
    strict = r.strict;
    note = r.note;
  }
  res.json({ strict, phases: byPhase, note });
});

router.get('/:id', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // ?view=agent serves the digested surface (same as MCP get_ticket) for
  // agents reading via the REST fallback; the portal default stays full.
  if (req.query.view === 'agent') {
    const historyLimit = Number.parseInt(String(req.query.historyLimit ?? ''), 10);
    const expand = typeof req.query.expand === 'string' && req.query.expand.trim()
      ? req.query.expand.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const fullHistory = req.query.fullHistory === 'true';
    return res.json(serializeTaskForAgent(task, Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : undefined, { expand, fullHistory }));
  }
  res.json(serializeTaskForApi(task));
});

// Debug-only: byte/token breakdown of the agent-facing get_ticket payload by
// section. Separate from the agent surfaces, so measuring never inflates what an
// agent reads. Powers the portal "Agent payload size" panel.
router.get('/:id/debug/sizes', (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const historyLimit = Number.parseInt(String(req.query.historyLimit ?? ''), 10);
  res.json(computeAgentPayloadMetrics(task, Number.isFinite(historyLimit) && historyLimit > 0 ? historyLimit : undefined));
});

// Debug-only: the broader "where does the agent context budget go" view —
// get_ticket payload + the launch prompt EH builds + the fixed skill modules,
// with explicit caveats about what the engine cannot measure (host system
// prompt, external MCP schemas, session accumulation).
router.get('/:id/debug/budget', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  try {
    res.json(await computeContextBudget(task));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to compute context budget' });
  }
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
      parentId,
    });

    // Link child to parent — derive subtasks from disk to avoid TOCTOU race
    const parentRaw = await fs.readFile(parent._path, 'utf-8');
    const parentParsed = matter(parentRaw);
    const parentSubtasks: string[] = Array.isArray(parentParsed.data.subtasks)
      ? parentParsed.data.subtasks.map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean)
      : [];
    parentSubtasks.push(childId);
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
    // Backwards-compat: requireInput flag now sets swimlane instead of changing status
    updates.swimlane = 'require-input';
    delete updates.requireInput;
    delete updates.status; // Don't change status — swimlane keeps ticket in place
    appendHistoryEntries.push({ type: 'swimlane_change', swimlane: 'require-input', action: 'set', user: actor });
  }

  const requireInputStatus = configCache.requireInputStatus || 'Require Input';
  // Backwards-compat: portal drag to "Require Input" column routes through swimlane
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
    // Route through swimlane: keep current status, set swimlane
    updates.swimlane = 'require-input';
    delete updates.status;
    appendHistoryEntries.push({ type: 'swimlane_change', swimlane: 'require-input', action: 'set', user: actor });
  }

  // When status changes away from a swimlane'd state, auto-clear the swimlane
  if (updates.status && task.swimlane && updates.status !== requireInputStatus) {
    appendHistoryEntries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: actor });
    updates.swimlane = null;
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
    // Tear down the ticket's dedicated worktree first so deleting the ticket doesn't orphan
    // it (FLUX-577). Abandon path (applyToMain:false): uncommitted work is preserved as a
    // recoverable stash ref, NOT applied to master. Only this ticket's own worktree is
    // touched (taskWorktreeDir by id) — a shared/joined worktree another ticket holds is
    // left alone. Best-effort: a teardown failure must not block the delete.
    if (task.branch) {
      const wtPath = taskWorktreeDir(workspaceRoot!, id);
      if (existsSync(wtPath)) {
        stopAllSessionsForTask(id, 'Deleting ticket — detaching worktree');
        await detachTaskWorktree(workspaceRoot!, wtPath, { ticketId: id, applyToMain: false }).catch((e) => {
          console.error(`Worktree teardown failed while deleting ${id}:`, e?.message);
        });
      }
    }
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

import { createTicketBranch, getTicketBranchStatus, deleteTicketBranch, extractFileFromDiff, captureDiff, createPullRequest, mergePullRequest, checkGhAuth, getPullRequestStatus, getDefaultBranch } from '../branch-manager.js';
import { createTaskWorktree, detachTaskWorktree, taskWorktreeDir, listTaskWorktrees, findWorktreeForBranch, worktreeChangeCount, listLocalBranches, currentBranchName } from '../task-worktree.js';
import { isEditorAvailable, openEditorWindow, openEditorFile } from '../editor-launcher.js';
import { cleanupMergedBranch } from '../pr-cleanup.js';
import { broadcastEvent } from '../events.js';

router.post('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const title: string = task.title || id;
  const baseBranch: string | undefined = req.body?.baseBranch;
  // FLUX-521: per-launch "dedicated worktree" choice; defaults to the workspace setting.
  const useWorktree: boolean = typeof req.body?.worktree === 'boolean'
    ? req.body.worktree
    : (configCache as any).worktreeByDefault === true;

  try {
    // Idempotent: reuse an existing branch (e.g. one a prior worktree-open created)
    // instead of erroring with a raw git "already exists".
    let branch = task.branch as string | undefined;
    if (!branch) {
      branch = await createTicketBranch(id, title, baseBranch);
      await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
    }

    let worktreePath: string | undefined;
    let worktreeError: string | undefined;
    if (useWorktree) {
      try {
        worktreePath = await createTaskWorktree(workspaceRoot!, id, branch, baseBranch ? { baseBranch } : {});
      } catch (wtErr: any) {
        // Branch is created — don't fail; surface the lost isolation on the ticket.
        worktreeError = wtErr.message;
        await updateTaskWithHistory(id, {
          updatedBy: 'Agent',
          entries: [buildActivityEntry(`⚠️ Dedicated worktree NOT created: ${worktreeError}. The agent will run in the main tree (no isolation).`, 'Agent', new Date().toISOString())],
        });
      }
    }
    broadcastEvent('taskUpdated', { id });
    res.json({ branch, ...(worktreePath ? { worktree: worktreePath } : {}), ...(worktreeError ? { worktreeError } : {}) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const name: string | undefined = task.branch;
  // FLUX-521: report whether a dedicated worktree exists (drives the portal detach control).
  const wtPath = taskWorktreeDir(workspaceRoot!, id);
  const worktree = existsSync(wtPath) ? wtPath : null;
  if (!name) return res.json({ name: null, exists: false, aheadCount: 0, behindCount: 0, worktree });

  try {
    const status = await getTicketBranchStatus(name);
    res.json({ name, ...status, worktree });
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
    // FLUX-521: a worktree holds the branch checked out — stop the session (release
    // the cwd lock) and detach before delete. This is an ABANDON, so uncommitted work
    // is preserved as a stash ref but NOT applied onto master.
    const wtPath = taskWorktreeDir(workspaceRoot!, id);
    if (existsSync(wtPath)) {
      stopAllSessionsForTask(id, 'Deleting branch — detaching worktree');
      await detachTaskWorktree(workspaceRoot!, wtPath, { ticketId: id, applyToMain: false });
    }
    await deleteTicketBranch(name, force);
    await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch: null } });
    res.json({ deleted: name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Worktree detach (manual-finish escape hatch, FLUX-521) ─────────────────────
// Remove the task's worktree but keep the branch, so the human can merge/PR/delete
// by hand. Uncommitted work is preserved (stashed → applied onto master, or kept as
// a stash ref on conflict — see detachTaskWorktree).
router.post('/:id/worktree/detach', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const wtPath = taskWorktreeDir(workspaceRoot!, id);
  if (!existsSync(wtPath)) {
    return res.status(404).json({ error: 'No worktree for this ticket' });
  }
  try {
    // Stop any live session so its process doesn't hold the worktree cwd (lock).
    stopAllSessionsForTask(id, 'Detaching worktree');
    const result = await detachTaskWorktree(workspaceRoot!, wtPath, { ticketId: id });
    broadcastEvent('taskUpdated', { id });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Open a ticket in a dedicated worktree window (FLUX-522) ─────────────────────
// Ensure a branch + worktree exist, then open a NEW VS Code window rooted there
// (a running session can't relocate its own cwd). Returns the worktree path, a
// seed prompt to paste, and whether the editor actually launched.
router.post('/:id/worktree/open', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const baseBranch: string | undefined = req.body?.baseBranch;
  try {
    let branch: string | undefined = task.branch;
    if (!branch) {
      branch = await createTicketBranch(id, task.title || id, baseBranch);
      await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
    }
    // Reuse a worktree already checked out on this branch (e.g. a joined ticket
    // sharing the parent's worktree); otherwise create this ticket's own.
    let worktree = await findWorktreeForBranch(workspaceRoot!, branch);
    if (!worktree) {
      worktree = await createTaskWorktree(workspaceRoot!, id, branch, baseBranch ? { baseBranch } : {});
    }
    const opened = await isEditorAvailable();
    if (opened) openEditorWindow(worktree);
    broadcastEvent('taskUpdated', { id });
    const seedPrompt = `Picking up ${id}: ${task.title || id}. Read the ticket and continue.`;
    res.json({ worktree, branch, opened, seedPrompt });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Join an existing worktree (shared-branch work, FLUX-516) ───────────────────
// Adopt another ticket's branch so THIS ticket runs in that branch's existing
// worktree (e.g. fixing review-found bugs alongside the parent ticket). No new
// branch or worktree is created — the ticket just points at the existing branch,
// and execution-root resolution (by branch) routes it into the shared worktree.
router.post('/:id/worktree/join', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const branch: string | undefined = typeof req.body?.branch === 'string' ? req.body.branch.trim() : undefined;
  if (!branch) return res.status(400).json({ error: 'branch is required' });

  try {
    const worktree = await findWorktreeForBranch(workspaceRoot!, branch);
    if (!worktree) {
      return res.status(409).json({ error: `No active worktree is checked out on '${branch}' to join.` });
    }
    await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
    broadcastEvent('taskUpdated', { id });
    res.json({ branch, worktree, joined: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PR routes (FLUX-556) ───────────────────────────────────────────────────────
// PRs are BRANCH-scoped: a PR belongs to a branch, and N tickets sharing that branch
// share its PR. These endpoints back the in-EH PR card / "Open PRs" swimlane (FLUX-555).
// Hard dependency on `gh` + a GitHub remote — every path degrades gracefully (clean
// "unavailable", never a 500) when gh is missing/unauthed so the UI can fall back.

// Live PR state for a ticket's branch. `{ pr: null }` when the ticket has no branch,
// no PR exists, or gh is unavailable. Best-effort — never 500.
router.get('/:id/pr', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (!task.branch) return res.json({ pr: null });

  try {
    // No `gh auth status` pre-check — getPullRequestStatus already returns null on any gh
    // failure (unauthed / non-GitHub remote / no PR), so the extra subprocess on every poll
    // was redundant (FLUX-561 #4).
    const pr = await getPullRequestStatus(task.branch);
    return res.json({ pr });
  } catch {
    return res.json({ pr: null }); // best-effort: never surface a 500 here
  }
});

// "Raise PR": push the ticket's branch + open a PR for review WITHOUT moving to Done
// (Done happens at merge — FLUX-555 decision #2). Stores the PR URL as implementationLink.
router.post('/:id/pr', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (!task.branch) return res.status(409).json({ error: 'Ticket has no branch to raise a PR for.' });

  if (!(await checkGhAuth())) {
    return res.status(409).json({ error: 'gh is not authenticated (or no GitHub remote).', unavailable: true });
  }

  // Pre-check: a branch with no commits ahead of the default branch can't open a PR
  // (gh would fail with "No commits between …"). Return an actionable 409 rather than a
  // raw 500 (FLUX-561). aheadCount comes from rev-list vs the default branch.
  const status = await getTicketBranchStatus(task.branch).catch(() => null);
  if (status && status.exists && status.aheadCount === 0) {
    return res.status(409).json({ error: `Branch \`${task.branch}\` has no commits ahead of the base branch yet — commit work before raising a PR.` });
  }

  try {
    const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${id}`;
    const url = await createPullRequest(task.branch, task.title || id, prBody);
    // Stamp the PR link on every ticket sharing the branch (branch-scoped PR). The PR's surface
    // is now its own `PR-<n>` deck card (created by syncPrTickets on the next poll) — the FLUX-558
    // `open-pr` swimlane/glow on member tickets is retired (FLUX-569), so we no longer set it.
    const branchTickets = (Object.values(tasksCache) as any[]).filter((t) => t.branch === task.branch);
    for (const t of branchTickets) {
      await updateTaskWithHistory(t.id, {
        updatedBy: 'Agent',
        entries: t.id === id ? [buildActivityEntry(`PR raised: ${url}`, 'Agent', new Date().toISOString())] : [],
        extraFields: { implementationLink: url },
      });
      if (t.id !== id) broadcastEvent('taskUpdated', { id: t.id });
    }
    const pr = await getPullRequestStatus(task.branch).catch(() => null);
    broadcastEvent('taskUpdated', { id });
    res.json({ url, number: pr?.number ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Squash-merge the branch's PR, then run branch-scoped post-merge cleanup (advance every
// ticket on the branch → Done, fast-forward master, tear down worktree + branch — FLUX-557).
// Guard: refuse while a live agent session owns the worktree (FLUX-555 decision #8) —
// merging out from under a running session would lose/clobber in-flight work.
router.post('/:id/pr/merge', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  const branch: string | undefined = task.branch;
  if (!branch) return res.status(409).json({ error: 'Ticket has no branch / PR to merge.' });

  // Branch-scoped: a merge advances ALL tickets sharing this branch.
  const sharedTickets = Object.values(tasksCache).filter((t: any) => t.branch === branch) as any[];

  // Guard: any live session on a branch-sharing ticket owns the worktree.
  const liveOwners = sharedTickets.filter((t) => getActiveSessionsForTask(t.id).length > 0);
  if (liveOwners.length > 0) {
    return res.status(409).json({
      error: `Cannot merge — a live agent session owns this worktree (${liveOwners.map((t) => t.id).join(', ')}). Stop the session, then merge.`,
    });
  }

  // Finish-on-shared-PR guard (FLUX-569, from the FLUX-556/PR#6 incident): a merge advances ALL
  // branch tickets → Done. When non-terminal siblings are bundled in, that's a one-way door, so
  // require explicit confirmation (`force:true`) and surface exactly who would be swept along.
  // The PR deck card lists them in its merge confirm and then re-sends with force.
  const force = req.body?.force === true;
  if (!force) {
    const nonDone = sharedNonDoneSiblings(Object.values(tasksCache) as any[], branch, id);
    if (nonDone.length > 0) {
      return res.status(409).json({
        error: `Merging \`${branch}\` would advance ${nonDone.length} unfinished ticket(s) to Done: ${nonDone.map((t) => `${t.id} (${t.status})`).join(', ')}. Confirm to merge the whole shared PR anyway.`,
        sharedNonDone: nonDone.map((t) => ({ id: t.id, status: t.status, title: t.title })),
        requiresForce: true,
      });
    }
  }

  if (!(await checkGhAuth())) {
    return res.status(409).json({ error: 'gh is not authenticated (or no GitHub remote).', unavailable: true });
  }

  try {
    await mergePullRequest(branch); // squash + delete remote branch
  } catch (err: any) {
    return res.status(500).json({ error: `Merge failed: ${err.message}` });
  }

  // Post-merge cleanup (FLUX-557): advance all branch tickets → Done, fast-forward local
  // master, and tear down the worktree + branch when the tree is clean (otherwise a
  // persistent notification is raised). Branch-scoped — runs once for the shared branch.
  const cleanup = await cleanupMergedBranch(workspaceRoot!, branch);

  // Resolve PR tickets (kind:'pr') for this branch RIGHT NOW. cleanupMergedBranch deliberately
  // skips them (their state is owned by syncPrTickets — FLUX-587), which left the merged PR
  // card sitting OPEN until the next 90s poll ("nothing happened" for a long minute — FLUX-588).
  // The merge just succeeded here, so move them to Done immediately instead of waiting.
  for (const t of sharedTickets.filter((t) => (t as any).kind === 'pr')) {
    await upsertManagedTicket(t.id, { status: 'Done', prState: 'MERGED', swimlane: null }).catch(() => {});
    broadcastEvent('taskUpdated', { id: t.id });
  }

  res.json({ merged: true, ...cleanup });
});

// Continue development on a PR by binding work to its branch (FLUX-569 AC1). A zero-member PR
// ticket — e.g. a PR opened directly on GitHub with no EH ticket — has nothing holding its work,
// so "Continue development" offers two ways to give it a home that folds into the deck:
//  - mode 'adopt'  → rebind an EXISTING ticket to the PR's branch + move it to In Progress.
//  - mode 'create' → create a FRESH ticket bound to the branch (status In Progress).
// Either way the new member is work-gated In Progress on the branch, so it folds into the deck;
// we recompute + stamp the PR ticket's members immediately rather than wait for the 90s poll.
router.post('/:id/pr/adopt', async (req, res) => {
  const { id } = req.params;
  const pr = tasksCache[id] as any;
  if (!pr) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (pr.kind !== 'pr') return res.status(409).json({ error: 'Adopt/create is only available for PR tickets.' });
  const branch: string | undefined = pr.branch;
  if (!branch) return res.status(409).json({ error: 'PR ticket has no branch to bind work to.' });

  const mode: string = (req.body?.mode ?? '').toString();
  const author: string = req.body?.updatedBy || 'Unknown';

  try {
    let memberId: string;
    if (mode === 'adopt') {
      const targetId: string = (req.body?.ticketId ?? '').toString().trim();
      const target = tasksCache[targetId] as any;
      if (!target) return res.status(404).json({ error: `Ticket ${targetId} not found` });
      if (target.kind === 'pr') return res.status(409).json({ error: 'Cannot adopt a PR ticket into another PR.' });
      // Don't silently re-point a ticket that's already bound to a DIFFERENT branch (FLUX-569
      // lifecycle-edge safety): it's likely a live member of another PR, and rebinding would
      // orphan it from that PR and abandon committed work on its old branch. Same-branch adopt is
      // a harmless re-home (it just folds the ticket back in + re-activates it), so allow that.
      if (target.branch && target.branch !== branch) {
        return res.status(409).json({
          error: `Ticket ${targetId} is already bound to branch \`${target.branch}\` — adopting it into PR #${pr.prNumber} (\`${branch}\`) would orphan it from its existing PR and abandon committed work. Detach it from its current branch first, or create a new ticket instead.`,
        });
      }
      await updateTaskWithHistory(targetId, {
        updatedBy: author,
        entries: [{ type: 'comment', user: author, comment: `Adopted into PR #${pr.prNumber} — bound to branch \`${branch}\` to continue its work.`, date: new Date().toISOString() }],
        nextStatus: 'In Progress',
        extraFields: { branch, ...(target.implementationLink ? {} : { implementationLink: pr.implementationLink }) },
      });
      memberId = targetId;
    } else if (mode === 'create') {
      const title: string = (req.body?.title ?? '').toString().trim();
      if (!title) return res.status(400).json({ error: 'A title is required to create a ticket.' });
      const reqBody = (req.body?.body ?? '').toString().trim();
      const { id: newId } = await createTask({
        title,
        status: 'In Progress',
        body: reqBody || `Continues the work in PR #${pr.prNumber}${pr.implementationLink ? ` ([link](${pr.implementationLink}))` : ''}.`,
        author,
        links: [{ type: 'continues', target: id, label: `PR #${pr.prNumber}` }],
      });
      await updateTaskWithHistory(newId, { updatedBy: 'Agent', extraFields: { branch, implementationLink: pr.implementationLink } });
      memberId = newId;
    } else {
      return res.status(400).json({ error: `Unknown mode "${mode}" — expected "adopt" or "create".` });
    }

    // Fold the new member into the PR deck immediately (don't wait for the 90s sync poll).
    const members = selectMembers(Object.values(tasksCache) as any[], branch);
    await upsertManagedTicket(id, { members }).catch(() => {});
    broadcastEvent('taskUpdated', { id });
    broadcastEvent('taskUpdated', { id: memberId });
    res.json({ memberId, members });
  } catch (err: any) {
    res.status(500).json({ error: `Adopt/create failed: ${err.message}` });
  }
});

// Retry a merged/closed PR (FLUX-593): spawn a NEW ticket linked to the PR via a 'retries'
// relation, carrying the user's reason + the PR's context as agent launch-focus, optionally
// on a fresh branch. A merged PR is immutable — this is a fresh cycle, not an un-merge. The
// 'retries' link is the first instance of the typed-relationships model (epic FLUX-596).
router.post('/:id/retry', async (req, res) => {
  const { id } = req.params;
  const pr = tasksCache[id] as any;
  if (!pr) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (pr.kind !== 'pr') return res.status(409).json({ error: 'Retry is only available for PR tickets.' });

  const reason: string = (req.body?.reason ?? '').toString().trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required to retry a PR.' });
  const createBranch: boolean = req.body?.createBranch === true;
  const author: string = req.body?.updatedBy || 'Unknown';

  const prNum = pr.prNumber;
  const prUrl: string = pr.implementationLink || '';
  const baseTitle = (pr.title || `PR #${prNum}`).replace(/^PR #\d+:\s*/, ''); // drop "PR #n: " prefix
  const members: string[] = Array.isArray(pr.members) ? pr.members : [];
  const memberTask = members.map((m) => tasksCache[m]).find(Boolean) as any;
  const tags: string[] = Array.isArray(memberTask?.tags) ? memberTask.tags : [];

  const stateWord = pr.prState === 'MERGED' ? 'merged' : pr.prState === 'CLOSED' ? 'was closed without merging' : 'is resolved';
  const body = [
    `## Retry of PR #${prNum}`,
    ``,
    `**PR #${prNum}**${prUrl ? ` ([link](${prUrl}))` : ''} ${stateWord}, but the work needs another pass.`,
    ``,
    `**Reason for retry (from ${author}):**`,
    `> ${reason.replace(/\n/g, '\n> ')}`,
    ``,
    members.length ? `**Original ticket(s):** ${members.join(', ')}` : `**Original ticket(s):** (none recorded)`,
    ``,
    `## How to continue`,
    `The original PR is settled and can't be re-opened, so this is a fresh cycle on a new branch. Review PR #${prNum}'s diff and the reason above, reproduce the problem, and continue from where that work left off — then open a new PR.`,
  ].join('\n');

  try {
    const { id: newId, task } = await createTask({
      title: `Retry PR #${prNum}: ${baseTitle}`,
      status: 'In Progress',
      ...(memberTask?.priority ? { priority: memberTask.priority } : {}),
      tags,
      body,
      author,
      links: [{ type: 'retries', target: id, label: `PR #${prNum}` }],
    });

    let branch: string | undefined;
    if (createBranch) {
      try {
        branch = await createTicketBranch(newId, task.title || newId);
        await updateTaskWithHistory(newId, { updatedBy: 'Agent', extraFields: { branch } });
      } catch (err: any) {
        // Best-effort — the ticket exists regardless; note why the branch didn't get created.
        await updateTaskWithHistory(newId, {
          updatedBy: 'Agent',
          entries: [{ type: 'comment', user: 'Agent', comment: `Retry branch could not be created automatically: ${err.message}. Create one via Start.`, date: new Date().toISOString() }],
        });
      }
    }
    broadcastEvent('taskUpdated', { id: newId });
    res.json({ id: newId, branch: branch ?? null });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to create retry ticket: ${err.message}` });
  }
});

// Update a stale PR branch by merging the default branch into it (FLUX-559). Conservative:
// requires a clean worktree and aborts the merge on conflict (the user resolves in the
// worktree) — never leaves a half-merged tree. Pushes the merge so the PR refreshes.
router.post('/:id/pr/update-branch', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  const branch: string | undefined = task.branch;
  if (!branch) return res.status(409).json({ error: 'Ticket has no branch to update.' });

  const worktree = await findWorktreeForBranch(workspaceRoot!, branch).catch(() => null);
  if (!worktree) {
    return res.status(409).json({ error: 'No active worktree holds this branch — open the worktree before updating.' });
  }
  const { stdout: porcelain } = await execFileAsync('git', ['-C', worktree, 'status', '--porcelain'], { windowsHide: true }).catch(() => ({ stdout: 'err' }));
  if (porcelain.trim().length > 0) {
    return res.status(409).json({ error: 'Worktree has uncommitted changes — commit or stash them first.' });
  }

  try {
    const def = await getDefaultBranch();
    await execFileAsync('git', ['-C', worktree, 'fetch', 'origin', def], { windowsHide: true });
    try {
      await execFileAsync('git', ['-C', worktree, 'merge', '--no-edit', `origin/${def}`], { windowsHide: true });
    } catch (mergeErr: any) {
      await execFileAsync('git', ['-C', worktree, 'merge', '--abort'], { windowsHide: true }).catch(() => {});
      return res.status(409).json({ error: `Update hit conflicts with ${def} — resolve them in the worktree, then push. (${mergeErr.message})` });
    }
    await execFileAsync('git', ['-C', worktree, 'push', 'origin', branch], { windowsHide: true }).catch(() => {});
    broadcastEvent('taskUpdated', { id });
    res.json({ updated: true, branch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Diff sidecar route ────────────────────────────────────────────────────────

router.get('/:id/diff', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const mode = req.query.mode === 'working' ? 'working' : 'committed';
  let fullDiff: string;

  if (mode === 'working') {
    // Live diff: generate it on the fly from the current working tree vs baseline
    try {
      const diff = await captureDiff(task.branch ?? null, task.baselineCommit ?? null, 'working');
      if (!diff) return res.status(404).json({ error: 'Could not generate live diff' });
      fullDiff = diff.fullDiff;
    } catch (err: any) {
      return res.status(500).json({ error: `Live diff failed: ${err.message}` });
    }
  } else {
    // Committed diff: read the sidecar file stored at finish
    const diffPath = path.join(getActiveFluxDir(), `${id}.diff`);
    try {
      fullDiff = await fs.readFile(diffPath, 'utf-8');
    } catch {
      return res.status(404).json({ error: 'No diff stored for this ticket' });
    }
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

// GET /api/tasks/:id/branch-diff — live changed-file summary for the ticket's branch vs
// the merge-base (FLUX-615), powering the inline diff panel in the chat window. Worktree-
// aware (same plumbing as /api/diffs/file), so per-file hunks fetched via that endpoint
// line up with this summary. 404-free for "no branch" — returns an empty summary instead.
router.get('/:id/branch-diff', async (req, res) => {
  const { id } = req.params;
  const task = tasksCache[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (!task.branch) return res.json({ branch: null, worktree: null, base: null, files: [] });

  try {
    const summary = await diffFilesForBranch(workspaceRoot!, task.branch);
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

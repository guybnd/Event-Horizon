import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { fileURLToPath } from 'url';

import { tasksCache, serializeTaskForApi, updateTaskWithHistory, activateWorkspace, workspaceActivating, readTaskFromDisk } from './task-store.js';
import { configCache, autoRegisterUnknownTags } from './config.js';
import { broadcastEvent } from './events.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry } from './history.js';
import { getCliWorkspace, getActiveFluxDir } from './workspace.js';
import { createTicketBranch, getTicketBranchStatus, deleteTicketBranch, createPullRequest, checkGhAuth, captureDiff, getCurrentCommit } from './branch-manager.js';

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

export async function startMcpServer(): Promise<void> {
  // MCP uses stdout for protocol messages — redirect all logging to stderr
  const originalLog = console.log;
  console.log = (...args: any[]) => console.error(...args);

  const workspacePath = getCliWorkspace();
  if (!workspacePath) {
    console.error('MCP server requires --workspace <path> argument');
    process.exit(1);
  }

  await activateWorkspace(workspacePath);

  const server = new McpServer({
    name: 'event-horizon',
    version: '1.0.0',
  });

  // ─── Context Tools ──────────────────────────────────────────────────────────

  server.tool(
    'get_ticket',
    'Read a ticket by ID — returns full frontmatter, body, and history',
    { ticketId: z.string().describe('Ticket ID, e.g. FLUX-42') },
    async ({ ticketId }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      const { _path, ...output } = serializeTaskForApi(task);
      return jsonResult(output);
    },
  );

  server.tool(
    'list_tickets',
    'List tickets with optional filtering by status, assignee, tag, or priority',
    {
      status: z.string().optional().describe('Filter by status (e.g. "In Progress", "Todo")'),
      assignee: z.string().optional().describe('Filter by assignee'),
      tag: z.string().optional().describe('Filter by tag name'),
      priority: z.string().optional().describe('Filter by priority (Critical, High, Medium, Low, None)'),
    },
    async ({ status, assignee, tag, priority }) => {
      let tasks = Object.values(tasksCache);
      if (status) tasks = tasks.filter((t: any) => t.status === status);
      if (assignee) tasks = tasks.filter((t: any) => t.assignee === assignee);
      if (tag) tasks = tasks.filter((t: any) => t.tags?.includes(tag));
      if (priority) tasks = tasks.filter((t: any) => t.priority === priority);
      const summary = tasks.map((t: any) => ({
        id: t.id, title: t.title, status: t.status,
        priority: t.priority, effort: t.effort, assignee: t.assignee, tags: t.tags,
      }));
      return jsonResult(summary);
    },
  );

  server.tool(
    'get_board_config',
    'Read board configuration — statuses, tags, priorities, project key',
    {},
    async () => {
      const statuses = [
        ...(configCache.columns || []).map((c: any) => c.name),
        ...(configCache.hiddenStatuses || []).map((s: any) => s.name),
      ];
      const { projects, tags, priorities, users, requireInputStatus, readyForMergeStatus } = configCache;
      return jsonResult({ statuses, projects, tags, priorities, users, requireInputStatus, readyForMergeStatus });
    },
  );

  // ─── Mutation Tools ─────────────────────────────────────────────────────────

  server.tool(
    'create_ticket',
    'Create a new ticket on the board',
    {
      title: z.string().describe('Ticket title'),
      status: z.string().optional().describe('Initial status (default: Todo)'),
      priority: z.string().optional().describe('Priority level (default: None)'),
      effort: z.string().optional().describe('Effort estimate: XS, S, M, L, XL, or None'),
      assignee: z.string().optional().describe('Assignee name (default: unassigned)'),
      tags: z.array(z.string()).optional().describe('Tags array'),
      body: z.string().optional().describe('Markdown body/description'),
      author: z.string().optional().describe('Author name (default: Agent)'),
    },
    async ({ title, status, priority, effort, assignee, tags, body, author }) => {
      if (workspaceActivating) return errorResult('Workspace is activating, please retry');

      const pKey = configCache.projects?.[0] || 'FLUX';
      let maxId = 0;
      Object.keys(tasksCache).forEach((key) => {
        if (key.startsWith(`${pKey}-`)) {
          const num = parseInt(key.replace(`${pKey}-`, ''), 10);
          if (!isNaN(num) && num > maxId) maxId = num;
        }
      });

      const nextId = `${pKey}-${maxId + 1}`;
      const filePath = path.join(getActiveFluxDir(), `${nextId}.md`);
      const createdAt = new Date().toISOString();
      const actor = author || 'Agent';

      const frontmatter: any = {
        id: nextId,
        title,
        status: status || 'Todo',
        priority: priority || 'None',
        effort: effort || 'None',
        assignee: assignee || 'unassigned',
        tags: tags || [],
        createdBy: actor,
        updatedBy: actor,
        history: ensureCreationActivity([], actor, createdAt).history,
      };

      const validationErrors = validateTicketFrontmatter(frontmatter);
      if (validationErrors.length > 0) {
        return errorResult(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`);
      }

      if (frontmatter.tags.length > 0) await autoRegisterUnknownTags(frontmatter.tags);
      const fileContent = matter.stringify(body || '', frontmatter);
      await fs.writeFile(filePath, fileContent, 'utf-8');
      tasksCache[nextId] = { ...frontmatter, body: body || '', id: nextId, _path: filePath };
      broadcastEvent('taskCreated', { id: nextId });
      return jsonResult({ id: nextId, title, status: frontmatter.status });
    },
  );

  server.tool(
    'update_ticket',
    'Update ticket metadata — title, priority, effort, tags, assignee, or body. Does NOT change status (use change_status for that).',
    {
      ticketId: z.string().describe('Ticket ID'),
      title: z.string().optional().describe('New title'),
      priority: z.string().optional().describe('New priority'),
      effort: z.string().optional().describe('New effort estimate'),
      assignee: z.string().optional().describe('New assignee'),
      tags: z.array(z.string()).optional().describe('Replace tags array'),
      body: z.string().optional().describe('Replace markdown body'),
      implementationLink: z.string().optional().describe('PR URL or commit hash'),
    },
    async ({ ticketId, title, priority, effort, assignee, tags, body, implementationLink }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const { _path } = task;
      const { frontmatter, body: existingBody } = await readTaskFromDisk(task);

      if (title !== undefined) frontmatter.title = title;
      if (priority !== undefined) frontmatter.priority = priority;
      if (effort !== undefined) frontmatter.effort = effort;
      if (assignee !== undefined) frontmatter.assignee = assignee;
      if (tags !== undefined) frontmatter.tags = tags;
      if (implementationLink !== undefined) frontmatter.implementationLink = implementationLink;
      const nextBody = body !== undefined ? body : existingBody;
      frontmatter.updatedBy = 'Agent';

      const validationErrors = validateTicketFrontmatter(frontmatter);
      if (validationErrors.length > 0) {
        return errorResult(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`);
      }

      if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
        await autoRegisterUnknownTags(frontmatter.tags);
      }

      const activityTimestamp = new Date().toISOString();
      const existingHistory = normalizeHistoryEntries(frontmatter.history || []).history;

      const fieldChanges: string[] = [];
      if (title !== undefined && title !== task.title) fieldChanges.push('Updated title.');
      if (body !== undefined && body !== task.body) fieldChanges.push('Updated description.');
      if (priority !== undefined && priority !== task.priority) fieldChanges.push(`Changed priority to ${priority}.`);
      if (effort !== undefined && effort !== task.effort) fieldChanges.push(`Changed effort to ${effort}.`);
      if (assignee !== undefined && assignee !== task.assignee) fieldChanges.push(`Changed assignee to ${assignee}.`);
      if (tags !== undefined) fieldChanges.push('Updated tags.');
      if (implementationLink !== undefined) fieldChanges.push('Updated implementation link.');

      if (fieldChanges.length > 0) {
        existingHistory.push(buildActivityEntry(fieldChanges.join(' '), 'Agent', activityTimestamp));
      }

      frontmatter.history = normalizeHistoryEntries(existingHistory).history;
      const fileContent = matter.stringify(nextBody, frontmatter);
      await fs.writeFile(_path, fileContent, 'utf-8');
      tasksCache[ticketId] = { ...frontmatter, body: nextBody, id: ticketId, _path };
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`Updated ${ticketId}`);
    },
  );

  server.tool(
    'change_status',
    'Move a ticket to a new status. A comment is REQUIRED when moving to Require Input or Ready.',
    {
      ticketId: z.string().describe('Ticket ID'),
      newStatus: z.string().describe('Target status'),
      comment: z.string().optional().describe('Required for Require Input/Ready transitions. Provide the question or completion summary.'),
    },
    async ({ ticketId, newStatus, comment }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const requireInputStatus = configCache.requireInputStatus || 'Require Input';
      const readyStatus = configCache.readyForMergeStatus || 'Ready';

      if (newStatus === requireInputStatus && task.status !== requireInputStatus && !comment) {
        return errorResult('Transitioning to Require Input requires a comment (the question to ask).');
      }
      if (newStatus === readyStatus && task.status !== readyStatus && !comment && configCache.requireCommentOnStatusChange !== false) {
        return errorResult('Transitioning to Ready requires a completion comment.');
      }

      const entries: any[] = [];
      if (comment) {
        entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
      }

      // Capture baselineCommit on first move to In Progress. This is the diff anchor
      // for finish_ticket when the ticket doesn't have a branch.
      const extraFields: Record<string, any> = {};
      if (newStatus === 'In Progress' && !task.baselineCommit) {
        const head = await getCurrentCommit();
        if (head) extraFields.baselineCommit = head;
      }

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: newStatus,
        ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      });

      if (!result) return errorResult(`Failed to update ${ticketId}`);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} moved to ${newStatus}`);
    },
  );

  server.tool(
    'add_comment',
    "Append a comment to a ticket's history",
    {
      ticketId: z.string().describe('Ticket ID'),
      comment: z.string().describe('Comment text'),
      user: z.string().optional().describe('Author of the comment (default: Agent)'),
    },
    async ({ ticketId, comment, user }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const actor = user || 'Agent';
      const entries = [{ type: 'comment', user: actor, comment, date: new Date().toISOString() }];
      const result = await updateTaskWithHistory(ticketId, { entries, updatedBy: actor });
      if (!result) return errorResult(`Failed to update ${ticketId}`);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`Comment added to ${ticketId}`);
    },
  );

  server.tool(
    'log_progress',
    'Log a progress update on a ticket — adds an activity entry to history',
    {
      ticketId: z.string().describe('Ticket ID'),
      message: z.string().describe('Progress message'),
    },
    async ({ ticketId, message }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const activityTimestamp = new Date().toISOString();
      const entries = [buildActivityEntry(message, 'Agent', activityTimestamp)];
      const result = await updateTaskWithHistory(ticketId, { entries, updatedBy: 'Agent' });
      if (!result) return errorResult(`Failed to update ${ticketId}`);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`Progress logged on ${ticketId}`);
    },
  );

  // ─── Lifecycle Tools ────────────────────────────────────────────────────────

  server.tool(
    'finish_ticket',
    'Atomically finish a ticket: set implementationLink, add completion comment, move status to Done',
    {
      ticketId: z.string().describe('Ticket ID'),
      implementationLink: z.string().describe('PR URL or commit hash'),
      completionComment: z.string().describe('Summary of what was implemented'),
    },
    async ({ ticketId, implementationLink, completionComment }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      let finalLink = implementationLink;
      let noteForComment = '';

      // If ticket has a branch, attempt to create a PR
      if (task.branch) {
        const ghAvailable = await checkGhAuth();
        if (ghAvailable) {
          try {
            const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
            const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
            finalLink = prUrl;
          } catch (err: any) {
            noteForComment = `\n\n⚠️ PR creation failed: ${err.message}. Commit: ${implementationLink}`;
            finalLink = implementationLink;
          }
        } else {
          noteForComment = `\n\n⚠️ PR creation skipped — gh not configured. Commit: ${implementationLink}. Open a PR manually when ready.`;
          finalLink = implementationLink;
        }
      }

      const entries = [{ type: 'comment', user: 'Agent', comment: completionComment + noteForComment, date: new Date().toISOString() }];
      const finishExtraFields: Record<string, any> = { implementationLink: finalLink };

      // Capture diff summary + sidecar file. Best-effort — failure here must not block finish.
      try {
        const diff = await captureDiff(task.branch ?? null, task.baselineCommit ?? null);
        if (diff && diff.summary.length > 0) {
          finishExtraFields.diffSummary = diff.summary;
          const diffPath = path.join(getActiveFluxDir(), `${ticketId}.diff`);
          await fs.writeFile(diffPath, diff.fullDiff, 'utf-8');
        }
      } catch (err: any) {
        console.error(`Diff capture failed for ${ticketId}:`, err.message);
      }

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: 'Done',
        extraFields: finishExtraFields,
      });

      if (!result) return errorResult(`Failed to finish ${ticketId}`);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} finished → Done (link: ${finalLink})`);
    },
  );

  // ─── Branch Tools ──────────────────────────────────────────────────────────

  server.tool(
    'create_branch',
    'Create a git feature branch for a ticket and store its name on the ticket',
    {
      ticketId: z.string().describe('Ticket ID'),
      baseBranch: z.string().optional().describe('Base branch (default: master)'),
    },
    async ({ ticketId, baseBranch }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      if (task.branch) return errorResult(`Ticket ${ticketId} already has branch: ${task.branch}`);

      try {
        const branch = await createTicketBranch(ticketId, task.title || ticketId, baseBranch);
        await updateTaskWithHistory(ticketId, { updatedBy: 'Agent', extraFields: { branch } });
        broadcastEvent('taskUpdated', { id: ticketId });
        return jsonResult({ branch });
      } catch (err: any) {
        return errorResult(`Failed to create branch: ${err.message}`);
      }
    },
  );

  server.tool(
    'get_branch',
    'Get the branch status for a ticket — name, existence, and ahead/behind counts vs master',
    {
      ticketId: z.string().describe('Ticket ID'),
    },
    async ({ ticketId }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const name: string | undefined = task.branch;
      if (!name) return jsonResult({ name: null, exists: false, aheadCount: 0, behindCount: 0 });

      try {
        const status = await getTicketBranchStatus(name);
        return jsonResult({ name, ...status });
      } catch (err: any) {
        return errorResult(`Failed to get branch status: ${err.message}`);
      }
    },
  );

  server.tool(
    'delete_branch',
    'Delete the git branch associated with a ticket. Refuses unmerged branches unless force=true.',
    {
      ticketId: z.string().describe('Ticket ID'),
      force: z.boolean().optional().describe('Force delete even if unmerged (default: false)'),
    },
    async ({ ticketId, force }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const name: string | undefined = task.branch;
      if (!name) return errorResult(`Ticket ${ticketId} has no associated branch`);

      try {
        await deleteTicketBranch(name, force ?? false);
        await updateTaskWithHistory(ticketId, { updatedBy: 'Agent', extraFields: { branch: null } });
        broadcastEvent('taskUpdated', { id: ticketId });
        return textResult(`Branch ${name} deleted`);
      } catch (err: any) {
        return errorResult(`Failed to delete branch: ${err.message}`);
      }
    },
  );

  server.tool(
    'create_subtask',
    'Create a subtask and link it to a parent ticket',
    {
      parentId: z.string().describe('Parent ticket ID'),
      title: z.string().describe('Subtask title'),
      status: z.string().optional().describe('Initial status (default: Todo)'),
      priority: z.string().optional().describe('Priority (default: None)'),
      effort: z.string().optional().describe('Effort estimate (default: None)'),
      body: z.string().optional().describe('Markdown body'),
      tags: z.array(z.string()).optional().describe('Tags array'),
      assignee: z.string().optional().describe('Assignee (default: unassigned)'),
    },
    async ({ parentId, title, status, priority, effort, body, tags, assignee }) => {
      const parent = tasksCache[parentId];
      if (!parent) return errorResult(`Parent ticket ${parentId} not found`);
      if (workspaceActivating) return errorResult('Workspace is activating, please retry');

      const pKey = configCache.projects?.[0] || 'FLUX';
      let maxId = 0;
      Object.keys(tasksCache).forEach((key) => {
        if (key.startsWith(`${pKey}-`)) {
          const num = parseInt(key.replace(`${pKey}-`, ''), 10);
          if (!isNaN(num) && num > maxId) maxId = num;
        }
      });

      const childId = `${pKey}-${maxId + 1}`;
      const childPath = path.join(getActiveFluxDir(), `${childId}.md`);
      const createdAt = new Date().toISOString();
      const actor = 'Agent';

      const childFrontmatter: any = {
        id: childId,
        title,
        status: status || 'Todo',
        priority: priority || 'None',
        effort: effort || 'None',
        assignee: assignee || 'unassigned',
        tags: tags || [],
        createdBy: actor,
        updatedBy: actor,
        history: [
          { type: 'activity', user: actor, date: createdAt, comment: `Created as subtask of ${parentId}.` },
        ],
      };

      const validationErrors = validateTicketFrontmatter(childFrontmatter);
      if (validationErrors.length > 0) {
        return errorResult(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`);
      }

      if (childFrontmatter.tags.length > 0) await autoRegisterUnknownTags(childFrontmatter.tags);

      const childContent = matter.stringify(body || '', childFrontmatter);
      await fs.writeFile(childPath, childContent, 'utf-8');
      tasksCache[childId] = { ...childFrontmatter, body: body || '', id: childId, _path: childPath };

      // Link to parent
      const parentSubtasks: string[] = Array.isArray(parent.subtasks)
        ? parent.subtasks.map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean)
        : [];
      parentSubtasks.push(childId);

      const parentRaw = await fs.readFile(parent._path, 'utf-8');
      const parentParsed = matter(parentRaw);
      parentParsed.data.subtasks = parentSubtasks;
      parentParsed.data.updatedBy = actor;
      const parentContent = matter.stringify(parentParsed.content, parentParsed.data);
      await fs.writeFile(parent._path, parentContent, 'utf-8');
      tasksCache[parentId] = { ...tasksCache[parentId], subtasks: parentSubtasks, updatedBy: actor };

      broadcastEvent('taskCreated', { id: childId, parentId });
      return jsonResult({ id: childId, parentId, title, status: childFrontmatter.status });
    },
  );

  // ─── Start Transport ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start only when this file is the direct entry point, not when imported as a module
try {
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startMcpServer().catch((err) => {
      console.error('MCP server failed:', err);
      process.exit(1);
    });
  }
} catch {
  // import.meta.url unavailable (e.g. inside pkg) — skip auto-start
}

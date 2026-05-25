import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';

import { tasksCache, serializeTaskForApi, updateTaskWithHistory, activateWorkspace, workspaceActivating } from './task-store.js';
import { configCache, autoRegisterUnknownTags } from './config.js';
import { broadcastEvent } from './events.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { normalizeHistoryEntries, ensureCreationActivity, buildActivityEntry } from './history.js';
import { getCliWorkspace, getActiveFluxDir } from './workspace.js';

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
      let frontmatter: any;
      let existingBody: string;
      try {
        const rawFile = await fs.readFile(_path, 'utf-8');
        const parsed = matter(rawFile);
        existingBody = parsed.content || '';
        frontmatter = { ...parsed.data };
      } catch {
        const { body: cachedBody, _path: _p, id: _id, ...cachedFm } = task;
        existingBody = cachedBody || '';
        frontmatter = { ...cachedFm };
      }

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

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: newStatus,
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

      const entries = [{ type: 'comment', user: 'Agent', comment: completionComment, date: new Date().toISOString() }];
      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: 'Done',
        extraFields: { implementationLink },
      });

      if (!result) return errorResult(`Failed to finish ${ticketId}`);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} finished → Done (link: ${implementationLink})`);
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

// Auto-start when run as entry point
startMcpServer().catch((err) => {
  console.error('MCP server failed:', err);
  process.exit(1);
});

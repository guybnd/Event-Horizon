import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { fileURLToPath } from 'url';

import { tasksCache, serializeTaskForApi, updateTaskWithHistory, activateWorkspace, workspaceActivating, readTaskFromDisk, docsCache, createTask, atomicWriteFile, type CreateTaskOptions } from './task-store.js';
import { configCache, autoRegisterUnknownTags } from './config.js';
import { broadcastEvent } from './events.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { normalizeHistoryEntries, buildActivityEntry } from './history.js';
import { getCliWorkspace, getActiveFluxDir, getWorkspacesList } from './workspace.js';
import { createTicketBranch, getTicketBranchStatus, deleteTicketBranch, createPullRequest, mergePullRequest, checkGhAuth, captureDiff, getCurrentCommit } from './branch-manager.js';
import { getActiveSessionsForTask } from './session-store.js';
import { generatePromptNotification, dismissNotificationsForTicket } from './notifications.js';
import { getGroupContext, getMemberBinding, groupDocsLabel, summarizeGroup, groupDocPathToStoreRelative, activeGroupDocsLabel } from './group.js';
import { submitGroupEdit } from './group-edit.js';

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

  server.tool(
    'get_project_group',
    'Read the multi-repo group (if configured): group name + member repos (name, role, git remote, resolved local path, test command, registration state). Also reports `membership` when the current workspace is the parent or a bound member of a group. Returns a clear notice when no group is configured.',
    {},
    async () => {
      const registeredPaths = (await getWorkspacesList()).map((w) => w.path);
      const ctx = getGroupContext();
      if (ctx) {
        const summary = summarizeGroup(ctx, registeredPaths);
        summary.membership = { role: 'parent', groupName: ctx.config.name, parentRoot: ctx.parentRoot };
        return jsonResult(summary);
      }
      const binding = getMemberBinding();
      if (binding) {
        const summary = summarizeGroup(null, registeredPaths);
        summary.docsLabel = groupDocsLabel(binding.parentGroup);
        const self = binding.parentGroup.config.members.find((m) => m.name === binding.memberName);
        summary.membership = {
          role: 'member',
          groupName: binding.parentGroup.config.name,
          parentRoot: binding.parentRoot,
          memberName: binding.memberName,
          ...(self?.role ? { memberRole: self.role } : {}),
        };
        return jsonResult(summary);
      }
      return jsonResult(summarizeGroup(null, registeredPaths));
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

      try {
        const opts: CreateTaskOptions = { title, author: author || 'Agent' };
        if (status) opts.status = status;
        if (priority) opts.priority = priority;
        if (effort) opts.effort = effort;
        if (assignee) opts.assignee = assignee;
        if (tags) opts.tags = tags;
        if (body) opts.body = body;
        const { id, task } = await createTask(opts);
        return jsonResult({ id, title: task.title, status: task.status });
      } catch (err: any) {
        return errorResult(err.message || 'Failed to create ticket');
      }
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
    'Move a ticket to a new status. A comment is REQUIRED when moving to Require Input or Ready. Set callerRole to your role (e.g. "orchestrator") when calling from a multi-session context.',
    {
      ticketId: z.string().describe('Ticket ID'),
      newStatus: z.string().describe('Target status'),
      comment: z.string().optional().describe('Required for Require Input/Ready transitions. Provide the question or completion summary.'),
      callerRole: z.string().optional().describe('Role of the calling session (e.g. "orchestrator"). Required to change status when scatter-gather sessions are active.'),
    },
    async ({ ticketId, newStatus, comment, callerRole }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      // Scatter-gather guard: if there are active step sessions on this task,
      // only an orchestrator (or explicit lead) can change status. Scope the check
      // to active sessions so concurrent reviewers in the same run hold the barrier.
      const activeSessions = getActiveSessionsForTask(ticketId);
      const activeStepSessions = activeSessions.filter(s => s.patternPosition === 'step');
      if (activeStepSessions.length > 0 && activeSessions.length >= 2) {
        const isOrchestrator = callerRole === 'orchestrator' || callerRole === 'lead';
        if (!isOrchestrator) {
          return errorResult(
            `Cannot change status: ${activeStepSessions.length} scatter-gather sessions are active on ${ticketId}. ` +
            `Only the orchestrator can change status while parallel reviews are running. ` +
            `Post your findings via add_comment instead.`
          );
        }
      }

      const requireInputStatus = configCache.requireInputStatus || 'Require Input';
      const readyStatus = configCache.readyForMergeStatus || 'Ready';

      // Backwards-compat: change_status to "Require Input" routes through the swimlane system.
      // The ticket stays in its current status but gets the require-input swimlane set.
      if (newStatus === requireInputStatus && task.status !== requireInputStatus) {
        if (!comment) {
          return errorResult('Transitioning to Require Input requires a comment (the question to ask).');
        }

        const entries: any[] = [
          { type: 'comment', user: 'Agent', comment, date: new Date().toISOString() },
          { type: 'swimlane_change', swimlane: 'require-input', action: 'set', user: 'Agent', date: new Date().toISOString(), comment },
        ];

        const result = await updateTaskWithHistory(ticketId, {
          entries,
          updatedBy: 'Agent',
          extraFields: { swimlane: 'require-input' },
        });
        if (!result) return errorResult(`Failed to update ${ticketId}`);

        const sessions = getActiveSessionsForTask(ticketId);
        for (const s of sessions) {
          s.status = 'waiting-input';
          s.pausedForInput = true;
        }

        broadcastEvent('taskUpdated', { id: ticketId });
        generatePromptNotification(ticketId, task.title || ticketId, 'Require Input');
        return textResult(`${ticketId} swimlane set to 'require-input' (status remains ${task.status})`);
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

      // Clear swimlane when moving out of a blocked state (e.g. user answered the question)
      if (task.swimlane && newStatus !== requireInputStatus) {
        extraFields.swimlane = null;
        entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
        dismissNotificationsForTicket(ticketId);
      }

      // When moving to Ready with a branch, push and create a PR for review.
      if (newStatus === readyStatus && task.branch) {
        const ghAvailable = await checkGhAuth();
        if (ghAvailable) {
          try {
            const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
            const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
            extraFields.implementationLink = prUrl;
            entries.push({ type: 'activity', user: 'Agent', comment: `PR created: ${prUrl}`, date: new Date().toISOString() });
          } catch (err: any) {
            entries.push({ type: 'activity', user: 'Agent', comment: `⚠️ PR creation failed: ${err.message}. Push branch manually.`, date: new Date().toISOString() });
          }
        }
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

  // ─── Swimlane Tools ──────────────────────────────────────────────────────────

  server.tool(
    'set_swimlane',
    'Set a swimlane on a ticket (e.g. "require-input"). The ticket stays in its current status column but is visually flagged. A comment is required for swimlanes with commentRequired: true.',
    {
      ticketId: z.string().describe('Ticket ID'),
      swimlane: z.string().describe('Swimlane ID (e.g. "require-input")'),
      comment: z.string().optional().describe('Required for require-input swimlane (the question to ask)'),
    },
    async ({ ticketId, swimlane, comment }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const swimlanes: any[] = configCache.swimlanes || [];
      const swimlaneDef = swimlanes.find((s: any) => s.id === swimlane);
      if (!swimlaneDef) {
        return errorResult(`Unknown swimlane '${swimlane}'. Available: ${swimlanes.map((s: any) => s.id).join(', ')}`);
      }

      if (swimlaneDef.commentRequired && !comment) {
        return errorResult(`Swimlane '${swimlane}' requires a comment (the question to ask).`);
      }

      const entries: any[] = [];

      // If ticket already has a swimlane, emit a 'cleared' entry before setting the new one
      if (task.swimlane && task.swimlane !== swimlane) {
        entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
      } else if (task.swimlane === swimlane) {
        return errorResult(`${ticketId} already has swimlane '${swimlane}'. Clear it first or use a different swimlane.`);
      }

      if (comment) {
        entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
      }
      entries.push({ type: 'swimlane_change', swimlane, action: 'set', user: 'Agent', date: new Date().toISOString(), comment: comment || undefined });

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        extraFields: { swimlane },
      });
      if (!result) return errorResult(`Failed to update ${ticketId}`);

      if (swimlane === 'require-input') {
        const sessions = getActiveSessionsForTask(ticketId);
        for (const s of sessions) {
          s.status = 'waiting-input';
          s.pausedForInput = true;
        }
      }

      broadcastEvent('taskUpdated', { id: ticketId });
      generatePromptNotification(ticketId, task.title || ticketId, swimlaneDef.label);
      return textResult(`${ticketId} swimlane set to '${swimlane}'`);
    },
  );

  server.tool(
    'clear_swimlane',
    'Clear the active swimlane from a ticket, returning it to normal board state.',
    {
      ticketId: z.string().describe('Ticket ID'),
      comment: z.string().optional().describe('Optional comment explaining the resolution'),
    },
    async ({ ticketId, comment }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      if (!task.swimlane) return errorResult(`${ticketId} has no active swimlane to clear.`);

      const previousSwimlane = task.swimlane;
      const entries: any[] = [];
      if (comment) {
        entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
      }
      entries.push({ type: 'swimlane_change', swimlane: previousSwimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString(), comment: comment || undefined });

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        extraFields: { swimlane: null },
      });
      if (!result) return errorResult(`Failed to update ${ticketId}`);

      dismissNotificationsForTicket(ticketId);
      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} swimlane '${previousSwimlane}' cleared`);
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

      const readyStatus = configCache.readyForMergeStatus || 'Ready';
      if (task.status !== readyStatus) {
        return errorResult(
          `Cannot finish ${ticketId} — ticket must be in "${readyStatus}" status first (current: "${task.status}"). ` +
          `Move to "${readyStatus}" with change_status and wait for user confirmation before finishing.`
        );
      }

      let finalLink = implementationLink;
      let noteForComment = '';

      // If ticket has a branch, merge the existing PR
      if (task.branch) {
        const ghAvailable = await checkGhAuth();
        if (!ghAvailable) {
          // Can't merge without gh — bounce back to In Progress
          const failEntries = [{ type: 'comment', user: 'Agent', comment: `⚠️ Finish aborted — gh not configured. Merge the PR manually, then finish again.`, date: new Date().toISOString() }];
          await updateTaskWithHistory(ticketId, { entries: failEntries, updatedBy: 'Agent', nextStatus: 'In Progress' });
          broadcastEvent('taskUpdated', { id: ticketId });
          return errorResult(`Cannot finish ${ticketId} — gh not configured. Ticket moved back to In Progress.`);
        }
        try {
          await mergePullRequest(task.branch);
          if (!finalLink || !finalLink.startsWith('http')) {
            finalLink = task.implementationLink || implementationLink;
          }
        } catch (mergeErr: any) {
          // Merge failed — bounce back to In Progress with explanation
          const failEntries = [{ type: 'comment', user: 'Agent', comment: `⚠️ PR merge failed: ${mergeErr.message}. Fix the issue and try again.`, date: new Date().toISOString() }];
          await updateTaskWithHistory(ticketId, { entries: failEntries, updatedBy: 'Agent', nextStatus: 'In Progress' });
          broadcastEvent('taskUpdated', { id: ticketId });
          return errorResult(`Cannot finish ${ticketId} — PR merge failed: ${mergeErr.message}. Ticket moved back to In Progress.`);
        }
      }

      const entries = [{ type: 'comment', user: 'Agent', comment: completionComment, date: new Date().toISOString() }];
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

      try {
        const opts: CreateTaskOptions = { title, author: 'Agent', parentId };
        if (status) opts.status = status;
        if (priority) opts.priority = priority;
        if (effort) opts.effort = effort;
        if (assignee) opts.assignee = assignee;
        if (tags) opts.tags = tags;
        if (body) opts.body = body;
        const { id: childId, task: childTask } = await createTask(opts);

        // Link to parent — derive subtasks from disk to avoid TOCTOU race
        const parentRaw = await fs.readFile(parent._path, 'utf-8');
        const parentParsed = matter(parentRaw);
        const parentSubtasks: string[] = Array.isArray(parentParsed.data.subtasks)
          ? parentParsed.data.subtasks.map((s: any) => typeof s === 'string' ? s : s.id).filter(Boolean)
          : [];
        parentSubtasks.push(childId);
        parentParsed.data.subtasks = parentSubtasks;
        parentParsed.data.updatedBy = 'Agent';
        const parentContent = matter.stringify(parentParsed.content, parentParsed.data);
        await atomicWriteFile(parent._path, parentContent);
        tasksCache[parentId] = { ...tasksCache[parentId], subtasks: parentSubtasks, updatedBy: 'Agent' };

        return jsonResult({ id: childId, parentId, title: childTask.title, status: childTask.status });
      } catch (err: any) {
        return errorResult(err.message || 'Failed to create subtask');
      }
    },
  );

  // ─── Delegation Tools (Supervisor Pattern) ──────────────────────────────────
  // These tools allow a supervisor lead agent to dynamically spawn child agents
  // and receive their results. The MCP server calls the engine's long-poll
  // delegation endpoint; the response blocks until the child finishes.

  const ENGINE_URL = process.env.EVENT_HORIZON_ENGINE_URL || 'http://localhost:3067';

  server.tool(
    'list_available_agents',
    'List available agent personas that can be delegated to. Returns id, label, description, role (lead/worker/flex), and phases for each.',
    {
      phase: z.string().optional().describe('Filter by phase (grooming, implementation, review, release). Omit to see all.'),
    },
    async ({ phase }) => {
      try {
        const url = phase
          ? `${ENGINE_URL}/api/orchestration/personas?phase=${encodeURIComponent(phase)}`
          : `${ENGINE_URL}/api/orchestration/personas`;
        const res = await fetch(url);
        if (!res.ok) return errorResult('Failed to fetch agent roster');
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.personas ?? [];
        const summary = list.map((p: any) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          role: p.role,
          phases: p.phases,
        }));
        return jsonResult(summary);
      } catch (err: any) {
        return errorResult(`Failed to list agents: ${err.message}`);
      }
    },
  );

  server.tool(
    'delegate_to_agent',
    'Delegate a task to a specialist agent. Spawns the agent, waits for it to finish, and returns its output. Use this when specialist knowledge would produce better results than doing the work yourself.',
    {
      ticketId: z.string().describe('Ticket ID the delegation is for'),
      personaId: z.string().describe('Agent persona ID to delegate to (from list_available_agents)'),
      task: z.string().describe('Clear description of what the delegate should do. Be specific about files, scope, and expected output format.'),
      effort: z.string().optional().describe('Effort level for the delegate: low, medium, high (default: medium). Use low for quick checks, high for thorough work.'),
      timeout: z.number().optional().describe('Timeout in seconds (default: 300, max: 600). The delegation fails if the agent takes longer.'),
    },
    async ({ ticketId, personaId, task: delegationTask, effort, timeout }) => {
      try {
        const timeoutMs = timeout ? Math.min(timeout * 1000, 600_000) : 300_000;
        const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/delegate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            framework: 'claude',
            personaId,
            task: delegationTask,
            effortOverride: effort || '',
            skipPermissions: true,
            timeout: timeoutMs,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResult(`Delegation failed: ${err.error || res.statusText}`);
        }
        const result = await res.json();
        if (!result.succeeded) {
          return errorResult(`Delegate "${personaId}" ${result.status}: ${result.output || 'no output'}`);
        }
        return textResult(result.output || '(delegate produced no output)');
      } catch (err: any) {
        return errorResult(`Delegation error: ${err.message}`);
      }
    },
  );

  server.tool(
    'delegate_parallel',
    'Delegate tasks to multiple agents in parallel. All agents run simultaneously; returns when all finish. Use for independent work that benefits from different specialist perspectives.',
    {
      ticketId: z.string().describe('Ticket ID the delegations are for'),
      delegations: z.array(z.object({
        personaId: z.string().describe('Agent persona ID'),
        task: z.string().describe('What this specific delegate should do'),
        effort: z.string().optional().describe('Effort level: low, medium, high'),
      })).describe('Array of delegation specs to run in parallel'),
      timeout: z.number().optional().describe('Timeout in seconds for ALL delegations (default: 300, max: 600)'),
    },
    async ({ ticketId, delegations, timeout }) => {
      const timeoutMs = timeout ? Math.min(timeout * 1000, 600_000) : 300_000;
      const results = await Promise.allSettled(
        delegations.map(async (d) => {
          const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/delegate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              framework: 'claude',
              personaId: d.personaId,
              task: d.task,
              effortOverride: d.effort || '',
              skipPermissions: true,
              timeout: timeoutMs,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || res.statusText);
          }
          return res.json();
        })
      );

      const output: any[] = results.map((r, i) => {
        const persona = delegations[i]!.personaId;
        if (r.status === 'fulfilled') {
          const v = r.value as any;
          return { persona, succeeded: v.succeeded, status: v.status, output: v.output || '(no output)' };
        }
        const reason = (r as PromiseRejectedResult).reason;
        return { persona, succeeded: false, status: 'error', output: reason?.message || 'unknown error' };
      });
      return jsonResult(output);
    },
  );

  // ─── Group Docs Tools (FLUX-421 / FLUX-420) ─────────────────────────────────

  server.tool(
    'list_group_docs',
    'List the shared group docs (the cross-project knowledge base) by path and title. Works from any workspace — parent or bound member. Returns an empty list in single-repo mode.',
    {},
    async () => {
      const label = activeGroupDocsLabel();
      const docs = Object.values(docsCache)
        .filter((d) => d.group === true)
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((d) => ({ path: d.path, title: d.title, directory: d.directory }));
      if (docs.length === 0) {
        const inGroup = getGroupContext() != null || getMemberBinding() != null;
        return jsonResult({
          docs: [],
          message: inGroup
            ? 'No group docs found — the shared store may be empty.'
            : `No group configured. This is a single-repo workspace. Group docs appear under the '${label}/' prefix once a group is set up.`,
        });
      }
      return jsonResult({ docs, label });
    },
  );

  server.tool(
    'read_group_doc',
    'Read the full body of a shared group doc by its path (e.g. "Product/features/payments"). Works from any workspace — parent or bound member.',
    {
      path: z.string().describe('Doc path as returned by list_group_docs (e.g. "Product/features/payments")'),
    },
    async ({ path: docPath }) => {
      const doc = docsCache[docPath];
      if (!doc || !doc.group) {
        return errorResult(
          `Group doc '${docPath}' not found. Use list_group_docs to see available paths.`,
        );
      }
      return jsonResult({ path: doc.path, title: doc.title, body: doc.body, directory: doc.directory });
    },
  );

  server.tool(
    'submit_group_doc',
    'Create or update a shared group doc through the parent repo, committing to flux-group-docs and fanning out to all members. Works from any workspace — parent or bound member. Returns the per-member fan-out result so you know which members received the change.',
    {
      path: z.string().describe(
        'Store-relative path for the doc, without the group prefix and without .md extension. Use forward slashes. Examples: "features/payments-api", "architecture/overview". Must be a single safe path segment (no .., no absolute paths).',
      ),
      title: z.string().describe('Document title (written as the first H1 heading).'),
      body: z.string().describe('Full markdown body content (not including the title heading — that is prepended automatically).'),
      message: z.string().optional().describe('Optional git commit message. Defaults to an auto-generated message.'),
    },
    async ({ path: storeRel, title, body, message }) => {
      const writer = getGroupContext() ?? getMemberBinding()?.parentGroup ?? null;
      if (!writer) {
        return errorResult(
          'No group writer is available. This workspace is not a group parent and is not bound to one. Set up a multi-repo group first (see get_project_group).',
        );
      }
      // Prepend the H1 title so the doc is self-contained.
      const content = `# ${title}\n\n${body.replace(/^\s+/, '')}`;
      try {
        const result = await submitGroupEdit(
          writer,
          [{ path: storeRel.endsWith('.md') ? storeRel : `${storeRel}.md`, content }],
          { message: message ?? `group: agent doc update (${storeRel})` },
        );
        const fanOut = result.sync.members.map((m) => ({
          name: m.name,
          ok: m.ok,
          ...(m.diverged ? { diverged: true } : {}),
          ...(m.error ? { error: m.error } : {}),
        }));
        return jsonResult({
          applied: result.applied,
          committed: result.sync.committed,
          pushed: result.sync.pushed,
          failed: result.sync.failed,
          members: fanOut,
        });
      } catch (err: any) {
        return errorResult(`Failed to submit group doc: ${err.message}`);
      }
    },
  );

  server.tool(
    'delete_group_doc',
    'Delete a shared group doc through the parent repo. Works from any workspace — parent or bound member. Returns the per-member fan-out result.',
    {
      path: z.string().describe(
        'Doc path as returned by list_group_docs (e.g. "Product/features/payments"). The group prefix is required here.',
      ),
    },
    async ({ path: docPath }) => {
      const writer = getGroupContext() ?? getMemberBinding()?.parentGroup ?? null;
      if (!writer) {
        return errorResult(
          'No group writer is available. This workspace is not a group parent and is not bound to one.',
        );
      }
      const storeRel = groupDocPathToStoreRelative(docPath);
      if (!storeRel) {
        return errorResult(
          `'${docPath}' is not a valid group doc path. It must start with the group docs prefix (e.g. 'Product/…').`,
        );
      }
      try {
        const result = await submitGroupEdit(writer, [{ path: storeRel, delete: true }]);
        const fanOut = result.sync.members.map((m) => ({
          name: m.name,
          ok: m.ok,
          ...(m.diverged ? { diverged: true } : {}),
          ...(m.error ? { error: m.error } : {}),
        }));
        return jsonResult({
          deleted: storeRel,
          committed: result.sync.committed,
          pushed: result.sync.pushed,
          failed: result.sync.failed,
          members: fanOut,
        });
      } catch (err: any) {
        return errorResult(`Failed to delete group doc: ${err.message}`);
      }
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

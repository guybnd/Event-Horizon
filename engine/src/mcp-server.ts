import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';

import { tasksCache, serializeTaskForAgent, updateTaskWithHistory, activateWorkspace, workspaceActivating, readTaskFromDisk, docsCache, createTask, atomicWriteFile, type CreateTaskOptions } from './task-store.js';
import { configCache, autoRegisterUnknownTags } from './config.js';
import { broadcastEvent } from './events.js';
import { validateTicketFrontmatter, formatValidationErrors } from './schema.js';
import { extractTicket } from './extract.js';
import { mergeTickets } from './merge.js';
import { normalizeHistoryEntries, buildActivityEntry } from './history.js';
import { getCliWorkspace, getActiveFluxDir, getWorkspacesList, workspaceRoot } from './workspace.js';
import { getTicketBranchStatus, deleteTicketBranch, createPullRequest, mergePullRequest, checkGhAuth, captureDiff, resolveCommit, planFinishPr, getDefaultBranch } from './branch-manager.js';
import { detachTaskWorktree, taskWorktreeDir, findWorktreeForBranch, worktreeChangeCount } from './task-worktree.js';
import { ensureTicketIsolation } from './ticket-isolation.js';
import { cleanupMergedBranch } from './pr-cleanup.js';
import { sharedNonDoneSiblings } from './pr-tickets.js';
import { existsSync, statSync, readFileSync } from 'fs';
import { getActiveSessionsForTask, stopAllSessionsForTask, reapStaleParkedSessions } from './session-store.js';
import { generatePromptNotification, dismissNotificationsForTicket, addNotification } from './notifications.js';
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

// Soft ceiling for ticket bodies written by agents. The body is injected in
// full into every future agent session, so oversized bodies tax every session
// on the ticket. The write is accepted either way — this only nudges.
const BODY_WARN_CHARS = 10_000;

function bodySizeWarning(body: string | undefined | null): string | undefined {
  if (!body || body.length <= BODY_WARN_CHARS) return undefined;
  return `Body is ${body.length} chars (soft limit ${BODY_WARN_CHARS}). Large bodies bloat every agent session on this ticket — keep the body a concise plan and move bulk material (logs, dumps, research) to .docs/ with a link.`;
}

/**
 * If `dir` is a **linked git worktree**, resolve the main working tree (which holds the
 * real `.flux`/`.flux-store`) so the MCP server binds to the canonical ticket store rather
 * than the worktree's empty one (FLUX-571). A linked worktree has a `.git` **file** (not a
 * dir) of the form `gitdir: <main>/.git/worktrees/<name>`; the main tree is the parent of
 * the common git dir. Returns null for a normal repo / bare / unreadable layout. Pure
 * filesystem (no subprocess) so it's cheap at MCP startup.
 */
export function resolveMainWorktree(dir: string): string | null {
  try {
    const gitPath = path.join(dir, '.git');
    if (!existsSync(gitPath) || statSync(gitPath).isDirectory()) return null; // normal repo or no repo
    const m = readFileSync(gitPath, 'utf8').trim().match(/^gitdir:\s*(.+)$/);
    if (!m || !m[1]) return null;
    let gitdir = m[1].trim(); // <main>/.git/worktrees/<name>
    if (!path.isAbsolute(gitdir)) gitdir = path.resolve(dir, gitdir);
    // The common git dir (<main>/.git) is recorded in `commondir`, else derive it by
    // stripping the `/worktrees/<name>` suffix.
    let commonDir: string;
    try {
      const cd = readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
      commonDir = path.isAbsolute(cd) ? cd : path.resolve(gitdir, cd);
    } catch {
      const norm = gitdir.replace(/\\/g, '/');
      const idx = norm.lastIndexOf('/worktrees/');
      if (idx === -1) return null;
      commonDir = gitdir.slice(0, idx);
    }
    const mainWorktree = path.dirname(commonDir); // parent of <main>/.git
    return existsSync(mainWorktree) ? path.resolve(mainWorktree) : null;
  } catch {
    return null;
  }
}

/**
 * FLUX-730/FLUX-731: the commit-before-Ready refusal *decision*, factored out of the
 * `change_status` handler so it can be unit-tested without an MCP-handler harness. Pure:
 * inputs in, decision out — no I/O.
 *
 * Refuse ONLY a worktree branch that exists and has 0 commits ahead of base — a dedicated
 * worktree means an agent did (or should have done) real work in an isolated tree, so 0
 * commits ahead means it was never committed and no PR can ever open (the FLUX-716/717/719
 * incident). Everything else allows: a worktree branch with commits ahead (falls through to
 * PR), a plain (non-worktree) branch with 0 commits ahead (kept as a soft warning per scope),
 * and branchless tickets (which legitimately stay uncommitted until finish).
 */
export function evaluateWorktreeReadyRefusal(input: {
  worktreePath: string | null;
  branchStatus: { exists: boolean; aheadCount: number } | null;
  ticketId: string;
  branch: string;
  readyStatus: string;
  /** Uncommitted change count in the worktree vs base, used only to phrase the message. */
  changeCount?: number;
}): { refuse: boolean; message?: string } {
  const { worktreePath, branchStatus, ticketId, branch, readyStatus, changeCount = 0 } = input;
  if (!(worktreePath && branchStatus && branchStatus.exists && branchStatus.aheadCount === 0)) {
    return { refuse: false };
  }
  const didWork = changeCount > 0
    ? `Its worktree has ${changeCount} uncommitted change${changeCount === 1 ? '' : 's'} — the work was done but never committed.`
    : `Its worktree has no changes yet.`;
  return {
    refuse: true,
    message:
      `Cannot move ${ticketId} to ${readyStatus}: its worktree branch \`${branch}\` has no commits ahead of base. ${didWork} ` +
      `Commit the worktree's work with a real message (in the worktree: \`git add -A && git commit\`), then retry the move to ${readyStatus} — that opens the PR for review. Status left unchanged.`,
  };
}

export async function startMcpServer(): Promise<void> {
  // MCP uses stdout for protocol messages — redirect all logging to stderr
  const originalLog = console.log;
  console.log = (...args: any[]) => console.error(...args);

  // Prefer the canonical workspace the engine pins via env (FLUX-516). An agent
  // running in a git worktree has cwd = the worktree, so `.mcp.json`'s
  // `--workspace .` would otherwise bind this server to the worktree's own (empty)
  // store instead of the real ticket store. EH_CANONICAL_WORKSPACE is the engine's
  // active workspace root, so worktree agents see and update their real tickets.
  // EH_CANONICAL_WORKSPACE (set by the agent adapters when EH spawns the agent) wins —
  // it's the engine's explicit canonical root. When it's absent (e.g. a session opened
  // manually in a worktree via "Open in VS Code"), fall back to --workspace/cwd, but if
  // THAT is a linked git worktree, redirect to the main working tree so the server still
  // binds to the real ticket store instead of the worktree's empty one (FLUX-571).
  const envWorkspace = process.env.EH_CANONICAL_WORKSPACE;
  let workspacePath = envWorkspace ? path.resolve(envWorkspace) : getCliWorkspace();
  if (!workspacePath) {
    console.error('MCP server requires --workspace <path> argument');
    process.exit(1);
  }
  if (!envWorkspace) {
    const mainTree = resolveMainWorktree(workspacePath);
    if (mainTree && mainTree !== path.resolve(workspacePath)) {
      console.error(`[mcp] ${workspacePath} is a linked worktree — binding to the canonical workspace ${mainTree} (FLUX-571)`);
      workspacePath = mainTree;
    }
  }

  await activateWorkspace(workspacePath);

  const server = buildMcpServer();

  // ─── Start Transport ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Build a fully-configured Event Horizon MCP server with every tool registered, WITHOUT
 * connecting a transport. Shared by the stdio entry path (`startMcpServer`, the `--mcp`
 * headless mode) and the in-process Streamable-HTTP mount on the engine
 * (`handleMcpHttpRequest`, FLUX-645). The caller owns transport + workspace activation;
 * the tools operate on the engine's already-active task-store cache.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'event-horizon',
    version: '1.0.0',
  });

  // ─── Context Tools ──────────────────────────────────────────────────────────

  server.tool(
    'get_ticket',
    'Read a ticket by ID — returns frontmatter, body, and recent history. agent_session entries are digested to one-line summaries (progress dropped, progressCount kept); history is windowed to the most recent entries, with the count of omitted older ones in olderHistoryEntries. Older entries that carry an agent summary are shown collapsed ({summary, id, collapsed:true}); pass their ids in `expand` to get the full text (or `fullHistory:true` for everything, discouraged).',
    {
      ticketId: z.string().describe('Ticket ID, e.g. FLUX-42'),
      historyLimit: z.number().int().positive().optional().describe('Max history entries to return (default 20)'),
      expand: z.array(z.string()).optional().describe('History entry ids to return in FULL (un-collapse). Pass the `id` shown on a collapsed entry when its summary is not enough.'),
      fullHistory: z.boolean().optional().describe('Return all history uncollapsed. Discouraged — defeats the digest and re-inflates context; prefer expand:[ids].'),
    },
    async ({ ticketId, historyLimit, expand, fullHistory }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      const { _path, ...output } = serializeTaskForAgent(task, historyLimit, { expand, fullHistory });
      return jsonResult(output);
    },
  );

  server.tool(
    'get_session_log',
    'Read the full progress log of one past agent session on a ticket. Use only when investigating what a specific prior session did — get_ticket already returns a digest of every session (sessionId + progressCount). Pass tail to fetch just the last N progress entries.',
    {
      ticketId: z.string().describe('Ticket ID, e.g. FLUX-42'),
      sessionId: z.string().describe('Session ID from a get_ticket agent_session history entry'),
      tail: z.number().int().positive().optional().describe('Return only the last N progress entries'),
    },
    async ({ ticketId, sessionId, tail }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      const history: any[] = Array.isArray(task.history) ? task.history : [];
      const entry = history.find((e: any) => e?.type === 'agent_session' && e?.sessionId === sessionId);
      if (!entry) {
        const known = history
          .filter((e: any) => e?.type === 'agent_session' && e?.sessionId)
          .map((e: any) => e.sessionId);
        return errorResult(
          `Session ${sessionId} not found on ${ticketId}.` +
          (known.length > 0 ? ` Known sessions: ${known.join(', ')}` : ' This ticket has no agent sessions.'),
        );
      }
      const progress: any[] = Array.isArray(entry.progress) ? entry.progress : [];
      if (tail != null && progress.length > tail) {
        return jsonResult({ ...entry, progress: progress.slice(-tail), omittedProgressEntries: progress.length - tail });
      }
      return jsonResult(entry);
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
        if (status !== undefined) opts.status = status;
        if (priority !== undefined) opts.priority = priority;
        if (effort !== undefined) opts.effort = effort;
        if (assignee !== undefined) opts.assignee = assignee;
        if (tags) opts.tags = tags;
        if (body !== undefined) opts.body = body;
        const { id, task } = await createTask(opts);
        const warning = bodySizeWarning(body);
        return jsonResult({ id, title: task.title, status: task.status, ...(warning ? { warning } : {}) });
      } catch (err: any) {
        return errorResult(err.message || 'Failed to create ticket');
      }
    },
  );

  // FLUX-656: the `extract` curation verb — carve a topic-slice out of a conversation stream
  // (the orchestrator thread `__board__` by default) into a NEW card. Gated in the CONFIRM
  // tier (below) and surfaced via the board-rebase `promote` proposal — never auto-applied.
  // It is additive (one op-log entry + a new ticket); the source turns are never moved.
  server.tool(
    'extract_ticket',
    'Carve a topic-slice out of a conversation stream into a NEW ticket (the promotion gate). A chat starts as turns in the orchestrator thread and materializes into a card only when it crosses a threshold — promotion is EXTRACTION, not 1:1: address the slice by seq range on the source stream. Human-approved only (CONFIRM gate / board-rebase proposal); the source turns are never moved or copied — the new card re-derives the slice.',
    {
      from: z.string().optional().describe('Source stream id to carve from (default: __board__, the orchestrator thread).'),
      fromSeq: z.number().int().describe('Inclusive start seq of the topic-slice on the source stream.'),
      toSeq: z.number().int().describe('Inclusive end seq of the topic-slice on the source stream.'),
      title: z.string().describe('Title for the new ticket.'),
      priority: z.string().optional().describe('Priority (default: None).'),
      effort: z.string().optional().describe('Effort estimate (default: None).'),
      tags: z.array(z.string()).optional().describe('Tags array.'),
      body: z.string().optional().describe('Markdown body for the new ticket.'),
    },
    async ({ from, fromSeq, toSeq, title, priority, effort, tags, body }) => {
      if (workspaceActivating) return errorResult('Workspace is activating, please retry');
      try {
        const result = await extractTicket({
          ...(from !== undefined ? { from } : {}),
          fromSeq,
          toSeq,
          title,
          ...(priority !== undefined ? { priority } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(tags ? { tags } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        return jsonResult(result);
      } catch (err: any) {
        return errorResult(err.message || 'Failed to extract ticket');
      }
    },
  );

  // FLUX-657: the `merge` curation verb — fold several chat-streams/tickets into ONE survivor
  // effort (the inverse of extract). Gated in the CONFIRM tier (below) and surfaced via the
  // board-rebase `fold` proposal — never auto-applied. Additive (one op-log entry); the source
  // turns are never moved, and each source is tombstoned + archived (not deleted).
  server.tool(
    'merge_tickets',
    'Fold several tickets/chat-streams into ONE survivor effort — the inverse of extract, for when "three chats are really one effort." The survivor\'s transcript re-derives as the chronological union of its own turns plus every source stream\'s turns (source attribution preserved); each source ticket is tombstoned (mergedInto pointer + pinned comment) and archived, never deleted — its turns stay intact in the substrate. Additive and reversible (one op in the curation op-log). Human-approved only (CONFIRM gate / board-rebase `fold` proposal).',
    {
      into: z.string().describe('Survivor ticket id the sources fold into.'),
      from: z.array(z.string()).describe('Source ticket/stream ids to fold into the survivor (each gets tombstoned + archived). Must be non-empty and exclude `into`.'),
    },
    async ({ into, from }) => {
      if (workspaceActivating) return errorResult('Workspace is activating, please retry');
      try {
        const result = await mergeTickets({ into, from });
        return jsonResult(result);
      } catch (err: any) {
        return errorResult(err.message || 'Failed to merge tickets');
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

      // Build the merged frontmatter for a pre-write schema check. The authoritative write below
      // re-reads + re-applies these inside the per-ticket lock (updateTaskWithHistory).
      const { frontmatter } = await readTaskFromDisk(task);
      if (title !== undefined) frontmatter.title = title;
      if (priority !== undefined) frontmatter.priority = priority;
      if (effort !== undefined) frontmatter.effort = effort;
      if (assignee !== undefined) frontmatter.assignee = assignee;
      if (tags !== undefined) frontmatter.tags = tags;
      if (implementationLink !== undefined) frontmatter.implementationLink = implementationLink;

      const validationErrors = validateTicketFrontmatter(frontmatter);
      if (validationErrors.length > 0) {
        return errorResult(`Schema validation failed:\n${formatValidationErrors(validationErrors)}`);
      }

      if (tags !== undefined && Array.isArray(tags)) {
        await autoRegisterUnknownTags(tags);
      }

      const fieldChanges: string[] = [];
      if (title !== undefined && title !== task.title) fieldChanges.push('Updated title.');
      if (body !== undefined && body !== task.body) fieldChanges.push('Updated description.');
      if (priority !== undefined && priority !== task.priority) fieldChanges.push(`Changed priority to ${priority}.`);
      if (effort !== undefined && effort !== task.effort) fieldChanges.push(`Changed effort to ${effort}.`);
      if (assignee !== undefined && assignee !== task.assignee) fieldChanges.push(`Changed assignee to ${assignee}.`);
      if (tags !== undefined) fieldChanges.push('Updated tags.');
      if (implementationLink !== undefined) fieldChanges.push('Updated implementation link.');

      const extraFields: Record<string, any> = {};
      if (priority !== undefined) extraFields.priority = priority;
      if (effort !== undefined) extraFields.effort = effort;
      if (assignee !== undefined) extraFields.assignee = assignee;
      if (tags !== undefined) extraFields.tags = tags;
      if (implementationLink !== undefined) extraFields.implementationLink = implementationLink;

      // FLUX-788: route through the locked + atomic write path (FLUX-645/290) instead of a bare
      // fs.writeFile read-modify-write, which raced concurrent add_comment/log_progress/change_status
      // on the same ticket and could drop the history append or expose a half-written file.
      try {
        const result = await updateTaskWithHistory(ticketId, {
          updatedBy: 'Agent',
          entries: fieldChanges.length > 0
            ? [buildActivityEntry(fieldChanges.join(' '), 'Agent', new Date().toISOString())]
            : [],
          ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
          ...(title !== undefined ? { newTitle: title } : {}),
          ...(body !== undefined ? { newBody: body } : {}),
        });
        if (!result) return errorResult(`Failed to update ${ticketId}`);
      } catch (err: any) {
        return errorResult(`Failed to update ${ticketId}: ${err?.message || err}`);
      }

      broadcastEvent('taskUpdated', { id: ticketId });
      const warning = body !== undefined ? bodySizeWarning(body) : undefined;
      return textResult(`Updated ${ticketId}${warning ? `\nWarning: ${warning}` : ''}`);
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
      reviewState: z.enum(['approved', 'changes-requested']).nullable().optional().describe('FLUX-816: the EH review verdict to record on the card. Set "approved" when concluding a review to Ready, "changes-requested" when sending back to In Progress. Pass null to clear. Surfaces a review badge; distinct from the GitHub-synced reviewDecision.'),
    },
    async ({ ticketId, newStatus, comment, callerRole, reviewState }) => {
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

      const extraFields: Record<string, any> = {};

      // FLUX-816: record the EH review verdict alongside the status move so the card reflects it.
      // Passed explicitly by the review orchestrator (approved→Ready, changes-requested→In Progress)
      // or null to clear. No auto-clear on re-entry to In Progress — a 'changes-requested' verdict
      // legitimately coincides with In Progress and must persist until the next review concludes.
      if (reviewState !== undefined) {
        extraFields.reviewState = reviewState;
      }

      // Clear swimlane when moving out of a blocked state (e.g. user answered the question)
      if (task.swimlane && newStatus !== requireInputStatus) {
        extraFields.swimlane = null;
        entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
        dismissNotificationsForTicket(ticketId);
      }

      // When moving to Ready with a branch, push and create a PR for review (FLUX-555).
      // The work MUST be committed before Ready — a branch with no commits ahead of base
      // can't open a PR.
      if (newStatus === readyStatus && task.branch) {
        const branchStatus = await getTicketBranchStatus(task.branch).catch(() => null);

        // FLUX-730: ENFORCE commit-before-Ready for *worktree* branches. A dedicated worktree
        // means an agent did (or should have done) real work in an isolated tree; reaching Ready
        // with 0 commits ahead means it was never committed, so no PR can ever open and the work
        // sits silently uncommitted (the FLUX-716/717/719 incident). Refuse the transition —
        // don't just warn — so the agent is forced to commit. Git-only (no gh dependency), so it
        // holds even when gh is unauthed. Scope: ONLY worktree branches. Plain-branch tickets and
        // branchless tickets keep their existing behavior (branchless legitimately stays
        // uncommitted until finish), so the refusal is gated on an actual worktree existing.
        const worktreePath = await findWorktreeForBranch(workspaceRoot!, task.branch).catch(() => null);
        if (worktreePath && branchStatus && branchStatus.exists && branchStatus.aheadCount === 0) {
          const baseBranch = await getDefaultBranch().catch(() => 'master');
          const changeCount = await worktreeChangeCount(worktreePath, baseBranch).catch(() => 0);
          const decision = evaluateWorktreeReadyRefusal({
            worktreePath,
            branchStatus,
            ticketId,
            branch: task.branch,
            readyStatus,
            changeCount,
          });
          if (decision.refuse) return errorResult(decision.message!);
        }

        // Rather than fail silently in a buried activity line, surface a no-commit branch
        // LOUDLY (notification + comment) so the user/agent knows to commit (FLUX-563).
        const ghAvailable = await checkGhAuth();
        if (ghAvailable) {
          if (branchStatus && branchStatus.exists && branchStatus.aheadCount === 0) {
            // Non-worktree (plain) branch with no commits: can't open a PR. Plain-branch tickets
            // are NOT enforced (per scope) — keep the existing soft warning + notification.
            const msg = `${ticketId} moved to ${readyStatus} but its branch \`${task.branch}\` has no commits yet — commit the work to open a PR for review.`;
            entries.push({ type: 'activity', user: 'Agent', comment: `⚠️ ${msg}`, date: new Date().toISOString() });
            addNotification({
              type: 'info',
              title: 'Commit needed to open PR',
              message: msg,
              ticketId,
              actions: [{ label: 'Open worktree', actionId: 'open-worktree' }],
            });
          } else {
            try {
              const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
              const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
              extraFields.implementationLink = prUrl;
              extraFields.swimlane = 'open-pr';
              entries.push({ type: 'activity', user: 'Agent', comment: `PR created: ${prUrl}`, date: new Date().toISOString() });
            } catch (err: any) {
              const msg = `PR creation failed: ${err.message}. Push the branch / commit work manually.`;
              entries.push({ type: 'activity', user: 'Agent', comment: `⚠️ ${msg}`, date: new Date().toISOString() });
              addNotification({ type: 'error', title: 'PR creation failed', message: `${ticketId}: ${msg}`, ticketId, actions: [{ label: 'Open worktree', actionId: 'open-worktree' }] });
            }
          }
        }
      }

      const prevStatus = task.status;
      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: newStatus,
        ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      });

      if (!result) return errorResult(`Failed to update ${ticketId}`);

      // FLUX-721: a forward transition abandons any session still parked (waiting-input) on an
      // EARLIER phase — reap them so they don't linger as merge-gating (FLUX-636 Tier-2) or
      // start-blocking (FLUX-667) zombies. The Require-Input branch above returns early (parking
      // is legitimate there), so this runs only on forward moves; the helper preserves the live
      // caller ('running') and the persistent per-ticket 'chat' session (FLUX-602).
      if (newStatus !== prevStatus) {
        const reaped = reapStaleParkedSessions(ticketId, `ticket moved to ${newStatus}`);
        if (reaped.length > 0) {
          await updateTaskWithHistory(ticketId, {
            updatedBy: 'Agent',
            entries: [{ type: 'activity', user: 'Agent', comment: `Reaped ${reaped.length} stale parked session${reaped.length > 1 ? 's' : ''} from an earlier phase on move to ${newStatus}.`, date: new Date().toISOString() }],
          });
        }
      }

      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} moved to ${newStatus}`);
    },
  );

  server.tool(
    'archive_ticket',
    'Safely remove a ticket from the active board by moving it to the Archived status. This is the reversible alternative to deletion — history is preserved and the ticket can be brought back with unarchive_ticket. There is no hard-delete tool; prefer archiving.',
    {
      ticketId: z.string().describe('Ticket ID'),
      comment: z.string().optional().describe('Optional reason for archiving (recorded in history).'),
    },
    async ({ ticketId, comment }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const archiveStatus = configCache.archiveStatus || 'Archived';
      if (task.status === archiveStatus) {
        return textResult(`${ticketId} is already ${archiveStatus}`);
      }

      const entries: any[] = [];
      if (comment) {
        entries.push({ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() });
      }

      const extraFields: Record<string, any> = {};
      // Clear any swimlane so the archived ticket doesn't keep a stale blocked flag.
      if (task.swimlane) {
        extraFields.swimlane = null;
        entries.push({ type: 'swimlane_change', swimlane: task.swimlane, action: 'cleared', user: 'Agent', date: new Date().toISOString() });
        dismissNotificationsForTicket(ticketId);
      }

      const result = await updateTaskWithHistory(ticketId, {
        entries,
        updatedBy: 'Agent',
        nextStatus: archiveStatus,
        ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
      });
      if (!result) return errorResult(`Failed to archive ${ticketId}`);

      // FLUX-721: an archived ticket is off the active board — reap any sessions still parked on
      // an earlier phase so they don't linger as zombies. Preserves the persistent 'chat' session.
      reapStaleParkedSessions(ticketId, `ticket archived → ${archiveStatus}`);

      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} archived (moved to ${archiveStatus})`);
    },
  );

  server.tool(
    'unarchive_ticket',
    'Bring an archived ticket back onto the active board by moving it out of the Archived status. Defaults to "Todo"; pass toStatus to restore it to a specific column.',
    {
      ticketId: z.string().describe('Ticket ID'),
      toStatus: z.string().optional().describe('Status to restore the ticket to (default: "Todo")'),
    },
    async ({ ticketId, toStatus }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const archiveStatus = configCache.archiveStatus || 'Archived';
      if (task.status !== archiveStatus) {
        return errorResult(`${ticketId} is not archived (status is ${task.status}).`);
      }

      const target = toStatus || 'Todo';
      if (target === archiveStatus) {
        return errorResult(`Cannot unarchive ${ticketId} to ${archiveStatus} — choose a non-archive status.`);
      }

      const result = await updateTaskWithHistory(ticketId, {
        entries: [],
        updatedBy: 'Agent',
        nextStatus: target,
      });
      if (!result) return errorResult(`Failed to unarchive ${ticketId}`);

      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} unarchived (moved to ${target})`);
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
      summary: z.string().optional().describe('Faithful one-paragraph summary of this comment. Once it ages out of the recent window, the agent digest shows the summary instead of the full text (full text still fetchable on demand). Write it for a substantial comment; preserve the decision/why/anything actionable — concise but NOT lossy. Skip for short comments.'),
      pin: z.boolean().optional().describe('Pin this comment so it is NEVER collapsed in the agent digest (use for review handoffs / key decisions that must always stay visible in full).'),
      supersedes: z.array(z.string()).optional().describe('History entry id(s) this comment makes obsolete (e.g. it reverses or replaces an earlier decision). The superseded entries collapse to a one-line marker in the agent digest so the next session reads the live decision, not the dead one — still recoverable via get_ticket expand. Set this ONLY when genuinely retiring a now-wrong entry; a pinned or user-authored target is treated as advisory-only (kept full) — the engine will not bury human intent on an agent\'s say-so.'),
    },
    async ({ ticketId, comment, user, summary, pin, supersedes }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const actor = user || 'Agent';
      const entries = [{
        type: 'comment', user: actor, comment, date: new Date().toISOString(),
        ...(summary && summary.trim() ? { summary: summary.trim() } : {}),
        ...(pin ? { pin: true } : {}),
        ...(Array.isArray(supersedes) && supersedes.length ? { supersedes } : {}),
      }];
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
      summary: z.string().optional().describe('Faithful summary shown in the agent digest once this note ages out of the recent window (full text fetchable on demand). Write it for a long note; concise but not lossy. Skip for short ones.'),
      pin: z.boolean().optional().describe('Pin so this note is never collapsed in the agent digest.'),
      supersedes: z.array(z.string()).optional().describe('History entry id(s) this note makes obsolete (it records that an earlier decision/plan no longer holds). The superseded entries collapse to a one-line marker in the agent digest — still recoverable via get_ticket expand. A pinned or user-authored target is advisory-only (kept full); the engine will not bury human intent on an agent\'s say-so.'),
    },
    async ({ ticketId, message, summary, pin, supersedes }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const activityTimestamp = new Date().toISOString();
      const extra: Record<string, unknown> = {
        ...(summary && summary.trim() ? { summary: summary.trim() } : {}),
        ...(pin ? { pin: true } : {}),
        ...(Array.isArray(supersedes) && supersedes.length ? { supersedes } : {}),
      };
      const entries = [buildActivityEntry(message, 'Agent', activityTimestamp, extra)];
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
      force: z.boolean().optional().describe('Override the shared-PR guard: merge even though the branch is shared by non-Done sibling tickets (their work merges + they advance to Done too).'),
    },
    async ({ ticketId, implementationLink, completionComment, force }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);

      const readyStatus = configCache.readyForMergeStatus || 'Ready';
      if (task.status !== readyStatus) {
        return errorResult(
          `Cannot finish ${ticketId} — ticket must be in "${readyStatus}" status first (current: "${task.status}"). ` +
          `Move to "${readyStatus}" with change_status and wait for user confirmation before finishing.`
        );
      }

      // Finish-on-shared-PR guard (FLUX-569, from the FLUX-556/PR#6 incident): finishing one
      // member of a SHARED branch merges the whole PR — advancing every bundled sibling to Done
      // as a one-way door, even ones that aren't finished. Refuse when the branch is shared by
      // non-Done sibling tickets, unless `force`. Exempt PR tickets (kind:'pr'): merging a PR
      // ticket to advance its members IS the sanctioned shared-merge surface.
      if (task.branch && task.kind !== 'pr' && !force) {
        const nonDone = sharedNonDoneSiblings(Object.values(tasksCache) as any[], task.branch, ticketId);
        if (nonDone.length > 0) {
          return errorResult(
            `Cannot finish ${ticketId} — its branch \`${task.branch}\` is shared by ${nonDone.length} sibling ticket(s) that are NOT Done: ` +
            `${nonDone.map((t) => `${t.id} (${t.status})`).join(', ')}. Merging would advance them all to Done as a one-way door. ` +
            `Either finish/close those siblings first, merge via the PR ticket, or re-run finish with force:true if you intend to land the whole shared PR. ` +
            `(If this is a blocking call, raise it via Require Input — don't leave it only in chat — FLUX-570.)`
          );
        }
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

        // Ensure an OPEN PR exists before merging (FLUX-578 + FLUX-741). finish must be
        // self-sufficient: the PR is normally opened at the Ready transition, but if that didn't
        // happen (work committed only now) we open it here. CRITICALLY, a branch whose prior PR is
        // already MERGED/CLOSED (a commit pushed after that PR merged — FLUX-656) must NOT fall
        // through to `gh pr merge` on the dead PR (which throws "already merged" and strands the
        // commit) — planFinishPr opens a FRESH PR for it instead. A branch with 0 commits ahead
        // can't get a PR → route to Require Input (FLUX-570: don't leave a blocker only in chat).
        try {
          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
          const plan = await planFinishPr(task.branch, task.title || ticketId, prBody);
          if (plan.action === 'blocked') {
            const msg = `Cannot finish ${ticketId} — ${plan.reason} Commit your work, then finish again.`;
            await updateTaskWithHistory(ticketId, {
              entries: [{ type: 'comment', user: 'Agent', comment: `⚠️ ${msg}`, date: new Date().toISOString() }],
              updatedBy: 'Agent',
              nextStatus: configCache.requireInputStatus || 'Require Input',
              extraFields: { swimlane: 'require-input' },
            });
            broadcastEvent('taskUpdated', { id: ticketId });
            return errorResult(`${msg} Ticket moved to Require Input.`);
          }
          if (plan.action === 'created' && plan.url) finalLink = plan.url;
        } catch (createErr: any) {
          await updateTaskWithHistory(ticketId, { entries: [{ type: 'comment', user: 'Agent', comment: `⚠️ Finish aborted — could not open a PR: ${createErr.message}.`, date: new Date().toISOString() }], updatedBy: 'Agent', nextStatus: 'In Progress' });
          broadcastEvent('taskUpdated', { id: ticketId });
          return errorResult(`Cannot finish ${ticketId} — PR creation failed: ${createErr.message}. Ticket moved back to In Progress.`);
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
      // Clear any swimlane (e.g. open-pr) as we move to Done — finish used to leave it set,
      // so merged tickets kept glowing as open PRs forever (FLUX-574).
      const finishExtraFields: Record<string, any> = { implementationLink: finalLink, swimlane: null };

      // Capture diff summary + sidecar file. Best-effort — failure here must not block finish.
      try {
        // Lazy repair: if baselineCommit is missing at finish (ticket never went through the
        // launch hook), anchor it at HEAD's parent. By finish time the ticket's commit is
        // already HEAD, so stamping HEAD would yield an empty HEAD..HEAD range — the parent
        // gives the plan's intended HEAD~1..HEAD fallback. If the parent is unavailable (root
        // commit) leave it null and let captureDiff handle it.
        if (!task.branch && !task.baselineCommit) {
          const parent = await resolveCommit('HEAD~1');
          if (parent) {
            await updateTaskWithHistory(ticketId, {
              updatedBy: 'Agent',
              extraFields: { baselineCommit: parent },
            });
            task.baselineCommit = parent;
          }
        }

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

      // FLUX-721: now that the ticket is Done, reap any sessions still parked on an earlier phase
      // so they don't linger as start-blocking zombies. Preserves the persistent 'chat' session.
      const reapedOnFinish = reapStaleParkedSessions(ticketId, 'ticket finished → Done');
      if (reapedOnFinish.length > 0) {
        await updateTaskWithHistory(ticketId, {
          updatedBy: 'Agent',
          entries: [{ type: 'activity', user: 'Agent', comment: `Reaped ${reapedOnFinish.length} stale parked session${reapedOnFinish.length > 1 ? 's' : ''} from an earlier phase on finish.`, date: new Date().toISOString() }],
        });
      }

      // Post-merge cleanup — the SAME unified path as POST /:id/pr/merge (FLUX-574): for a
      // branch ticket, `cleanupMergedBranch` tears down the worktree (by branch, so shared
      // worktrees resolve correctly), switches the main tree off the branch if needed, then
      // force-deletes the branch and fast-forwards master — in the correct order, so the
      // branch-delete no longer fails after the merge already landed. It skips re-advancing
      // this already-Done ticket. A dirty worktree is kept + flagged (never stashed to
      // master post-merge). Best-effort — a failure here must not undo the finish.
      if (task.branch) {
        try {
          await cleanupMergedBranch(workspaceRoot!, task.branch);
        } catch (cleanupErr: any) {
          console.error(`Post-merge cleanup failed for ${ticketId}:`, cleanupErr.message);
        }
      }

      broadcastEvent('taskUpdated', { id: ticketId });
      return textResult(`${ticketId} finished → Done (link: ${finalLink})`);
    },
  );

  // ─── Branch Tools ──────────────────────────────────────────────────────────

  server.tool(
    'create_branch',
    'Create a git feature branch for a ticket and store its name on the ticket. Optionally spin up a dedicated git worktree so the agent runs isolated from master (FLUX-516).',
    {
      ticketId: z.string().describe('Ticket ID'),
      baseBranch: z.string().optional().describe('Base branch (default: master)'),
      worktree: z.boolean().optional().describe('Create a dedicated git worktree for this branch. Agent branch sessions are worktree-isolated BY DEFAULT (FLUX-741) so parallel ticket sessions never share a checkout; pass `worktree:false` to run in the shared main tree instead (single-checkout / human-manual escape). Implies a branch.'),
    },
    async ({ ticketId, baseBranch, worktree }) => {
      const task = tasksCache[ticketId];
      if (!task) return errorResult(`Ticket ${ticketId} not found`);
      if (task.branch) return errorResult(`Ticket ${ticketId} already has branch: ${task.branch}`);

      try {
        // FLUX-521: optionally create a dedicated worktree (worktree ⇒ branch).
        // FLUX-741: agent branch sessions are worktree-isolated BY DEFAULT — two parallel ticket
        // sessions must never share one checkout (the FLUX-734/739 loss, where a shared-root switch
        // discarded uncommitted work). The explicit `worktree` param is the per-call escape
        // (`worktree:false` → run in the shared main tree). The portal/human "Start task" path keeps
        // its own `worktreeByDefault` default (off, see routes/tasks.ts) — this flip is agent-only.
        // FLUX-845: the branch+worktree mechanism is centralized in ensureTicketIsolation; this tool
        // only resolves the agent POLICY (worktree-by-default) and delegates.
        const result = await ensureTicketIsolation(ticketId, { worktree: worktree ?? true, baseBranch });
        return jsonResult(result);
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
        // FLUX-521: a branch can't be deleted while a worktree holds it checked out —
        // stop the session (release the cwd lock) and detach. This is an ABANDON, so
        // uncommitted work is preserved as a stash ref but NOT applied onto master.
        const wtPath = taskWorktreeDir(workspaceRoot!, ticketId);
        if (existsSync(wtPath)) {
          stopAllSessionsForTask(ticketId, 'Deleting branch — detaching worktree');
          await detachTaskWorktree(workspaceRoot!, wtPath, { ticketId, applyToMain: false });
        }
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
        // skipBroadcast: defer the taskCreated event until after the child is
        // linked to its parent, so a failed parent write never emits an event
        // for an orphan child (FLUX-435).
        const opts: CreateTaskOptions = { title, author: 'Agent', parentId, skipBroadcast: true };
        if (status !== undefined) opts.status = status;
        if (priority !== undefined) opts.priority = priority;
        if (effort !== undefined) opts.effort = effort;
        if (assignee !== undefined) opts.assignee = assignee;
        if (tags) opts.tags = tags;
        if (body !== undefined) opts.body = body;
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

        // Now that both the child and the parent link are persisted, emit the
        // creation event (FLUX-435).
        broadcastEvent('taskCreated', { id: childId, parentId });

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
      phase: z.string().optional().describe('Filter by phase (grooming, implementation, review, finalize). Omit to see all.'),
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
        const framework = process.env.EVENT_HORIZON_FRAMEWORK || 'claude';
        const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/delegate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            framework,
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
          const framework = process.env.EVENT_HORIZON_FRAMEWORK || 'claude';
          const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/delegate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              framework,
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

  server.tool(
    'start_session',
    'Start an agent work session ON a ticket and return IMMEDIATELY (fire-and-forget). Use this to DISPATCH work: when the user asks to groom/implement/review/finalize a ticket, start the phase session on that ticket instead of doing the work yourself in this chat. The session runs in the ticket\'s own scope; the user opens that ticket\'s chat to drive it. Unlike delegate_to_agent, this does NOT wait for the session to finish.',
    {
      ticketId: z.string().describe('Ticket ID to start the session on'),
      phase: z.enum(['grooming', 'implementation', 'review', 'finalize']).optional().describe('Work phase — drives the session mission. If omitted, the engine derives it from the ticket status.'),
      personaId: z.string().optional().describe('Optional persona to lead the session (from list_available_agents). Default: the phase\'s solo lead.'),
      effort: z.string().optional().describe('Effort level: low, medium, high, xhigh.'),
      worktree: z.boolean().optional().describe('Isolate the session in a dedicated git worktree (FLUX-845). Defaults to TRUE: agent dispatch is unattended and often concurrent, so it must never share a checkout with another session. Pass `worktree:false` for the single-checkout / shared-tree escape (manual case).'),
    },
    async ({ ticketId, phase, personaId, effort, worktree }) => {
      try {
        const framework = process.env.EVENT_HORIZON_FRAMEWORK || 'claude';
        // FLUX-845: isolate by default — the engine creates the branch+worktree before spawning.
        const body: Record<string, unknown> = {
          framework,
          skipPermissions: true,
          patternPosition: 'standalone',
          isolation: worktree === false ? 'branch' : 'worktree',
        };
        if (phase) body.phase = phase;
        if (personaId) body.personaId = personaId;
        if (effort) body.effortOverride = effort;
        const res = await fetch(`${ENGINE_URL}/api/tasks/${ticketId}/cli-session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResult(`Failed to start session on ${ticketId}: ${err.error || res.statusText}`);
        }
        const result = await res.json();
        const sid = result.session?.id || 'unknown';
        return textResult(`Started a ${phase || 'phase'} session on ${ticketId} (session ${sid}). It is running in the ticket's own scope — open ${ticketId}'s chat to drive it.`);
      } catch (err: any) {
        return errorResult(`Failed to start session: ${err.message}`);
      }
    },
  );

  server.tool(
    'get_board_state',
    'Live snapshot of board activity: which tickets have ACTIVE agent sessions right now and what each is doing, plus ticket counts by status. Use this to see the field before dispatching work or to check on running sessions.',
    {},
    async () => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/state`);
        if (!res.ok) return errorResult(`Failed to get board state: ${res.statusText}`);
        return jsonResult(await res.json());
      } catch (err: any) {
        return errorResult(`Failed to get board state: ${err.message}`);
      }
    },
  );

  // FLUX-659: the board-rebase ritual. The orchestrator emits a BATCH of proposed restructurings
  // for the human to approve in one pass; this parks the batch (engine-side) and broadcasts it —
  // it does NOT mutate. Fire-then-resolve: the tool returns immediately (unlike permission_prompt,
  // which blocks). "Propose, never silently restructure."
  server.tool(
    'propose_board_rebase',
    'Propose a BATCH of board restructurings for the human to approve in one pass — the board-rebase ritual. Use this when asked to triage / "rebase the board" or at end-of-session, INSTEAD of mutating the board directly. Each item is a single action the user approves or rejects; nothing is applied until they click Apply approved. NEVER call the restructuring verbs (extract_ticket / merge_tickets / archive_ticket / change_status) directly to reorganize the board — emit them here as proposals. Returns immediately; the proposal is parked for approval.',
    {
      items: z.array(z.object({
        kind: z.enum(['promote', 'fold', 'archive', 'dispatch', 'status', 'leave']).describe('promote = extract a chat/turns into a new card (FLUX-656); fold = merge one stream into another (FLUX-657); archive = retire the ticket(s); dispatch = start a phase session; status = move a ticket to a new status; leave = keep it in the orchestrator thread (the safe default — never drop an item, leave it).'),
        targets: z.array(z.string()).describe('Ticket id(s) the item acts on, e.g. ["FLUX-123"]. For fold, the source stream(s) being merged.'),
        summary: z.string().describe('One-line human-readable description of the proposed action.'),
        rationale: z.string().optional().describe('Why you propose this — shown under the summary and recorded as a comment when applied.'),
        newStatus: z.string().optional().describe('For kind "status": the target status.'),
        phase: z.string().optional().describe('For kind "dispatch": the phase (grooming / implementation / review / finalize).'),
        into: z.string().optional().describe('For kind "fold": the destination ticket the sources merge into.'),
        fromSeq: z.number().int().optional().describe('For kind "promote": inclusive start seq of the topic-slice on the source stream (targets[0], default __board__).'),
        toSeq: z.number().int().optional().describe('For kind "promote": inclusive end seq of the topic-slice on the source stream.'),
        title: z.string().optional().describe('For kind "promote": title for the new card the slice seeds (falls back to the summary).'),
      })).min(1).describe('The batch of proposed restructurings.'),
    },
    async ({ items }) => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/board-rebase`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, conversationId: process.env.EH_CONVERSATION_ID || null }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return errorResult(`Failed to surface board-rebase proposal: ${err.error || res.statusText}`);
        }
        const result = await res.json();
        return textResult(`Surfaced a board-rebase proposal with ${result.count} item(s) for the user to approve (batch ${result.id}). The proposal is PARKED — nothing has been applied. The user reviews each item and clicks "Apply approved" (or "Dismiss"). Do not call the restructuring verbs directly.`);
      } catch (err: any) {
        return errorResult(`Board-rebase channel unavailable: ${err.message}`);
      }
    },
  );

  // FLUX-605: permission policy for gated sessions (--permission-prompt-tool).
  const SAFE_PERMISSION_TOOLS = new Set([
    'get_ticket', 'list_tickets', 'get_board_config', 'get_branch', 'get_project_group', 'get_board_state',
    'list_available_agents', 'read_group_doc', 'list_group_docs', 'get_session_log',
    // FLUX-659: the proposal path is always safe — it parks a batch for human approval, never mutates.
    'propose_board_rebase',
    'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead',
  ]);
  // FLUX-659 teeth: the restructuring verbs join the CONFIRM tier so a DIRECT orchestrator call to
  // mutate the board is gated even if it bypasses the board-rebase ritual — "never silently
  // restructure" is enforced by the gate, not just the prompt. extract_ticket (FLUX-656) and
  // merge_tickets (FLUX-657) are both live and registered above; they are gated here.
  const CONFIRM_PERMISSION_TOOLS = new Set([
    'change_status', 'delete_branch', 'finish_ticket', 'Bash',
    'archive_ticket', 'extract_ticket', 'merge_tickets',
  ]);
  function permissionDecisionFor(toolName: string): 'allow' | 'deny' | 'confirm' {
    const bare = toolName.replace(/^mcp__.+?__/, '');
    if (SAFE_PERMISSION_TOOLS.has(bare)) return 'allow';
    if (CONFIRM_PERMISSION_TOOLS.has(bare)) return 'confirm';
    return 'allow';
  }

  server.tool(
    'permission_prompt',
    'Internal — Claude Code calls this via --permission-prompt-tool to decide if a tool call is permitted. Returns {behavior:"allow",updatedInput} or {behavior:"deny",message}. Reads auto-allow; destructive ops (change_status, delete_branch, finish_ticket, Bash) require human approval via the EH portal.',
    { tool_name: z.string(), input: z.any().optional() },
    async ({ tool_name, input }) => {
      const decision = permissionDecisionFor(tool_name);
      if (decision === 'allow') return jsonResult({ behavior: 'allow', updatedInput: input ?? {} });
      if (decision === 'deny') return jsonResult({ behavior: 'deny', message: `${tool_name} is not permitted.` });
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool_name, input, conversationId: process.env.EH_CONVERSATION_ID || null, conversationToken: process.env.EH_CONVERSATION_TOKEN || null }),
        });
        if (!res.ok) return jsonResult({ behavior: 'deny', message: 'Approval channel error — denied.' });
        return jsonResult(await res.json());
      } catch (err: any) {
        return jsonResult({ behavior: 'deny', message: `Approval channel unavailable — denied (${err.message}).` });
      }
    },
  );

  // FLUX-662: structured question → portal picker → answer-in-the-same-turn. The working
  // substitute for the native AskUserQuestion (which can't be fulfilled in `claude -p` print
  // mode). Schema mirrors the native tool so agents reach for it the same way; the handler
  // POSTs to the engine and BLOCKS on the response, which is held open until the user answers
  // (or a 4-minute timeout returns an `unanswered` sentinel — kept under undici's 300s
  // headersTimeout so the held-open fetch doesn't abort before the park resolves).
  server.tool(
    'ask_user_question',
    'Ask the user a structured multiple-choice question and BLOCK until they answer. Renders an interactive picker in the EH chat/board surface (single- or multi-select, with an "Other" free-text option) and returns the user\'s selection so you can continue the same turn. Use this whenever you need a decision or to resolve ambiguity instead of guessing — never assume; ask. Returns { answers: { [question]: chosenLabel | chosenLabel[] }, notes? }. If the user does not answer in time you get an unanswered result and should proceed with your best judgment.',
    {
      questions: z.array(z.object({
        question: z.string().describe('The full question to ask the user.'),
        header: z.string().describe('A very short label/category for the question (a few words).'),
        options: z.array(z.object({
          label: z.string().describe('The option text shown to (and returned for) the user.'),
          description: z.string().optional().describe('Optional longer explanation of what this option means.'),
        })).min(1).describe('The choices the user can pick from.'),
        multiSelect: z.boolean().optional().describe('Allow the user to select multiple options (default false).'),
      })).min(1).describe('One or more questions to ask (usually one).'),
    },
    async ({ questions }) => {
      try {
        const res = await fetch(`${ENGINE_URL}/api/board/ask-question`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questions, conversationId: process.env.EH_CONVERSATION_ID || null, conversationToken: process.env.EH_CONVERSATION_TOKEN || null }),
        });
        if (!res.ok) return errorResult('Ask-question channel error — no answer received. Proceed with your best judgment or ask again.');
        const result = await res.json();
        if (result?.unanswered) {
          return textResult('The user did not answer in time. Proceed using your best judgment, or ask again if the answer is essential.');
        }
        return jsonResult({ answers: result.answers ?? {}, ...(result.notes ? { notes: result.notes } : {}) });
      } catch (err: any) {
        return errorResult(`Ask-question channel unavailable: ${err.message}. Proceed with your best judgment.`);
      }
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

  return server;
}

// ─── Streamable-HTTP mount (FLUX-645) ────────────────────────────────────────
//
// The engine process serves the MCP server in-process over loopback HTTP at
// POST/GET/DELETE /mcp, so every Claude Code session — main checkout or an
// `.eh-worktrees/*` worktree — points at one URL and shares the engine's single
// task-store cache + chokidar watchers, with no per-session stdio process. Per-session
// transports are keyed by the `Mcp-Session-Id` header so concurrent sessions stay
// isolated. index.ts registers the routes BEFORE express.json so the raw JSON-RPC request
// stream reaches the transport unparsed.
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headerId = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(headerId) ? headerId[0] : headerId;
  let transport = sessionId ? httpTransports.get(sessionId) : undefined;

  if (!transport) {
    // Only a POST may open a session — it must carry the `initialize` request. A GET/DELETE
    // (or a POST with an unknown session id) has no live transport to attach to.
    if (req.method !== 'POST') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid MCP session' }, id: null }));
      return;
    }
    // New session: fresh server + transport. The transport assigns the session id on
    // `initialize` (and rejects a non-initialize first message itself), so we never pre-parse
    // the body — pre-parsing would also let express.json consume the stream (see index.ts).
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { httpTransports.set(sid, newTransport); },
    });
    newTransport.onclose = () => {
      const sid = newTransport.sessionId;
      if (sid) httpTransports.delete(sid);
    };
    // Cast: StreamableHTTPServerTransport `implements Transport`, but its getter/setter `onclose`
    // is `(() => void) | undefined` which trips exactOptionalPropertyTypes against Transport's
    // optional `onclose?`. The instance genuinely is a Transport.
    await buildMcpServer().connect(newTransport as Transport);
    transport = newTransport;
  }

  await transport.handleRequest(req, res);
}

// NOTE (FLUX-705): no self-start-on-direct-invocation block here. This module is now
// statically imported by index.ts so the in-process HTTP MCP mount shares the engine's
// live task-store (in SEA it was previously loaded as a SECOND bundle with its own,
// never-activated task-store → "Received null" on write + a cache blind to new tickets).
// A `process.argv[1] === import.meta.url` guard would misfire once bundled into index.js
// and spawn a stdio server at engine startup. `--mcp` stdio mode is started explicitly by
// index.ts's MCP_MODE handler instead.

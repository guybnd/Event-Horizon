import { createTicketBranch } from './branch-manager.js';
import { createTaskWorktree } from './task-worktree.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { buildActivityEntry } from './history.js';
import { workspaceRoot } from './workspace.js';

/**
 * Canonical ticket-isolation mechanism (FLUX-845).
 *
 * Creating a ticket's feature branch + (optionally) a dedicated git worktree was
 * copy-pasted in three divergent places: the `create_branch` MCP tool, the
 * `POST /:id/branch` route, and — crucially — NOWHERE on the two agent dispatch
 * paths (`start_session` + board-rebase `dispatch`), which therefore launched
 * branchless in the shared checkout. This is the one place that owns the
 * mechanism; every caller resolves its own POLICY (worktree-by-default or not)
 * and hands the resolved boolean here.
 *
 * Idempotent: an existing `task.branch` is reused (never re-created), and
 * `createTaskWorktree` self-heals/reuses a worktree already at the target path.
 * A worktree failure is non-fatal — the branch still exists and the lost
 * isolation is surfaced on the ticket history rather than failing the launch.
 */
export interface EnsureIsolationOptions {
  /** Create a dedicated worktree (implies a branch). When false, only the branch is created. */
  worktree: boolean;
  baseBranch?: string | undefined;
  /** History author for the branch/worktree entries (default 'Agent'). */
  updatedBy?: string | undefined;
}

export interface EnsureIsolationResult {
  branch: string;
  worktree?: string;
  worktreeError?: string;
}

export async function ensureTicketIsolation(
  ticketId: string,
  opts: EnsureIsolationOptions,
): Promise<EnsureIsolationResult> {
  const task = tasksCache[ticketId];
  if (!task) throw new Error(`Ticket ${ticketId} not found`);
  const updatedBy = opts.updatedBy ?? 'Agent';

  // Idempotent: reuse an existing branch (e.g. one a prior worktree-open created)
  // instead of erroring with a raw git "already exists".
  let branch = task.branch as string | undefined;
  if (!branch) {
    branch = await createTicketBranch(ticketId, task.title || ticketId, opts.baseBranch);
    await updateTaskWithHistory(ticketId, { updatedBy, extraFields: { branch } });
    // Reflect onto the live cache object so callers spawning in the same tick
    // (resolveTaskExecutionRoot reads task.branch) see the new branch.
    task.branch = branch;
  }

  let worktree: string | undefined;
  let worktreeError: string | undefined;
  if (opts.worktree) {
    try {
      worktree = await createTaskWorktree(
        workspaceRoot!,
        ticketId,
        branch,
        opts.baseBranch ? { baseBranch: opts.baseBranch } : {},
      );
    } catch (wtErr: any) {
      // Branch is created — don't fail the whole call; the caller falls back to
      // the main tree. Surface it on the ticket so the lost isolation isn't silent.
      worktreeError = wtErr?.message ?? String(wtErr);
      await updateTaskWithHistory(ticketId, {
        updatedBy,
        entries: [
          buildActivityEntry(
            `⚠️ Dedicated worktree NOT created: ${worktreeError}. The agent will run in the main tree (no isolation).`,
            updatedBy,
            new Date().toISOString(),
          ),
        ],
      });
    }
  }

  broadcastEvent('taskUpdated', { id: ticketId });
  return { branch, ...(worktree ? { worktree } : {}), ...(worktreeError ? { worktreeError } : {}) };
}

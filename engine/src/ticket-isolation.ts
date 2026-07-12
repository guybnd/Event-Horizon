import { getWorkspace } from './workspace-context.js';
import { createTicketBranch } from './branch-manager.js';
import { createTaskWorktree, reclaimWorktrees } from './task-worktree.js';
import { updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { buildActivityEntry } from './history.js';
import { isWorktreeReclaimable } from './pr-cleanup.js';
import { getWorkspaceRoot } from './workspace.js';

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
 * A worktree failure does not throw HERE — the branch still exists (a manual
 * /branch caller wants it regardless) and the failure is surfaced on the ticket
 * history. Note this is NOT "the agent runs on master": post-FLUX-1018 the spawn
 * path fails closed, so a branch-bearing ticket whose worktree could not be
 * created will fail to START rather than degrade to the main checkout.
 *
 * FLUX-1018 invariant — **a branch implies a worktree on the spawn path.** The
 * two coherent isolation modes for an agent are (a) branch + dedicated worktree
 * (the default, fully isolated) or (b) no branch at all (branchless, main tree,
 * direct-commit flow). "Branch but no worktree, run on the shared main tree" is
 * the unsafe middle that caused the FLUX-972 master-commit: a single-shot agent
 * (Copilot `-p`) never checks the branch out, so it commits on master. So
 * `worktree:false` only skips worktree creation for a *manual* branch (the
 * /branch route / `branch` MCP tool — no agent spawn); when an agent is spawned,
 * resolveTaskExecutionRoot creates the worktree anyway (fail closed).
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
  const task = getWorkspace().tasks[ticketId];
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
    const createWorktree = async () => {
      const wt = await createTaskWorktree(
        getWorkspaceRoot()!,
        ticketId,
        branch!,
        opts.baseBranch ? { baseBranch: opts.baseBranch } : {},
      );
      // FLUX-1305: stamp a timestamped marker the reclaim sweep's zero-commit-branch backstop
      // (pr-cleanup.ts#isWorktreeReclaimableForSweep) checks before treating a never-committed
      // branch as abandoned. Without it, a worktree created here from a board/chat session — which
      // never registers a live EH session for the ticket — reads as idle and gets swept on the
      // very next ~90s reconcile tick, before the caller even starts editing. Best-effort: a write
      // failure must not fail worktree creation itself.
      await updateTaskWithHistory(ticketId, {
        updatedBy,
        entries: [
          buildActivityEntry(`Created worktree for branch ${branch}`, updatedBy, new Date().toISOString(), {
            event: 'worktree-created',
          }),
        ],
      }).catch(() => {});
      return wt;
    };
    try {
      worktree = await createWorktree();
    } catch (wtErr: unknown) {
      // Latest failure to report — starts as the original attempt's error and is
      // replaced by the retry's error below (never reassigns the caught `wtErr`
      // binding itself: no-ex-assign).
      let lastErr: unknown = wtErr;
      // FLUX-1018 / FLUX-1031: a full worktree cap is almost always slots held by
      // tickets that no longer need their tree — stale Done/Released/Archived worktrees
      // post-merge cleanup left behind (their node_modules junctions made them read as
      // "dirty", so cleanup kept them), OR tickets resting at Ready awaiting review
      // (freed eagerly at Ready + on the reconcile sweep, but reclaimed here too as the
      // hard backstop so a spawn never deadlocks inside the sweep window). Reclaim any
      // such clean, idle worktree (isWorktreeReclaimable skips live-session tickets) and
      // retry ONCE before giving up — so a legit new task gets an isolated worktree
      // instead of silently failing to start.
      if (/limit reached/i.test(wtErr instanceof Error ? wtErr.message : String(wtErr))) {
        // FLUX-1112: bypass the always-on Ready-worktree grace here — this is the LAST-RESORT
        // backstop when a spawn is genuinely blocked on the concurrency cap, so a legit new task
        // must never fail to start over a buffer meant to protect an ad hoc reviewer elsewhere.
        const reclaimed = await reclaimWorktrees(
          getWorkspaceRoot()!,
          (id) => isWorktreeReclaimable(id, { honorReadyGrace: false }),
        ).catch(() => [] as string[]);
        if (reclaimed.length > 0) {
          try {
            worktree = await createWorktree();
          } catch (retryErr: unknown) {
            lastErr = retryErr;
          }
        }
      }
      if (!worktree) {
        // The branch exists, so this call still succeeds (a manual /branch caller
        // wants the branch regardless). But do NOT claim "the agent will run in the
        // main tree": post-FLUX-1018 the spawn path (resolveTaskExecutionRoot →
        // adapter fresh-spawn guard) fails CLOSED — a branch-bearing ticket must run
        // in its own worktree or not at all, never on master. So if the caller goes
        // on to spawn an agent, that spawn will FAIL TO START rather than silently
        // degrade. Surface that accurately so the next debugger isn't misled in the
        // exact cap-exhaustion mode this ticket exists to make visible.
        worktreeError = lastErr instanceof Error ? lastErr.message : String(lastErr);
        await updateTaskWithHistory(ticketId, {
          updatedBy,
          entries: [
            buildActivityEntry(
              `⚠️ Dedicated worktree NOT created: ${worktreeError}. Isolation could not be established; ` +
                `a spawned agent session will FAIL TO START (it will not run on master). ` +
                `Free a worktree slot (finish/abandon a task) or fix the error, then retry.`,
              updatedBy,
              new Date().toISOString(),
            ),
          ],
        });
      }
    }
  }

  broadcastEvent('taskUpdated', { id: ticketId });
  return { branch, ...(worktree ? { worktree } : {}), ...(worktreeError ? { worktreeError } : {}) };
}

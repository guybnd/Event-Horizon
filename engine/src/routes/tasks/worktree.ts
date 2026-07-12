// Worktree routes (FLUX-349 split): the two hot-poll listing endpoints (/worktrees,
// /uncommitted-count) with their stale-while-revalidate memo, plus the per-ticket worktree
// lifecycle (detach / open / join). Mounted by the ../tasks.ts barrel BEFORE the crud router so
// the literal paths win over GET /:id.
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';
import { existsSync } from 'fs';
import { getWorkspaceRoot } from '../../workspace.js';
import { updateTaskWithHistory } from '../../task-store.js';
import { stopAllSessionsForTask } from '../../session-store.js';
import { createTicketBranch } from '../../branch-manager.js';
import {
  createTaskWorktree, detachTaskWorktree, taskWorktreeDir, listTaskWorktrees, findWorktreeForBranch,
  worktreeChangeCount, worktreeChangeCounts, currentBranchName,
} from '../../task-worktree.js';
import { isEditorAvailable, openEditorWindow } from '../../editor-launcher.js';
import { broadcastEvent } from '../../events.js';
import { git, errorMessage } from './helpers.js';
import type { TaskRecord } from './helpers.js';

const router = express.Router();

// Resolve the repo's default branch name (master → main → 'master'), run in `root`.
// Best-effort: mirrors diff-aggregator's resolution so the worktree ahead-count and
// the divergence aggregate measure against the same base (FLUX-582).
async function resolveDefaultBranch(root: string): Promise<string> {
  for (const candidate of ['master', 'main']) {
    try {
      await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return 'master';
}

// ─── Stale-while-revalidate memo for the two hot polling endpoints (FLUX-1126, FLUX-1185) ───
// Several portal components (AppContext, OrchestrationLauncher, WorktreesPanel,
// StartTaskPrompt) each poll these endpoints independently, landing near-identical bursts
// of git spawns roughly a second apart — on top of the steady 30s stoplight poll. FLUX-1126's
// TTL cache deduped concurrent callers WITHIN the 4s window, but it was still expire-then-
// recompute-inline: any call landing AFTER expiry blocked on the full per-worktree git fan-out
// (700-950ms) — and since the portal polls every 30s against a 4s TTL, that was EVERY poll, not
// just a rare miss. Serve stale-while-revalidate instead: every call after the very first
// returns the last computed value INSTANTLY, and — only when that value is older than the TTL —
// kicks a single-flighted background recompute that updates the cache for the NEXT call. A
// failed background recompute leaves the last good value in place (retried on the next stale
// trigger) rather than caching the rejection or evicting the value. Per the ticket's default: no
// explicit invalidation on worktree create/detach — data can now be up to (poll interval +
// refresh time) stale, invisible for these badge/gauge consumers.
const HOT_POLL_TTL_MS = 4_000;

/**
 * Wraps `compute` for stale-while-revalidate serving — see block comment above. Only the very
 * first call ever (no cached value yet) blocks; every call after that resolves from the cached
 * value immediately, regardless of staleness.
 */
export function swrAsync<T>(ttlMs: number, compute: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let hasValue = false;
  let updatedAt = 0;
  let inFlight: Promise<T> | null = null;

  function refresh(): Promise<T> {
    if (inFlight) return inFlight;
    const promise = compute();
    inFlight = promise;
    promise.then(
      (v) => { value = v; hasValue = true; updatedAt = Date.now(); },
      () => { /* keep the stale value (if any); the next stale trigger retries */ },
    ).finally(() => { inFlight = null; });
    return promise;
  }

  return () => {
    if (!hasValue) return refresh(); // nothing to serve yet — this call alone blocks
    if (Date.now() - updatedAt >= ttlMs) void refresh().catch(() => { /* swallow — the `.then` above already handled retaining the stale value */ });
    return Promise.resolve(value as T);
  };
}

async function computeWorktrees() {
  const worktrees = await listTaskWorktrees(getWorkspaceRoot()!);
  // Resolve the default branch once (master → main) for the per-worktree ahead count.
  const defaultBranch = await resolveDefaultBranch(getWorkspaceRoot()!);
  return Promise.all(
    worktrees.map(async (w) => {
      const ticket = (Object.values(getWorkspace().tasks) as TaskRecord[]).find((t) => t.branch === w.branch);
      // Changed-file count vs master — drives the board chip's "N changed" badge.
      const changedFiles = await worktreeChangeCount(w.path).catch(() => 0);
      // Commits this worktree is ahead of the default branch (FLUX-582) — pairs with
      // changedFiles for the panel's "↑N · M vs master" divergence badge. Best-effort.
      const aheadCount = await git(w.path, ['rev-list', '--count', `${defaultBranch}..HEAD`])
        .then((r) => parseInt(r.stdout.trim(), 10) || 0).catch(() => 0);
      return {
        path: w.path,
        branch: w.branch,
        ticketId: ticket?.id ?? null,
        ticketTitle: ticket?.title ?? null,
        changedFiles,
        aheadCount,
      };
    }),
  );
}

const getWorktreesMemoized = swrAsync(HOT_POLL_TTL_MS, computeWorktrees);

// List active task worktrees (FLUX-516). Registered before /:id so the literal
// path wins. Maps each worktree to the ticket whose branch it holds (if any).
router.get('/worktrees', async (_req, res) => {
  try {
    const result = await getWorktreesMemoized();
    res.json({ worktrees: result });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

async function computeUncommittedCount() {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return { count: 0, branch: null as string | null, diverged: 0 };
  const [mainCount, branch, worktrees] = await Promise.all([
    worktreeChangeCount(workspaceRoot, 'HEAD').catch(() => 0),
    currentBranchName(workspaceRoot).catch(() => null),
    listTaskWorktrees(workspaceRoot).catch(() => [] as Array<{ path: string }>),
  ]);
  // Aggregate uncommitted work across EVERY active task worktree too, not just the main
  // tree — otherwise the badge reads 0 while 20+ files sit uncommitted in a worktree.
  // Alongside it, `diverged` sums each worktree's full divergence vs master (committed +
  // uncommitted) so the stoplight can show a secondary "vs master" count that survives a
  // commit, unlike the uncommitted `count` (FLUX-582). Both best-effort. `HEAD` and
  // `master` counts share one `ls-files` spawn per worktree via `worktreeChangeCounts`
  // (FLUX-1126) — untracked files don't depend on the diff base, so computing them twice
  // per worktree per poll was pure waste.
  const wtCounts = await Promise.all(
    worktrees.map((w) => worktreeChangeCounts(w.path, ['HEAD', 'master']).catch(() => ({ HEAD: 0, master: 0 }))),
  );
  const count = mainCount + wtCounts.reduce((sum, c) => sum + (c.HEAD ?? 0), 0);
  const diverged = wtCounts.reduce((sum, c) => sum + (c.master ?? 0), 0);
  return { count, branch, diverged };
}

const getUncommittedCountMemoized = swrAsync(HOT_POLL_TTL_MS, computeUncommittedCount);

// Count of uncommitted files in the active workspace — working tree vs HEAD
// (tracked changes) plus untracked. Powers the board header "uncommitted
// changes" stoplight (FLUX-535). Registered before /:id so the literal path
// wins. Best-effort: 0 when not a git repo or git errors (worktreeChangeCount
// already swallows those).
router.get('/uncommitted-count', async (_req, res) => {
  const result = await getUncommittedCountMemoized();
  res.json(result);
});

// ─── Worktree detach (manual-finish escape hatch, FLUX-521) ─────────────────────
// Remove the task's worktree but keep the branch, so the human can merge/PR/delete
// by hand. Uncommitted work is preserved (stashed → applied onto master, or kept as
// a stash ref on conflict — see detachTaskWorktree).
router.post('/:id/worktree/detach', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const wtPath = taskWorktreeDir(getWorkspaceRoot()!, id);
  if (!existsSync(wtPath)) {
    return res.status(404).json({ error: 'No worktree for this ticket' });
  }
  try {
    // Stop any live session so its process doesn't hold the worktree cwd (lock).
    stopAllSessionsForTask(id, 'Detaching worktree');
    const result = await detachTaskWorktree(getWorkspaceRoot()!, wtPath, { ticketId: id });
    broadcastEvent('taskUpdated', { id });
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ─── Open a ticket in a dedicated worktree window (FLUX-522) ─────────────────────
// Ensure a branch + worktree exist, then open a NEW VS Code window rooted there
// (a running session can't relocate its own cwd). Returns the worktree path, a
// seed prompt to paste, and whether the editor actually launched.
router.post('/:id/worktree/open', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
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
    let worktree = await findWorktreeForBranch(getWorkspaceRoot()!, branch);
    if (!worktree) {
      worktree = await createTaskWorktree(getWorkspaceRoot()!, id, branch, baseBranch ? { baseBranch } : {});
    }
    const opened = await isEditorAvailable();
    if (opened) openEditorWindow(worktree);
    broadcastEvent('taskUpdated', { id });
    const seedPrompt = `Picking up ${id}: ${task.title || id}. Read the ticket and continue.`;
    res.json({ worktree, branch, opened, seedPrompt });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// ─── Join an existing worktree (shared-branch work, FLUX-516) ───────────────────
// Adopt another ticket's branch so THIS ticket runs in that branch's existing
// worktree (e.g. fixing review-found bugs alongside the parent ticket). No new
// branch or worktree is created — the ticket just points at the existing branch,
// and execution-root resolution (by branch) routes it into the shared worktree.
router.post('/:id/worktree/join', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const branch: string | undefined = typeof req.body?.branch === 'string' ? req.body.branch.trim() : undefined;
  if (!branch) return res.status(400).json({ error: 'branch is required' });

  try {
    const worktree = await findWorktreeForBranch(getWorkspaceRoot()!, branch);
    if (!worktree) {
      return res.status(409).json({ error: `No active worktree is checked out on '${branch}' to join.` });
    }
    await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
    broadcastEvent('taskUpdated', { id });
    res.json({ branch, worktree, joined: true });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;

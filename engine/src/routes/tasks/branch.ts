// ─── Branch routes (FLUX-349 split) ──────────────────────────────────────────
// Branch allocation + status + delete for a ticket, and the workspace-wide branch list. Mounted
// by the ../tasks.ts barrel BEFORE the crud router so GET /branches wins over GET /:id.
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';
import { existsSync } from 'fs';
import { getWorkspaceRoot } from '../../workspace.js';
import { getConfig } from '../../config.js';
import { updateTaskWithHistory } from '../../task-store.js';
import { stopAllSessionsForTask } from '../../session-store.js';
import { getTicketBranchStatus, deleteTicketBranch } from '../../branch-manager.js';
import { detachTaskWorktree, taskWorktreeDir, listTaskWorktrees, listLocalBranches } from '../../task-worktree.js';
import { ensureTicketIsolation } from '../../ticket-isolation.js';
import { errorMessage } from './helpers.js';
import type { TaskRecord } from './helpers.js';

const router = express.Router();

// Local branch names + whether each currently holds a worktree — powers the
// "Attach to branch" picker (FLUX-516). Registered before /:id so the literal
// path wins.
router.get('/branches', async (_req, res) => {
  try {
    const [names, worktrees] = await Promise.all([
      listLocalBranches(getWorkspaceRoot()!),
      listTaskWorktrees(getWorkspaceRoot()!),
    ]);
    const worktreeBranches = new Set(worktrees.map((w) => w.branch));
    const ticketBranches = new Set(
      (Object.values(getWorkspace().tasks) as TaskRecord[]).map((t) => t.branch).filter(Boolean),
    );
    res.json({
      branches: names.map((name) => ({
        name,
        hasWorktree: worktreeBranches.has(name),
        isTicketBranch: ticketBranches.has(name),
      })),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.post('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const baseBranch: string | undefined = req.body?.baseBranch;
  // FLUX-521: per-launch "dedicated worktree" choice; defaults to the workspace setting.
  // FLUX-845: the branch+worktree MECHANISM is centralized in ensureTicketIsolation;
  // this route only resolves the portal POLICY (config worktreeByDefault) and delegates.
  const useWorktree: boolean = typeof req.body?.worktree === 'boolean'
    ? req.body.worktree
    : getConfig().worktreeByDefault === true;

  try {
    const result = await ensureTicketIsolation(id, { worktree: useWorktree, baseBranch });
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.get('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const name: string | undefined = task.branch;
  // FLUX-521: report whether a dedicated worktree exists (drives the portal detach control).
  const wtPath = taskWorktreeDir(getWorkspaceRoot()!, id);
  const worktree = existsSync(wtPath) ? wtPath : null;
  if (!name) return res.json({ name: null, exists: false, aheadCount: 0, behindCount: 0, worktree });

  try {
    const status = await getTicketBranchStatus(name);
    res.json({ name, ...status, worktree });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.delete('/:id/branch', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

  const name: string | undefined = task.branch;
  if (!name) return res.status(400).json({ error: 'No branch associated with this ticket' });

  const force: boolean = req.body?.force === true;

  try {
    // FLUX-521: a worktree holds the branch checked out — stop the session (release
    // the cwd lock) and detach before delete. This is an ABANDON, so uncommitted work
    // is preserved as a stash ref but NOT applied onto master.
    const wtPath = taskWorktreeDir(getWorkspaceRoot()!, id);
    if (existsSync(wtPath)) {
      stopAllSessionsForTask(id, 'Deleting branch — detaching worktree');
      await detachTaskWorktree(getWorkspaceRoot()!, wtPath, { ticketId: id, applyToMain: false });
    }
    await deleteTicketBranch(name, force);
    await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch: null } });
    res.json({ deleted: name });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;

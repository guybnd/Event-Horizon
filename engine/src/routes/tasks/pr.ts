// ─── PR routes (FLUX-556; FLUX-349 split) ───────────────────────────────────────
// PRs are BRANCH-scoped: a PR belongs to a branch, and N tickets sharing that branch
// share its PR. These endpoints back the in-EH PR card / "Open PRs" swimlane (FLUX-555).
// Hard dependency on `gh` + a GitHub remote — every path degrades gracefully (clean
// "unavailable", never a 500) when gh is missing/unauthed so the UI can fall back.
// PR-card (kind:'pr') operations — adopt/retry — live in pr-ticket.ts; the branchless
// engine-side finish lives in finish.ts.
import { getWorkspace } from '../../workspace-context.js';
import express from 'express';
import { getWorkspaceRoot } from '../../workspace.js';
import { buildActivityEntry } from '../../history.js';
import { updateTaskWithHistory } from '../../task-store.js';
import { stopAllSessionsForTask, getBlockingSessionsForTask, getParkedSessionsForTask } from '../../session-store.js';
import { getTicketBranchStatus, createPullRequest, mergePullRequest, getGhAvailability, ghUnavailableMessage, getPullRequestStatus, getDefaultBranch, isMergeConflict } from '../../branch-manager.js';
import { findWorktreeForBranch, worktreeIsDirty } from '../../task-worktree.js';
import { cleanupMergedBranch } from '../../pr-cleanup.js';
import { disarmTemperForExternalStop } from '../../temper.js';
import { broadcastEvent } from '../../events.js';
import { sharedNonDoneSiblings, resolveMergedPrTickets } from '../../pr-tickets.js';
import { git, errorMessage } from './helpers.js';
import type { TaskRecord } from './helpers.js';

const router = express.Router();

// Live PR state for a ticket's branch. `{ pr: null }` when the ticket has no branch,
// no PR exists, or gh is unavailable. Best-effort — never 500.
router.get('/:id/pr', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
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
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  if (!task.branch) return res.status(409).json({ error: 'Ticket has no branch to raise a PR for.' });

  const ghAvailability = await getGhAvailability();
  if (!ghAvailability.ok) {
    return res.status(409).json({ error: ghUnavailableMessage(ghAvailability.reason), unavailable: true });
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
    const url = await createPullRequest(task.branch, task.title || id, prBody, id);
    // Stamp the PR link on every ticket sharing the branch (branch-scoped PR). The PR's surface
    // is now its own `PR-<n>` deck card (created by syncPrTickets on the next poll) — the FLUX-558
    // `open-pr` swimlane/glow on member tickets is retired (FLUX-569), so we no longer set it.
    const branchTickets = (Object.values(getWorkspace().tasks) as TaskRecord[]).filter((t) => t.branch === task.branch);
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
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// Squash-merge the branch's PR, then run branch-scoped post-merge cleanup (advance every
// ticket on the branch → Done, fast-forward master, tear down worktree + branch — FLUX-557).
// Guard: refuse while a live agent session owns the worktree (FLUX-555 decision #8) —
// merging out from under a running session would lose/clobber in-flight work.
router.post('/:id/pr/merge', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  const branch: string | undefined = task.branch;
  if (!branch) return res.status(409).json({ error: 'Ticket has no branch / PR to merge.' });

  // Branch-scoped: a merge advances ALL tickets sharing this branch.
  const sharedTickets = (Object.values(getWorkspace().tasks) as TaskRecord[]).filter((t) => t.branch === branch);

  // Two-tier merge guard (FLUX-636):
  // Tier 1 — hard block: pending/running sessions are actively executing; merging would clobber in-flight work.
  const blockingOwners = sharedTickets.filter((t) => getBlockingSessionsForTask(t.id).length > 0);
  if (blockingOwners.length > 0) {
    return res.status(409).json({
      error: `Cannot merge — a live agent session owns this worktree (${blockingOwners.map((t) => t.id).join(', ')}). Stop the session, then merge.`,
    });
  }

  // Tier 2 — parked sessions (waiting-input): work is committed, safe to reclaim worktree.
  // Without opt-in flag, return a distinct machine-readable 409 so the portal can render "Stop & merge".
  const parkedOwners = sharedTickets.filter((t) => getParkedSessionsForTask(t.id).length > 0);
  const stopParked = req.body?.stopParkedSessions === true;
  if (parkedOwners.length > 0 && !stopParked) {
    return res.status(409).json({
      error: `${parkedOwners.length} parked session(s) will be ended (${parkedOwners.map((t) => t.id).join(', ')}). Stop & merge?`,
      parkedOnly: true,
      parkedOwners: parkedOwners.map((t) => t.id),
    });
  }
  // Finish-on-shared-PR guard (FLUX-569, from the FLUX-556/PR#6 incident): a merge advances ALL
  // branch tickets → Done. When non-terminal siblings are bundled in, that's a one-way door, so
  // require explicit confirmation (`force:true`) and surface exactly who would be swept along.
  // The PR deck card lists them in its merge confirm and then re-sends with force.
  // FLUX-747: this rejection MUST run BEFORE the parked-stop side effect below — otherwise a
  // request with stopParkedSessions:true but no force would kill the parked sessions (losing the
  // warm --resume) and *then* 409 with requiresForce, costing the resume without the merge.
  const force = req.body?.force === true;
  if (!force) {
    // sharedNonDoneSiblings (pr-tickets.ts) declares a narrower TicketRecord return shape than
    // this file's TaskRecord (no `title`) — the filtered entries are still the SAME getWorkspace().tasks
    // objects though, so re-key back into getWorkspace().tasks for the field it doesn't carry.
    const nonDone = sharedNonDoneSiblings(Object.values(getWorkspace().tasks), branch, id);
    if (nonDone.length > 0) {
      return res.status(409).json({
        error: `Merging \`${branch}\` would advance ${nonDone.length} unfinished ticket(s) to Done: ${nonDone.map((t) => `${t.id} (${t.status})`).join(', ')}. Confirm to merge the whole shared PR anyway.`,
        sharedNonDone: nonDone.map((t) => ({ id: t.id, status: t.status, title: (getWorkspace().tasks[t.id] as TaskRecord | undefined)?.title })),
        requiresForce: true,
      });
    }
  }

  if (parkedOwners.length > 0 && stopParked) {
    // FLUX-1304 (FLUX-1297 follow-up): disarm Temper on every parked owner BEFORE stopping its
    // session — same race as `cleanupMergedBranch`'s own disarm loop. Without this, Temper's own
    // tick can observe the 'cancelled' session this stop produces before the `cleanupMergedBranch`
    // call below advances the ticket's board status to Done, and park/revert a ticket whose work
    // just landed. Best-effort: never blocks the merge.
    for (const t of parkedOwners) {
      try { await disarmTemperForExternalStop(t.id); } catch { /* best effort */ }
    }
    for (const t of parkedOwners) {
      stopAllSessionsForTask(t.id, 'stop & merge');
      await updateTaskWithHistory(t.id, {
        updatedBy: 'Agent',
        entries: [buildActivityEntry(`Parked session ended for merge of \`${branch}\`.`, 'Agent', new Date().toISOString())],
      });
    }
  }

  const ghAvailability = await getGhAvailability();
  if (!ghAvailability.ok) {
    return res.status(409).json({ error: ghUnavailableMessage(ghAvailability.reason), unavailable: true });
  }

  try {
    await mergePullRequest(branch); // squash + delete remote branch
  } catch (err: unknown) {
    // FLUX-986: unlike finish_ticket, this route otherwise returns a 500 without touching ticket
    // state at all. On a genuine git conflict, flag `merge-conflict` so the portal can render the
    // "Launch Rebase Session" CTA. Status is deliberately left untouched here — the ticket only
    // bounces to In Progress once the user actually clicks that CTA (PrDeckCard.tsx), not silently
    // out from under them the instant the merge fails.
    if (isMergeConflict(err)) {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        extraFields: { swimlane: 'merge-conflict' },
      });
      broadcastEvent('taskUpdated', { id });
    }
    return res.status(500).json({ error: `Merge failed: ${errorMessage(err)}` });
  }

  // Post-merge cleanup (FLUX-557): advance all branch tickets → Done, fast-forward local
  // master, and tear down the worktree + branch when the tree is clean (otherwise a
  // persistent notification is raised). Branch-scoped — runs once for the shared branch.
  const cleanup = await cleanupMergedBranch(getWorkspaceRoot()!, branch);

  // Resolve PR tickets (kind:'pr') for this branch RIGHT NOW. cleanupMergedBranch deliberately
  // skips them (their state is owned by syncPrTickets — FLUX-587), which left the merged PR
  // card sitting OPEN until the next 90s poll ("nothing happened" for a long minute — FLUX-588).
  // The merge just succeeded here, so move them to Done immediately instead of waiting.
  await resolveMergedPrTickets(branch);

  res.json({ merged: true, ...cleanup });
});

// Update a stale PR branch by merging the default branch into it (FLUX-559). Conservative:
// requires a clean worktree and aborts the merge on conflict (the user resolves in the
// worktree) — never leaves a half-merged tree. Pushes the merge so the PR refreshes.
router.post('/:id/pr/update-branch', async (req, res) => {
  const { id } = req.params;
  const task = getWorkspace().tasks[id];
  if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });
  const branch: string | undefined = task.branch;
  if (!branch) return res.status(409).json({ error: 'Ticket has no branch to update.' });

  const worktree = await findWorktreeForBranch(getWorkspaceRoot()!, branch).catch(() => null);
  if (!worktree) {
    return res.status(409).json({ error: 'No active worktree holds this branch — open the worktree before updating.' });
  }
  if (await worktreeIsDirty(worktree)) {
    return res.status(409).json({ error: 'Worktree has uncommitted changes — commit or stash them first.' });
  }

  try {
    const def = await getDefaultBranch();
    await git(worktree, ['fetch', 'origin', def]);
    try {
      await git(worktree, ['merge', '--no-edit', `origin/${def}`]);
    } catch (mergeErr: unknown) {
      await git(worktree, ['merge', '--abort']).catch(() => {});
      return res.status(409).json({ error: `Update hit conflicts with ${def} — resolve them in the worktree, then push. (${errorMessage(mergeErr)})` });
    }
    await git(worktree, ['push', 'origin', branch]).catch(() => {});
    broadcastEvent('taskUpdated', { id });
    res.json({ updated: true, branch });
  } catch (err: unknown) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;

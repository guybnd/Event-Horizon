import { execFile } from 'child_process';
import { promisify } from 'util';
import { findWorktreeForBranch, removeTaskWorktree, detachTaskWorktree } from './task-worktree.js';
import { getDefaultBranch, deleteTicketBranch, getPullRequestStatus } from './branch-manager.js';
import { addNotification } from './notifications.js';
import { stopAllSessionsForTask } from './session-store.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';

const execFileAsync = promisify(execFile);

const DONE_STATUS = 'Done';

function git(workspaceRoot: string, args: string[]) {
  return execFileAsync('git', ['-C', workspaceRoot, ...args], { windowsHide: true });
}

export interface CleanupResult {
  outcome: 'cleaned' | 'unsafe' | 'noop';
  branch: string;
  advanced: string[];        // ticket ids moved → Done
  masterSynced: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  reason?: string;           // when unsafe
  notificationId?: string;   // when unsafe
}

/**
 * Fast-forward the local default branch (master) to its remote (FLUX-540). The engine
 * reads the LOCAL tree for diffs/collision detection, so a stale local master makes
 * the board lie after a merge. Best-effort — never throws.
 *
 * If master is the branch checked out in the main working tree we ff-merge it in place;
 * otherwise we fast-forward the ref directly (`fetch origin master:master`), which git
 * refuses for a checked-out branch — hence the split.
 */
export async function syncDefaultBranch(workspaceRoot: string): Promise<boolean> {
  try {
    const def = await getDefaultBranch();
    await git(workspaceRoot, ['fetch', 'origin']);
    const { stdout: cur } = await git(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur.trim() === def) {
      await git(workspaceRoot, ['merge', '--ff-only', `origin/${def}`]);
    } else {
      await git(workspaceRoot, ['fetch', 'origin', `${def}:${def}`]);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Post-merge cleanup for a (squash-)merged branch — FLUX-557. Branch-scoped: all tickets
 * sharing the branch are advanced once. Safe by construction:
 *
 *  1. Advance every non-Done ticket on the branch → Done (the PR's content landed).
 *  2. Stop any sessions still pointed at the worktree.
 *  3. Fast-forward local master.
 *  4. If the worktree is DIRTY → STOP: keep it, raise a persistent notification with
 *     "Clean up" / "Open worktree" actions (never silently discard uncommitted work,
 *     and never the detach stash-to-master path — the work already landed via the PR).
 *  5. Clean worktree → remove it + force-delete the branch (squash merge means `-d`
 *     won't see it as merged, so force).
 *
 * Note on the "no extra commits" check: with squash merge the branch's original SHAs are
 * never ancestors of master, so a `git log master..branch` gate would ALWAYS read as
 * "unsafe" (false positive). gh's MERGED state is the source of truth that the content
 * landed; the genuine residual-work risk is an uncommitted (dirty) tree, which we gate on.
 *
 * Idempotent: safe to call repeatedly (reconcile poller) — already-Done tickets aren't
 * re-advanced, an already-removed worktree / deleted branch are no-ops.
 */
export async function cleanupMergedBranch(workspaceRoot: string, branch: string): Promise<CleanupResult> {
  const branchTickets = (Object.values(tasksCache) as any[]).filter((t) => t.branch === branch);

  // 1. Advance non-Done tickets → Done. Each is isolated: the squash-merge already landed
  // (irreversible), so one ticket's write failure must NOT abort the rest of the cleanup
  // or leave siblings un-advanced (FLUX-561 #2).
  const advanced: string[] = [];
  for (const t of branchTickets) {
    if (t.status === DONE_STATUS) continue; // already Done → no re-advance, no duplicate comment (#3)
    // PR tickets (kind:'pr') are owned by syncPrTickets — it sets their prState (MERGED/CLOSED)
    // when resolving. Advancing them here would mark Done with a stale prState=OPEN (FLUX-587).
    if (t.kind === 'pr') continue;
    try {
      await updateTaskWithHistory(t.id, {
        updatedBy: 'Agent',
        entries: [{ type: 'comment', user: 'Agent', comment: `PR squash-merged for branch \`${branch}\` — advanced to Done.`, date: new Date().toISOString() }],
        nextStatus: DONE_STATUS,
        // Clear the open-pr swimlane (the PR is merged) and stamp a link if none was set.
        extraFields: { swimlane: null, ...(t.implementationLink ? {} : { implementationLink: `merged:${branch}` }) },
      });
      broadcastEvent('taskUpdated', { id: t.id });
      advanced.push(t.id);
    } catch (err: any) {
      console.error(`[pr-cleanup] Failed to advance ${t.id} after merge of ${branch}:`, err?.message);
    }
  }

  // 2. Stop sessions on the worktree.
  for (const t of branchTickets) stopAllSessionsForTask(t.id, 'Post-merge worktree cleanup');

  // 3. Fast-forward local master.
  const masterSynced = await syncDefaultBranch(workspaceRoot);

  // 4 + 5. Worktree teardown (gated on a clean tree).
  const worktree = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
  let worktreeRemoved = false;
  if (worktree) {
    const { stdout: porcelain } = await git(worktree, ['status', '--porcelain']).catch(() => ({ stdout: '' }));
    if (porcelain.trim().length > 0) {
      const primary = branchTickets[0];
      const note = addNotification({
        type: 'info',
        title: 'Worktree needs cleanup',
        message:
          `The PR for \`${branch}\` merged, but its worktree still has uncommitted changes — ` +
          `it was kept so nothing is lost. Commit or discard them, then clean up.`,
        ...(primary?.id ? { ticketId: primary.id } : {}),
        actions: [
          { label: 'Clean up worktree', actionId: 'cleanup-worktree' },
          { label: 'Open worktree', actionId: 'open-worktree' },
        ],
      });
      return { outcome: 'unsafe', branch, advanced, masterSynced, worktreeRemoved: false, branchDeleted: false, reason: 'dirty-worktree', notificationId: note.id };
    }
    try {
      await removeTaskWorktree(workspaceRoot, worktree);
      worktreeRemoved = true;
    } catch {
      // removeTaskWorktree refuses to discard a dirty tree (defensive backstop); we already
      // checked above, so a failure here is a lock/leftover — leave it for the next prune.
    }
  }

  // If the MAIN working tree itself has the branch checked out (a main-tree branch
  // ticket with no worktree), switch it off the branch first — you can't delete the
  // branch you're on. gh's `--delete-branch` used to do this; we dropped it (FLUX-574),
  // so handle it here. Fast-forward the default branch after switching so the tree
  // reflects the merge.
  try {
    const { stdout: cur } = await git(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur.trim() === branch) {
      const def = await getDefaultBranch();
      await git(workspaceRoot, ['checkout', def]);
      await git(workspaceRoot, ['merge', '--ff-only', `origin/${def}`]).catch(() => {});
    }
  } catch {
    // Best-effort — if we can't switch off the branch, the delete below just no-ops.
  }

  // Force-delete the branch (local + remote) — squash merge ⇒ `-d` won't recognise it.
  let branchDeleted = false;
  try {
    await deleteTicketBranch(branch, true);
    branchDeleted = true;
  } catch {
    // Already gone, or still checked out somewhere — best-effort; reconcile will retry.
  }

  return { outcome: 'cleaned', branch, advanced, masterSynced, worktreeRemoved, branchDeleted };
}

const TERMINAL_STATUSES = new Set([DONE_STATUS, 'Archived', 'Released']);

/**
 * Set or clear the `open-pr` swimlane across the tickets sharing a branch — quietly
 * (no history entry), and ONLY when it actually changes, so the 90s sync never spams.
 * Turning on never clobbers the more-urgent `require-input` swimlane; turning off only
 * clears `open-pr` (leaves any other swimlane alone).
 */
async function setOpenPrSwimlane(tickets: any[], on: boolean, prUrl?: string): Promise<void> {
  for (const t of tickets) {
    if (on) {
      const wantSwimlane = !t.swimlane && t.swimlane !== 'open-pr'; // only flag an unflagged ticket
      const wantLink = !!prUrl && !t.implementationLink;
      if (!wantSwimlane && !wantLink) continue;
      const extraFields: Record<string, any> = {};
      if (wantSwimlane) extraFields.swimlane = 'open-pr';
      if (wantLink) extraFields.implementationLink = prUrl;
      await updateTaskWithHistory(t.id, { updatedBy: 'Agent', extraFields });
      broadcastEvent('taskUpdated', { id: t.id });
    } else if (t.swimlane === 'open-pr') {
      await updateTaskWithHistory(t.id, { updatedBy: 'Agent', extraFields: { swimlane: null } });
      broadcastEvent('taskUpdated', { id: t.id });
    }
  }
}

/**
 * Sync the board against gh's PR state (FLUX-557/559) — the poll-based "EH gets notified
 * about PRs" mechanism (decision #10: poll now, webhooks later). Runs on the engine's PR
 * interval. For every non-terminal ticket carrying a branch (deduped by branch):
 *  - OPEN    → light up the `open-pr` swimlane/glow + stamp the PR link (discovers PRs
 *              opened directly on GitHub, not just those raised through EH).
 *  - MERGED  → run post-merge cleanup (advance + tear down).
 *  - CLOSED  → bounce a PR-state ticket back to In Progress + detach (abandon path).
 *  - no PR   → clear a stale `open-pr` swimlane (PR was deleted).
 * Idempotent and quiet — only writes on a real change. Best-effort; never throws.
 */
export async function reconcilePullRequests(workspaceRoot: string): Promise<void> {
  // Group non-terminal branch tickets by branch — a shared branch has one PR. PR tickets
  // (kind:'pr') are EXCLUDED: their lifecycle (status/prState/swimlane) is owned solely by
  // syncPrTickets. Treating them as normal branch tickets here let the open-pr swimlane + the
  // CLOSED→In Progress bounce mangle them (a closed PR ticket stuck In Progress — FLUX-598).
  const byBranch = new Map<string, any[]>();
  for (const t of Object.values(tasksCache) as any[]) {
    if (!t.branch || t.kind === 'pr' || TERMINAL_STATUSES.has(t.status)) continue;
    const arr = byBranch.get(t.branch) ?? [];
    arr.push(t);
    byBranch.set(t.branch, arr);
  }
  if (byBranch.size === 0) return;

  for (const [branch, tickets] of byBranch) {
    try {
      const pr = await getPullRequestStatus(branch);
      if (!pr) {
        await setOpenPrSwimlane(tickets, false); // PR gone — clear stale glow
        continue;
      }
      if (pr.state === 'MERGED') {
        await cleanupMergedBranch(workspaceRoot, branch);
      } else if (pr.state === 'CLOSED') {
        // Bounce only tickets currently in a PR state (open-pr swimlane) so we don't
        // re-comment every poll once they're back in In Progress.
        const bounce = tickets.filter((t) => t.swimlane === 'open-pr');
        for (const t of bounce) {
          await updateTaskWithHistory(t.id, {
            updatedBy: 'Agent',
            entries: [{ type: 'comment', user: 'Agent', comment: `PR for \`${branch}\` was closed on GitHub without merging — returned to In Progress.`, date: new Date().toISOString() }],
            nextStatus: 'In Progress',
            extraFields: { swimlane: null },
          });
          broadcastEvent('taskUpdated', { id: t.id });
        }
        if (bounce.length > 0) {
          // Resolve the worktree BY BRANCH (not by an arbitrary branch-ticket's dir) so
          // shared/joined branches detach the worktree that actually holds the branch —
          // mirrors cleanupMergedBranch (reviewer Major, FLUX-557).
          const wt = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
          if (wt) {
            stopAllSessionsForTask(bounce[0].id, 'PR closed — detaching worktree');
            await detachTaskWorktree(workspaceRoot, wt, { ticketId: bounce[0].id, applyToMain: false }).catch(() => {});
          }
        }
      } else {
        // OPEN — discover/refresh: light up the swimlane + glow and stamp the link.
        await setOpenPrSwimlane(tickets, true, pr.url);
      }
    } catch {
      // Best-effort per branch — a single gh hiccup must not abort the sweep.
    }
  }
}

/**
 * Backstop for orphaned merged branches (FLUX-599). The merge-time delete can be missed — the
 * branch was checked out when cleanup ran (can't `-D` a checked-out branch), or all its tickets
 * were already Done so reconcile skipped it (esp. PRs merged directly on GitHub). Squash-merge
 * also hides these from `git branch --merged`. So sweep recently-merged PRs and force-delete any
 * `flux/` branch that still exists and isn't currently checked out / held by a worktree.
 * Idempotent + quiet; best-effort (never throws).
 */
export async function pruneMergedBranches(workspaceRoot: string): Promise<void> {
  // 1. Recently-merged PR head refs (ours only).
  let mergedSet: Set<string>;
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'headRefName'], { cwd: workspaceRoot, windowsHide: true });
    const refs = (JSON.parse(stdout) as any[]).map((p) => p?.headRefName).filter((b): b is string => typeof b === 'string' && b.startsWith('flux/'));
    mergedSet = new Set(refs);
  } catch {
    return; // gh unavailable / non-GitHub remote
  }
  if (mergedSet.size === 0) return;

  // 2. Which flux/ branches still exist (local or remote)?
  const existing = new Set<string>();
  try {
    const { stdout } = await git(workspaceRoot, ['branch', '--list', 'flux/*', '--format=%(refname:short)']);
    stdout.split('\n').forEach((l) => { const b = l.trim(); if (b) existing.add(b); });
  } catch { /* ignore */ }
  try {
    const { stdout } = await git(workspaceRoot, ['ls-remote', '--heads', 'origin', 'flux/*']);
    stdout.split('\n').forEach((l) => { const m = l.match(/refs\/heads\/(.+)$/); if (m && m[1]) existing.add(m[1]); });
  } catch { /* ignore */ }

  // 3. Don't touch the branch the main tree is currently on.
  let cur = '';
  try { const { stdout } = await git(workspaceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']); cur = stdout.trim(); } catch { /* ignore */ }

  for (const branch of mergedSet) {
    if (!existing.has(branch) || branch === cur) continue;
    // A worktree still holds it → leave it for cleanupMergedBranch's worktree-aware teardown.
    const wt = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
    if (wt) continue;
    try {
      await deleteTicketBranch(branch, true);
      console.log(`[pr-prune] removed orphaned merged branch ${branch}`);
    } catch {
      /* best-effort — retry next poll */
    }
  }
}

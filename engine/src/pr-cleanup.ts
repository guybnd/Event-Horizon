import { execFile } from 'child_process';
import { promisify } from 'util';
import { findWorktreeForBranch, removeTaskWorktree, detachTaskWorktree } from './task-worktree.js';
import { getDefaultBranch, deleteTicketBranch, getPullRequestStatus } from './branch-manager.js';
import { addNotification } from './notifications.js';
import { stopAllSessionsForTask } from './session-store.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { TERMINAL_TICKET_STATUSES } from './schema.js';

const execFileAsync = promisify(execFile);

const DONE_STATUS = 'Done';

function git(workspaceRoot: string, args: string[]) {
  return execFileAsync('git', ['-C', workspaceRoot, ...args], { windowsHide: true });
}

/**
 * Whether a ticket has ALREADY reached Done at some point — its history records a status_change
 * into Done, or a prior merge-cleanup "advanced to Done" comment. This is how the AUTOMATIC
 * reconcile path tells a FRESH merge (ticket heading to Done for the first time → advance it) from
 * a DELIBERATE reopen of an already-merged ticket (user moved it back off Done → leave it alone).
 *
 * `gh pr view <branch>` reports a merged branch as MERGED *forever* (the remote branch can even be
 * deleted), so without this guard reconcile re-advances a reopened ticket to Done on every poll —
 * spamming duplicate "advanced to Done" comments and making the reopen impossible to keep (FLUX-588).
 * Explicit callers (finish_ticket, the "Clean up worktree" notification) pass auto=false and bypass
 * this — an explicit finish must always land.
 */
function hasReachedDoneBefore(t: any): boolean {
  const history = Array.isArray(t?.history) ? t.history : [];
  return history.some(
    (h: any) =>
      // A prior transition into Done — the reliable signal: any advance to Done (merge cleanup,
      // finish, or a manual move) emits a status_change (task-store updateTaskWithHistory).
      (h?.type === 'status_change' && h?.to === DONE_STATUS) ||
      // Backstop on this module's OWN merge comment, matched by its exact prefix so a user/agent
      // comment that merely contains "advanced to Done" can't false-positive a fresh ticket.
      (h?.type === 'comment' && typeof h?.comment === 'string' && h.comment.includes('PR squash-merged for branch')),
  );
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
export async function cleanupMergedBranch(workspaceRoot: string, branch: string, opts: { auto?: boolean } = {}): Promise<CleanupResult> {
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
    // AUTO reconcile only (FLUX-588): a ticket the user has DELIBERATELY reopened (it reached Done
    // before, now sits in a non-terminal status) must NOT be force-advanced back to Done. gh reports
    // the merged branch as MERGED forever, so without this the 90s poller snaps the reopen back every
    // tick and spams duplicate "advanced to Done" comments. A fresh, never-Done ticket still advances.
    if (opts.auto && hasReachedDoneBefore(t)) continue;
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

  // AUTO reconcile only (FLUX-588): if a deliberately-reopened ticket (previously Done, now back in
  // a working status) still rides this branch, the merge was already reconciled and the user is
  // actively working again — STOP. Don't stop their sessions, don't tear the worktree down, don't
  // delete the branch out from under them. Explicit finish/cleanup (auto=false) is never short-
  // circuited here. (A fresh sibling on the same branch was already advanced above; its branch just
  // lingers until the reopened sibling also terminalises — correct, the branch is genuinely in use.)
  if (opts.auto && branchTickets.some((t) => !TERMINAL_TICKET_STATUSES.has(t.status) && hasReachedDoneBefore(t))) {
    return { outcome: 'noop', branch, advanced, masterSynced: false, worktreeRemoved: false, branchDeleted: false, reason: 'reopened' };
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

/**
 * Clear a stale `open-pr` swimlane across the tickets sharing a branch — quietly (no history
 * entry) and ONLY when set. The PR-as-ticket model (FLUX-565) makes the `PR-<n>` deck card the
 * PR surface, so normal tickets no longer glow as open PRs (FLUX-558's `open-pr` swimlane is
 * retired — FLUX-569). This mops up any legacy swimlanes left on tickets from before migration;
 * it only ever clears `open-pr`, leaving any other (e.g. `require-input`) swimlane alone.
 */
async function clearOpenPrSwimlane(tickets: any[]): Promise<void> {
  for (const t of tickets) {
    if (t.swimlane === 'open-pr') {
      await updateTaskWithHistory(t.id, { updatedBy: 'Agent', extraFields: { swimlane: null } });
      broadcastEvent('taskUpdated', { id: t.id });
    }
  }
}

/**
 * Reconcile member tickets against gh's PR state (FLUX-557/559) for **out-of-band** GitHub
 * actions (merge/close done directly on GitHub) — the poll-based mechanism (decision #10: poll
 * now, webhooks later). The `PR-<n>` deck card itself is maintained by `syncPrTickets`; this
 * function owns the side-effects on the PR's *member* tickets + the worktree/branch. Runs on
 * the engine's PR interval. For every non-terminal ticket carrying a branch (deduped by branch):
 *  - MERGED  → run post-merge cleanup (advance members → Done + tear down worktree/branch).
 *  - CLOSED  → bounce Ready members back to In Progress + detach (abandon path).
 *  - OPEN    → no-op for normal tickets (the PR ticket is the surface now); mop up any legacy
 *              `open-pr` swimlane left from before the FLUX-558→PR-ticket migration (FLUX-569).
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
    if (!t.branch || t.kind === 'pr' || TERMINAL_TICKET_STATUSES.has(t.status)) continue;
    const arr = byBranch.get(t.branch) ?? [];
    arr.push(t);
    byBranch.set(t.branch, arr);
  }
  if (byBranch.size === 0) return;

  for (const [branch, tickets] of byBranch) {
    try {
      const pr = await getPullRequestStatus(branch);
      if (!pr) {
        await clearOpenPrSwimlane(tickets); // PR gone — mop up any legacy glow
        continue;
      }
      if (pr.state === 'MERGED') {
        // auto:true → respect a deliberate reopen (don't snap it back to Done / don't prune its
        // branch). The merge already landed; re-advancing a reopened ticket every poll is the bug.
        await cleanupMergedBranch(workspaceRoot, branch, { auto: true });
      } else if (pr.state === 'CLOSED') {
        // Bounce Ready members (work done, awaiting merge) back to In Progress — the abandon
        // path. Gated on status===Ready (not the retired open-pr swimlane — FLUX-569): an
        // already-In Progress member is left alone, so this is idempotent and never re-comments
        // on the next poll. Todo/Grooming pile tickets on the branch aren't members → untouched.
        const bounce = tickets.filter((t) => t.status === 'Ready');
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
        // OPEN — the PR's home is now its `PR-<n>` deck card (maintained by syncPrTickets), not
        // a glow on the member tickets. Nothing to set here; just mop up any legacy `open-pr`
        // swimlane carried over from before the migration (FLUX-569).
        await clearOpenPrSwimlane(tickets);
      }
    } catch {
      // Best-effort per branch — a single gh hiccup must not abort the sweep.
    }
  }
}

/**
 * Branches whose backstop delete has thrown and already raised a "couldn't clean up" notification
 * (FLUX-599). Deduped here so a genuinely-stuck branch is surfaced ONCE per orphaned state rather
 * than re-notified every poll. An entry is cleared when its branch finally disappears from the
 * existing set (deleted by hand or by a later poll), so a future re-orphan can notify again.
 * In-module ⇒ resets on engine restart, which is acceptable: re-notifying once after a restart for
 * a still-stuck branch is fine.
 */
const notifiedStuckBranches = new Set<string>();

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

  // 3b. Don't prune a branch a still-active (non-terminal) ticket rides — e.g. a deliberately
  // reopened merged-PR ticket (FLUX-588). Its PR is MERGED on GitHub, but the user is working on it
  // again; force-deleting the branch would pull live work out from under them. Once the ticket
  // terminalises (Done/Archived/Released) the branch is eligible for the normal post-merge prune.
  const activeBranches = new Set<string>();
  for (const t of Object.values(tasksCache) as any[]) {
    if (t.branch && !TERMINAL_TICKET_STATUSES.has(t.status)) activeBranches.add(t.branch);
  }

  // A previously-stuck branch that's now gone (deleted by hand / a later poll) drops its dedupe
  // entry so a future re-orphan can notify again.
  for (const b of [...notifiedStuckBranches]) {
    if (!existing.has(b)) notifiedStuckBranches.delete(b);
  }

  for (const branch of mergedSet) {
    if (!existing.has(branch) || branch === cur || activeBranches.has(branch)) continue;
    // A worktree still holds it → leave it for cleanupMergedBranch's worktree-aware teardown.
    const wt = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
    if (wt) continue;
    try {
      await deleteTicketBranch(branch, true);
      console.log(`[pr-prune] removed orphaned merged branch ${branch}`);
      notifiedStuckBranches.delete(branch); // recovered
    } catch {
      // The branch is gh-MERGED, not checked out, and not worktree-held — i.e. it SHOULD be
      // deletable — yet the delete keeps throwing (gh/remote outage, a lock, perms). Retrying
      // forever in silence orphans it with no user signal (FLUX-599 residual). Surface it ONCE
      // (deduped above) so the user can delete it manually, instead of swallowing.
      if (!notifiedStuckBranches.has(branch)) {
        notifiedStuckBranches.add(branch);
        try {
          addNotification({
            type: 'error',
            title: 'Branch cleanup failed',
            message:
              `Couldn't clean up merged branch \`${branch}\` — delete it manually ` +
              `(\`git branch -D ${branch}\` and \`git push origin --delete ${branch}\`).`,
            actions: [{ label: 'Dismiss', actionId: 'dismiss' }],
          });
        } catch { /* notification must never break the sweep */ }
      }
      /* best-effort — retry next poll */
    }
  }
}

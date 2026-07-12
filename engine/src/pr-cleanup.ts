import { getWorkspace } from './workspace-context.js';
import { log } from './log.js';
import { findWorktreeForBranch, removeTaskWorktree, detachTaskWorktree, stashDirtyTree, unlinkWorktreeDependencies, reclaimWorktrees } from './task-worktree.js';
import { getDefaultBranch, deleteTicketBranch, getPullRequestStatus, getTicketBranchStatus, getOpenPullRequestsWithBase } from './branch-manager.js';
import { addNotification } from './notifications.js';
import { stopAllSessionsForTask, getActiveSessionsForTask, isWithinReclaimGrace, RECLAIM_GRACE_MS } from './session-store.js';
import { updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { getConfig } from './config.js';
import { TERMINAL_TICKET_STATUSES } from './schema.js';
import { buildActivityEntry } from './history.js';
// FLUX-1297: disarm Temper before this module stops a ticket's sessions itself (see
// `disarmTemperForExternalStop`'s doc comment). Deliberately a function-body-only cross-import —
// furnace-stoker.ts already imports from this module (reclaimReadyWorktrees), so this closes a
// 3-file cycle (pr-cleanup -> temper -> furnace-stoker -> pr-cleanup) that is safe because none of
// the three touch each other's exports at module-evaluation time, only inside function bodies.
import { disarmTemperForExternalStop } from './temper.js';
// FLUX-998 (epic FLUX-996): route every git/gh call in the post-merge cleanup + PR-reconcile
// path through the S1 runner — a hung `git fetch`/`gh pr list` here used to block the merge
// and the 90s reconcile poller forever (no timeout, no non-interactive env).
import { runGit, runGh } from './git-exec.js';

const DONE_STATUS = 'Done';

function git(workspaceRoot: string, args: string[]) {
  return runGit(args, { cwd: workspaceRoot });
}

/**
 * History-entry shape as read by this module — covers only the `status_change`/`comment`/
 * `agent_session` fields it actually inspects (frontmatter history is a loosely-typed,
 * runtime-validated record — see `schema.ts#validateTicketFrontmatter` — not a single
 * canonical TS type).
 */
interface TicketHistoryEntry {
  type?: string;
  to?: string;
  comment?: string;
  date?: string;
  endedAt?: string;
  startedAt?: string;
  /** FLUX-1305: marks the `worktree-created` activity entry `ensureTicketIsolation` stamps. */
  event?: string;
}

/** Minimal `tasksCache` ticket shape as read/written by this module. */
interface CachedTicket {
  id: string;
  branch?: string;
  status: string;
  kind?: string;
  implementationLink?: string;
  swimlane?: string | null;
  history?: TicketHistoryEntry[];
  /** FLUX-1326: see {@link branchesPendingDependencyClear}'s doc comment. */
  branchDeletePending?: boolean;
}

// ─── Worktree reclamation at Ready (FLUX-1031) ───────────────────────────────

/** Why {@link worktreeUnreclaimableReason} refused — surfaced by the Furnace's slot-holder naming (FLUX-1157). */
export type UnreclaimableReason = 'unknown-ticket' | 'live-session' | 'recent-activity' | 'status';

/**
 * Why a ticket's task worktree can NOT be reclaimed (its slot returned to the board-wide pool) right
 * now, or `null` when it IS reclaimable — FLUX-1031. {@link isWorktreeReclaimable} is a thin boolean
 * wrapper over this; the reason itself exists so callers that need to explain a still-held slot (the
 * Furnace's `no_slots` refusal, FLUX-1157) don't have to re-derive the same checks.
 *
 * The task-worktree pool is capped board-wide (DEFAULT_MAX_TASK_WORKTREES = 4).
 * Before this, a slot was freed ONLY when a PR merged, so every ticket resting at
 * Ready (awaiting review) kept holding one — stack up ~4 Ready tickets, or a
 * Furnace batch that opens PRs back-to-back, and the next task's spawn failed with
 * "worktree limit reached (4/4)". A ticket becomes reclaimable the moment it reaches
 * Ready: the commit-before-Ready invariant (mcp-server `evaluateWorktreeReadyRefusal`)
 * guarantees its work is committed on — and the PR push put it on the remote of — the
 * feature branch, so removing the worktree loses nothing. If the ticket later bounces
 * back to In Progress on a changes-requested round-trip, `resolveTaskExecutionRoot`
 * self-heals the worktree (recreates it from the branch, which still carries every
 * commit). Terminal tickets (Done/Released/Archived) are reclaimable for the same
 * reason — their branch already merged or was abandoned.
 *
 * NEVER reclaim while a session is still live on the worktree's branch: that would
 * yank a slot out from under work in flight — chiefly the very session that just moved
 * the ticket to Ready and is still winding down. Such a worktree is left for the next
 * sweep, which reclaims it once the session ends. (The lower-level `reclaimWorktrees`
 * independently refuses to remove a tree with uncommitted tracked changes, so real work
 * is doubly protected.)
 *
 * The live-session check spans EVERY ticket sharing the worktree's branch, not just the
 * directory-owning ticket (FLUX-1031 review). A task runs in whatever worktree holds ITS
 * branch, and a ticket can *Join* another ticket's branch — the documented mechanism for a
 * review-bug fix to ride along on the same branch/worktree while the original ticket rests
 * at Ready (see `resolveTaskExecutionRoot`). That joined sibling's live session runs inside
 * this physical worktree even though the directory is named for `ticketId`, so keying the
 * guard on `ticketId` alone would leave it invisible and let the sweep delete the worktree
 * out from under it. Mirror `sharedNonDoneSiblings`' branch-scoped resolution instead.
 *
 * `opts.honorReadyGrace` (default true) applies the {@link READY_WORKTREE_GRACE_MS} buffer
 * below — pass `false` for the under-pressure cap backstop (ticket-isolation.ts), which must
 * still reclaim instantly when a spawn is genuinely blocked on the concurrency cap.
 */
export function worktreeUnreclaimableReason(ticketId: string, opts: { honorReadyGrace?: boolean } = {}): UnreclaimableReason | null {
  const t = (getWorkspace().tasks as Record<string, CachedTicket>)[ticketId];
  if (!t) return 'unknown-ticket';
  if (hasLiveSessionOnBranch(t.branch, ticketId)) return 'live-session'; // never yank live work
  // FLUX-1060: within the post-restart grace window, also protect a worktree whose ticket shows
  // very recent session activity. After an engine restart the in-memory session map is empty and
  // rehydrated from persisted stubs (session-store) — but a session that entered `waiting-input`
  // just before the restart may have had no stub written yet, so the branch check above can't see
  // it. Outside the grace window this is inert, so steady-state reclaim (FLUX-1031) is unchanged.
  if (isWithinReclaimGrace() && hasRecentSessionActivity(t)) return 'recent-activity';
  // FLUX-1112: a short, ALWAYS-ON buffer after a ticket's last session activity, distinct from the
  // post-restart-only grace above. Incidents FLUX-1094/1103/1095 saw a Ready ticket's worktree
  // vanish out from under an active reviewer within moments of the review starting — the reviewer
  // had `cd`'d into the worktree directly (or was otherwise not a session the live-session guard
  // above can see: e.g. an orchestrator/board session, or a session scoped to a different ticket)
  // rather than dispatching a registered EH session on THIS ticket, so hasLiveSessionOnBranch saw
  // nothing to protect. A ticket most commonly gets its first review moments after its
  // implementation session ends and it lands at Ready, so a brief buffer covers exactly that
  // window without meaningfully reintroducing the board-wide pool exhaustion FLUX-1031 fixed
  // (tickets reach Ready at staggered times in practice, and the cap backstop below bypasses this
  // buffer entirely when a slot is genuinely needed right now).
  if (opts.honorReadyGrace !== false && hasRecentSessionActivity(t, Date.now(), READY_WORKTREE_GRACE_MS)) return 'recent-activity';
  const readyStatus = getConfig().readyForMergeStatus || 'Ready';
  if (t.status === readyStatus || TERMINAL_TICKET_STATUSES.has(t.status)) return null;
  return 'status';
}

/** Whether a ticket's task worktree can be reclaimed right now — see {@link worktreeUnreclaimableReason}. */
export function isWorktreeReclaimable(ticketId: string, opts: { honorReadyGrace?: boolean } = {}): boolean {
  return worktreeUnreclaimableReason(ticketId, opts) === null;
}

/**
 * FLUX-1214 backstop: on top of the ordinary {@link worktreeUnreclaimableReason} gate, ALSO reclaim
 * a worktree whose ticket is refused solely for `'status'` (not Ready/terminal) when its branch
 * carries zero commits ahead of its base. The `'status'` gate assumes a resting ticket's worktree
 * holds real, uncommitted-to-base work that a reviewer/implementer will return to — true for a
 * ticket mid-implementation, but not for one whose branch was created and then never used for a
 * single commit (a phase-blind isolation bug, e.g. the grooming-phase branch this ticket fixes; or
 * a manual `branch` MCP call on a ticket that never got worked). Such a worktree is safe to remove
 * regardless of status: nothing is lost, and `resolveTaskExecutionRoot`/`createTaskWorktree`
 * self-heal it from the branch if the ticket is later dispatched for real. Never widens past
 * `'status'` — the live-session/recent-activity refusals above still apply unconditionally, so this
 * can never yank a worktree out from under work in flight.
 */
export async function isWorktreeReclaimableForSweep(ticketId: string, opts: { honorReadyGrace?: boolean } = {}): Promise<boolean | string> {
  const reason = worktreeUnreclaimableReason(ticketId, opts);
  if (reason === null) return 'ready-or-terminal-status';
  if (reason !== 'status') return false;
  const t = (getWorkspace().tasks as Record<string, CachedTicket>)[ticketId];
  if (!t?.branch) return false;
  // FLUX-1305: never widen past a worktree that was JUST created — give it a chance to pick up a
  // session or a commit before the zero-commit backstop below treats it as abandoned. Without this,
  // a worktree created via the `branch` MCP tool from a board/chat session — which never registers
  // a live EH session for the ticket, so the checks above can't see it — reads as
  // 'status'-refused-but-zero-commits and gets swept on the very next ~90s reconcile tick, before
  // the calling session even starts editing (incident: FLUX-1303's worktree vanishing twice).
  if (hasRecentWorktreeCreation(t)) return false;
  const branchStatus = await getTicketBranchStatus(t.branch).catch(() => null);
  if (!branchStatus?.exists || branchStatus.aheadCount !== 0) return false;
  return 'zero-commit-branch (FLUX-1214)';
}

/**
 * FLUX-1112: always-on buffer (not gated to the post-restart window) between a ticket's last
 * recorded session activity and the moment its worktree becomes reclaimable by the PROACTIVE
 * paths (the periodic sweep + the eager reclaim-at-Ready trigger). Deliberately short — long
 * enough to survive the first minute or two after a ticket reaches Ready (when a reviewer most
 * commonly starts looking), not long enough to meaningfully stall board-wide pool recovery.
 */
export const READY_WORKTREE_GRACE_MS = 3 * 60_000;

/**
 * FLUX-1305: how long a freshly-created, never-committed-to worktree is shielded from the
 * FLUX-1214 zero-commit-branch backstop (see {@link isWorktreeReclaimableForSweep}). Deliberately
 * generous (well beyond the ~90s reconcile-tick cadence) — this only delays reclaiming a branch
 * that truly never gets worked; it never protects one that picks up a commit or a live session
 * (those are already unreclaimable through the ordinary checks).
 */
export const WORKTREE_CREATION_GRACE_MS = 30 * 60_000;

/**
 * Was this ticket's worktree created within the last `graceMs`? Scans history for the
 * `worktree-created` marker `ensureTicketIsolation` stamps when it makes a NEW worktree — the only
 * signal available for a worktree spun up from a board/chat session, which never registers a live
 * EH session on the ticket (so {@link hasLiveSessionOnBranch} can't see it either).
 */
function hasRecentWorktreeCreation(t: CachedTicket, now: number = Date.now(), graceMs: number = WORKTREE_CREATION_GRACE_MS): boolean {
  const history = Array.isArray(t?.history) ? t.history : [];
  for (const h of history) {
    if (h?.type !== 'activity' || h?.event !== 'worktree-created') continue;
    const ts = Date.parse(h.date ?? '');
    if (!Number.isNaN(ts) && now - ts < graceMs) return true;
  }
  return false;
}

/**
 * Did this ticket have an agent session whose last-known activity is within `graceMs` of `now`?
 * Scans its own history for an `agent_session` entry's most recent timestamp. Two callers:
 *  - the post-restart grace (default `graceMs=RECLAIM_GRACE_MS`, only consulted inside
 *    {@link isWithinReclaimGrace}) — `reconcileOrphanedSessions` stamps `endedAt`≈boot-time on
 *    every session still active at restart, so those read as "recent" for that window.
 *  - the always-on {@link READY_WORKTREE_GRACE_MS} buffer (FLUX-1112) above.
 * Owner-scoped: a joined branch sibling's activity is already covered by the branch-scoped
 * live-session check, not this history scan.
 */
function hasRecentSessionActivity(t: CachedTicket, now: number = Date.now(), graceMs: number = RECLAIM_GRACE_MS): boolean {
  const history = Array.isArray(t?.history) ? t.history : [];
  for (const h of history) {
    if (h?.type !== 'agent_session') continue;
    const ts = Date.parse(h.endedAt ?? h.date ?? h.startedAt ?? '');
    if (!Number.isNaN(ts) && now - ts < graceMs) return true;
  }
  return false;
}

/**
 * Is any session live on `branch` — the directory-owning ticket's OR a joined sibling's
 * (any other ticket whose `branch` is this branch)? Branch-scoped so a ticket that Joined
 * the worktree's branch (the review-bug-fix ride-along) can't be reclaimed out from under.
 * Falls back to the owning-ticket-only check when the ticket carries no branch.
 */
function hasLiveSessionOnBranch(branch: string | undefined, ownerId: string): boolean {
  if (getActiveSessionsForTask(ownerId).length > 0) return true;
  if (!branch) return false;
  for (const t of Object.values(getWorkspace().tasks) as CachedTicket[]) {
    if (t.id === ownerId || t.branch !== branch) continue;
    if (getActiveSessionsForTask(t.id).length > 0) return true;
  }
  return false;
}

/**
 * Proactive board-wide sweep (FLUX-1031): reclaim every task worktree whose owning
 * ticket is reclaimable (Ready or terminal) and idle (no live session, clean tree) —
 * OR (FLUX-1214) whose branch never picked up a single commit, regardless of status
 * (see {@link isWorktreeReclaimableForSweep}). Runs on the engine's reconcile interval
 * so a Ready ticket's slot is freed shortly after its session ends — well before the
 * pool can exhaust — without a per-adapter exit hook. `reclaimWorktrees` never
 * discards real work (it removes only genuinely clean trees). Returns the reclaimed
 * ticket ids. Best-effort; never throws.
 */
export async function reclaimReadyWorktrees(workspaceRoot: string): Promise<string[]> {
  // FLUX-1305: capture the rule string `isWorktreeReclaimableForSweep` resolved for each ticket so
  // a reclaimed worktree's disappearance is explained on the ticket itself, not just silently
  // logged engine-side (reclaimWorktrees logs the same rule to stderr).
  const rules = new Map<string, string>();
  const predicate = async (ticketId: string): Promise<boolean | string> => {
    const rule = await isWorktreeReclaimableForSweep(ticketId);
    if (rule) rules.set(ticketId, typeof rule === 'string' ? rule : 'reclaimable');
    return rule;
  };
  const reclaimed = await reclaimWorktrees(workspaceRoot, predicate).catch(() => [] as string[]);
  for (const id of reclaimed) {
    const rule = rules.get(id) ?? 'idle-worktree-cleanup';
    await updateTaskWithHistory(id, {
      updatedBy: 'Agent',
      entries: [buildActivityEntry(`Task worktree automatically reclaimed (${rule})`, 'Agent', new Date().toISOString())],
    }).catch(() => {});
  }
  return reclaimed;
}

/**
 * Dirty-root backstop (FLUX-741, incident FLUX-734): before the engine switches/resets the MAIN
 * tree off a merged branch (post-merge cleanup MUST proceed), stash any uncommitted work so the
 * switch can't silently discard it, and surface the recoverable stash ref so the work isn't merely
 * "safe but invisible". Best-effort: never throws — a notification failure must not abort cleanup.
 */
async function backstopDirtyRoot(workspaceRoot: string, branch: string, reason: string): Promise<void> {
  try {
    const guard = await stashDirtyTree(workspaceRoot, { reason: `EH ${reason} ${branch}` });
    if (!guard.stashed) return;
    const refHint = guard.stashRef ? guard.stashRef.slice(0, 10) : 'stash@{0}';
    addNotification({
      type: 'info',
      title: 'Uncommitted root changes stashed',
      message:
        `The main checkout had uncommitted changes when cleaning up \`${branch}\`. ` +
        `They were stashed (not lost) before the engine switched the tree — recover with ` +
        `\`git stash apply ${guard.stashRef ?? 'stash@{0}'}\` (or see \`git stash list\` for \`${refHint}\`).`,
      actions: [{ label: 'Dismiss', actionId: 'dismiss' }],
    });
  } catch {
    /* best-effort — durability is the stash; the notification is a courtesy */
  }
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
function hasReachedDoneBefore(t: CachedTicket): boolean {
  const history = Array.isArray(t?.history) ? t.history : [];
  return history.some(
    (h: TicketHistoryEntry) =>
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
  reason?: string;           // when unsafe, or when the delete was skipped (see 'branch-depended-on')
  notificationId?: string;   // when unsafe
  dependentTicketIds?: string[]; // FLUX-1270: flagged `merge-conflict` when reason is 'branch-depended-on'
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
      // The ff-merge updates working-tree files; a fast-forward that touches a locally-modified
      // file would abort (or, worse, the surrounding cleanup would later clobber it). Stash any
      // dirty root work first so nothing is lost (FLUX-741) before fast-forwarding in place.
      await backstopDirtyRoot(workspaceRoot, def, 'pre-sync');
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
  const branchTickets = (Object.values(getWorkspace().tasks) as CachedTicket[]).filter((t) => t.branch === branch);

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
    } catch (err) {
      console.error(`[pr-cleanup] Failed to advance ${t.id} after merge of ${branch}:`, (err as Error)?.message);
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

  // FLUX-1297: disarm Temper on every ticket on this branch BEFORE stopping their sessions —
  // otherwise Temper's own tick can observe the resulting 'cancelled' review session and park a
  // ticket whose work just landed (the finish/merge race). Best-effort: never blocks cleanup.
  for (const t of branchTickets) {
    try { await disarmTemperForExternalStop(t.id); } catch { /* best effort */ }
  }

  // 2. Stop sessions on the worktree.
  for (const t of branchTickets) stopAllSessionsForTask(t.id, 'Post-merge worktree cleanup');

  // 3. Fast-forward local master.
  const masterSynced = await syncDefaultBranch(workspaceRoot);

  // 4 + 5. Worktree teardown (gated on a clean tree).
  const worktree = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
  let worktreeRemoved = false;
  if (worktree) {
    // FLUX-1018: drop the shared node_modules junctions (FLUX-518) BEFORE the
    // dirty check. They are untracked symlinks into the main tree, so they always
    // make `git status --porcelain` non-empty — which used to make EVERY merged
    // worktree read as "dirty", so cleanup kept it. Stale Done worktrees then
    // piled up and filled the concurrency cap, forcing new isolated sessions to
    // fall back onto master (the FLUX-972 incident). Unlinking first is safe
    // (link-only deletes, never the target) and lets a genuinely clean worktree
    // be removed while real uncommitted work still trips the guard below.
    await unlinkWorktreeDependencies(worktree).catch(() => {});
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
      // Dirty-root backstop (FLUX-741, FLUX-734): the main tree is on the merged branch and is
      // about to be switched off it — `git checkout <def>` would silently discard uncommitted
      // root edits (the FLUX-739 loss). Stash them first (recoverable) and surface the ref.
      await backstopDirtyRoot(workspaceRoot, branch, 'pre-cleanup');
      await git(workspaceRoot, ['checkout', def]);
      await git(workspaceRoot, ['merge', '--ff-only', `origin/${def}`]).catch(() => {});
    }
  } catch {
    // Best-effort — if we can't switch off the branch, the delete below just no-ops.
  }

  // FLUX-1270: don't delete a branch another OPEN PR still bases off — GitHub auto-closes that PR
  // the instant its base ref disappears, with no error surfaced anywhere (the live incident this
  // guards against: FLUX-861 merged/deleted while FLUX-1265's PR still based off it, silently
  // reverting FLUX-1265's work). Flag the dependent ticket(s) `merge-conflict` (same swimlane +
  // "Launch Rebase Session" CTA as a real git conflict — generalized off PrDeckCard.tsx-only scoping
  // so it also renders on a plain, non-PR ticket card) instead of deleting, so a human can either
  // rebase them onto master or pull {parent, follow-up} into a sequential batch that adopts this
  // branch (`furnace_build`'s `adoptBranchFrom`).
  const dependentPrs = await getOpenPullRequestsWithBase(branch).catch(() => []);
  if (dependentPrs.length) {
    const dependentBranches = new Set(dependentPrs.map((p) => p.headRefName).filter(Boolean));
    const dependentTickets = (Object.values(getWorkspace().tasks) as CachedTicket[]).filter((t) => t.branch && dependentBranches.has(t.branch));
    for (const t of dependentTickets) {
      if (t.swimlane === 'merge-conflict') continue; // already flagged
      const pr = dependentPrs.find((p) => p.headRefName === t.branch);
      try {
        await updateTaskWithHistory(t.id, {
          updatedBy: 'Agent',
          entries: [{
            type: 'comment',
            user: 'Agent',
            comment:
              `\`${branch}\` (this ticket's base branch) just merged and would normally be deleted — but ` +
              `PR ${pr?.url || `#${pr?.number ?? '?'}`} still depends on it, so the branch was KEPT to avoid ` +
              `GitHub silently auto-closing that PR. Rebase this ticket's branch onto \`master\`, or fold it ` +
              `into a sequential batch that adopts \`${branch}\`, before it can be safely removed.`,
            date: new Date().toISOString(),
          }],
          extraFields: { swimlane: 'merge-conflict' },
        });
        broadcastEvent('taskUpdated', { id: t.id });
      } catch (err) {
        console.error(`[pr-cleanup] Failed to flag ${t.id} as depending on merged branch ${branch}:`, (err as Error)?.message);
      }
    }
    // FLUX-1326: persist a marker on THIS branch's own tickets (already advanced to Done in step 1
    // above) so a later sweep can find and retry `branch` once the dependency clears.
    // `reconcilePullRequests` only groups NON-terminal tickets by branch, so the instant every
    // ticket on `branch` reaches Done, the branch drops out of that grouping and this function is
    // never called again for it by the normal poller — without a persisted marker the branch would
    // linger forever once flagged (see `recheckDependentBranches`, which scans for this marker
    // instead of relying on ticket status). Persisted rather than an in-module Set so it survives an
    // engine restart.
    for (const t of branchTickets) {
      if (t.branchDeletePending) continue; // already marked
      try {
        await updateTaskWithHistory(t.id, { updatedBy: 'Agent', extraFields: { branchDeletePending: true } });
      } catch (err) {
        console.error(`[pr-cleanup] Failed to mark ${t.id}'s branch ${branch} for a dependency recheck:`, (err as Error)?.message);
      }
    }
    return {
      outcome: 'cleaned',
      branch,
      advanced,
      masterSynced,
      worktreeRemoved,
      branchDeleted: false,
      reason: 'branch-depended-on',
      dependentTicketIds: dependentTickets.map((t) => t.id),
    };
  }

  // FLUX-1326: the dependency (if any) has cleared — drop the marker set above so
  // `recheckDependentBranches` stops resweeping this branch. Guarded so the common case (a branch
  // that was never dependency-blocked) never writes.
  for (const t of branchTickets) {
    if (!t.branchDeletePending) continue;
    try {
      await updateTaskWithHistory(t.id, { updatedBy: 'Agent', extraFields: { branchDeletePending: null } });
    } catch (err) {
      console.error(`[pr-cleanup] Failed to clear the dependency-recheck marker on ${t.id}:`, (err as Error)?.message);
    }
  }

  // Force-delete the branch (local + remote) — squash merge ⇒ `-d` won't recognise it.
  // FLUX-1231: if a worktree still holds this branch (it read clean above but removeTaskWorktree
  // couldn't remove it — a lock/leftover), a `git branch -D` is GUARANTEED to fail ("used by
  // worktree"). Skip the doomed local+remote delete entirely; the next reconcile retries once the
  // worktree is gone. This keeps the log clean at the source instead of relying only on
  // deleteTicketBranch's quieted catch.
  let branchDeleted = false;
  if (worktree && !worktreeRemoved) {
    log.debug(`[pr-cleanup] deferred branch delete for ${branch} — a worktree still holds it; will retry once removed`);
  } else {
    try {
      await deleteTicketBranch(branch, true);
      branchDeleted = true;
    } catch {
      // Already gone, or still checked out somewhere — best-effort; reconcile will retry.
    }
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
async function clearOpenPrSwimlane(tickets: CachedTicket[]): Promise<void> {
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
  const byBranch = new Map<string, CachedTicket[]>();
  for (const t of Object.values(getWorkspace().tasks) as CachedTicket[]) {
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
            extraFields: { swimlane: null, reviewState: null },
          });
          broadcastEvent('taskUpdated', { id: t.id });
        }
        if (bounce.length > 0) {
          // Resolve the worktree BY BRANCH (not by an arbitrary branch-ticket's dir) so
          // shared/joined branches detach the worktree that actually holds the branch —
          // mirrors cleanupMergedBranch (reviewer Major, FLUX-557).
          const wt = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
          if (wt) {
            stopAllSessionsForTask(bounce[0]!.id, 'PR closed — detaching worktree');
            await detachTaskWorktree(workspaceRoot, wt, { ticketId: bounce[0]!.id, applyToMain: false }).catch(() => {});
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
 * Branches `cleanupMergedBranch` is currently holding onto because another OPEN PR still bases off
 * them (FLUX-1270's `branch-depended-on` guard) — every ticket carrying a truthy
 * `branchDeletePending` marker, grouped by branch. Deliberately scans ALL of `tasksCache` (not
 * `reconcilePullRequests`'s non-terminal-only grouping): the tickets on a `branch-depended-on`
 * branch are already Done by the time the marker is set (step 1 of `cleanupMergedBranch` advances
 * them before the dependent-PR check runs), so a terminal-status filter would never see them again.
 * Persisted on ticket frontmatter rather than an in-module `Set` so it survives an engine restart.
 */
function branchesPendingDependencyClear(): Set<string> {
  const branches = new Set<string>();
  for (const t of Object.values(getWorkspace().tasks) as CachedTicket[]) {
    if (t.branch && t.branchDeletePending) branches.add(t.branch);
  }
  return branches;
}

/**
 * FLUX-1326: revisit branches `cleanupMergedBranch` kept alive under its dependent-PR guard
 * (`reason: 'branch-depended-on'`) and retry the delete now that time has passed — the dependent
 * PR(s) may since have merged, closed, or been rebased off `branch` entirely. Without this, once a
 * `branch-depended-on` branch's tickets all reach Done, `reconcilePullRequests`'s non-terminal
 * grouping never revisits it and the branch lingers indefinitely (see
 * {@link branchesPendingDependencyClear}). `cleanupMergedBranch` itself is idempotent and does the
 * real work: if a dependent PR is still open it just re-flags (no-op — already-flagged tickets are
 * skipped) and the marker stays; once the dependency is gone it deletes the branch and clears the
 * marker. Runs on the same cadence as `reconcilePullRequests`/`pruneMergedBranches`. Best-effort;
 * never throws.
 */
export async function recheckDependentBranches(workspaceRoot: string): Promise<void> {
  for (const branch of branchesPendingDependencyClear()) {
    try {
      await cleanupMergedBranch(workspaceRoot, branch, { auto: true });
    } catch {
      // Best-effort per branch — retry next tick.
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
    const { stdout } = await runGh(['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'headRefName'], { cwd: workspaceRoot });
    const refs = (JSON.parse(stdout) as Array<{ headRefName?: unknown }>)
      .map((p) => p?.headRefName)
      .filter((b): b is string => typeof b === 'string' && b.startsWith('flux/'));
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
  for (const t of Object.values(getWorkspace().tasks) as CachedTicket[]) {
    if (t.branch && !TERMINAL_TICKET_STATUSES.has(t.status)) activeBranches.add(t.branch);
  }

  // A previously-stuck branch that's now gone (deleted by hand / a later poll) drops its dedupe
  // entry so a future re-orphan can notify again.
  for (const b of [...notifiedStuckBranches]) {
    if (!existing.has(b)) notifiedStuckBranches.delete(b);
  }

  // FLUX-1326: don't force-delete a branch cleanupMergedBranch deliberately kept alive under its
  // dependent-PR guard (FLUX-1270) — its tickets are already Done (terminal), so `activeBranches`
  // above doesn't protect it, and its worktree was already torn down before that guard was hit, so
  // the worktree check right below doesn't protect it either. Without this, this backstop would
  // force-delete the branch on the very next tick after cleanupMergedBranch flags it — reintroducing
  // the exact GitHub auto-close-the-dependent-PR incident the guard exists to prevent. Leave it for
  // `recheckDependentBranches` to retry (via cleanupMergedBranch's own dependency check) instead.
  const pendingDependencyBranches = branchesPendingDependencyClear();

  for (const branch of mergedSet) {
    if (!existing.has(branch) || branch === cur || activeBranches.has(branch)) continue;
    if (pendingDependencyBranches.has(branch)) continue;
    // A worktree still holds it → leave it for cleanupMergedBranch's worktree-aware teardown.
    const wt = await findWorktreeForBranch(workspaceRoot, branch).catch(() => null);
    if (wt) continue;
    try {
      await deleteTicketBranch(branch, true);
      log.info(`[pr-prune] removed orphaned merged branch ${branch}`);
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

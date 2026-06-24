import { execFile } from 'child_process';
import { promisify } from 'util';
import { tasksCache, upsertManagedTicket, updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';

const execFileAsync = promisify(execFile);

// Membership is WORK-GATED (FLUX-565 decision #4): a ticket folds into a PR only once it's
// being developed on the branch. Todo/Grooming/Backlog tickets that merely point at the
// branch stay in their pile and are NOT members.
const WORKING_STATUSES = new Set(['In Progress', 'Ready']);

const PR_KIND = 'pr';

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: string; // OPEN | MERGED | CLOSED
  headRefName: string;
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  isDraft: boolean;
}

export function prTicketId(n: number): string {
  return `PR-${n}`;
}

/**
 * Work-gated membership (FLUX-565 #4), pure + testable: from a set of tickets, the ones
 * actively developed on `branch` (a normal ticket, not a PR ticket, In Progress/Ready).
 * Todo/Grooming/Backlog tickets that point at the branch are deliberately excluded — they
 * stay in their pile until work starts.
 */
export function selectMembers(tickets: any[], branch: string): string[] {
  return tickets
    .filter((t) => t && t.kind !== PR_KIND && t.branch === branch && WORKING_STATUSES.has(t.status))
    .map((t) => t.id)
    .sort();
}

// A merge advances every ticket on the branch → Done; these statuses are already terminal, so a
// sibling in one of them has no live work a merge would silently sweep along.
const TERMINAL_TICKET_STATUSES = new Set(['Done', 'Released', 'Archived']);

/**
 * Sibling tickets sharing `branch` (excluding `selfId` and PR tickets) that are NOT terminal —
 * pure + testable. The finish-on-shared-PR guard (FLUX-569, from the FLUX-556/PR#6 one-way-door
 * incident): finishing/merging a single member squash-merges the whole branch, advancing every
 * one of these to Done irreversibly. The guard refuses when any exist unless the caller passes
 * `force`. PR tickets (kind:'pr') are exempt — merging a PR ticket to advance its members IS the
 * sanctioned shared-merge surface.
 */
export function sharedNonDoneSiblings(tickets: any[], branch: string, selfId: string): any[] {
  return tickets.filter(
    (t) => t && t.kind !== PR_KIND && t.branch === branch && t.id !== selfId && !TERMINAL_TICKET_STATUSES.has(t.status),
  );
}

/** PR tickets (kind:'pr') that point at `branch` — pure + testable. */
export function prTicketsOnBranch(tickets: any[], branch: string): any[] {
  return tickets.filter((t) => t && t.kind === PR_KIND && t.branch === branch);
}

/**
 * Resolve every PR ticket on `branch` to the terminal merged state immediately — the
 * post-merge counterpart to syncPrTickets' stale-PR resolution. POST /:id/pr/merge calls this
 * right after the squash-merge so a merged PR card flips to Done + MERGED at once instead of
 * sitting OPEN until the next 90s reconciler poll (FLUX-588). cleanupMergedBranch deliberately
 * skips kind:'pr' tickets (their state is owned here / by syncPrTickets — FLUX-587), so without
 * this the card lingers for up to a poll interval. Best-effort per ticket (upsert only writes on
 * a real change); broadcasts each update and returns the resolved PR-ticket ids.
 */
export async function resolveMergedPrTickets(branch: string): Promise<string[]> {
  const resolved: string[] = [];
  for (const t of prTicketsOnBranch(Object.values(tasksCache) as any[], branch)) {
    await upsertManagedTicket(t.id, { status: 'Done', prState: 'MERGED', swimlane: null }).catch(() => {});
    broadcastEvent('taskUpdated', { id: t.id });
    resolved.push(t.id);
  }
  return resolved;
}

/** The slice of an existing PR ticket the field-mapper needs to decide status transitions. */
export interface ExistingPrState {
  status?: string;
  prState?: string;
}

const TERMINAL_PR_STATES = new Set(['MERGED', 'CLOSED']);

/**
 * Was this PR ticket resolved (Done / terminal gh-state) and is now OPEN again on gh? A
 * CLOSED-then-reopened (or merged-then-reopened) PR has to climb back out of Done — the
 * FLUX-566 deferred edge: the old `isNew`-gated mapper left it stuck at Done forever.
 */
function isReopened(existing: ExistingPrState | null): boolean {
  if (!existing) return false;
  return existing.status === 'Done' || (existing.prState ? TERMINAL_PR_STATES.has(existing.prState) : false);
}

/**
 * PR-ticket frontmatter fields for an OPEN gh PR (pure). `existing` is the current PR ticket
 * (or null for a brand-new one) and drives the status transition (FLUX-569 lifecycle edges):
 *  - CHANGES_REQUESTED → In Progress + `changes-requested` tint (the review-fail bounce).
 *  - brand-new OR reopened (was Done/terminal, now OPEN again) → Ready.
 *  - otherwise omit status — an existing open PR keeps its status so a send-for-review move to
 *    In Progress isn't clobbered on the next poll.
 */
export function prTicketFields(pr: GhPr, members: string[], existing: ExistingPrState | null): Record<string, any> {
  const changesRequested = pr.reviewDecision === 'CHANGES_REQUESTED';
  const fields: Record<string, any> = {
    kind: PR_KIND,
    title: `PR #${pr.number}: ${pr.title}`,
    branch: pr.headRefName,
    prNumber: pr.number,
    prState: pr.state, // always OPEN here → also clears a stale MERGED/CLOSED on reopen.
    reviewDecision: pr.reviewDecision ?? null,
    isDraft: !!pr.isDraft,
    implementationLink: pr.url,
    members,
    // changes-requested flags a tint (rendered in P2); otherwise no swimlane.
    swimlane: changesRequested ? 'changes-requested' : null,
  };
  if (changesRequested) {
    fields.status = 'In Progress'; // review-fail bounce (decision #3) — owned here in P4.
  } else if (!existing || isReopened(existing)) {
    fields.status = 'Ready';
  }
  return fields;
}

function membersForBranch(branch: string): string[] {
  return selectMembers(Object.values(tasksCache) as any[], branch);
}

/**
 * Of `memberIds`, the ones currently at `Ready` — pure + testable. The changes-requested unwind
 * (FLUX-569) bounces ONLY Ready members back to In Progress; members already In Progress are left
 * alone. This is the load-bearing idempotency guard: the unwind runs on every 90s poll, so after
 * the first bounce the members are In Progress and a repeat poll selects nothing → no re-comment
 * churn. Unknown ids (resolved tickets that aren't members anymore) are dropped.
 */
export function membersToBounce(tickets: any[], memberIds: string[]): string[] {
  const byId = new Map((tickets as any[]).filter((t) => t).map((t) => [t.id, t]));
  return memberIds.filter((id) => byId.get(id)?.status === 'Ready');
}

/**
 * Bounce the given member tickets that are at `Ready` back to `In Progress` (FLUX-569). Used by
 * the changes-requested unwind: a Ready member (work done, awaiting merge) returns to active
 * development. Idempotent via `membersToBounce` — members already In Progress are left alone (no
 * re-comment / churn), and resolved members aren't members anymore (work-gated). Best-effort.
 */
async function bounceMembersToInProgress(memberIds: string[], comment: string): Promise<void> {
  for (const id of membersToBounce(Object.values(tasksCache) as any[], memberIds)) {
    try {
      await updateTaskWithHistory(id, {
        updatedBy: 'Agent',
        entries: [{ type: 'comment', user: 'Agent', comment, date: new Date().toISOString() }],
        nextStatus: 'In Progress',
      });
      broadcastEvent('taskUpdated', { id });
    } catch {
      /* best-effort — a single member write failure must not abort the sweep */
    }
  }
}

async function listOpenPrs(workspaceRoot: string): Promise<GhPr[]> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,title,url,state,headRefName,reviewDecision,isDraft'],
      { cwd: workspaceRoot, windowsHide: true },
    );
    const arr = JSON.parse(stdout);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return []; // gh unavailable / non-GitHub remote — best-effort
  }
}

/**
 * Sync the board's PR tickets against gh (FLUX-566). For every OPEN PR, upsert an
 * engine-managed `PR-<n>` ticket (`kind: 'pr'`) carrying the PR metadata + its work-gated
 * members; map gh-state → EH column. PR tickets whose PR is no longer open are resolved to
 * Done. Quiet + idempotent (upsert only writes on a real change). Best-effort; never throws.
 *
 * State mapping (FLUX-565 decision #3) — `syncPrTickets` is the PR-lifecycle owner (FLUX-569):
 * a NEW open PR lands in **Ready**; CHANGES_REQUESTED bounces the PR ticket to **In Progress**
 * + `changes-requested` tint and unwinds its Ready members back to In Progress; a **reopened**
 * PR (was Done/terminal, now OPEN again) climbs back out of Done → Ready (prTicketFields). An
 * existing open PR that isn't changes-requested/reopened keeps its status, so a send-for-review
 * move to In Progress (P3) isn't clobbered. PRs gone from the open list resolve to the terminal
 * Done (the member advance + worktree teardown on out-of-band merge/close is reconcilePullRequests).
 */
export async function syncPrTickets(workspaceRoot: string): Promise<void> {
  const openPrs = await listOpenPrs(workspaceRoot);
  const openNumbers = new Set(openPrs.map((p) => p.number));

  for (const pr of openPrs) {
    const id = prTicketId(pr.number);
    const existing = tasksCache[id] as any;
    const members = membersForBranch(pr.headRefName);
    const fields = prTicketFields(pr, members, existing ?? null);
    await upsertManagedTicket(id, fields).catch(() => {});
    // Review-fail bounce (FLUX-569 / decision #3): when a PR has changes requested, unwind its
    // worked members back to In Progress so they're directly workable again (the deck stays,
    // unwind to fix; a push re-folds + re-reviews). Idempotent — only Ready members move, and
    // once In Progress they're skipped, so no per-poll churn.
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      await bounceMembersToInProgress(members, `Changes requested on PR #${pr.number} — back to In Progress to address review.`);
    }
  }

  // Resolve PR tickets whose PR left the open list → set the terminal prState + Done.
  // Includes ALREADY-Done tickets whose prState is still non-terminal (e.g. cleanupMergedBranch
  // advanced the PR ticket to Done without updating prState — FLUX-587). We query gh BY NUMBER
  // (reliable once the branch is deleted) rather than by branch. Idempotent: only non-terminal
  // prState gets reconciled, so settled (MERGED/CLOSED) tickets are skipped → no per-poll churn.
  const stalePrTickets = (Object.values(tasksCache) as any[]).filter(
    (t) => t.kind === PR_KIND && typeof t.prNumber === 'number' && !openNumbers.has(t.prNumber)
      && t.prState !== 'MERGED' && t.prState !== 'CLOSED',
  );
  for (const t of stalePrTickets) {
    const state = (await getPrStateByNumber(workspaceRoot, t.prNumber)) ?? 'MERGED';
    await upsertManagedTicket(t.id, {
      status: 'Done',
      prState: state,
      swimlane: null,
    }).catch(() => {});
  }
}

/** Definitive gh state (OPEN/MERGED/CLOSED) for a PR by number — reliable after branch delete. */
async function getPrStateByNumber(workspaceRoot: string, n: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'view', String(n), '--json', 'state', '--jq', '.state'], { cwd: workspaceRoot, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

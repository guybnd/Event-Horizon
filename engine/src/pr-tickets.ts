import { execFile } from 'child_process';
import { promisify } from 'util';
import { tasksCache, upsertManagedTicket } from './task-store.js';

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

/** PR-ticket frontmatter fields for a gh PR (pure; `isNew` decides whether to set status). */
export function prTicketFields(pr: GhPr, members: string[], isNew: boolean): Record<string, any> {
  const fields: Record<string, any> = {
    kind: PR_KIND,
    title: `PR #${pr.number}: ${pr.title}`,
    branch: pr.headRefName,
    prNumber: pr.number,
    prState: pr.state,
    reviewDecision: pr.reviewDecision ?? null,
    isDraft: !!pr.isDraft,
    implementationLink: pr.url,
    members,
    // changes-requested flags a tint (rendered in P2); otherwise no swimlane.
    swimlane: pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : null,
  };
  // New open PR → Ready (awaiting review/merge). Existing tickets keep their status so a
  // send-for-review move to In Progress isn't clobbered on the next poll.
  if (isNew) fields.status = 'Ready';
  return fields;
}

function membersForBranch(branch: string): string[] {
  return selectMembers(Object.values(tasksCache) as any[], branch);
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
 * State mapping (FLUX-565 decision #3): a NEW open PR lands in **Ready** (awaiting
 * review/merge); CHANGES_REQUESTED flags the `changes-requested` swimlane. We do NOT force
 * Ready↔In Progress on existing open PR tickets — that transition is driven by the
 * send-for-review action (P3), so the sync only owns metadata + the terminal Done.
 */
export async function syncPrTickets(workspaceRoot: string): Promise<void> {
  const openPrs = await listOpenPrs(workspaceRoot);
  const openNumbers = new Set(openPrs.map((p) => p.number));

  for (const pr of openPrs) {
    const id = prTicketId(pr.number);
    const fields = prTicketFields(pr, membersForBranch(pr.headRefName), !tasksCache[id]);
    await upsertManagedTicket(id, fields).catch(() => {});
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

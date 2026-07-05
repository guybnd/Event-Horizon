import { workspaceRoot } from './workspace.js';
// FLUX-998 (epic FLUX-996): every git/gh call in this file used to be a bare execFileAsync —
// no timeout, no non-interactive env — so a slow/unreachable remote or a stalled gh credential
// prompt hung branch create/push/PR-raise/merge forever (the spawn/Ready/finish paths). Route
// everything through the S1 runner (runGit/runGh), which always applies a bounded timeout,
// buildGitSyncEnv's non-interactive+gh-authed env, and tree-kill on timeout/abort.
import { runGit, runGh } from './git-exec.js';

function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runGit(args, { cwd: workspaceRoot! });
}

// Larger maxBuffer for `git diff` — defaults (1MB) truncate big diffs into ENOBUFS.
function gitDiff(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runGit(args, { cwd: workspaceRoot!, maxBuffer: 8 * 1024 * 1024 });
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function branchName(ticketId: string, title: string): string {
  return `flux/${ticketId}-${slugify(title)}`;
}

export async function createTicketBranch(ticketId: string, title: string, baseBranch?: string): Promise<string> {
  if (!baseBranch) baseBranch = await getDefaultBranch();
  const name = branchName(ticketId, title);
  // Idempotent: only create the local ref if it doesn't already exist (e.g. a prior
  // worktree-open already created it). Use `git branch` (not checkout) — the engine
  // process must NOT switch HEAD to the ticket branch; the agent's worktree/session
  // is what checks it out.
  if (!(await branchRefExists(name))) {
    try {
      await git(['branch', name, baseBranch]);
    } catch (err) {
      // FLUX-852: a concurrent same-ticket dispatch can create the ref between the existence
      // check above and this `git branch` — tolerate that race (reuse the now-existing branch)
      // instead of surfacing a raw "already exists" 500. Re-throw any other failure.
      if (!(await branchRefExists(name))) throw err;
    }
  }
  await git(['push', '-u', 'origin', name]);
  return name;
}

async function branchRefExists(name: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function getDefaultBranch(): Promise<string> {
  try {
    const { stdout } = await git(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return stdout.trim().replace('refs/remotes/origin/', '') || 'master';
  } catch {
    return 'master';
  }
}

export async function getTicketBranchStatus(name: string, base?: string): Promise<{ exists: boolean; aheadCount: number; behindCount: number }> {
  try {
    await git(['rev-parse', '--verify', name]);
  } catch {
    return { exists: false, aheadCount: 0, behindCount: 0 };
  }

  try {
    // FLUX-716: accept a pre-resolved default branch so a caller that already knows it (the resume
    // preamble resolves it once per turn) doesn't pay a second `getDefaultBranch()` git spawn.
    const baseBranch = base ?? await getDefaultBranch();
    const { stdout } = await git(['rev-list', '--left-right', '--count', `${baseBranch}...${name}`]);
    const parts = stdout.trim().split(/\s+/);
    const behindCount = parseInt(parts[0] ?? '0', 10) || 0;
    const aheadCount = parseInt(parts[1] ?? '0', 10) || 0;
    return { exists: true, aheadCount, behindCount };
  } catch {
    return { exists: true, aheadCount: 0, behindCount: 0 };
  }
}

export async function deleteTicketBranch(name: string, force = false): Promise<void> {
  // Idempotent local delete: skip `git branch -d/-D` when the branch is already gone.
  // A merged branch is force-deleted by post-merge cleanup, so a LATER delete_branch (e.g.
  // clearing a reopened ticket's stale ref) must not throw "branch not found" — the caller
  // relies on this returning cleanly to then clear the ticket's `branch` field (FLUX-588).
  if (await branchRefExists(name)) {
    const flag = force ? '-D' : '-d';
    try {
      await git(['branch', flag, name]);
    } catch (err) {
      // FORCE delete: tolerate failure (most often "checked out" — you can't `-D` the branch a
      // worktree / the main tree is on) so it doesn't block the REMOTE delete below. Otherwise
      // a merge whose branch is still checked out orphaned the branch on BOTH sides (the throw
      // skipped the remote push) with no retry — FLUX-599. The local copy is just our working
      // ref; the backstop prune reclaims it once it's no longer checked out.
      // NON-force (`-d`): rethrow — the failure is the "refuses unmerged" safety the caller wants.
      if (!force) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[branch] forced local delete of ${name} failed (likely checked out): ${message}`);
    }
  }
  // Remote delete — attempted REGARDLESS of the local outcome (independent of it). Best-effort:
  // swallow when the remote ref is already gone / was never pushed.
  try {
    await git(['push', 'origin', '--delete', name]);
  } catch {
    /* remote ref already gone */
  }
}

export async function checkGhAuth(): Promise<boolean> {
  try {
    // FLUX-989: bound `gh auth status` — a hung gh (e.g. mid-prompt) would otherwise
    // block buildGitSyncEnv() and every sync git call behind it forever. A timeout kills
    // gh and we treat it as "not authenticated", so the sync proceeds non-interactively.
    // FLUX-998: runGh's default timeout IS GIT_SYNC_TIMEOUT_MS, so no explicit override needed.
    // MUST pass `env: process.env` (not the default buildGitSyncEnv() path): buildGitSyncEnv()
    // calls checkGhAuth() itself to decide whether to inject gh's credential helper, so leaving
    // this on the normal path recurses infinitely (buildGitSyncEnv → checkGhAuth → runGh →
    // buildGitSyncEnv → …, RangeError: Maximum call stack size exceeded — caught by
    // branch-manager.test.ts). Matches this probe's original behavior: it never had the
    // non-interactive/askpass env either, since `gh auth status` reads gh's own stored auth state
    // rather than prompting for git credentials the way push/fetch can.
    await runGh(['auth', 'status'], { env: process.env });
    return true;
  } catch {
    return false;
  }
}

export async function createPullRequest(branch: string, title: string, body: string): Promise<string> {
  // Push latest commits on the branch before creating/updating the PR.
  await runGit(['push', '-u', 'origin', branch], { cwd: workspaceRoot! });

  // If an OPEN PR already exists for this branch, return its URL rather than erroring. Gate on
  // state: `gh pr view <branch>` returns the most-recent PR regardless of state, so a previously
  // CLOSED/MERGED PR on this branch would otherwise be "reused" and block opening a fresh one
  // (a re-pushed branch whose old PR was closed never got a new PR — FLUX-597).
  try {
    const { stdout: existing } = await runGh(['pr', 'view', branch, '--json', 'url,state']);
    const pr = JSON.parse(existing) as { url?: string; state?: string };
    if (pr?.url && pr.state === 'OPEN') return pr.url;
  } catch {
    // No existing PR (or unreadable) — fall through to create one.
  }

  const { stdout } = await runGh(['pr', 'create', '--title', title, '--body', body, '--head', branch]);
  return stdout.trim();
}

/** What {@link postPrReview} managed to record on the PR. */
export type PrReviewOutcome =
  | 'approved'          // a real `--approve` review landed (green check on the PR)
  | 'changes-requested' // a real `--request-changes` review landed
  | 'commented'         // fell back to a plain `--comment` review (verdict visible, not a formal decision)
  | 'failed';           // gh unavailable / no PR / unauthed — nothing posted (best-effort)

/**
 * Mirror an internal review verdict onto the real GitHub PR (FLUX-1033). `pr` may be a PR number,
 * URL, or branch (all accepted by `gh pr review`).
 *
 * SELF-APPROVAL CAVEAT: GitHub rejects a formal `--approve`/`--request-changes` review when the
 * authenticated `gh` user AUTHORED the PR — and the Furnace opens the PR under that same token, so
 * the formal review usually fails. We therefore attempt the formal decision first (it lands cleanly
 * when a distinct reviewer token is configured) and, on ANY failure, fall back to a plain `--comment`
 * review so the verdict is still visible on the PR itself.
 *
 * Best-effort throughout: a total gh failure returns 'failed' and never throws — callers (the Furnace)
 * must not fail a charge because the PR couldn't be annotated.
 *
 * `opts.commentOnly` forces a plain `--comment` review WITHOUT ever attempting the formal decision. The
 * Furnace uses it for a non-final ticket of a sequential batch's shared PR (FLUX-1033/FLUX-1053): that
 * ticket's verdict is worth recording as visible progress, but a real `--approve` must wait for the
 * batch's final ticket — approving an incomplete shared PR (or one a later ticket will reject) is wrong.
 */
export async function postPrReview(
  pr: string,
  verdict: 'approved' | 'changes-requested',
  body: string,
  opts: { commentOnly?: boolean } = {},
): Promise<PrReviewOutcome> {
  if (opts.commentOnly) {
    try {
      await runGh(['pr', 'review', pr, '--comment', '--body', body]);
      return 'commented';
    } catch (commentErr) {
      const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
      console.warn(`[branch] post PR comment review on ${pr} failed: ${message}`);
      return 'failed';
    }
  }
  const flag = verdict === 'approved' ? '--approve' : '--request-changes';
  try {
    await runGh(['pr', 'review', pr, flag, '--body', body]);
    return verdict;
  } catch {
    // Most commonly self-approval rejection ("Can not approve your own pull request"); could also be
    // gh unavailable/unauthed. Fall back to a comment review so the verdict is still on the PR.
    try {
      await runGh(['pr', 'review', pr, '--comment', '--body', body]);
      return 'commented';
    } catch (commentErr) {
      const message = commentErr instanceof Error ? commentErr.message : String(commentErr);
      console.warn(`[branch] post PR review (${verdict}) on ${pr} failed: ${message}`);
      return 'failed';
    }
  }
}

export async function mergePullRequest(branch: string): Promise<void> {
  // Merge only — do NOT `--delete-branch`. gh's local-branch delete fails when the branch
  // is checked out (in a worktree, or the main tree itself), which made the merge call
  // throw AFTER the merge had already landed (FLUX-574). Branch deletion is handled by the
  // post-merge cleanup (`cleanupMergedBranch`) in the correct order: free the branch
  // (remove worktree / switch the main tree off it) → then force-delete local + remote.
  await runGh(['pr', 'merge', branch, '--squash']);
}

/**
 * Distinguish a genuine git merge conflict from other `gh pr merge` failures (auth, network,
 * rate-limit) so callers can offer a guided rebase CTA only when a conflict is actually the
 * cause (FLUX-986). Auth/permission signatures are checked first and always win — they have
 * their own recovery path (re-auth, not rebase) and must never trip the conflict CTA.
 *
 * FLUX-1104: does NOT match on the generic "not mergeable" / "mergeable state" phrasing —
 * GitHub's own merge API returns that exact wording for merges blocked by required status
 * checks or branch protection too (e.g. "is not mergeable: the base branch policy prohibits
 * the merge", cli/cli#7518), which is not a git conflict and must not trip the rebase CTA.
 * Only phrases specific to an actual conflicting merge state match (cli/cli#12773).
 */
export function isMergeConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const stderr = (err as { stderr?: string } | null)?.stderr ?? '';
  const text = `${message}\n${stderr}`.toLowerCase();
  if (
    text.includes('gh auth') ||
    text.includes('authentication') ||
    text.includes('permission denied') ||
    text.includes('could not read username') ||
    text.includes('could not read password')
  ) {
    return false;
  }
  return (
    text.includes('conflict') ||
    text.includes('cannot be cleanly created') ||
    text.includes('could not be cleanly created')
  );
}

/** Normalized PR state for a branch — what the EH PR card / swimlane render (FLUX-556). */
export interface PrStatus {
  number: number;
  state: string;                  // OPEN | MERGED | CLOSED
  url: string;
  title: string;
  reviewDecision: string | null;  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  mergeable: string;              // MERGEABLE | CONFLICTING | UNKNOWN
  checks: { total: number; passed: number; failed: number; pending: number };
  headRefName: string;            // the PR's source branch (FLUX-944: used to tell a sibling PR from this ticket's own)
}

/** A single `gh pr view` statusCheckRollup entry — either a CheckRun (status+conclusion) or a StatusContext (state). */
interface GhCheckRollupEntry {
  status?: string;
  conclusion?: string;
  state?: string;
}

/** Raw shape of `gh pr view --json number,state,url,title,reviewDecision,mergeable,statusCheckRollup,headRefName`. */
interface GhPrViewRaw {
  number?: number;
  state?: string;
  url?: string;
  title?: string;
  reviewDecision?: string | null;
  mergeable?: string;
  statusCheckRollup?: GhCheckRollupEntry[];
  headRefName?: string;
}

/**
 * Best-effort PR state for a branch via `gh pr view`. `selector` accepts anything `gh pr view`
 * does — a branch name, PR number, or PR URL (FLUX-944 uses the URL form to look up a sibling
 * ticket's PR from an `implementationLink`). Returns null when no PR exists for the selector, or
 * gh is unavailable/unauthed — callers degrade gracefully and never surface a 500 (FLUX-556).
 * statusCheckRollup is folded into a compact pass/fail/pending tally; v1 surfaces (does not gate
 * on) checks — CI gating is P3.
 */
export async function getPullRequestStatus(selector: string): Promise<PrStatus | null> {
  try {
    const { stdout } = await runGh(
      ['pr', 'view', selector, '--json', 'number,state,url,title,reviewDecision,mergeable,statusCheckRollup,headRefName'],
    );
    const raw = JSON.parse(stdout) as GhPrViewRaw;
    if (!raw || typeof raw.number !== 'number') return null;

    const rollup: GhCheckRollupEntry[] = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : [];
    const checks = { total: rollup.length, passed: 0, failed: 0, pending: 0 };
    for (const c of rollup) {
      // gh exposes CheckRun (status + conclusion) or StatusContext (state) entries.
      const status = String(c.status ?? '').toUpperCase();
      const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
      if (status && status !== 'COMPLETED') { checks.pending++; continue; }
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(concl)) checks.passed++;
      else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) checks.failed++;
      else checks.pending++;
    }

    return {
      number: raw.number,
      state: String(raw.state ?? 'OPEN'),
      url: String(raw.url ?? ''),
      title: String(raw.title ?? ''),
      reviewDecision: raw.reviewDecision ? String(raw.reviewDecision) : null,
      mergeable: String(raw.mergeable ?? 'UNKNOWN'),
      checks,
      headRefName: String(raw.headRefName ?? ''),
    };
  } catch {
    return null; // no PR for this selector, or gh unavailable — best-effort
  }
}

/** How {@link finish_ticket} should obtain a mergeable PR for a branch (FLUX-741). */
export interface FinishPrPlan {
  /**
   * 'reuse' = an OPEN PR already exists; 'created' = a fresh PR was opened; 'blocked' = can't
   * open one (route to Require Input); 'folded' = the branch is deliberately empty because its
   * work already landed via a sibling ticket's merged PR (FLUX-944) — finish with that link,
   * no PR to create/merge on this branch.
   */
  action: 'reuse' | 'created' | 'blocked' | 'folded';
  /** PR url for 'reuse'/'created'/'folded'. */
  url?: string;
  /** Why we couldn't open a PR (for the Require Input message) when action === 'blocked'. */
  reason?: string;
}

/** Injectable deps so {@link planFinishPr} is unit-testable without gh/git. */
export interface FinishPrDeps {
  getStatus?: (branch: string) => Promise<PrStatus | null>;
  getBranchStatus?: (branch: string) => Promise<{ exists: boolean; aheadCount: number; behindCount: number }>;
  createPr?: (branch: string, title: string, body: string) => Promise<string>;
}

/**
 * Decide how `finish_ticket` should land `branch` (FLUX-741, incident FLUX-656). The old finish
 * path only special-cased "no PR at all" (`if (!existingPr)`) and otherwise fell straight through
 * to `gh pr merge` — so a branch whose PR was already **MERGED/CLOSED** (e.g. a commit pushed after
 * the prior PR merged, FLUX-656) hit `gh pr merge` on a dead PR, which throws "already merged" and
 * strands the commit. This unifies the decision:
 *
 *  - OPEN PR            → reuse it (merge proceeds as before).
 *  - MERGED/CLOSED, or no PR at all → the old PR is dead; open a FRESH one via {@link createPullRequest}
 *    (its OPEN-only reuse logic already declines to reuse a dead PR), then merge that.
 *  - branch has 0 commits ahead of its base → a PR genuinely can't be opened (nothing to merge).
 *    This is usually a real blocker (`blocked`; the caller routes to Require Input) — UNLESS
 *    `siblingLink` (the caller's `implementationLink`) already points at a MERGED PR on a
 *    DIFFERENT branch: that's the fold-together pattern (FLUX-944) — this ticket's deliverable
 *    was deliberately committed onto a sibling ticket's branch/PR instead of its own, so its own
 *    branch is empty ON PURPOSE. Detected that way, it's `folded`, not blocked.
 *
 * Never merges a non-OPEN PR. Deps are injectable for tests; defaults hit the real gh/git layer.
 */
export async function planFinishPr(
  branch: string,
  title: string,
  body: string,
  deps: FinishPrDeps = {},
  siblingLink?: string,
): Promise<FinishPrPlan> {
  const getStatus = deps.getStatus ?? getPullRequestStatus;
  const getBranchStatus = deps.getBranchStatus ?? getTicketBranchStatus;
  const createPr = deps.createPr ?? createPullRequest;

  const existing = await getStatus(branch).catch(() => null);
  if (existing && existing.state === 'OPEN') {
    return { action: 'reuse', ...(existing.url ? { url: existing.url } : {}) };
  }

  // No PR, or a dead (MERGED/CLOSED) one → we need a fresh PR. Guard on commits-ahead first:
  // opening a PR with nothing ahead of the base fails, so route those to Require Input.
  const bs = await getBranchStatus(branch).catch(() => null);
  if (bs && bs.exists && bs.aheadCount === 0) {
    if (siblingLink) {
      const linked = await getStatus(siblingLink).catch(() => null);
      if (linked && linked.state === 'MERGED' && linked.headRefName && linked.headRefName !== branch) {
        return { action: 'folded', url: siblingLink };
      }
    }
    return {
      action: 'blocked',
      reason: existing
        ? `the previous PR for \`${branch}\` is ${existing.state} and the branch has no new commits ahead of its base — nothing to merge.`
        : `branch \`${branch}\` has no commits yet.`,
    };
  }

  const url = await createPr(branch, title, body);
  return { action: 'created', url };
}

export async function getCurrentCommit(): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Resolve any rev (e.g. 'HEAD~1') to a full sha, or null if it doesn't exist.
export async function resolveCommit(rev: string): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--verify', rev]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// True if `ancestor` is an ancestor of (or identical to) `descendant`. `git merge-base
// --is-ancestor` exits 0 for true, non-zero for false; any failure (unknown ref) → false.
export async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

// The fork point of `branch` from `base` (the default branch by default). Tries the local ref
// first, then the remote-tracking ref — a PR branch synced from gh may not be checked out
// locally. Returns the merge-base sha, or null if neither ref resolves / there's no common
// ancestor.
export async function getMergeBase(branch: string, base?: string): Promise<string | null> {
  const baseBranch = base ?? (await getDefaultBranch());
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      await git(['rev-parse', '--verify', ref]);
      const { stdout } = await git(['merge-base', baseBranch, ref]);
      const mb = stdout.trim();
      if (mb) return mb;
    } catch {
      /* ref not resolvable as written — try the next candidate */
    }
  }
  return null;
}

// The commit to anchor a ticket's review diff (FLUX-585). For a branch/PR ticket the correct
// anchor is the branch's fork point from the default branch (merge-base) — NOT whatever the
// engine's HEAD happened to be when the session launched. HEAD can sit on an unrelated sibling
// commit, so anchoring there made `baseline..HEAD` diffs surface phantom reversions of work that
// lives only on that sibling. Branch-less tickets keep the current-HEAD anchor.
export async function resolveBaselineCommit(branch?: string | null): Promise<string | null> {
  if (branch) {
    const mb = await getMergeBase(branch);
    if (mb) return mb;
  }
  return getCurrentCommit();
}

export interface DiffFileSummary {
  file: string;
  additions: number;
  deletions: number;
}

export interface DiffCapture {
  summary: DiffFileSummary[];
  fullDiff: string;
  truncated: boolean;
}

const DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_PROMPT_MAX_BYTES = 80 * 1024;

// Resolve the range to diff: branch mode (merge-base..tip) takes precedence; otherwise
// baseline..HEAD; otherwise the single most recent commit on HEAD.
// If mode is 'working', diffs baselineCommit against the working tree.
async function resolveDiffRange(branch?: string | null, baselineCommit?: string | null, mode?: 'committed' | 'working'): Promise<string | null> {
  if (mode === 'working' && baselineCommit) {
    try {
      await git(['rev-parse', '--verify', baselineCommit]);
      return baselineCommit;
    } catch {
      return null;
    }
  }

  if (branch) {
    try {
      await git(['rev-parse', '--verify', branch]);
      const base = await getDefaultBranch();
      const { stdout: mb } = await git(['merge-base', base, branch]);
      const mergeBase = mb.trim();
      if (mergeBase) return `${mergeBase}..${branch}`;
    } catch {
      /* branch missing locally — fall through to other strategies */
    }
  }
  if (baselineCommit) {
    try {
      await git(['rev-parse', '--verify', baselineCommit]);
      // Guard against a stale baseline that isn't an ancestor of HEAD (FLUX-585): diffing
      // baseline..HEAD then surfaces phantom reverts of commits that only ever lived on a
      // sibling branch. Fall through to the HEAD~1 fallback rather than emit a fictitious diff.
      if (await isAncestor(baselineCommit, 'HEAD')) {
        return `${baselineCommit}..HEAD`;
      }
    } catch {
      /* baseline gone — fall through */
    }
  }
  try {
    await git(['rev-parse', '--verify', 'HEAD~1']);
    return 'HEAD~1..HEAD';
  } catch {
    return null;
  }
}

function parseNumstat(stdout: string): DiffFileSummary[] {
  const out: DiffFileSummary[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [addStr, delStr, ...fileParts] = parts;
    if (addStr === undefined || delStr === undefined) continue;
    // Binary files show "-\t-\tpath" in numstat.
    const additions = addStr === '-' ? 0 : parseInt(addStr, 10) || 0;
    const deletions = delStr === '-' ? 0 : parseInt(delStr, 10) || 0;
    out.push({ file: fileParts.join(' '), additions, deletions });
  }
  return out;
}

export async function captureDiff(branch?: string | null, baselineCommit?: string | null, mode?: 'committed' | 'working'): Promise<DiffCapture | null> {
  const range = await resolveDiffRange(branch, baselineCommit, mode);
  if (!range) return null;

  let summary: DiffFileSummary[];
  try {
    const { stdout } = await gitDiff(['diff', '--numstat', range]);
    summary = parseNumstat(stdout);
  } catch {
    return null;
  }

  let fullDiff: string;
  let truncated = false;
  try {
    const { stdout } = await gitDiff(['diff', range]);
    if (Buffer.byteLength(stdout, 'utf-8') > DIFF_MAX_BYTES) {
      fullDiff = stdout.slice(0, DIFF_MAX_BYTES) + '\n# [diff truncated — exceeds 2MB]\n';
      truncated = true;
    } else {
      fullDiff = stdout;
    }
  } catch {
    fullDiff = '';
  }

  return { summary, fullDiff, truncated };
}

export interface PromptDiffCapture {
  diff: string;
  truncated: boolean;
  range: string;
}

export async function captureDiffForPrompt(branch?: string | null, baselineCommit?: string | null): Promise<PromptDiffCapture | null> {
  const range = await resolveDiffRange(branch, baselineCommit);
  if (!range) return null;

  try {
    const { stdout } = await gitDiff(['diff', range]);
    const byteLen = Buffer.byteLength(stdout, 'utf-8');
    if (byteLen > DIFF_PROMPT_MAX_BYTES) {
      return {
        diff: stdout.slice(0, DIFF_PROMPT_MAX_BYTES),
        truncated: true,
        range,
      };
    }
    return { diff: stdout, truncated: false, range };
  } catch {
    return null;
  }
}

// Extract a single file's hunk from a unified diff blob. Simple parser — splits on
// `diff --git ` boundaries and matches the requested path.
export function extractFileFromDiff(fullDiff: string, file: string): string | null {
  if (!fullDiff) return null;
  const sections = fullDiff.split(/^diff --git /m);
  for (const section of sections) {
    if (!section.trim()) continue;
    // Header line looks like: a/path b/path
    const firstNewline = section.indexOf('\n');
    const header = firstNewline >= 0 ? section.slice(0, firstNewline) : section;
    if (header.includes(`a/${file}`) || header.includes(`b/${file}`)) {
      return 'diff --git ' + section;
    }
  }
  return null;
}

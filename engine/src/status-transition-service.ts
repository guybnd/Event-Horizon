// FLUX-1044: the shared status-transition rulebook. REST's PUT /:id handler (routes/tasks.ts)
// and the MCP tools (`update_ticket`, `change_status` in mcp-server.ts) each enforce the same
// workflow rules — comment requirements on Require Input/Ready, schema validation + unknown-tag
// registration before a write — and used to implement them independently, so a rule change had
// to be reasoned about (and often re-implemented) across two-to-three code paths. This module is
// the single seam: it owns the *decisions*; each caller keeps its own protocol formatting
// (REST's `{error: CODE, message}` JSON vs MCP's tool-error text).
//
// Deliberately NOT shared (intentional REST/MCP asymmetries — preserve, don't converge):
//   - Commit-before-Ready (`evaluateWorktreeReadyRefusal` below) is an MCP-only opt-in call.
//     REST drag-to-Ready is a visible human action, distinct from the silent agent failure
//     FLUX-730 targets — see the code comment at the PUT handler's Ready branch (FLUX-730/731).
//   - The FLUX-1263 plan-review gate, reviewState/planReviewState resolution, and next-step
//     hints are MCP-`change_status`-only additions and stay in mcp-server.ts.

import { validateTicketFrontmatter, formatValidationErrors, type TicketValidationError } from './schema.js';
import { autoRegisterUnknownTags } from './config.js';

/**
 * The configured names of the two comment-gated statuses, with their canonical fallbacks.
 * Both callers used to inline `configCache.requireInputStatus || 'Require Input'` etc. —
 * resolve once here so a renamed board stays consistent across REST and MCP.
 */
export function resolveTransitionStatusNames(config: {
  requireInputStatus?: string | undefined;
  readyForMergeStatus?: string | undefined;
}): { requireInputStatus: string; readyStatus: string } {
  return {
    requireInputStatus: config.requireInputStatus || 'Require Input',
    readyStatus: config.readyForMergeStatus || 'Ready',
  };
}

/** Which comment-requirement rule refused the transition. */
export type CommentGate = 'require-input-comment' | 'ready-comment';

export type CommentGateDecision = { refuse: false } | { refuse: true; gate: CommentGate };

/**
 * The comment-requirement rule for status transitions, shared by REST PUT and MCP
 * `change_status`. Pure: inputs in, decision out. What counts as "has a comment" is
 * protocol-specific and stays with the caller (REST scans the submitted history/appendHistory
 * entries; MCP has an explicit `comment` param) — this owns WHICH transitions demand one:
 *
 *   - Into Require Input: a comment (the question being asked) is ALWAYS required — a hard
 *     engine invariant, never relaxed by config or the portal skip flag.
 *   - Into Ready: a completion comment is required unless the board config waives it
 *     (`requireCommentOnStatusChange: false`) or the caller passes the portal-only
 *     session "don't ask again" override (`skipCommentRequirement`, FLUX-847 — REST-only;
 *     MCP callers never set it).
 *
 * Only transitions INTO the gated status are checked; a ticket already sitting there is
 * unaffected.
 */
export function evaluateCommentGate(input: {
  currentStatus: string | undefined;
  newStatus: string | undefined;
  hasComment: boolean;
  requireInputStatus: string;
  readyStatus: string;
  /** `configCache.requireCommentOnStatusChange` — gates ONLY the Ready check. */
  requireCommentOnStatusChange?: boolean | undefined;
  /** FLUX-847 portal-only override — relaxes ONLY the Ready check. */
  skipCommentRequirement?: boolean | undefined;
}): CommentGateDecision {
  const {
    currentStatus, newStatus, hasComment, requireInputStatus, readyStatus,
    requireCommentOnStatusChange, skipCommentRequirement = false,
  } = input;
  if (!newStatus || newStatus === currentStatus || hasComment) return { refuse: false };
  if (newStatus === requireInputStatus) {
    return { refuse: true, gate: 'require-input-comment' };
  }
  if (newStatus === readyStatus && requireCommentOnStatusChange !== false && !skipCommentRequirement) {
    return { refuse: true, gate: 'ready-comment' };
  }
  return { refuse: false };
}

/**
 * Pre-write validation + unknown-tag registration sequencing, shared by REST PUT and MCP
 * `update_ticket` (NOT `change_status`, whose write path only ever appends a small controlled
 * field set and never takes tags). Validation runs FIRST — an invalid write must not register
 * its tags as a side effect. `tagsToRegister` is explicit because the two callers genuinely
 * differ on what they register (REST registers the merged frontmatter's tags on every PUT;
 * `update_ticket` only registers when the request actually carried a `tags` param) — keeping
 * that a caller decision preserves both behaviors exactly.
 */
export async function validateAndRegisterTicketWrite(
  frontmatter: Record<string, unknown>,
  tagsToRegister: unknown,
): Promise<{ ok: true } | { ok: false; errors: TicketValidationError[]; message: string }> {
  const errors = validateTicketFrontmatter(frontmatter);
  if (errors.length > 0) {
    return { ok: false, errors, message: formatValidationErrors(errors) };
  }
  if (Array.isArray(tagsToRegister)) {
    await autoRegisterUnknownTags(tagsToRegister as string[]);
  }
  return { ok: true };
}

/**
 * FLUX-730/FLUX-731: the commit-before-Ready refusal *decision*, factored out of the
 * `change_status` handler so it can be unit-tested without an MCP-handler harness. Pure:
 * inputs in, decision out — no I/O.
 *
 * MCP-ONLY opt-in Ready precondition (FLUX-1044): the REST PUT route deliberately does NOT
 * call this — dragging a card to Ready in the portal is a visible human action, distinct from
 * the silent agent failure mode this guards against (see the FLUX-730/731 comment in
 * routes/tasks.ts's Ready branch). Do not wire it into the REST path without a human decision.
 *
 * Refuse ONLY a worktree branch that exists and has 0 commits ahead of base — a dedicated
 * worktree means an agent did (or should have done) real work in an isolated tree, so 0
 * commits ahead means it was never committed and no PR can ever open (the FLUX-716/717/719
 * incident). Everything else allows: a worktree branch with commits ahead (falls through to
 * PR), a plain (non-worktree) branch with 0 commits ahead (kept as a soft warning per scope),
 * and branchless tickets (which legitimately stay uncommitted until finish).
 */
export function evaluateWorktreeReadyRefusal(input: {
  worktreePath: string | null;
  branchStatus: { exists: boolean; aheadCount: number } | null;
  ticketId: string;
  branch: string;
  readyStatus: string;
  /** Genuinely uncommitted change count in the worktree (git status, not a diff-vs-base), used only to phrase the message. */
  changeCount?: number;
  /**
   * FLUX-1267: explicit caller acknowledgment that this ticket's scope legitimately produces no
   * code diff (a verification/investigation/spike ticket), passed as `noDiffExpected` on
   * `change_status`. Only lifts the refusal when the worktree is ALSO clean (changeCount === 0) —
   * if there are uncommitted changes sitting in the tree, that contradicts a zero-diff claim, so
   * the FLUX-730 guard still fires and the caller must commit or reconsider.
   */
  noDiffAcknowledged?: boolean;
}): { refuse: boolean; message?: string } {
  const { worktreePath, branchStatus, ticketId, branch, readyStatus, changeCount = 0, noDiffAcknowledged = false } = input;
  if (!(worktreePath && branchStatus && branchStatus.exists && branchStatus.aheadCount === 0)) {
    return { refuse: false };
  }
  if (noDiffAcknowledged && changeCount === 0) {
    return { refuse: false };
  }
  const didWork = changeCount > 0
    ? `Its worktree has ${changeCount} uncommitted change${changeCount === 1 ? '' : 's'} — the work was done but never committed.`
    : `Its worktree has no changes yet.`;
  return {
    refuse: true,
    message:
      `Cannot move ${ticketId} to ${readyStatus}: its worktree branch \`${branch}\` has no commits ahead of base. ${didWork} ` +
      `Commit the worktree's work with a real message (in the worktree: \`git add -A && git commit\`), then retry the move to ${readyStatus} — that opens the PR for review. ` +
      `If this ticket's scope genuinely produces no code diff (verification/investigation-only), retry with noDiffExpected:true instead. Status left unchanged.`,
  };
}

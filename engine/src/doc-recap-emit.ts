// FLUX-1662 (Phase A step 5 / Phase B step 10) — the shared "build + persist" doc-recap emit path.
// Called from change_status's Ready-with-branch flow (mcp-server.ts) and, in Phase B, re-called
// after a self-serve inline doc edit commits (routes/diffs.ts) so the recap reflects the edit.
// Best-effort by design: a recap is a convenience surface, never a gate — any failure here must
// never fail the caller's own transition/commit, so this never throws.

import { getWorkspace, runWithWorkspace, type Workspace } from './workspace-context.js';
import { updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { log } from './log.js';
import { withArtifactPublication, writeArtifactRevisionInPublication } from './artifacts.js';
import { buildDocRecapHtml } from './doc-recap.js';
import { requireWorkspaceRoot } from './workspace.js';
import { prTicketsOnBranch } from './pr-tickets.js';
import { runGit } from './git-exec.js';

export async function emitDocRecap(
  ticketId: string,
  branch: string,
  baselineCommit: string,
  ws: Workspace = getWorkspace(),
): Promise<void> {
  return runWithWorkspace(ws, async () => {
    try {
      const built = await buildDocRecapHtml(ticketId, branch, baselineCommit);
      if (!built) return;

      await withArtifactPublication(ticketId, async () => {
        const current = ws.tasks[ticketId];
        if (!current) return;
        const publication = await writeArtifactRevisionInPublication(
          ticketId,
          built.html,
          { title: 'Doc Recap', kind: 'doc-recap', docPaths: built.docPaths },
          current.docRecap,
        );
        const result = await updateTaskWithHistory(ticketId, {
          updatedBy: 'Agent',
          extraFields: { docRecap: publication.pointer },
          entries: [{
            type: 'activity',
            user: 'Agent',
            comment: `Published doc-recap artifact revision ${publication.rev} (${publication.bytes.toLocaleString()} bytes).`,
            date: new Date().toISOString(),
          }],
        }, ws);
        if (!result) throw new Error(`Ticket ${ticketId} disappeared before its doc-recap pointer could be persisted`);
        broadcastEvent('taskUpdated', { id: ticketId });
        broadcastEvent('artifactReady', { ticketId, rev: publication.rev, channel: 'doc-recap' });
      });
    } catch (err: unknown) {
      // A sidecar is written before the pointer. Preserve the never-throw contract for callers,
      // but retain the original error and stack so a missing Docs tab can be diagnosed.
      console.error(`[doc-recap] emit failed for ${ticketId} on branch ${branch}:`, err);
      log.warn(`[doc-recap] emit failed for ${ticketId} on branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** Resolves the ticket that owns `branch` (Phase B: re-emit after a self-serve commit lands on a
 *  branch, keyed by ref rather than ticket id). Returns null if no ticket owns this branch. */
export function findTicketIdForBranch(branch: string): string | null {
  const tasks = getWorkspace().tasks;
  for (const id of Object.keys(tasks)) {
    if (tasks[id]?.branch === branch) return id;
  }
  return null;
}

/**
 * The stored `baselineCommit` for ANY ticket that shares `branch` — the fixed divergence point
 * recorded once at branch-creation time (branch-manager.ts), which doesn't drift after the PR
 * merges (unlike a live `merge-base` recompute — FLUX-1676). A PR ticket (`kind:'pr'`) never
 * carries its own `baselineCommit` (`prTicketFields` in pr-tickets.ts never sets it), so this
 * scans every ticket sharing the branch rather than just the one the caller has in hand — a
 * member ticket's baselineCommit applies equally to the PR ticket viewing the same branch.
 * Returns null when no ticket on the branch has one recorded (an orphan branch, or a ticket
 * created before baselineCommit was tracked) — callers fall back to a live merge-base recompute.
 */
export function resolveBaselineCommitForBranch(branch: string, ws: Workspace = getWorkspace()): string | null {
  for (const t of Object.values(ws.tasks) as Array<{ branch?: string | null; baselineCommit?: string | null } | undefined>) {
    if (t?.branch === branch && t.baselineCommit) return t.baselineCommit;
  }
  return null;
}

/**
 * FLUX-1670: re-emit the doc-recap for the PR TICKET (kind:'pr', id `PR-<n>`) that owns `branch`,
 * not just its member ticket — so the PR ticket's own Docs surface stays current even after every
 * member's worktree is reclaimed (member reaches Ready). Called from the same seams as
 * `emitDocRecap` (member Ready via MCP/REST, self-serve doc commit, and PR sync) right after the
 * member-ticket emit. Best-effort by design, same convention as `emitDocRecap`: any failure here
 * must never fail the caller's own transition/commit, so this never throws.
 *
 * Churn guard: `emitDocRecap` itself is NOT naturally idempotent (it always builds + may publish a
 * fresh revision), so this only calls it when the branch's tip actually moved since the last PR
 * recap (`docRecapCommit`), avoiding a fresh artifact revision on every repeat call for an
 * unchanged branch (e.g. multiple members reaching Ready back-to-back with no new commits).
 */
export async function emitDocRecapForBranch(branch: string, ws: Workspace = getWorkspace()): Promise<void> {
  return runWithWorkspace(ws, async () => {
    const prTickets = prTicketsOnBranch(Object.values(ws.tasks), branch);
    for (const prTicket of prTickets) {
      try {
        const workspaceRoot = requireWorkspaceRoot();
        const { stdout } = await runGit(['rev-parse', branch], { cwd: workspaceRoot });
        const tipSha = stdout.trim();
        if (!tipSha) continue;

        const docRecapCommit = (prTicket as { docRecapCommit?: string }).docRecapCommit;
        if (docRecapCommit === tipSha) continue; // no new commits since the last PR-level recap

        await emitDocRecap(prTicket.id, branch, resolveBaselineCommitForBranch(branch, ws) ?? '', ws);
        await updateTaskWithHistory(prTicket.id, {
          updatedBy: 'Agent',
          extraFields: { docRecapCommit: tipSha },
        }, ws);
      } catch (err: unknown) {
        log.warn(`[doc-recap] emitDocRecapForBranch failed for ${prTicket.id} on branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

import { runGit, resolveDefaultBranchName } from './git-exec.js';
import { type Workspace } from './workspace-context.js';
import { updateTaskWithHistory } from './task-store.js';
import { broadcastEvent } from './events.js';
import { TERMINAL_TICKET_STATUSES } from './schema.js';
import { hasReachedDoneBefore, type CachedTicket } from './pr-cleanup.js';

const DONE_STATUS = 'Done';

/** Bounded scan window for the default-branch `git log` (FLUX-1773) — see module doc comment below. */
const COMMIT_CLOSE_SCAN_LIMIT = 200;

const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/**
 * Extract closing-trailer ticket ids from a commit's subject+body (FLUX-1773). Pure, no I/O — the
 * whole unit-test surface for the matching grammar lives against this function.
 *
 * `\b` before the keyword (not `(?:^|\s)`) so `feat: thing (Closes: FLUX-123)` matches — `\b` still
 * rejects `uncloses FLUX-1`/`foocloses FLUX-1` (no word-boundary between two word characters).
 * `(?::\s*|\s+)` after the keyword accepts `Closes:FLUX-1`, `Closes: FLUX-1`, and `closes FLUX-1`
 * while still rejecting `closesFLUX-1` (no separator at all). A bare `(FLUX-123)`, `[FLUX-123]`,
 * `for FLUX-123`, or a naked `FLUX-123` — with no `closes`/`fixes`/`resolves` keyword — never
 * matches, by design: a mention is not a close.
 */
const CLOSING_TRAILER_RE = /\b(?:closes|fixes|resolves)(?::\s*|\s+)((?:[A-Za-z][A-Za-z0-9]*-\d+)(?:\s*,\s*[A-Za-z][A-Za-z0-9]*-\d+)*)/gi;

export function parseClosingTrailers(message: string, projectKeys: string[]): string[] {
  const keys = new Set(projectKeys.map((k) => k.toUpperCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  CLOSING_TRAILER_RE.lastIndex = 0;
  while ((match = CLOSING_TRAILER_RE.exec(message))) {
    const capture = match[1] ?? '';
    for (const rawId of capture.split(',')) {
      const id = rawId.trim().toUpperCase();
      const key = id.split('-')[0] ?? '';
      if (!keys.has(key)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

/** Module-level, process-lifetime: last-seen default-branch head SHA per workspace root (FLUX-1773 decision 1 — no persisted cursor; a restart re-scans once). */
const lastSeenHead = new Map<string, string>();

/**
 * Reconciler for projects that commit straight to the default branch with no PR flow (FLUX-1773).
 * Scans the last {@link COMMIT_CLOSE_SCAN_LIMIT} commits on the resolved default branch/ref for a
 * `Closes:`/`Fixes:`/`Resolves: <ID>` trailer and advances the matching ticket to Done — the second
 * automatic path to Done alongside `pr-cleanup.ts`'s merged-PR flow, for boards with no `gh`/PR at
 * all. Never throws — called from the always-run group of the reconcile tick.
 */
export async function closeTicketsFromDefaultBranchCommits(workspaceRoot: string, ws: Workspace): Promise<void> {
  try {
    const run = (args: string[]) => runGit(args, { cwd: workspaceRoot });
    const def = await resolveDefaultBranchName(run);

    let ref: string;
    try {
      await run(['rev-parse', '--verify', '--quiet', `refs/heads/${def}`]);
      ref = def;
    } catch {
      try {
        await run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${def}`]);
        ref = `origin/${def}`;
      } catch {
        return; // no local or remote-tracking ref for the resolved default branch name
      }
    }

    const { stdout: headOut } = await run(['rev-parse', '--verify', '--quiet', ref]);
    const head = headOut.trim();
    if (!head) return;
    if (lastSeenHead.get(workspaceRoot) === head) return; // unchanged since last tick — nothing new to scan

    // Project keys read from ws.config (not ambient getConfig()) — ws is already an explicit
    // parameter here, and this keeps the guard-ladder tests from needing runWithWorkspace just to
    // read one array (FLUX-1773 plan-review Minor #3).
    const projectKeys: string[] = Array.isArray(ws.config?.projects) ? ws.config.projects : ['FLUX'];

    const { stdout } = await run(['log', ref, '-n', String(COMMIT_CLOSE_SCAN_LIMIT), `--format=%H${FIELD_SEP}%s${FIELD_SEP}%b${RECORD_SEP}`]);
    const records = stdout.split(RECORD_SEP).map((r) => r.trim()).filter(Boolean);

    for (const record of records) {
      const [sha, subject = '', body = ''] = record.split(FIELD_SEP);
      if (!sha) continue;
      const ids = parseClosingTrailers(`${subject}\n${body}`, projectKeys);
      for (const id of ids) {
        const t = ws.tasks[id] as CachedTicket | undefined;
        if (!t) continue; // guard 1: unknown ticket id
        if (t.kind === 'pr') continue; // guard 2: PR tickets are owned by syncPrTickets
        if (TERMINAL_TICKET_STATUSES.has(t.status)) continue; // guard 3: already terminal
        if (hasReachedDoneBefore(t)) continue; // guard 4: deliberately reopened after a prior Done
        if (t.branch && t.branch !== def) continue; // guard 5: owned by the PR/worktree flow

        try {
          await updateTaskWithHistory(id, {
            updatedBy: 'Agent',
            entries: [{
              type: 'comment',
              user: 'Agent',
              comment: `Closed by commit \`${sha.slice(0, 8)}\` on \`${def}\` — commit message carries \`Closes: ${id}\`.`,
              date: new Date().toISOString(),
            }],
            nextStatus: DONE_STATUS,
            extraFields: { swimlane: null, ...(t.implementationLink ? {} : { implementationLink: sha }) },
            // FLUX-1773 decision 6: journaled, not derived — unlike cleanupMergedBranch's mirror of
            // gh's MERGED state, a lost write here is NOT safely re-derivable: the head-SHA early-out
            // above returns before `git log` runs again once the head is unchanged, so a dropped
            // derived write would never be replayed.
            // FLUX-1779: stable per-(commit,ticket) key so a journal replay after a sync-induced
            // reset --hard finds the ticket already Done and no-ops instead of appending a duplicate
            // history comment.
            idempotencyKey: `commit-close:${sha}:${id}`,
          }, ws);
          broadcastEvent('taskUpdated', { id });
        } catch (err) {
          console.error(`[commit-close] Failed to close ${id} from commit ${sha}:`, (err as Error)?.message);
        }
      }
    }

    lastSeenHead.set(workspaceRoot, head);
  } catch (err) {
    console.error(`[commit-close] Reconcile sweep failed for ${workspaceRoot}:`, (err as Error)?.message);
  }
}

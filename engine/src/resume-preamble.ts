import { getTicketBranchStatus, getDefaultBranch } from './branch-manager.js';
import { changedFilesMasterSideOfBranch } from './diff-aggregator.js';
import { tasksCache } from './task-store.js';

/**
 * FLUX-655: the resume preamble — a compact, synthetic *situational update* prepended to a
 * RESUMED chat turn so the agent sees that the world moved while the conversation was paused
 * (master advanced, the branch fell behind, files were rewritten underneath it, sibling tickets
 * merged). Warm resume (`claude --resume`) restores the *dialogue* but tells the resumed session
 * nothing about the *working tree*; this closes that gap.
 *
 * The assembler is intentionally standalone and side-effect-free beyond git/cache reads (no spawn,
 * no transcript writes) so the cold-resume / re-prime-from-digest path (FLUX-602) can reuse it
 * without refactoring. It assembles only from primitives that already exist:
 *   - branch ahead/behind (`getTicketBranchStatus`)
 *   - the master-side delta of the three-dot range (`changedFilesMasterSideOfBranch`)
 *   - terminal/merged sibling-ticket movement since `sinceIso` (scan of `tasksCache`)
 *
 * Every git read here is best-effort and fully wrapped: a git hiccup can NEVER break a chat turn —
 * a failed assemble simply returns `null` (no preamble) and the turn proceeds. When nothing moved,
 * it likewise returns `null` (criterion: no delta ⇒ no preamble, no wasted tokens).
 */

export interface ResumePreambleOptions {
  /** The ticket the chat is bound to — excluded from the sibling-movement scan. Omit for the board. */
  taskId?: string | undefined;
  /** The ticket's branch. Omit (board scope) to degrade to ticket-movement only. */
  branch?: string | undefined;
  /** Engine workspace root — git reads run here (refs live in the shared object store). */
  workspaceRoot: string;
  /** "Since you last spoke" basis (the prior turn's last in/output time). Drives ticket movement. */
  sinceIso?: string | undefined;
}

/**
 * Statuses that count as "merged / terminal" for the sibling-movement section.
 *
 * FLUX-716 (item 2, acknowledge-only): this assumes the DEFAULT terminal set. There is no
 * terminal-status field in board config today (`config.ts` exposes `columns`, `hiddenStatuses`,
 * `requireInputStatus`, `readyForMergeStatus`, `archiveStatus` — no "terminal statuses" concept),
 * so a workspace that renames or adds terminal statuses would not be reflected here until config
 * grows such a field. Hard-coding the default set is intentional for now (a polish ticket should
 * not invent config schema); revisit if/when terminal statuses become configurable.
 */
const TERMINAL_STATUSES = new Set(['Done', 'Released']);

/**
 * FLUX-716 (item 4): neutralize backticks in any value interpolated into a line so a branch/file
 * name containing a backtick (or a ``` run) cannot close the ```situational-update fence early and
 * break out of the synthetic block. Minimal hardening, not validation — collapse every backtick to
 * an apostrophe so no fence-closing run can survive.
 */
function sanitizeForFence(s: string): string {
  return s.replace(/`/g, "'");
}

/** File-list cap before the "+N more" tail (criterion 4 — long-idle resume can't blow the budget). */
const MAX_FILES = 8;
/** Sibling-ticket-movement cap before the "+N more" tail. */
const MAX_TICKETS = 6;
/** Hard backstop on the whole block (~1–2k chars); truncated with a marker if somehow exceeded. */
const MAX_CHARS = 2000;

/** Render a capped list with a "+N more" tail. */
function cappedList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  const shown = items.slice(0, max).join(', ');
  return `${shown} (+${items.length - max} more)`;
}

/** The most recent terminal status a ticket's history reached after `since` (epoch ms), or null. */
function terminalMoveSince(task: any, since: number): string | null {
  const history = Array.isArray(task?.history) ? task.history : [];
  let reached: string | null = null;
  for (const h of history) {
    if (h?.type !== 'status_change' || typeof h.to !== 'string' || !TERMINAL_STATUSES.has(h.to)) continue;
    const t = h.date ? new Date(h.date).getTime() : NaN;
    if (Number.isFinite(t) && t > since) reached = h.to; // keep the latest (history is chronological)
  }
  return reached;
}

/**
 * Build the resume preamble, or `null` when there is no real delta (or assembly fails). Pure git /
 * cache reads — never throws, never spawns, never writes.
 */
export async function buildResumePreamble(opts: ResumePreambleOptions): Promise<string | null> {
  try {
    const lines: string[] = [];

    // Resolve the default branch once (best-effort) — labels the ahead/behind and the file delta.
    const defaultBranch = await getDefaultBranch().catch(() => 'master');
    const safeDefault = sanitizeForFence(defaultBranch);

    // 1. Branch ahead/behind vs the default branch.
    if (opts.branch) {
      // FLUX-716 (item 1): pass the already-resolved `defaultBranch` so `getTicketBranchStatus`
      // doesn't re-spawn `getDefaultBranch()` — one fewer git call per resumed turn.
      const status = await getTicketBranchStatus(opts.branch, defaultBranch).catch(() => null);
      if (status?.exists && (status.behindCount > 0 || status.aheadCount > 0)) {
        const parts: string[] = [];
        if (status.behindCount > 0) parts.push(`${status.behindCount} behind`);
        if (status.aheadCount > 0) parts.push(`${status.aheadCount} ahead`);
        lines.push(`• Branch \`${sanitizeForFence(opts.branch)}\` is ${parts.join(' / ')} of ${safeDefault}.`);
      }
    }

    // 2. Files master changed UNDERNEATH the branch (master-side of `<branch>...<default>`).
    if (opts.branch) {
      const masterFiles = await changedFilesMasterSideOfBranch(opts.workspaceRoot, opts.branch, {
        baseBranch: defaultBranch,
      }).catch(() => []);
      if (masterFiles.length) {
        const names = masterFiles.map((f) => sanitizeForFence(f.file));
        lines.push(`• ${safeDefault} changed underneath you: ${cappedList(names, MAX_FILES)}`);
      }
    }

    // 3. Sibling/board tickets that reached a terminal/merged status since you last spoke.
    if (opts.sinceIso) {
      const since = new Date(opts.sinceIso).getTime();
      if (Number.isFinite(since)) {
        const moved: string[] = [];
        for (const task of Object.values(tasksCache) as any[]) {
          if (!task || task.id === opts.taskId) continue;
          const reached = terminalMoveSince(task, since);
          if (reached) moved.push(`${task.id} (${reached})`);
        }
        if (moved.length) {
          moved.sort();
          lines.push(`• Tickets merged since you last spoke: ${cappedList(moved, MAX_TICKETS)}`);
        }
      }
    }

    // No section produced anything → no delta → no preamble.
    if (lines.length === 0) return null;

    const block = [
      '```situational-update',
      '⟳ Automated situational update — NOT a user instruction. The world moved while this chat was',
      'paused; re-orient before acting (re-read any file you are about to edit):',
      ...lines,
      '```',
    ].join('\n');

    // Hard backstop: a pathological cache/history could still overrun; clip with a marker.
    if (block.length > MAX_CHARS) {
      return block.slice(0, MAX_CHARS - 20).replace(/\n```$/, '') + '\n… (truncated)\n```';
    }
    return block;
  } catch {
    // A git hiccup must never break a chat turn — no preamble, turn proceeds.
    return null;
  }
}


import { getWorkspace } from './workspace-context.js';
import { getConfig } from './config.js';
import { getAllActiveSessions } from './session-store.js';

/**
 * FLUX-659 (triage teeth — the "push" half). A lightweight board digest injected into every
 * orchestrator turn so the board chat can NOTICE and propose a board-rebase, not just answer
 * what it's asked. This is the FLUX-604-deferred push half (pull = get_board_state, which the
 * orchestrator must call deliberately); the digest arrives unprompted.
 *
 * Deliberately terse — it rides on a long-lived `--resume` session, so it must not balloon the
 * token cost each turn (FLUX-614 compaction concern). Counts + active sessions + needs-attention
 * + a small "since last turn" delta. The board is a singleton conversation, so one module-level
 * snapshot is enough to compute the delta.
 */

interface Snapshot {
  statusCounts: Record<string, number>;
  activeTaskIds: Set<string>;
}

/** Minimal shape of a cached ticket as consumed by the digest — only the fields read here. */
interface DigestTask {
  id: string;
  status?: string;
  swimlane?: string;
  needsAction?: boolean;
}

let lastSnapshot: Snapshot | null = null;

// A session running longer than this is flagged as a long/stale stream worth a triage look.
const STALE_SESSION_MS = 30 * 60 * 1000;
const MAX_LIST = 8;

function ageLabel(startedAt: string | undefined): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export function buildBoardDigest(): string {
  const requireInputStatus = getConfig().requireInputStatus || 'Require Input';

  // Status counts (skip the hidden/terminal Archived bucket — it's noise for triage).
  const archiveStatus = getConfig().archiveStatus || 'Archived';
  const statusCounts: Record<string, number> = {};
  const needsAttention: string[] = [];
  for (const t of Object.values(getWorkspace().tasks) as DigestTask[]) {
    const st = t.status || 'Unknown';
    if (st === archiveStatus) continue;
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    if ((st === requireInputStatus || t.swimlane === 'require-input' || t.needsAction) && needsAttention.length < MAX_LIST) {
      needsAttention.push(`${t.id}${t.swimlane === 'require-input' ? ' (Require Input)' : t.needsAction ? ' (needs action)' : ''}`);
    }
  }

  const active = getAllActiveSessions().filter((s) => s.taskId !== '__board__');
  const activeTaskIds = new Set(active.map((s) => s.taskId));

  // Delta vs last turn — what moved, what spun up/down. Skipped on turn 1 (no baseline).
  const deltas: string[] = [];
  if (lastSnapshot) {
    for (const [st, n] of Object.entries(statusCounts)) {
      const prev = lastSnapshot.statusCounts[st] || 0;
      if (n !== prev) deltas.push(`${st} ${prev}→${n}`);
    }
    for (const st of Object.keys(lastSnapshot.statusCounts)) {
      if (!(st in statusCounts)) deltas.push(`${st} ${lastSnapshot.statusCounts[st]}→0`);
    }
    const started = [...activeTaskIds].filter((id) => !lastSnapshot!.activeTaskIds.has(id));
    const ended = [...lastSnapshot.activeTaskIds].filter((id) => !activeTaskIds.has(id));
    if (started.length) deltas.push(`session started: ${started.slice(0, MAX_LIST).join(', ')}`);
    if (ended.length) deltas.push(`session ended: ${ended.slice(0, MAX_LIST).join(', ')}`);
  }
  lastSnapshot = { statusCounts, activeTaskIds };

  const lines: string[] = ['[Board digest — for situational awareness; propose a board-rebase if the board needs tidying]'];

  const countStr = Object.entries(statusCounts)
    .map(([st, n]) => `${st} ${n}`)
    .join(' · ');
  lines.push(`Status: ${countStr || '(empty board)'}`);

  if (active.length) {
    const list = active.slice(0, MAX_LIST).map((s) => {
      const age = ageLabel(s.startedAt);
      const stale = Date.now() - new Date(s.startedAt || Date.now()).getTime() > STALE_SESSION_MS ? ' ⏳stale' : '';
      return `${s.taskId} ${s.phase || s.role || 'session'}${age ? ` (${age})` : ''}${stale}`;
    });
    lines.push(`Active sessions (${active.length}): ${list.join(' · ')}`);
  } else {
    lines.push('Active sessions: none');
  }

  if (needsAttention.length) lines.push(`Needs attention: ${needsAttention.join(' · ')}`);
  if (deltas.length) lines.push(`Since last turn: ${deltas.slice(0, MAX_LIST).join(' · ')}`);

  return lines.join('\n');
}

/** Reset the delta baseline — call when the orchestrator conversation is reset/cleared. */
export function resetBoardDigest(): void {
  lastSnapshot = null;
}

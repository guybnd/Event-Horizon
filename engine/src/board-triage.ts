import { getWorkspace } from './workspace-context.js';
import { getTerminalStatuses } from './task-store.js';
import { getConfig } from './config.js';
import { getPullRequestStatus } from './branch-manager.js';

/**
 * FLUX-966: on-demand "Board Health" signals for the board-rebase ritual. Unlike
 * `board-digest.ts` (which rides every orchestrator turn and must stay free), this module is
 * computed ONLY when the portal's "Board Health" quick action fires — the dead-PR check shells
 * out to `gh pr view` per branch (capped below), so folding it into the always-on digest would
 * tax every single turn. Pure read: nothing here mutates a ticket, its history, or config.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Time-in-status thresholds before a Grooming/Require Input ticket is flagged stale. */
export const STALE_GROOMING_MS = 14 * DAY_MS;
export const STALE_REQUIRE_INPUT_MS = 7 * DAY_MS;

/** Cap on `gh pr view` calls per Triage run (subprocess + network cost, not free). */
export const MAX_PR_CHECKS = 20;
const PR_CHECK_CONCURRENCY = 4;

/** Display cap per rendered line — mirrors `board-digest.ts`'s MAX_LIST "+N more" convention. */
const MAX_LIST = 8;

const GROOMING_STATUS = 'Grooming';

/** Minimal `tasksCache` ticket shape as read by this module. */
interface TriageHistoryEntry {
  type?: string;
  date?: string;
  action?: string;
  swimlane?: string;
}

interface TriageTicket {
  id: string;
  title?: string;
  status: string;
  swimlane?: string;
  parentId?: string;
  branch?: string;
  history?: TriageHistoryEntry[];
}

/**
 * Milliseconds since the ticket last entered its CURRENT status, derived from the most recent
 * `status_change` history entry. A ticket that has never changed status falls back to its
 * earliest history entry (creation). Returns null when neither is available/parseable —
 * callers must treat that as "not stale", never crash the pass.
 */
function timeInStatusMs(ticket: TriageTicket): number | null {
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  let lastStatusChangeMs: number | null = null;
  let earliestMs: number | null = null;
  for (const entry of history) {
    if (!entry?.date) continue;
    const ms = new Date(entry.date).getTime();
    if (!Number.isFinite(ms)) continue;
    if (earliestMs === null || ms < earliestMs) earliestMs = ms;
    if (entry.type === 'status_change' && (lastStatusChangeMs === null || ms > lastStatusChangeMs)) {
      lastStatusChangeMs = ms;
    }
  }
  const anchor = lastStatusChangeMs ?? earliestMs;
  if (anchor === null) return null;
  const ms = Date.now() - anchor;
  return ms >= 0 ? ms : null;
}

/**
 * Milliseconds since the ticket's most recent `swimlane_change` entry that SET the
 * `require-input` swimlane — mirrors `history.ts`'s `computeRequireInputMeta` derivation used
 * for the attention dock. This board routes Require Input through the swimlane system (status
 * stays unchanged; see mcp-server.ts's `change_status` backwards-compat handling), so a
 * `status_change` scan never sees it. Falls back to `timeInStatusMs` for legacy tickets that
 * hold the literal "Require Input" status with no such history entry.
 */
function timeSinceRequireInputSetMs(ticket: TriageTicket): number | null {
  const history = Array.isArray(ticket.history) ? ticket.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry?.type === 'swimlane_change' && entry.action === 'set' && entry.swimlane === 'require-input') {
      if (!entry.date) return null;
      const ms = new Date(entry.date).getTime();
      if (!Number.isFinite(ms)) return null;
      const elapsed = Date.now() - ms;
      return elapsed >= 0 ? elapsed : null;
    }
  }
  return timeInStatusMs(ticket);
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
}

interface StaleSignal { id: string; status: string; days: number }
interface OrphanSignal { id: string; parentId: string; parentStatus: string }
interface DuplicateGroup { normalizedTitle: string; ids: string[] }
interface DeadPrSignal { id: string; state: 'no-pr' | 'MERGED' | 'CLOSED'; prNumber?: number }

function computeStaleSignals(tickets: TriageTicket[]): StaleSignal[] {
  const requireInputStatus = getConfig().requireInputStatus || 'Require Input';
  const out: StaleSignal[] = [];
  for (const t of tickets) {
    // Require Input is a swimlane on this board (status is left unchanged) — check both, like
    // board-digest.ts's needsAttention, so legacy literal-status data still works too.
    if (t.swimlane === 'require-input' || t.status === requireInputStatus) {
      const ms = timeSinceRequireInputSetMs(t);
      if (ms !== null && ms > STALE_REQUIRE_INPUT_MS) {
        out.push({ id: t.id, status: 'Require Input', days: Math.floor(ms / DAY_MS) });
      }
      continue;
    }
    if (t.status === GROOMING_STATUS) {
      const ms = timeInStatusMs(t);
      if (ms !== null && ms > STALE_GROOMING_MS) {
        out.push({ id: t.id, status: t.status, days: Math.floor(ms / DAY_MS) });
      }
    }
  }
  return out;
}

function computeOrphanedSubtasks(tickets: TriageTicket[], byId: Map<string, TriageTicket>, terminal: Set<string>): OrphanSignal[] {
  const out: OrphanSignal[] = [];
  for (const t of tickets) {
    if (!t.parentId || terminal.has(t.status)) continue;
    const parent = byId.get(t.parentId);
    if (!parent || !terminal.has(parent.status)) continue;
    out.push({ id: t.id, parentId: t.parentId, parentStatus: parent.status });
  }
  return out;
}

function computeDuplicateTitles(tickets: TriageTicket[], terminal: Set<string>): DuplicateGroup[] {
  const groups = new Map<string, string[]>();
  for (const t of tickets) {
    if (terminal.has(t.status) || !t.title) continue;
    const normalizedTitle = normalizeTitle(t.title);
    if (!normalizedTitle) continue;
    const arr = groups.get(normalizedTitle) ?? [];
    arr.push(t.id);
    groups.set(normalizedTitle, arr);
  }
  const out: DuplicateGroup[] = [];
  for (const [normalizedTitle, ids] of groups) {
    if (ids.length >= 2) out.push({ normalizedTitle, ids });
  }
  return out;
}

/** Bounded-concurrency `gh pr view` sweep over Ready+branched tickets, capped at MAX_PR_CHECKS. */
async function computeDeadPrSignals(candidates: TriageTicket[]): Promise<DeadPrSignal[]> {
  const out: DeadPrSignal[] = [];
  let idx = 0;
  async function worker() {
    while (idx < candidates.length) {
      const t = candidates[idx++]!;
      try {
        const pr = await getPullRequestStatus(t.branch!);
        if (!pr) out.push({ id: t.id, state: 'no-pr' });
        else if (pr.state === 'MERGED' || pr.state === 'CLOSED') out.push({ id: t.id, state: pr.state, prNumber: pr.number });
      } catch {
        // best-effort per ticket — one gh hiccup must not abort the sweep (mirrors
        // getPullRequestStatus's own null-on-error contract).
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PR_CHECK_CONCURRENCY, candidates.length) }, worker));
  return out;
}

/**
 * Compute every Triage signal and render it into a terse prompt fragment in the same voice as
 * `buildBoardDigest()`. Ticket-centric: a ticket matching several signals renders as ONE line
 * combining its facts, never duplicated across sections. Zero signals still returns an explicit
 * "board looks healthy" line — never silently omitted, never fabricated. Async only because the
 * dead-PR check is a read-only remote `gh` call; everything else is a synchronous in-memory read.
 */
export async function buildTriageFragment(): Promise<string> {
  const tickets = Object.values(getWorkspace().tasks) as unknown as TriageTicket[];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const terminal = new Set(getTerminalStatuses());

  const readyStatus = getConfig().readyForMergeStatus || 'Ready';
  const prCandidates = tickets.filter((t) => t.status === readyStatus && t.branch);
  const checkedCandidates = prCandidates.slice(0, MAX_PR_CHECKS);

  const stale = computeStaleSignals(tickets);
  const orphans = computeOrphanedSubtasks(tickets, byId, terminal);
  const dupes = computeDuplicateTitles(tickets, terminal);
  const deadPrs = await computeDeadPrSignals(checkedCandidates);

  // Ticket-centric fact accumulation — insertion order = first-encountered signal.
  const facts = new Map<string, string[]>();
  const addFact = (id: string, fact: string) => {
    const arr = facts.get(id) ?? [];
    arr.push(fact);
    facts.set(id, arr);
  };

  for (const s of stale) addFact(s.id, `${s.status}, no activity in ${s.days}d`);
  for (const o of orphans) addFact(o.id, `orphaned (parent ${o.parentId} is ${o.parentStatus})`);
  for (const d of dupes) {
    for (const id of d.ids) {
      const others = d.ids.filter((otherId) => otherId !== id);
      addFact(id, `possible duplicate of ${others.join(', ')} (title: "${d.normalizedTitle}")`);
    }
  }
  for (const d of deadPrs) {
    addFact(d.id, d.state === 'no-pr' ? 'Ready, no PR found' : `Ready, PR ${d.state.toLowerCase()}${d.prNumber ? ` #${d.prNumber}` : ''} elsewhere`);
  }

  const lines: string[] = ['[Board Health — signals computed on-demand at trigger time; reason over these before calling propose_board_rebase]'];

  const categoryCounts: string[] = [];
  if (stale.length) categoryCounts.push(`${stale.length} stale`);
  if (orphans.length) categoryCounts.push(`${orphans.length} orphaned`);
  if (dupes.length) categoryCounts.push(`${dupes.length} duplicate-title group${dupes.length === 1 ? '' : 's'}`);
  if (deadPrs.length) categoryCounts.push(`${deadPrs.length} dead-PR`);

  if (facts.size === 0) {
    lines.push('No staleness signals found — board looks healthy.');
  } else {
    lines.push(`${facts.size} ticket(s) flagged (${categoryCounts.join(', ')}):`);
    const ids = [...facts.keys()];
    for (const id of ids.slice(0, MAX_LIST)) {
      lines.push(`${id}: ${facts.get(id)!.join('; ')}`);
    }
    if (ids.length > MAX_LIST) lines.push(`+${ids.length - MAX_LIST} more flagged ticket(s) not shown.`);
  }

  if (prCandidates.length > MAX_PR_CHECKS) {
    lines.push(`Dead-PR check capped: only checked ${MAX_PR_CHECKS} of ${prCandidates.length} Ready+branched tickets — re-run to sweep the rest.`);
  }

  return lines.join('\n');
}

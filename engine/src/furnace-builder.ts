// The Furnace — batch builder / curation (FLUX-1008 / S2 → FLUX-1053 batch redesign).
//
// Turns the groomed backlog into a proposed set of tickets for a `parallel` batch: tickets that can
// burn independently. Deterministic — structural rules + a plan-text file-overlap heuristic, no LLM.
// `buildBatchTickets` is a PURE function over an injected list of ticket records so it unit-tests
// without a workspace; the REST/MCP layer passes `Object.values(tasksCache)`.
//
// Independence model:
//   - Candidates are groomed (status `Todo`) — optionally filtered by a tag hint.
//   - Parent/child: a parent is excluded whenever one of its subtasks is also a candidate (burn the
//     independent leaf, never both), so two PRs from a ticket and its own child can't collide.
//   - File overlap is a SOFT flag, never a hard exclude: each ticket burns in its own worktree, so the
//     only real risk is two PRs touching the same file colliding at human merge time. Overlapping
//     tickets are flagged and ordered apart. (For work that MUST share progress, make a sequential
//     batch instead — that is an explicit, first-class choice, not something the builder infers.)

import { type BatchTicket, newBatchTicket } from './models/furnace.js';

/** The minimal ticket shape the builder reasons over (a structural subset of the task record). */
export interface BuildCandidate {
  id: string;
  title?: string;
  status?: string;
  tags?: string[];
  body?: string;
  subtasks?: string[];
  parentId?: string;
}

export interface ExcludedTicket {
  ticketId: string;
  title?: string;
  reason: string;
}

export interface BatchProposal {
  /** Ordered, ready-to-load tickets (overlap-flagged, ordered apart). */
  tickets: BatchTicket[];
  /** Tickets deliberately left out, with why. */
  excluded: ExcludedTicket[];
  /** Human-facing summary lines about the build. */
  notes: string[];
}

export interface BuildBatchOptions {
  /** Statuses that count as "groomed & ready". Default `['Todo']`. */
  statuses?: string[];
  /** Only include tickets carrying this tag (the furnace opt-in hint). */
  tag?: string;
  /** Exclude tickets carrying any of these tags. */
  excludeTags?: string[];
  /** Cap the batch to at most this many tickets. */
  limit?: number;
}

// Cap how much of a body we scan for path mentions — a huge body could otherwise pin the single-threaded
// engine on this scan. A few KB is far more than any real ticket needs for the overlap heuristic.
const MAX_SCAN_LEN = 16 * 1024;

// A known code extension, anchored to the end of a candidate token (simple, non-backtracking alternation).
const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|json|md|html|py|go|rs|java|rb)$/;

/** Extract distinct file/module paths mentioned in a ticket body (for the overlap heuristic). Linear scan. */
export function extractMentionedPaths(body?: string): string[] {
  if (!body) return [];
  const scanned = body.length > MAX_SCAN_LEN ? body.slice(0, MAX_SCAN_LEN) : body;
  const set = new Set<string>();
  for (const raw of scanned.split(/[^\w./-]+/)) {
    const token = raw.replace(/^\.\//, '').replace(/\.+$/, '');
    if (token.includes('/') && CODE_EXT_RE.test(token)) set.add(token);
  }
  return [...set];
}

/** Filter to independent leaves: drop a parent whenever any of its subtasks is also a candidate. */
export function excludeParentChildPairs(
  candidates: BuildCandidate[],
): { kept: BuildCandidate[]; excluded: ExcludedTicket[] } {
  const ids = new Set(candidates.map((t) => t.id));
  const parentsWithCandidateChild = new Set<string>();
  for (const t of candidates) {
    if (t.parentId && ids.has(t.parentId)) parentsWithCandidateChild.add(t.parentId);
  }
  const kept: BuildCandidate[] = [];
  const excluded: ExcludedTicket[] = [];
  for (const t of candidates) {
    const childViaSubtasks = (t.subtasks ?? []).find((sid) => ids.has(sid));
    const isParentOfCandidate = childViaSubtasks !== undefined || parentsWithCandidateChild.has(t.id);
    if (isParentOfCandidate) {
      const child = childViaSubtasks ?? candidates.find((c) => c.parentId === t.id)?.id ?? 'a loaded ticket';
      const line: ExcludedTicket = {
        ticketId: t.id,
        reason: `parent of loaded ticket ${child} — burning the independent leaf instead`,
      };
      if (t.title !== undefined) line.title = t.title;
      excluded.push(line);
      continue;
    }
    kept.push(t);
  }
  return { kept, excluded };
}

/** Greedy "order apart" pass: sequence tickets so two sharing a file are not adjacent when avoidable. */
export function orderApart(items: BuildCandidate[], filesOf: (id: string) => string[]): BuildCandidate[] {
  const remaining = [...items];
  const result: BuildCandidate[] = [];
  let lastFiles: string[] = [];
  while (remaining.length) {
    let idx = remaining.findIndex((t) => {
      const f = filesOf(t.id);
      return !f.some((x) => lastFiles.includes(x));
    });
    if (idx === -1) idx = 0;
    const picked = remaining.splice(idx, 1)[0];
    if (!picked) break;
    result.push(picked);
    lastFiles = filesOf(picked.id);
  }
  return result;
}

/** Pure batch builder over an injected ticket list. */
export function buildBatchTickets(tickets: BuildCandidate[], opts: BuildBatchOptions = {}): BatchProposal {
  const statuses = opts.statuses ?? ['Todo'];
  const notes: string[] = [];

  const candidates = tickets.filter((t) => {
    if (!t || typeof t.id !== 'string') return false;
    if (!statuses.includes(t.status ?? '')) return false;
    if (opts.tag && !(t.tags ?? []).includes(opts.tag)) return false;
    if (opts.excludeTags && opts.excludeTags.some((x) => (t.tags ?? []).includes(x))) return false;
    return true;
  });

  const { kept, excluded } = excludeParentChildPairs(candidates);

  // File-overlap heuristic (soft) — pairwise shared-path detection, then order overlapping tickets apart.
  const filesByTicket = new Map<string, string[]>();
  for (const t of kept) filesByTicket.set(t.id, extractMentionedPaths(t.body));
  const overlapWith = new Map<string, Set<string>>();
  const overlapFiles = new Map<string, Set<string>>();
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i]; const b = kept[j];
      if (!a || !b) continue;
      const fa = filesByTicket.get(a.id) ?? [];
      const fb = filesByTicket.get(b.id) ?? [];
      const shared = fa.filter((f) => fb.includes(f));
      if (shared.length) {
        for (const [x, y] of [[a, b], [b, a]] as const) {
          if (!overlapWith.has(x.id)) { overlapWith.set(x.id, new Set()); overlapFiles.set(x.id, new Set()); }
          overlapWith.get(x.id)!.add(y.id);
          for (const f of shared) overlapFiles.get(x.id)!.add(f);
        }
      }
    }
  }

  const ordered = orderApart(kept, (id) => filesByTicket.get(id) ?? []);
  const capped = opts.limit ? ordered.slice(0, opts.limit) : ordered;

  const batchTickets: BatchTicket[] = capped.map((t, i) => {
    const entry = newBatchTicket(t.id, i, t.title);
    const withSet = overlapWith.get(t.id);
    if (withSet && withSet.size) {
      entry.note = `may touch ${[...(overlapFiles.get(t.id) ?? [])].join(', ')} (shared with ${[...withSet].join(', ')})`;
    }
    return entry;
  });

  notes.push(`${batchTickets.length} ticket(s) loaded from ${statuses.join('/')}${opts.tag ? ` tagged #${opts.tag}` : ''}.`);
  if (opts.limit && ordered.length > opts.limit) notes.push(`Capped to ${opts.limit} of ${ordered.length} eligible tickets.`);
  if (excluded.length) notes.push(`${excluded.length} excluded to avoid a parent/child pairing.`);
  const overlapCount = batchTickets.filter((e) => e.note).length;
  if (overlapCount) notes.push(`${overlapCount} ticket(s) flagged for possible file overlap — ordered apart, not blocked (each burns in its own worktree).`);

  return { tickets: batchTickets, excluded, notes };
}

/** Map a raw task-store record to the structural subset the builder needs. */
export function toBuildCandidate(task: any): BuildCandidate {
  const c: BuildCandidate = { id: task.id };
  if (task.title !== undefined) c.title = task.title;
  if (task.status !== undefined) c.status = task.status;
  if (Array.isArray(task.tags)) c.tags = task.tags;
  if (task.body !== undefined) c.body = task.body;
  if (Array.isArray(task.subtasks)) c.subtasks = task.subtasks;
  if (task.parentId !== undefined) c.parentId = task.parentId;
  return c;
}

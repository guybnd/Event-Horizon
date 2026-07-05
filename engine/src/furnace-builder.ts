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

import { type BatchTicket, type FurnaceBatch, isBatchTerminal, newBatchTicket } from './models/furnace.js';

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
  /**
   * Explicit ticket ids to include — the other intentional selector, usable instead of or alongside
   * `tag`. At least one of `tag` / `tickets` is required (FLUX-1051): a build with neither refuses to
   * scan the whole backlog.
   */
  tickets?: string[];
  /** Non-terminal (`draft`/`burning`) batches already in the store, for the one-active-batch guard. */
  activeBatches?: FurnaceBatch[];
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

/**
 * The id of the batch (other than `excludeBatchId`) that already owns this ticket in a non-terminal
 * (`draft`/`burning`) state, if any — the one-active-batch invariant (FLUX-1051). A ticket sitting in a
 * `done`/`parked` batch is free to be picked up again.
 */
export function findActiveBatchFor(
  ticketId: string,
  batches: FurnaceBatch[],
  opts: { excludeBatchId?: string } = {},
): string | undefined {
  for (const b of batches) {
    if (opts.excludeBatchId && b.id === opts.excludeBatchId) continue;
    if (isBatchTerminal(b.status)) continue;
    if (b.tickets.some((t) => t.ticketId === ticketId)) return b.id;
  }
  return undefined;
}

/** Pure batch builder over an injected ticket list. */
/** Push a candidate into `excluded` with a reason, carrying its denormalized title along if known. */
function excludeWithReason(excluded: ExcludedTicket[], t: BuildCandidate, reason: string): void {
  const line: ExcludedTicket = { ticketId: t.id, reason };
  if (t.title !== undefined) line.title = t.title;
  excluded.push(line);
}

export function buildBatchTickets(tickets: BuildCandidate[], opts: BuildBatchOptions = {}): BatchProposal {
  const statuses = opts.statuses ?? ['Todo'];
  const excluded: ExcludedTicket[] = [];

  const tag = opts.tag && opts.tag.length ? opts.tag : undefined;
  const explicitIds = [...new Set((opts.tickets ?? []).filter((id) => typeof id === 'string' && id.length > 0))];
  const hasExplicitIds = explicitIds.length > 0;

  // FLUX-1051: a batch must always be an intentional selection — no selector means no scan, full stop.
  // (No `allTickets` escape hatch: whoever truly wants everything can tag everything.)
  if (!tag && !hasExplicitIds) {
    return {
      tickets: [],
      excluded: [],
      notes: [
        'furnace_build requires an explicit selector: a `tag` (tickets carrying it, convention `burn-furnace`) or explicit `tickets` ids. Refusing to scan the whole backlog.',
      ],
    };
  }

  const byId = new Map<string, BuildCandidate>();
  for (const t of tickets) if (t && typeof t.id === 'string') byId.set(t.id, t);

  // Selector pool — union of everything tagged and everything explicitly named. Every id that enters
  // the pool below is accounted for exactly once: it lands in `tickets`, or in `excluded` with a reason.
  const taggedIds = new Set<string>();
  const pool = new Map<string, BuildCandidate>();
  if (tag) {
    for (const t of byId.values()) {
      if ((t.tags ?? []).includes(tag)) { pool.set(t.id, t); taggedIds.add(t.id); }
    }
  }
  for (const id of explicitIds) {
    const t = byId.get(id);
    if (t) pool.set(id, t);
    else excluded.push({ ticketId: id, reason: 'unknown ticket id' });
  }

  const afterExcludeTags: BuildCandidate[] = [];
  for (const t of pool.values()) {
    if (opts.excludeTags && opts.excludeTags.some((x) => (t.tags ?? []).includes(x))) {
      excludeWithReason(excluded, t, 'excluded by excludeTags');
      continue;
    }
    afterExcludeTags.push(t);
  }

  // Tag/status drift (FLUX-1051): a tagged-but-wrong-status ticket used to just fail this filter and
  // vanish — now every drop is recorded with why. Same pass also enforces the one-active-batch
  // invariant: a ticket already queued in another non-terminal batch is excluded, not double-loaded.
  // NOTE: `activeBatches` is a snapshot taken by the caller before this call; it is not re-read under a
  // lock, so two near-simultaneous builds/adds targeting different batches with the same ticket id can
  // each pass this check before either mutation lands — the same check-then-mutate tolerance the
  // pre-existing "already in this batch" guard has always had, not a new gap introduced here.
  const activeBatches = opts.activeBatches ?? [];
  const afterStatusAndBatch: BuildCandidate[] = [];
  for (const t of afterExcludeTags) {
    if (!statuses.includes(t.status ?? '')) {
      excludeWithReason(excluded, t, `${taggedIds.has(t.id) ? 'tagged but status' : 'status'} ${t.status || '(none)'} (not allowed)`);
      continue;
    }
    const owner = findActiveBatchFor(t.id, activeBatches);
    if (owner) {
      excludeWithReason(excluded, t, `already queued in batch ${owner}`);
      continue;
    }
    afterStatusAndBatch.push(t);
  }

  const { kept, excluded: parentChildExcluded } = excludeParentChildPairs(afterStatusAndBatch);
  excluded.push(...parentChildExcluded);

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
  const isCapped = !!opts.limit && ordered.length > opts.limit;
  const capped = opts.limit ? ordered.slice(0, opts.limit) : ordered;
  if (isCapped) {
    for (const t of ordered.slice(opts.limit)) excludeWithReason(excluded, t, 'capped by limit');
  }

  const batchTickets: BatchTicket[] = capped.map((t, i) => {
    const entry = newBatchTicket(t.id, i, t.title);
    const withSet = overlapWith.get(t.id);
    if (withSet && withSet.size) {
      entry.note = `may touch ${[...(overlapFiles.get(t.id) ?? [])].join(', ')} (shared with ${[...withSet].join(', ')})`;
    }
    return entry;
  });

  const selectorLabel = [
    tag ? `tagged #${tag}` : undefined,
    hasExplicitIds ? `${explicitIds.length} explicit id(s)` : undefined,
  ].filter(Boolean).join(' + ');
  const notes: string[] = [`${batchTickets.length} ticket(s) loaded from ${statuses.join('/')}, selected by ${selectorLabel}.`];
  const isDefaultStatuses = statuses.length === 1 && statuses[0] === 'Todo';
  if (opts.statuses && !isDefaultStatuses) notes.push(`Scan window overridden: ${statuses.join('/')}.`);
  if (isCapped) notes.push(`Capped to ${opts.limit} of ${ordered.length} eligible tickets.`);
  if (parentChildExcluded.length) notes.push(`${parentChildExcluded.length} excluded to avoid a parent/child pairing.`);
  const overlapCount = batchTickets.filter((e) => e.note).length;
  if (overlapCount) notes.push(`${overlapCount} ticket(s) flagged for possible file overlap — ordered apart, not blocked (each burns in its own worktree).`);

  // Lead with a warning when tagged tickets were skipped — the drift a silent filter used to hide.
  const loadedIds = new Set(batchTickets.map((t) => t.ticketId));
  const taggedSkipped = [...taggedIds].filter((id) => !loadedIds.has(id));
  if (taggedSkipped.length) notes.unshift(`⚠ ${taggedSkipped.length} tagged ticket(s) NOT loaded — see excluded.`);

  return { tickets: batchTickets, excluded, notes };
}

// ── Raw-CRUD ticket validation (FLUX-1029) ──────────────────────────────────────
//
// The builder (`buildBatchTickets`) inherently only ever picks tickets that exist and are groomed,
// because it filters an injected candidate list by status. The raw REST endpoints, by contrast, let a
// caller hand-build a batch's ticket list from arbitrary ids — so they need an explicit gate before
// persisting, or an ignited batch could spawn unattended sessions against ids that don't exist or
// aren't ready to burn. `validateBatchTickets` is that gate: same existence + allowed-status bar as the
// builder, pure over an injected lookup so it unit-tests without a workspace (the routes pass
// `tasksCache`). Unlike the builder it does NOT hard-exclude parent/child pairs — raw CRUD backs the
// portal's drag-from-board, where grouping related tickets can be deliberate (FLUX-1029 Decision A).

/** A ticket id rejected by `validateBatchTickets`, with why. */
export interface RejectedBatchTicket {
  ticketId: string;
  reason: 'unknown' | 'bad-status' | 'already-active';
  /** For `already-active` (FLUX-1051 one-active-batch guard): the batch that already owns this ticket. */
  batchId?: string;
}

export interface ValidateBatchTicketsResult {
  /** Accepted ids as ready-to-load, contiguously-ordered tickets. */
  ok: BatchTicket[];
  /** Ids rejected because they don't exist or aren't in an allowed status. */
  rejected: RejectedBatchTicket[];
}

/**
 * Validate a hand-supplied list of ticket ids for a raw-CRUD batch: each id must exist in `lookup` and
 * be in an allowed status (default `['Todo']`, matching the builder). Pure — `lookup` is the injected
 * ticket record (the routes pass `tasksCache`). Order is preserved for accepted ids.
 */
export function validateBatchTickets(
  ids: string[],
  lookup: Record<string, { status?: string; title?: string } | undefined>,
  opts: { allowedStatuses?: string[]; activeBatches?: FurnaceBatch[]; excludeBatchId?: string } = {},
): ValidateBatchTicketsResult {
  const allowedStatuses = opts.allowedStatuses ?? ['Todo'];
  const activeBatches = opts.activeBatches ?? [];
  const ok: BatchTicket[] = [];
  const rejected: RejectedBatchTicket[] = [];
  for (const ticketId of ids) {
    const task = lookup[ticketId];
    if (!task) {
      rejected.push({ ticketId, reason: 'unknown' });
      continue;
    }
    if (!allowedStatuses.includes(task.status ?? '')) {
      rejected.push({ ticketId, reason: 'bad-status' });
      continue;
    }
    // One-active-batch invariant (FLUX-1051): a ticket already queued in another non-terminal batch
    // cannot be queued into a second one through this gate (raw CRUD create/update, furnace_ticket action:"add").
    const owner = activeBatches.length
      ? findActiveBatchFor(ticketId, activeBatches, opts.excludeBatchId ? { excludeBatchId: opts.excludeBatchId } : {})
      : undefined;
    if (owner) {
      rejected.push({ ticketId, reason: 'already-active', batchId: owner });
      continue;
    }
    ok.push(newBatchTicket(ticketId, ok.length, task.title));
  }
  return { ok, rejected };
}

/**
 * Minimal shape of a raw task-store record this function reads (`tasksCache` stays `any` —
 * task-store.ts, out of scope here); this narrows the parameter so the field-by-field projection
 * below is actually type-checked.
 */
interface RawTaskRecord {
  id: unknown;
  title?: unknown;
  status?: unknown;
  tags?: unknown;
  body?: unknown;
  subtasks?: unknown;
  parentId?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Map a raw task-store record to the structural subset the builder needs. */
export function toBuildCandidate(task: RawTaskRecord): BuildCandidate {
  const c: BuildCandidate = { id: typeof task.id === 'string' ? task.id : String(task.id) };
  if (typeof task.title === 'string') c.title = task.title;
  if (typeof task.status === 'string') c.status = task.status;
  if (isStringArray(task.tags)) c.tags = task.tags;
  if (typeof task.body === 'string') c.body = task.body;
  if (isStringArray(task.subtasks)) c.subtasks = task.subtasks;
  if (typeof task.parentId === 'string') c.parentId = task.parentId;
  return c;
}

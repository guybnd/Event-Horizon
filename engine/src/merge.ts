import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';
import { tasksCache, updateTaskWithHistory } from './task-store.js';
import { configCache } from './config.js';
import { readTurns } from './transcript.js';
import { appendCurationOp, readCurationOps, streamsWithDerivedView, type MergeOp } from './curation-ops.js';

/**
 * FLUX-657: the `merge` curation verb — fold several chat-streams/tickets into ONE survivor
 * effort. The inverse of extract (FLUX-656): extract carves a slice *out* into a new card;
 * merge folds whole streams *in* to an existing one. This is the shared engine entrypoint
 * behind BOTH the `merge_tickets` MCP tool and the board-rebase `fold` executor, so the
 * fold→survivor path exists exactly once.
 *
 * Merge is ADDITIVE and un-doable: no source turns are moved or deleted. The survivor's
 * transcript is RE-DERIVED by gathering every `from` stream's turns chronologically via a
 * single `merge` op in the curation op-log (see `gatherTurnsForView` in transcript.ts) —
 * nothing is copied, so removing the op reverts the view. Each `from` ticket is then
 * tombstoned (a `mergedInto` frontmatter pointer + a pinned tombstone comment) and archived;
 * none are deleted and their original transcripts stay intact in the substrate.
 *
 * "The orchestrator proposes, never silently restructures": this is reached only through the
 * human-approved board-rebase `fold` ritual or a direct call that hits the FLUX-605 CONFIRM gate.
 */

export interface MergeTicketsOptions {
  /** Survivor ticket the sources fold into. */
  into: string;
  /** Source ticket/stream ids folded into the survivor. */
  from: string[];
  /** Actor recorded on the op + tombstones (default `Agent`). */
  by?: string;
}

export interface MergeTicketsResult {
  into: string;
  /** The source ids actually folded (post-dedup). */
  merged: string[];
  /** Total turns folded in from all `from` streams (the survivor's own turns not counted). */
  turnsFolded: number;
  /** Sources that failed their tombstone/archive side-effect (op already recorded — view folds
   *  regardless; these can be re-archived). Empty on a fully clean merge. */
  archiveFailures: string[];
}

/**
 * Fold `from[]` into `into`. Validates every id/guard BEFORE appending the op or mutating any
 * ticket (AC: no partial state on a guard failure), then: appends one `merge` op, and for each
 * `from` sets a `mergedInto` pointer + a pinned tombstone comment and archives it. Throws on a
 * guard violation (unknown id, empty `from`, self-merge, or an already-merged source).
 */
export async function mergeTickets(opts: MergeTicketsOptions): Promise<MergeTicketsResult> {
  const into = opts.into;
  const by = opts.by || 'Agent';

  // ── Guards (no partial state): validate everything before the op append / any mutation ──
  if (!into || !into.trim()) throw new Error('merge: a survivor `into` ticket id is required');
  if (!tasksCache[into]) throw new Error(`merge: survivor ${into} not found`);
  if (!Array.isArray(opts.from) || opts.from.length === 0) {
    throw new Error('merge: at least one `from` source is required');
  }

  // Build the op-log sets the chaining guards need (one read, used for both `into` and `from`).
  // The op-log is the source of truth for re-derivability.
  const ops = await readCurationOps();
  // (1) Streams already folded *away* as a merge source (re-folding double-tombstones them).
  const mergedAwaySources = new Set<string>();
  for (const op of ops) {
    if (op.op === 'merge' && Array.isArray(op.from)) for (const f of op.from) mergedAwaySources.add(f);
  }
  // (2) Streams whose VIEW ≠ substrate — any curation op's `into`: a prior merge survivor OR an
  // extracted card. `gatherTurnsForView` folds a source by its *substrate* alone (it composes no
  // ops on a source), so folding such a stream would silently drop its re-derived turns. One shared
  // predicate feeds this guard and the fold loop in transcript.ts, so a future re-deriving op-kind
  // can't reopen the gap (FLUX-657 review — generalizes the old merge-only `priorSurvivors` set,
  // which left extract targets unguarded).
  const derivedViewSources = streamsWithDerivedView(ops);

  // Survivor must be live: refuse folding into a card that was itself already merged away (it
  // carries a `mergedInto` redirect / sits in a prior op.from). Its own view redirects elsewhere,
  // so new sources folded here would never surface in the effort the redirect points at — turns
  // silently orphaned. (A prior *survivor* as `into` is fine — that's how you add more sources to
  // an existing effort; each source is read from its own substrate.) — FLUX-657 chaining guard.
  if (mergedAwaySources.has(into) || tasksCache[into].mergedInto) {
    throw new Error(
      `merge: survivor ${into} is itself already merged away into ` +
        `${tasksCache[into].mergedInto ?? 'another effort'}; fold into the live survivor instead`,
    );
  }

  // Dedupe while preserving order; reject self-merge and unknown sources up front.
  const from: string[] = [];
  for (const f of opts.from) {
    if (!f || !f.trim()) throw new Error('merge: a `from` source id is empty');
    if (f === into) throw new Error(`merge: cannot merge ${into} into itself (into ∈ from)`);
    if (from.includes(f)) continue; // dedupe a repeated source — fold it once
    if (!tasksCache[f]) throw new Error(`merge: source ${f} not found`);
    from.push(f);
  }

  // Refuse a source that was already folded by a prior merge op OR already carries a `mergedInto`
  // pointer (re-merging it would double-tombstone and confuse the redirect), AND refuse a source
  // whose view is re-derived from the op-log — a prior merge *survivor* or an *extracted* card.
  // `gatherTurnsForView` folds a source by reading its *substrate* turns, not its re-derived view,
  // so folding such a stream would silently drop the turns it only shows via an op (a survivor's
  // folded-in turns, an extract target's seeded slice). Re-merge / re-promote those original
  // sources directly into `into` instead.
  for (const f of from) {
    if (mergedAwaySources.has(f)) throw new Error(`merge: source ${f} is already merged into another effort`);
    if (derivedViewSources.has(f)) {
      throw new Error(
        `merge: source ${f} has a re-derived view — it is a prior merge survivor or an extracted ` +
          `card whose turns come from the curation op-log, not its own substrate; folding it reads ` +
          `only the substrate and would silently drop those turns — re-merge or re-promote its ` +
          `original sources directly into ${into}`,
      );
    }
    if (tasksCache[f].mergedInto) {
      throw new Error(`merge: source ${f} is already merged into ${tasksCache[f].mergedInto}`);
    }
  }

  // Count the turns being folded (also the per-stream substrate read; a source with no
  // transcript yet folds 0 turns, which is valid).
  let turnsFolded = 0;
  for (const f of from) turnsFolded += (await readTurns(f)).length;

  // ── Append the single durable fact FIRST: the survivor's folded view is re-derivable from
  //    substrate + this op, independent of the cosmetic archive side-effects below. ──
  const op: MergeOp = {
    op: 'merge',
    id: randomUUID(),
    into,
    from,
    by,
    ts: new Date().toISOString(),
  };
  await appendCurationOp(op);

  // The survivor's transcript view now re-derives the folded streams from substrate + op-log.
  broadcastEvent('taskUpdated', { id: into });

  // ── Tombstone + archive each source (best-effort: the merge op already stands, so a failure
  //    here leaves the view correctly folded; the source can be re-archived). ──
  const archiveStatus = configCache.archiveStatus || 'Archived';
  const archiveFailures: string[] = [];
  for (const f of from) {
    const task = tasksCache[f];
    const tombstone =
      `🔗 Merged into ${into}. This ticket's chat was folded into the survivor effort; its turns are ` +
      `preserved in the immutable substrate and now re-derive in ${into}'s view. Reversible — the merge ` +
      `is one op in the curation op-log, so removing it restores this card.`;
    const extraFields: Record<string, any> = { mergedInto: into };
    if (task?.swimlane) extraFields.swimlane = null; // drop any stale blocked flag on the tombstone
    const result = await updateTaskWithHistory(f, {
      entries: [{ type: 'comment', user: by, comment: tombstone, pin: true, date: new Date().toISOString() }],
      updatedBy: by,
      nextStatus: archiveStatus,
      extraFields,
    }).catch(() => null);
    if (!result) {
      archiveFailures.push(f);
      continue;
    }
    broadcastEvent('taskUpdated', { id: f });
  }

  return { into, merged: from, turnsFolded, archiveFailures };
}

import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';
import { createTask, deleteTask, tasksCache, updateTaskWithHistory } from './task-store.js';
import { configCache } from './config.js';
import { sliceTurns } from './transcript.js';
import { appendCurationOp, type ExtractOp } from './curation-ops.js';
import { BOARD_CONVERSATION_ID } from './agents/board.js';

/**
 * FLUX-656: the `extract` curation verb — carve a topic-slice out of a conversation stream
 * (the orchestrator thread `__board__` by default) and seed a NEW ticket with those turns.
 * This is the shared engine entrypoint behind BOTH the `extract_ticket` MCP tool and the
 * board-rebase `promote` executor, so the slice→card path exists exactly once.
 *
 * Extract is ADDITIVE and un-doable: the source turns are never moved or deleted. The new
 * card's transcript is RE-DERIVED by gathering the referenced slice via an `extract` op in
 * the curation op-log (see `readTranscriptMessages` in transcript.ts) — nothing is copied,
 * so removing the op reverts the view. "The orchestrator proposes, never silently
 * restructures": this is reached only through the human-approved board-rebase ritual or a
 * direct call that hits the FLUX-605 CONFIRM gate.
 *
 * ONE EXCEPTION (FLUX-1249): when the source is a `kind:"scratch"` disposable scratchpad,
 * promotion CONSUMES it — the scratch is tombstoned + archived after the new card is minted,
 * mirroring how `mergeTickets` consumes its sources. A scratch is disposable, so leaving it
 * live would surface every new scratch turn in BOTH cards. Archiving (never deleting) keeps
 * the promoted card's live re-derivation intact — `sliceTurns` reads the substrate transcript,
 * which a status change does not touch. Promoting any non-scratch source stays purely additive.
 */

/** The orchestrator stream id — the default source stream for an extract. (FLUX-904: now the
 *  single `BOARD_CONVERSATION_ID` from the dependency-free agents/board.ts seam.) */
const DEFAULT_SOURCE_STREAM = BOARD_CONVERSATION_ID;

export interface ExtractTicketOptions {
  /** Source stream the slice is carved from (default `__board__`). */
  from?: string;
  /** Inclusive seq range of the topic-slice on the source stream. */
  fromSeq: number;
  toSeq: number;
  title: string;
  priority?: string;
  effort?: string;
  tags?: string[];
  body?: string;
  /** Actor recorded on the op (default `Agent`). */
  by?: string;
}

export interface ExtractTicketResult {
  id: string;
  title: string;
  turnsExtracted: number;
  /** FLUX-1249: true when the source was a `kind:"scratch"` scratchpad that was consumed
   *  (tombstoned + archived) by this promote. Absent/false for a non-scratch source. */
  sourceConsumed?: boolean;
  /** FLUX-1249: set when the best-effort scratch-consume failed (the promote still stands —
   *  new card + op-log are durable; the scratch can be re-archived). */
  consumeError?: string;
}

/**
 * Carve `[fromSeq..toSeq]` out of `from` into a new ticket. Validates the range/source and
 * that the slice is non-empty BEFORE creating any ticket (AC5 — no partial state), then:
 * creates the card (`createTask`), appends one `extract` op, broadcasts `taskUpdated` for the
 * new id, and returns `{ id, title, turnsExtracted }`. Throws on a bad range / empty slice.
 */
export async function extractTicket(opts: ExtractTicketOptions): Promise<ExtractTicketResult> {
  const from = opts.from || DEFAULT_SOURCE_STREAM;
  const { fromSeq, toSeq, title } = opts;

  // ── Guards (AC5): reject before createTask so a bad request never creates a ticket ──
  if (!title || !title.trim()) throw new Error('extract: a title is required');
  if (typeof fromSeq !== 'number' || typeof toSeq !== 'number' || !Number.isFinite(fromSeq) || !Number.isFinite(toSeq)) {
    throw new Error('extract: fromSeq and toSeq must be finite numbers');
  }
  if (fromSeq > toSeq) throw new Error(`extract: inverted range (fromSeq ${fromSeq} > toSeq ${toSeq})`);

  // Resolve the slice from the source substrate. An unknown stream or an out-of-bounds range
  // both yield an empty slice → a clear error, still no ticket created.
  const slice = await sliceTurns(from, fromSeq, toSeq);
  if (slice.length === 0) {
    throw new Error(`extract: no turns in range [${fromSeq}..${toSeq}] of "${from}"`);
  }

  const by = opts.by || 'Agent';
  const { id, task } = await createTask({
    title,
    author: by,
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });

  const op: ExtractOp = {
    op: 'extract',
    id: randomUUID(),
    into: id,
    from,
    fromSeq,
    toSeq,
    by,
    ts: new Date().toISOString(),
  };
  // FLUX-738: the card now exists but nothing references it yet. If persisting the
  // `extract` op fails (disk full, EACCES, …) the card would be ORPHANED — present on the
  // board but with an empty re-derived view, the slice silently lost. Compensate by
  // hard-deleting the just-created card before rethrowing, leaving zero partial state
  // (safe: no op references it, so a plain delete fully reverts the createTask above).
  try {
    await appendCurationOp(op);
  } catch (err) {
    await deleteTask(id).catch(() => {});
    throw err;
  }

  // The new card's transcript view now re-derives the slice from substrate + op-log.
  broadcastEvent('taskUpdated', { id });

  // FLUX-1249: consume a promoted SCRATCH source. A scratch is disposable, so leaving it live
  // would surface every new scratch turn in BOTH cards (the extract op re-derives the slice
  // live on each read). Tombstone + archive it the same way `mergeTickets` consumes its sources
  // — but ONLY for a `kind:"scratch"` source; promoting `__board__`/a real ticket slice stays
  // purely additive (the kind guard is inherently safe, no opt-in flag needed). Best-effort: the
  // extract op already stands, so a failure here leaves the promoted card intact — surface it in
  // the result rather than undoing the promote. Archiving (never deleting) keeps the promoted
  // card's live re-derivation intact: `sliceTurns` reads the substrate transcript, untouched by
  // a status change (do NOT switch to `deleteTask` — that fs.unlinks the card).
  let sourceConsumed = false;
  let consumeError: string | undefined;
  if (tasksCache[from]?.kind === 'scratch') {
    try {
      const archiveStatus = configCache.archiveStatus || 'Archived';
      const tombstone =
        `🔗 Promoted into ${id}. This scratch chat was consumed by promotion; its turns are ` +
        `preserved in the immutable substrate and now re-derive in ${id}'s view. A scratch is ` +
        `disposable, so promotion takes the whole thing — exactly one live card remains.`;
      const extraFields: Record<string, unknown> = { mergedInto: id };
      if (tasksCache[from]?.swimlane) extraFields.swimlane = null; // drop any stale blocked flag
      const result = await updateTaskWithHistory(from, {
        entries: [{ type: 'comment', user: by, comment: tombstone, pin: true, date: new Date().toISOString() }],
        updatedBy: by,
        nextStatus: archiveStatus,
        extraFields,
      });
      if (result) {
        sourceConsumed = true;
        broadcastEvent('taskUpdated', { id: from });
      } else {
        consumeError = `failed to archive scratch source ${from}`;
      }
    } catch (err) {
      consumeError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    id,
    title: task.title,
    turnsExtracted: slice.length,
    ...(sourceConsumed ? { sourceConsumed: true } : {}),
    ...(consumeError ? { consumeError } : {}),
  };
}

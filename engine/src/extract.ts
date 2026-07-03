import { randomUUID } from 'crypto';
import { broadcastEvent } from './events.js';
import { createTask, deleteTask } from './task-store.js';
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

  return { id, title: task.title, turnsExtracted: slice.length };
}

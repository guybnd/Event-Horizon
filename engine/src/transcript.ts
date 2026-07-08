import { promises as fs } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import {
  type Turn,
  type TranscriptMessage,
  type TurnRole,
  classifyRole,
  projectTranscript,
} from './projection.js';
import { readCurationOps, type CurationOpEntry } from './curation-ops.js';

export type { Turn, TranscriptMessage } from './projection.js';

/**
 * FLUX-602 / FLUX-658: durable per-ticket conversation transcript — the immutable,
 * append-only RAW substrate of record (see FLUX-601 and
 * `.docs/event-horizon/architecture/substrate-vs-projection.md`). One JSONL file per
 * stream (`<streamId>.jsonl`), stored alongside assets/ and read-state.json inside the
 * active flux dir (same convention as getTaskAssetsDir / getReadStateFile in
 * workspace.ts). `streamId` is the conversation id — a ticket id or the board sentinel.
 *
 * Each line is one **turn envelope** (FLUX-658):
 *   { v, turnId, streamId, seq, ts, role, raw }
 * where `raw` is the original event — either a synthetic user/ask turn
 * ({ type: 'user', text, timestamp }) or a raw streamed event from the spawning agent CLI (any
 * adapter's JSONL — Claude's stream-json, Copilot/Gemini event lines, etc.), stored verbatim. The
 * format is generic JSONL, not Claude-specific. The envelope adds stable addressing (a monotonic per-stream `seq` and
 * `turnId = ${streamId}:${seq}`) without rewriting `raw`, so turns are sliceable
 * (`readTurns` / `sliceTurns`) — the primitives the curation verbs will call. Legacy
 * lines written before the envelope existed are still read losslessly (see `readTurns`).
 *
 * This is the local-first, in-repo record that outlives the CLI's own session store and
 * powers cold resume: after an engine restart wipes the in-memory session, the board start
 * path re-primes a fresh CLI session from the captured turns (`board-reprime.ts`, FLUX-838).
 * The board view is a re-derivable projection of it (`projectTranscript`), not an independent
 * store.
 */

export function getTranscriptDir(): string {
  return path.join(getActiveFluxDir(), 'transcripts');
}

export function getTranscriptFile(taskId: string): string {
  return path.join(getTranscriptDir(), `${taskId}.jsonl`);
}

/**
 * FLUX-833 review (M4): is `id` safe to use as a transcript stream id, i.e. a single path segment
 * that becomes `${id}.jsonl` inside transcripts/? A stream id is a ticket id or the `__board__`
 * sentinel; both are plain `[A-Za-z0-9_.-]` tokens. This rejects path separators and `..` so an
 * agent-supplied `conversationId` (taken off the permission/ask POST body) can't escape the
 * transcripts dir via traversal. This is path-safety ONLY: a *valid sibling ticket id* is the same
 * shape and passes here. The same-shape cross-ticket injection it can't stop is closed separately by
 * the session→ticket binding token (session-binding.ts, FLUX-841) — the HITL route honors a
 * conversationId only when the request also carries the requesting session's own valid binding
 * token, which it can't forge for a sibling.
 */
export function isSafeStreamId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128
    && /^[A-Za-z0-9_.-]+$/.test(id) && !id.includes('..') && !id.startsWith('.');
}

/** Envelope schema version written to disk (FLUX-658). */
const ENVELOPE_VERSION = 1;

// Serialize appends per stream so concurrent transcript (JSONL) lines never interleave.
const writeQueues = new Map<string, Promise<void>>();
// Monotonic per-stream line count — the next turn's `seq`. Lazily seeded from the file on
// first append in this process (so seq survives restarts and continues past legacy lines).
const lineCounts = new Map<string, number>();

/** Count the non-empty lines already in a transcript file (0 if it doesn't exist yet). */
async function countLines(file: string): Promise<number> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw err;
  }
}

/** Extract a raw event's `timestamp` field if it's a string, else undefined. */
function rawTimestamp(raw: unknown): string | undefined {
  const value = (raw as { timestamp?: unknown } | null | undefined)?.timestamp;
  return typeof value === 'string' ? value : undefined;
}

/** Best-effort envelope timestamp: the event's own `timestamp` if present, else now. */
function envelopeTs(raw: unknown): string {
  return rawTimestamp(raw) ?? new Date().toISOString();
}

/** Wrap a raw event in a turn envelope and append it as one JSONL line. The seq is
 *  assigned inside the serialized queue so it is strictly monotonic per stream. */
function appendEnveloped(streamId: string, raw: unknown): void {
  const file = getTranscriptFile(streamId);
  const prev = writeQueues.get(streamId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await fs.mkdir(getTranscriptDir(), { recursive: true });
      let count = lineCounts.get(streamId);
      if (count === undefined) {
        count = await countLines(file);
        lineCounts.set(streamId, count);
      }
      const seq = count;
      const envelope = {
        v: ENVELOPE_VERSION,
        turnId: `${streamId}:${seq}`,
        streamId,
        seq,
        ts: envelopeTs(raw),
        role: classifyRole(raw),
        raw,
      };
      await fs.appendFile(file, JSON.stringify(envelope) + '\n', 'utf8');
      lineCounts.set(streamId, seq + 1);
    })
    .catch((err) => {
      console.error(`[transcript] failed to append for ${streamId}:`, err);
    });
  writeQueues.set(streamId, next);
}

/** Append a single pre-serialized JSONL line (the raw stream-json from the CLI). The line
 *  is parsed back to its event object and wrapped in a turn envelope; an unparseable line
 *  is preserved verbatim as the envelope's `raw` so nothing is ever dropped. */
export function appendTranscriptLine(taskId: string, line: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    raw = line; // preserve the original text losslessly
  }
  appendEnveloped(taskId, raw);
}

/** Append a structured event (e.g. a synthetic user turn) as one enveloped JSONL line. */
export function appendTranscriptEvent(taskId: string, event: unknown): void {
  appendEnveloped(taskId, event);
}

/** Clear a conversation's transcript (delete the JSONL). Serialized behind any in-flight
 *  appends so it can't race a concurrent write; a missing file counts as already-clear. This
 *  backs the orchestrator "reset" — wiping the durable record so the chat starts fresh. */
export async function clearTranscript(taskId: string): Promise<void> {
  const file = getTranscriptFile(taskId);
  const prev = writeQueues.get(taskId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      await fs.unlink(file);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err; // a real unlink failure (EBUSY/EPERM) — file still on disk
    }
    // FLUX-917: reset the seq counter only when the file is actually gone (unlink succeeded or it was
    // already absent). Previously this lived in a `finally`, so a real unlink failure still deleted
    // the count — leaving lineCounts inconsistent with the on-disk file (it self-healed via re-seed,
    // but only accidentally). Reached only when the try above did not re-throw.
    lineCounts.delete(taskId);
  });
  // Keep the queue chain alive even if this rejects, so later appends still serialize.
  writeQueues.set(taskId, next.catch(() => {}));
  await next;
}

/** Await all in-flight appends for a stream (the per-stream write queue drains in order,
 *  so awaiting the latest covers every prior append). Used by tests and clean shutdown. */
export async function flushTranscript(taskId: string): Promise<void> {
  await (writeQueues.get(taskId) ?? Promise.resolve());
}

/** Read the raw transcript lines for a ticket (empty array if none yet). */
export async function readTranscript(taskId: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(getTranscriptFile(taskId), 'utf8');
    return raw.split('\n').filter((l) => l.trim());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

/** True iff a parsed line is a turn envelope (vs a bare legacy raw event). The trio of a
 *  string `turnId`, numeric `seq`, and a `raw` field never appears on raw stream-json or
 *  synthetic events, so the discriminator is unambiguous and intentionally `v`-independent:
 *  a future v2 envelope will still carry turnId+seq+raw, so the trio remains stable across
 *  schema versions without a version-aware read branch. If a v2 shape ever removes one of
 *  these three fields, add an explicit `o.v === ENVELOPE_VERSION` guard here. */
interface EnvelopeLine {
  turnId: string;
  streamId?: unknown;
  seq: number;
  ts?: unknown;
  role?: unknown;
  raw: unknown;
}

function isEnvelope(o: unknown): o is EnvelopeLine {
  if (!o || typeof o !== 'object') return false;
  const rec = o as Record<string, unknown>;
  return typeof rec.turnId === 'string' && typeof rec.seq === 'number' && 'raw' in rec;
}

/** Wrap a legacy (pre-envelope) line into a synthetic turn addressed by its line index. */
function legacyTurn(streamId: string, seq: number, raw: unknown): Turn {
  return {
    turnId: `${streamId}:${seq}`,
    streamId,
    seq,
    ts: rawTimestamp(raw) ?? '',
    role: classifyRole(raw),
    raw,
  };
}

/** Parse one transcript line into a `Turn`. Enveloped lines keep their stored identity;
 *  legacy un-enveloped (or unparseable) lines are wrapped with `legacySeq` as their seq. */
function lineToTurn(streamId: string, line: string, legacySeq: number): Turn {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return legacyTurn(streamId, legacySeq, line); // unparseable — preserve verbatim
  }
  if (isEnvelope(obj)) {
    return {
      turnId: obj.turnId,
      streamId: typeof obj.streamId === 'string' ? obj.streamId : streamId,
      seq: obj.seq,
      ts: typeof obj.ts === 'string' ? obj.ts : '',
      role: (obj.role as TurnRole | undefined) ?? classifyRole(obj.raw),
      raw: obj.raw,
    };
  }
  return legacyTurn(streamId, legacySeq, obj);
}

/**
 * Read the full turn substrate for a stream as addressable `Turn`s. Enveloped lines are
 * returned with their stored identity; legacy un-enveloped lines are wrapped on the fly
 * (seq = line index, `turnId = ${streamId}:${seq}`) so a mixed file reads as one uniform,
 * gap-free seq space — no migration pass required. Order is file order (== seq).
 */
export async function readTurns(streamId: string): Promise<Turn[]> {
  const lines = await readTranscript(streamId);
  return lines.map((line, i) => lineToTurn(streamId, line, i));
}

/**
 * FLUX-856: read only the last `maxLines` non-empty lines of a transcript file, reading at
 * most a bounded tail of the file from the end rather than the whole thing. Reads fixed-size
 * chunks backwards from EOF until `maxLines` complete lines are buffered (or the file start is
 * reached), so cost is O(returned bytes), independent of transcript size. Counting `\n` bytes
 * is UTF-8-safe (0x0A never occurs inside a multibyte sequence); the only line that can be
 * front-truncated by a chunk boundary is the over-read line beyond `maxLines`, which `slice`
 * discards. Missing file → []. This is the bounded read behind cold-resume re-prime.
 */
async function readTailLines(file: string, maxLines: number): Promise<string[]> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (size === 0) return [];
    const CHUNK = 64 * 1024;
    let pos = size;
    let buf = Buffer.alloc(0);
    let newlines = 0;
    // Read backwards until we have one more newline than requested lines (so the first kept
    // line is whole), or we hit the start of the file.
    while (pos > 0 && newlines <= maxLines) {
      const readSize = Math.min(CHUNK, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      await handle.read(chunk, 0, readSize, pos);
      buf = Buffer.concat([chunk, buf]);
      newlines = 0;
      for (const byte of buf) if (byte === 0x0a) newlines++;
    }
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  } finally {
    await handle?.close();
  }
}

/**
 * FLUX-856: read only the last `maxTurns` turns of a stream's substrate, bounding the read to
 * the file tail (see `readTailLines`) instead of parsing the whole transcript. Enveloped lines
 * keep their stored seq; the rare legacy line in the tail gets a best-effort window-relative
 * seq (the absolute line index is unknown without reading the whole file — acceptable because
 * the tail's only consumer, cold-resume re-prime, orders by array position, not seq). Order is
 * preserved (oldest→newest within the window).
 */
export async function tailTurns(streamId: string, maxTurns: number): Promise<Turn[]> {
  const lines = await readTailLines(getTranscriptFile(streamId), maxTurns);
  return lines.map((line, i) => lineToTurn(streamId, line, i));
}

/**
 * FLUX-856: the bounded-tail counterpart of `readTranscriptMessages` — project just the last
 * `maxTurns` of a stream's OWN substrate into chat messages, reading only the file tail. It
 * deliberately skips the cross-stream gather (`gatherTurnsForView`): its sole caller is the
 * board cold-resume re-prime, and the board is only ever an extract *source*, never a
 * destination, so it has no foreign turns to resolve. Use `readTranscriptMessages` for any
 * full, gather-aware view.
 */
export async function tailTranscriptMessages(streamId: string, maxTurns: number): Promise<TranscriptMessage[]> {
  return projectTranscript(await tailTurns(streamId, maxTurns));
}

/**
 * Address a contiguous range of turns by seq: `sliceTurns(streamId, 12, 20)` → turns
 * 12–20 inclusive. Bounds are optional (open-ended either side). This is the primitive
 * the curation verbs (extract/merge) call to carve a sub-conversation out of the
 * substrate. Order is preserved (seq-ascending).
 */
export async function sliceTurns(streamId: string, fromSeq?: number, toSeq?: number): Promise<Turn[]> {
  const lo = fromSeq ?? -Infinity;
  const hi = toSeq ?? Infinity;
  const turns = await readTurns(streamId);
  return turns.filter((t) => t.seq >= lo && t.seq <= hi);
}

/**
 * Deterministic chronological order for a folded (merge) view: by `ts` (ISO strings sort
 * lexicographically), tie-broken by `(streamId, seq)` so timestamp collisions / clock skew
 * across streams never make the order ambiguous (FLUX-657). Legacy turns without a stored `ts`
 * (`''`) sort first, then fall back to the stable stream/seq tie-break.
 */
function compareTurnsChrono(a: Turn, b: Turn): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.streamId !== b.streamId) return a.streamId < b.streamId ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * FLUX-861 (Fix B): bound the recursive fold composition below against a corrupted or
 * race-created op-log cycle that slipped past `mergeTickets`'s write-time cycle check
 * (`reachableFoldSources` in curation-ops.ts) — deep enough for any real curation chain a human
 * would ever build by hand, shallow enough to never blow the stack.
 */
const MAX_FOLD_DEPTH = 32;

/**
 * Gather the full turn list for a stream's VIEW: its own substrate turns, plus any turns
 * folded in by a curation op. Two op kinds contribute:
 *
 * - `extract` (FLUX-656): a `[fromSeq..toSeq]` SLICE of another stream carved INTO this card.
 *   `readCurationOps()` finds the ops whose `into === taskId`; each range is fetched via
 *   `sliceTurns(from, …)` from its *source* substrate and prepended in op order, ahead of the
 *   card's own turns.
 * - `merge` (FLUX-657/861): one or more WHOLE source streams folded into this survivor. Each
 *   `from` stream is folded by its own re-derived VIEW — recursing into this same resolution,
 *   not just reading its substrate (FLUX-861 Fix B; see `resolveStreamView` below) — then unioned
 *   with the survivor's own turns and ordered CHRONOLOGICALLY by `ts` (tie-break `(streamId,
 *   seq)`) — the natural reading of "fold three chats into one effort." Foreign turns keep their
 *   own `streamId`, so the projector tags them with a `sourceStream` attribution when handed
 *   `homeStreamId = taskId`.
 *
 * Both gathered slices and folded streams are ADDITIVE — the source substrate is never touched,
 * so removing the op reverts the view (the un-doable guarantee the epic rests on). This is the
 * cross-stream RESOLUTION layer; it lives in the reader so `projectTranscript` stays pure over a
 * flat turn list. Returns the gathered turns and the op-log (so the caller can hand both to the
 * projector).
 *
 * Accepts an optional pre-fetched `ops` for a caller that already read the op-log for its own
 * guards in the same call (e.g. `mergeTickets`) — skips the redundant re-read per source.
 */
export async function gatherTurnsForView(
  taskId: string,
  ops?: CurationOpEntry[],
): Promise<{ turns: Turn[]; ops: CurationOpEntry[] }> {
  const resolvedOps = ops ?? (await readCurationOps());
  const turns = await resolveStreamView(taskId, resolvedOps, new Set(), 0);
  return { turns, ops: resolvedOps };
}

/**
 * FLUX-861 (Fix B): recursive worker behind `gatherTurnsForView`. `ancestors` is the set of
 * stream ids already being resolved higher up this call chain, and `depth` the recursion depth —
 * both exist purely as a defense-in-depth backstop. `mergeTickets` rejects, at write time, any new
 * merge op that would make `into` reachable from one of its `from` sources (`reachableFoldSources`
 * in curation-ops.ts), so a genuine cycle should never reach this function; if one does anyway (a
 * hand-edited op-log, or two merges racing past the write-time check), `ancestors`/`depth` stop the
 * recursion instead of looping forever, falling back to the offending stream's plain substrate for
 * that one branch rather than throwing mid-read.
 */
async function resolveStreamView(
  taskId: string,
  ops: CurationOpEntry[],
  ancestors: ReadonlySet<string>,
  depth: number,
): Promise<Turn[]> {
  const extractedHere = ops.filter(
    (o): o is Extract<typeof o, { op: 'extract' }> => o.op === 'extract' && o.into === taskId,
  );
  const gathered: Turn[] = [];
  for (const op of extractedHere) {
    const slice = await sliceTurns(op.from, op.fromSeq, op.toSeq);
    gathered.push(...slice);
  }
  const own = await readTurns(taskId);

  // FLUX-657: fold every `from` stream of every merge op targeting this survivor. Dedupe source
  // ids across ops so re-merging the same stream can't double-fold its turns.
  const foldedFrom = new Set<string>();
  for (const op of ops) {
    if (op.op === 'merge' && op.into === taskId && Array.isArray(op.from)) {
      for (const f of op.from) if (f && f !== taskId) foldedFrom.add(f);
    }
  }
  if (foldedFrom.size === 0) {
    // No merge folding — preserve extract's exact ordering (gathered slices ahead of own turns).
    return [...gathered, ...own];
  }
  // FLUX-861: a source is now folded by its own re-derived VIEW (recursing into
  // `resolveStreamView`), NOT its raw substrate — folds compose, so a prior merge survivor or an
  // extracted card carries its own folded-in/gathered turns through instead of dropping them.
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(taskId);
  const folded: Turn[] = [];
  for (const f of foldedFrom) {
    if (ancestors.has(f) || depth >= MAX_FOLD_DEPTH) {
      folded.push(...(await readTurns(f)));
      continue;
    }
    folded.push(...(await resolveStreamView(f, ops, nextAncestors, depth + 1)));
  }
  // Merge the folded foreign turns into the survivor's OWN turns chronologically WITHOUT reordering
  // own turns among themselves: own keeps its substrate (seq) order, and each folded turn is placed
  // at the first own turn it chronologically precedes. A global re-sort would let a survivor's own
  // turns reorder (e.g. legacy turns with `ts === ''` floating to the front) purely because the card
  // became a merge target; this stable insertion keeps own's order invariant (FLUX-657 review).
  // Folded turns (including anything a recursed source itself gathered/folded) are chrono-sorted
  // among themselves first. Extract slices (if any also target this card) still prepend in op
  // order, ahead of the chronological body.
  folded.sort(compareTurnsChrono);
  const union: Turn[] = [];
  let fi = 0;
  for (const o of own) {
    while (fi < folded.length && compareTurnsChrono(folded[fi]!, o) <= 0) {
      union.push(folded[fi++]!);
    }
    union.push(o);
  }
  while (fi < folded.length) union.push(folded[fi++]!);
  return [...gathered, ...union];
}

/**
 * Parse the substrate into ordered chat messages for the portal. A thin adapter over the
 * substrate→view projection (FLUX-658): gather the turns (the card's own + any extracted
 * slice, FLUX-656), then run the pure `projectTranscript`. `taskId` is passed as the home
 * stream so foreign (extracted) turns render with a `sourceStream` attribution. The rendered
 * transcript stays a function of the substrate + op-log, not an independent store.
 */
export async function readTranscriptMessages(taskId: string): Promise<TranscriptMessage[]> {
  // FLUX-910: drain any queued appends for this stream before reading. appendTranscriptEvent is
  // fire-and-forget, and append-then-broadcast sites (the user-turn /start, the dispatch tee) emit
  // taskUpdated BEFORE the write lands — so a refetch that broadcast triggers could otherwise read a
  // transcript missing the just-appended turn (the post-send "my message vanished" race + the tee's
  // structural self-race). Flushing here makes the live view read-after-write consistent.
  await flushTranscript(taskId);
  const { turns, ops } = await gatherTurnsForView(taskId);
  return projectTranscript(turns, ops, taskId);
}

import { promises as fs } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import {
  type Turn,
  type TranscriptMessage,
  classifyRole,
  projectTranscript,
} from './projection.js';

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
 * ({ type: 'user', text, timestamp }) or a raw stream-json event from the `claude` CLI,
 * stored verbatim. The envelope adds stable addressing (a monotonic per-stream `seq` and
 * `turnId = ${streamId}:${seq}`) without rewriting `raw`, so turns are sliceable
 * (`readTurns` / `sliceTurns`) — the primitives the curation verbs will call. Legacy
 * lines written before the envelope existed are still read losslessly (see `readTurns`).
 *
 * This is the local-first, in-repo record that outlives the CLI's own session store and
 * powers cold resume (re-priming a fresh CLI session from the captured turns). The board
 * view is a re-derivable projection of it (`projectTranscript`), not an independent store.
 */

export function getTranscriptDir(): string {
  return path.join(getActiveFluxDir(), 'transcripts');
}

export function getTranscriptFile(taskId: string): string {
  return path.join(getTranscriptDir(), `${taskId}.jsonl`);
}

/** Envelope schema version written to disk (FLUX-658). */
const ENVELOPE_VERSION = 1;

// Serialize appends per stream so concurrent stream-json lines never interleave.
const writeQueues = new Map<string, Promise<void>>();
// Monotonic per-stream line count — the next turn's `seq`. Lazily seeded from the file on
// first append in this process (so seq survives restarts and continues past legacy lines).
const lineCounts = new Map<string, number>();

/** Count the non-empty lines already in a transcript file (0 if it doesn't exist yet). */
async function countLines(file: string): Promise<number> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

/** Best-effort envelope timestamp: the event's own `timestamp` if present, else now. */
function envelopeTs(raw: any): string {
  return typeof raw?.timestamp === 'string' ? raw.timestamp : new Date().toISOString();
}

/** Wrap a raw event in a turn envelope and append it as one JSONL line. The seq is
 *  assigned inside the serialized queue so it is strictly monotonic per stream. */
function appendEnveloped(streamId: string, raw: any): void {
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
  let raw: any;
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
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    } finally {
      // Reset the seq counter so a fresh transcript starts at seq 0.
      lineCounts.delete(taskId);
    }
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
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

/** True iff a parsed line is a turn envelope (vs a bare legacy raw event). The trio of a
 *  string `turnId`, numeric `seq`, and a `raw` field never appears on raw stream-json or
 *  synthetic events, so the discriminator is unambiguous. */
function isEnvelope(o: any): boolean {
  return !!o && typeof o === 'object' && typeof o.turnId === 'string' && typeof o.seq === 'number' && 'raw' in o;
}

/** Wrap a legacy (pre-envelope) line into a synthetic turn addressed by its line index. */
function legacyTurn(streamId: string, seq: number, raw: any): Turn {
  return {
    turnId: `${streamId}:${seq}`,
    streamId,
    seq,
    ts: typeof raw?.timestamp === 'string' ? raw.timestamp : '',
    role: classifyRole(raw),
    raw,
  };
}

/**
 * Read the full turn substrate for a stream as addressable `Turn`s. Enveloped lines are
 * returned with their stored identity; legacy un-enveloped lines are wrapped on the fly
 * (seq = line index, `turnId = ${streamId}:${seq}`) so a mixed file reads as one uniform,
 * gap-free seq space — no migration pass required. Order is file order (== seq).
 */
export async function readTurns(streamId: string): Promise<Turn[]> {
  const lines = await readTranscript(streamId);
  const turns: Turn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      turns.push(legacyTurn(streamId, i, line)); // unparseable — preserve verbatim
      continue;
    }
    if (isEnvelope(obj)) {
      turns.push({
        turnId: obj.turnId,
        streamId: typeof obj.streamId === 'string' ? obj.streamId : streamId,
        seq: obj.seq,
        ts: typeof obj.ts === 'string' ? obj.ts : '',
        role: obj.role ?? classifyRole(obj.raw),
        raw: obj.raw,
      });
    } else {
      turns.push(legacyTurn(streamId, i, obj));
    }
  }
  return turns;
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
 * Parse the substrate into ordered chat messages for the portal. This is now a thin
 * adapter over the substrate→view projection (FLUX-658): read the turns, then run the
 * pure `projectTranscript`. The rendered transcript is provably a function of the
 * substrate, not an independent store — no user-visible change.
 */
export async function readTranscriptMessages(taskId: string): Promise<TranscriptMessage[]> {
  const turns = await readTurns(taskId);
  return projectTranscript(turns);
}

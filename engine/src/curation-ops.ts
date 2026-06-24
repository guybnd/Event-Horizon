import { promises as fs } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import { type CurationOp } from './projection.js';

/**
 * FLUX-656: the curation op-log STORE. FLUX-658 shipped the projection *seam* —
 * `projectTranscript(turns, ops?)` accepts an append-only op-log — but nothing read or
 * wrote that log. This module is that persistence: an append-only JSONL at
 * `<fluxDir>/transcripts/_curation-ops.jsonl`, where the curation verbs (extract here,
 * merge in FLUX-657) record their structuring operations over the immutable turn
 * substrate (see `.docs/event-horizon/architecture/substrate-vs-projection.md`).
 *
 * Why a log, not a mutation: the substrate is never edited, so every verb is additive and
 * un-doable — remove the op and the view reverts. Extract lands first, so it creates this
 * store; merge REUSES it (same file path, same append/read helpers, same source-attribution
 * convention) so `board-rebase.ts` can drive both verbs uniformly. Keep the shapes co-designed.
 */

/**
 * The `extract` op (FLUX-656): a topic-slice `[fromSeq..toSeq]` of source stream `from`
 * (default `__board__`) was carved into a NEW ticket `into`. The sliced turns stay in their
 * immutable substrate; the new card's view is RE-DERIVED by gathering this slice (see
 * `readTranscriptMessages` in transcript.ts) — nothing is copied.
 */
export interface ExtractOp extends CurationOp {
  op: 'extract';
  /** Per-op id (the unit a future compensating op would reference). */
  id: string;
  /** New ticket id the slice seeds. */
  into: string;
  /** Source stream the slice is carved from (e.g. `__board__`). */
  from: string;
  fromSeq: number;
  toSeq: number;
  /** Actor who performed the extract. */
  by: string;
  ts: string;
}

/**
 * The union of curation ops persisted in the log. Extract is the only kind today; merge
 * (FLUX-657) adds its own member here so the store stays one shared, typed log. Reads stay
 * tolerant of unknown future kinds (they round-trip as opaque `CurationOp`s in projection.ts).
 */
export type CurationOpEntry = ExtractOp;

/** The append-only op-log file, alongside the per-stream transcripts. */
export function getCurationOpsFile(): string {
  return path.join(getActiveFluxDir(), 'transcripts', '_curation-ops.jsonl');
}

// Serialize appends so concurrent extracts/merges never interleave a JSONL line — same
// write-queue discipline as the transcript substrate (transcript.ts).
let writeQueue: Promise<void> = Promise.resolve();

/** Append one curation op as a JSONL line (serialized). Creates the dir on first write. */
export function appendCurationOp(op: CurationOpEntry): Promise<void> {
  const file = getCurationOpsFile();
  const next = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(op) + '\n', 'utf8');
  });
  // Keep the chain alive even if this append rejects, so later appends still serialize.
  writeQueue = next.catch(() => {});
  return next;
}

/** Read the full append-only op-log (empty array if none yet). Malformed lines are skipped
 *  defensively so one bad line never poisons the whole projection. */
export async function readCurationOps(): Promise<CurationOpEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(getCurationOpsFile(), 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const ops: CurationOpEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      ops.push(JSON.parse(line) as CurationOpEntry);
    } catch {
      // skip an unparseable line rather than throw
    }
  }
  return ops;
}

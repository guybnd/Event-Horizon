import { promises as fs } from 'fs';
import path from 'path';
import { getActiveFluxDir } from './workspace.js';
import { type CurationOp } from './projection.js';

/**
 * FLUX-656: the curation op-log STORE. FLUX-658 shipped the projection *seam* —
 * `projectTranscript(turns, ops?)` accepts an append-only op-log — but nothing read or
 * wrote that log. This module is that persistence: an append-only JSONL at
 * `<fluxDir>/transcripts/_curation-ops.jsonl`, where the curation verbs (extract + merge,
 * FLUX-656 / FLUX-657) record their structuring operations over the immutable turn
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
 * The `merge` op (FLUX-657): several source streams `from[]` were folded into one survivor
 * `into` — "three chats are really one effort." The inverse of extract: extract carves a slice
 * *out* into a new card; merge folds whole streams *in* to an existing one. Like extract it is
 * ADDITIVE — the source turns are never moved or deleted; the survivor's view is RE-DERIVED by
 * gathering every `from` stream's turns chronologically (see `gatherTurnsForView` in
 * transcript.ts), so removing the op reverts the merge. The `from` tickets are tombstoned +
 * archived as a side-effect of the verb, not by this op.
 */
export interface MergeOp extends CurationOp {
  op: 'merge';
  /** Per-op id (the unit a future compensating op would reference). */
  id: string;
  /** Survivor stream the sources fold into. */
  into: string;
  /** Source streams folded into the survivor (each tombstoned + archived). */
  from: string[];
  /** Actor who performed the merge. */
  by: string;
  ts: string;
}

/**
 * The union of curation ops persisted in the log. Extract and merge (FLUX-656 / FLUX-657)
 * share this one typed store. Reads stay tolerant of unknown future kinds (they round-trip as
 * opaque `CurationOp`s in projection.ts).
 */
export type CurationOpEntry = ExtractOp | MergeOp;

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
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
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

/**
 * FLUX-657 (review): the set of stream ids whose rendered VIEW differs from its own SUBSTRATE —
 * i.e. every stream that is the `into` of any curation op. Both verbs produce such a stream:
 * `extract` re-derives a foreign slice into a new card, `merge` folds foreign streams into a
 * survivor. In both cases the stream's transcript is a function of substrate + op-log, NOT just
 * its own `readTurns`.
 *
 * FLUX-861 (Fix B): this no longer gates `mergeTickets`'s source guard — `gatherTurnsForView` now
 * folds a merge source by its own re-derived VIEW (recursing through prior ops), so a stream in
 * this set is a valid `from` source again (promote→fold composes). The predicate itself stays —
 * it's still an accurate answer to "does this stream's transcript depend on the op-log, not just
 * its own substrate" — see `reachableFoldSources` below for the guard that replaced its old use.
 */
export function streamsWithDerivedView(ops: CurationOpEntry[]): Set<string> {
  const derived = new Set<string>();
  for (const op of ops) if (op.into) derived.add(op.into);
  return derived;
}

/**
 * FLUX-861 (Fix B): the "depends on" closure over the curation op-log, starting from `streamId` —
 * every stream whose turns `streamId`'s re-derived VIEW transitively includes. An edge `into ->
 * from` exists for every `extract` op (`into` depends on its single `from`) and every `merge` op
 * (`into` depends on each of its `from[]`).
 *
 * Folding now composes (`gatherTurnsForView` recurses a merge source's own view, not just its
 * substrate), so appending a new `merge` op `into <- from` is only safe if none of the candidate
 * `from` sources already has `into` in this closure — otherwise `into`'s view would end up
 * depending on itself and `gatherTurnsForView` would recurse forever. `mergeTickets` calls this
 * once per candidate source (`reachableFoldSources(ops, f).has(into)`) BEFORE appending the op, so
 * a cycle is rejected with a clear error instead of ever reaching the read path.
 */
export function reachableFoldSources(ops: CurationOpEntry[], streamId: string): Set<string> {
  const edges = new Map<string, string[]>();
  for (const op of ops) {
    if (op.op === 'extract') {
      const list = edges.get(op.into);
      if (list) list.push(op.from);
      else edges.set(op.into, [op.from]);
    } else if (op.op === 'merge' && Array.isArray(op.from)) {
      const list = edges.get(op.into);
      if (list) list.push(...op.from);
      else edges.set(op.into, [...op.from]);
    }
  }
  const seen = new Set<string>();
  const stack = [streamId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const next of edges.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

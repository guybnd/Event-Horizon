// FLUX-1428: durable local op journal that backs push-as-CAS + replay in sync-watcher.ts.
//
// The journal records every non-derived ticket mutation (status changes, comments, body edits,
// swimlane sets — anything human/agent-authored) BEFORE it is applied to disk. When a sync tick's
// push is rejected (the remote moved), the losing engine resets its worktree to the new remote
// head — which discards any local commit that hadn't been pushed yet. Without a durable record of
// what those discarded commits contained, that reset silently drops the write. The journal is that
// record: replay walks it back through the real handler (updateTaskWithHistory), so a mutation lost
// to `reset --hard` is redone against the fresh state instead of vanishing.
//
// Storage: `<storeDir>/sync-journal.jsonl`, one JSON object per line, gitignored (STORE_LOCAL_IGNORES
// in storage-sync.ts) so it is never synced through flux-data and survives `git reset --hard` (which
// only touches tracked files) and `git clean -fd` (which respects .gitignore).
import fs from 'fs/promises';
import path from 'path';
import { log } from './log.js';

export const SYNC_JOURNAL_FILE = 'sync-journal.jsonl';

export interface JournalEntry {
  /** Unique per append — not currently deduplicated on, but useful for log correlation. */
  opId: string;
  taskId: string;
  /** Present only for externally-triggered intents (PR merged, CI verdict) — see updateTaskWithHistory. */
  idempotencyKey?: string;
  ts: string;
  /** The exact options object the original updateTaskWithHistory(taskId, options) call was given. */
  options: Record<string, unknown>;
}

function journalPath(storeDir: string): string {
  return path.join(storeDir, SYNC_JOURNAL_FILE);
}

// FLUX-1428 review fix: appendJournalEntry (called from any request handler, any time) and
// dropFlushedJournalEntries (called from the sync tick) are NOT otherwise serialized against each
// other — serializeTicketWrite only orders writes to the same ticket, not journal-file mutations.
// Without this, dropFlushedJournalEntries' read-slice-write is a classic TOCTOU: an append that
// lands between its read and its write is silently clobbered by the whole-file overwrite. Chaining
// every caller through one promise per storeDir makes the read-modify-write atomic w.r.t. appends.
const journalLocks = new Map<string, Promise<void>>();

function withJournalLock<T>(storeDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = journalLocks.get(storeDir) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  journalLocks.set(
    storeDir,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

/**
 * Durable append: the returned promise only resolves once `entry` is fsync'd to disk. Callers
 * MUST await this before applying the corresponding mutation — that ordering is the entire
 * crash-safety invariant this module exists for (see the file header). A process crash at any
 * point after this resolves can never lose the entry; a crash before it resolves means the
 * mutation itself was never applied either (we haven't gotten there yet), so nothing is lost.
 *
 * Serialized against dropFlushedJournalEntries for the same storeDir — see withJournalLock.
 */
export async function appendJournalEntry(storeDir: string, entry: JournalEntry): Promise<void> {
  return withJournalLock(storeDir, async () => {
    const file = journalPath(storeDir);
    const line = JSON.stringify(entry) + '\n';
    const handle = await fs.open(file, 'a');
    try {
      await handle.appendFile(line, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/** Read every entry currently in the journal, in append order. Missing file reads as empty. */
export async function readJournalEntries(storeDir: string): Promise<JournalEntry[]> {
  const file = journalPath(storeDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.info(`[sync-journal] Skipping unparseable journal line: ${message}`);
    }
  }
  return entries;
}

/**
 * Drop exactly the first `count` entries — the prefix a sync tick snapshotted and successfully
 * pushed. Never a blind truncate: entries appended DURING that tick (after the snapshot was taken,
 * from concurrent request handling) are a suffix of the file that hasn't been pushed yet and must
 * survive to be picked up by the next tick.
 *
 * The internal read-then-write is serialized against appendJournalEntry for the same storeDir (see
 * withJournalLock) — otherwise a concurrent append landing between this function's read and its
 * write would be silently clobbered by the overwrite, discarding an un-pushed mutation.
 */
export async function dropFlushedJournalEntries(storeDir: string, count: number): Promise<void> {
  if (count <= 0) return;
  return withJournalLock(storeDir, async () => {
    const entries = await readJournalEntries(storeDir);
    const remaining = entries.slice(count);
    const content = remaining.map((e) => JSON.stringify(e) + '\n').join('');
    await fs.writeFile(journalPath(storeDir), content, 'utf-8');
  });
}

// FLUX-1428: the journal is a low-level durability primitive with no business-logic knowledge of
// tickets. Replaying an entry means re-invoking the real mutation handler (task-store.ts's
// updateTaskWithHistory) against the freshly-reset state — that's what makes a duplicate "advance
// to Done" collapse to a no-op instead of a second Done event (idempotency lives in the handler,
// not here). task-store.ts imports this module (for appendJournalEntry), so this module cannot
// statically import task-store.ts back without a cycle; it registers its handlers here instead —
// both the replay entry point and the post-`reset --hard` cache reload (reconcileBackgroundPull),
// which sync-watcher.ts's CAS loop needs for the identical reason.
export type ReplayHandler = (taskId: string, options: Record<string, unknown>) => unknown;
export type CacheReloadHandler = (storeDir: string, changedRelativePaths: string[]) => Promise<void>;

let replayHandler: ReplayHandler | null = null;
let cacheReloadHandler: CacheReloadHandler | null = null;

export function setJournalReplayHandler(fn: ReplayHandler): void {
  replayHandler = fn;
}

export function setJournalCacheReloadHandler(fn: CacheReloadHandler): void {
  cacheReloadHandler = fn;
}

/** Re-invoke the registered handler for one journal entry, marked so it doesn't re-journal itself. */
export async function replayJournalEntry(entry: JournalEntry): Promise<void> {
  if (!replayHandler) {
    throw new Error('[sync-journal] replayJournalEntry called before a replay handler was registered');
  }
  await replayHandler(entry.taskId, { ...entry.options, __replaying: true });
}

/**
 * Refresh the in-memory task cache for exactly the files a `reset --hard` just rewrote — MUST run
 * before {@link replayJournalEntry} so replay reads the winning side's fresh state, not a stale
 * in-memory copy of what the losing local commit thought the ticket looked like.
 */
export async function reloadCacheAfterReset(storeDir: string, changedRelativePaths: string[]): Promise<void> {
  if (!cacheReloadHandler) {
    throw new Error('[sync-journal] reloadCacheAfterReset called before a cache-reload handler was registered');
  }
  await cacheReloadHandler(storeDir, changedRelativePaths);
}

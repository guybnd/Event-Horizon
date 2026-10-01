import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  appendJournalEntry,
  readJournalEntries,
  dropFlushedJournalEntries,
  dropPendingCreateEntries,
  replayJournalEntry,
  reloadCacheAfterReset,
  setJournalReplayHandler,
  setJournalCacheReloadHandler,
  SYNC_JOURNAL_FILE,
  type JournalEntry,
} from './sync-journal.js';

describe('sync-journal — durable append-only op journal (FLUX-1428)', () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-journal-'));
  });

  afterEach(async () => {
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
    return {
      opId: overrides.opId ?? 'op-1',
      taskId: overrides.taskId ?? 'FLUX-1',
      ts: overrides.ts ?? '2026-07-15T00:00:00.000Z',
      options: overrides.options ?? { entries: [{ type: 'comment', comment: 'hello' }] },
      ...(overrides.idempotencyKey !== undefined ? { idempotencyKey: overrides.idempotencyKey } : {}),
    };
  }

  it('readJournalEntries returns [] when the file has never been created', async () => {
    expect(await readJournalEntries(storeDir)).toEqual([]);
  });

  it('appendJournalEntry durably persists the entry — a fresh read (not the in-memory return value) sees it', async () => {
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-1' }));

    // Read the raw file directly (bypassing readJournalEntries) to confirm the write actually
    // landed on disk — not merely buffered — by the time appendJournalEntry's promise resolved.
    // This is the crash-ordering invariant: any code that runs after the `await` (e.g. the local
    // git commit) is guaranteed the entry is already durable.
    const raw = await fs.readFile(path.join(storeDir, SYNC_JOURNAL_FILE), 'utf-8');
    expect(raw.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.opId).toBe('op-1');
    expect(parsed.taskId).toBe('FLUX-1');
  });

  it('appends preserve order across multiple calls', async () => {
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-1' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-2' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-3' }));

    const entries = await readJournalEntries(storeDir);
    expect(entries.map((e) => e.opId)).toEqual(['op-1', 'op-2', 'op-3']);
  });

  it('dropFlushedJournalEntries drops exactly the given opIds, preserving later appends', async () => {
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-1' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-2' }));

    // Simulate a concurrent request appending a THIRD entry while a sync tick is mid-flight —
    // the tick only snapshotted the first two, so its flush must not touch this one.
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-3' }));

    await dropFlushedJournalEntries(storeDir, new Set(['op-1', 'op-2']));

    const remaining = await readJournalEntries(storeDir);
    expect(remaining.map((e) => e.opId)).toEqual(['op-3']);
  });

  it('a concurrent append racing dropFlushedJournalEntries never gets lost (FLUX-1428 review fix — TOCTOU)', async () => {
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-1' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-2' }));

    // Fire the drop (simulating a sync tick flushing the first two entries after a successful
    // push) concurrently with an append (simulating a request handler journaling a new mutation
    // while that push is still in flight) — neither is awaited before the other starts, so
    // whichever wins the internal lock runs first. Without serializing append against drop's
    // internal read-filter-write, the append could land between drop's read and its whole-file
    // overwrite and be silently clobbered. With the fix, op-3 survives regardless of ordering:
    // either it's appended before the drop reads (so the drop's filter already excludes it and
    // preserves it) or after the drop writes (so it's simply appended fresh).
    await Promise.all([
      dropFlushedJournalEntries(storeDir, new Set(['op-1', 'op-2'])),
      appendJournalEntry(storeDir, makeEntry({ opId: 'op-3' })),
    ]);

    const remaining = await readJournalEntries(storeDir);
    expect(remaining.map((e) => e.opId)).toEqual(['op-3']);
  });

  it('dropFlushedJournalEntries with an empty set is a no-op', async () => {
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-1' }));
    await dropFlushedJournalEntries(storeDir, new Set());
    expect((await readJournalEntries(storeDir)).map((e) => e.opId)).toEqual(['op-1']);
  });

  it('a mid-file dropPendingCreateEntries does not desync a positional flush — later entries survive (FLUX-1634 review fix)', async () => {
    // Mirrors the sync-watcher shape: a prepared HEAD snapshots opIds for E1..E5, a create's
    // pending entry (E2) is voided from the MIDDLE of the file by a concurrent delete, then two
    // more entries (E6, E7) are appended before the flush runs. A positional `slice(preparedCount)`
    // would miscount after E2 disappears and eat E6 (an un-pushed, never-replayed mutation) along
    // with the prefix. The identity-keyed drop must not.
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E1' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E2', taskId: 'FLUX-2', kind: 'create', options: { filePath: 'FLUX-2.md', fileContent: 'x' } }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E3' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E4' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E5' }));

    const preparedOpIds = new Set((await readJournalEntries(storeDir)).map((e) => e.opId));
    expect(preparedOpIds.size).toBe(5);

    // The delete that voids FLUX-2's pending create lands inside the fetch+push window.
    await dropPendingCreateEntries(storeDir, 'FLUX-2');

    // More mutations are journaled while the push is still in flight — a real suffix that must
    // survive the eventual flush.
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E6' }));
    await appendJournalEntry(storeDir, makeEntry({ opId: 'E7' }));

    await dropFlushedJournalEntries(storeDir, preparedOpIds);

    const remaining = await readJournalEntries(storeDir);
    expect(remaining.map((e) => e.opId)).toEqual(['E6', 'E7']);
  });

  it('skips unparseable lines instead of throwing', async () => {
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-1' }));
    await fs.appendFile(path.join(storeDir, SYNC_JOURNAL_FILE), 'not json\n', 'utf-8');
    await appendJournalEntry(storeDir, makeEntry({ opId: 'op-2' }));

    const entries = await readJournalEntries(storeDir);
    expect(entries.map((e) => e.opId)).toEqual(['op-1', 'op-2']);
  });

  it('replayJournalEntry throws a clear error when no handler is registered', async () => {
    setJournalReplayHandler(null as never); // reset to unregistered
    await expect(replayJournalEntry(makeEntry())).rejects.toThrow(/replay handler/);
  });

  it('replayJournalEntry invokes the registered handler with __replaying: true, marking it as a replay', async () => {
    const calls: Array<{ taskId: string; options: Record<string, unknown> }> = [];
    setJournalReplayHandler((taskId, options) => {
      calls.push({ taskId, options });
      return undefined;
    });

    const entry = makeEntry({ taskId: 'FLUX-42', options: { nextStatus: 'Done' } });
    await replayJournalEntry(entry);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.taskId).toBe('FLUX-42');
    expect(calls[0]!.options).toMatchObject({ nextStatus: 'Done', __replaying: true });
  });

  it('reloadCacheAfterReset throws a clear error when no handler is registered', async () => {
    setJournalCacheReloadHandler(null as never); // reset to unregistered
    await expect(reloadCacheAfterReset(storeDir, ['FLUX-1.md'])).rejects.toThrow(/cache-reload handler/);
  });

  it('reloadCacheAfterReset invokes the registered handler with the changed paths', async () => {
    const calls: Array<{ storeDir: string; changedRelativePaths: string[] }> = [];
    setJournalCacheReloadHandler(async (dir, paths) => {
      calls.push({ storeDir: dir, changedRelativePaths: paths });
    });

    await reloadCacheAfterReset(storeDir, ['FLUX-1.md', 'FLUX-2.md']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.storeDir).toBe(storeDir);
    expect(calls[0]!.changedRelativePaths).toEqual(['FLUX-1.md', 'FLUX-2.md']);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getActiveFluxDir, getFluxStoreDir } from './workspace.js';
import { getWorkspace } from './workspace-context.js';
import { createTask, deleteTask, markTaskDeliberatelyDeleted, reconcileBackgroundPull } from './task-store.js';
import { readJournalEntries, replayJournalEntry, type CreateReplayPayload } from './sync-journal.js';
import { getNotifications, clearNotifications } from './notifications.js';

// FLUX-1634 review: sync-watcher.test.ts's create-replay coverage registers its own stub
// setJournalCreateReplayHandler, so it only proves replayJournalEntry dispatches a `kind:'create'`
// entry to whatever handler is registered — neither createTaskUnlocked's journal append nor the
// REAL production handler (task-store.ts's setJournalCreateReplayHandler call) was exercised.
// These tests import task-store.js, so its real handler is the one registered when this file's
// module registry loads (vitest isolates modules per test file) — replayJournalEntry here drives
// the actual production code, not a stub.
describe('createTaskUnlocked journal + create-replay handler (FLUX-1634)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-create-replay-'));
    await fs.mkdir(path.join(root, '.flux-store'), { recursive: true });
    setWorkspaceRoot(root);
    clearNotifications();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('journals a kind:"create" entry with the resolved file path/content before writing', async () => {
    const result = await createTask({ title: 'New ticket', author: 'Tester', skipBroadcast: true });
    const filePath = path.join(getActiveFluxDir(), `${result.id}.md`);
    const fileContent = await fs.readFile(filePath, 'utf-8');

    const entries = await readJournalEntries(getFluxStoreDir());
    const createEntry = entries.find((e) => e.taskId === result.id && e.kind === 'create');
    expect(createEntry).toBeDefined();
    const payload = createEntry!.options as unknown as CreateReplayPayload;
    expect(payload.filePath).toBe(filePath);
    expect(payload.fileContent).toBe(fileContent);
  });

  it('recreates a file lost to a reset, reproducing runSync\'s real ordering', async () => {
    const result = await createTask({ title: 'Lost ticket', author: 'Tester', skipBroadcast: true });
    const filePath = path.join(getActiveFluxDir(), `${result.id}.md`);
    const fileContent = await fs.readFile(filePath, 'utf-8');

    // Simulate a losing `reset --hard`: the file is gone, the journal entry survives (only dropped
    // after a successful push). Then run the SAME reconcileBackgroundPull call runSync makes before
    // replay (engine/src/sync-watcher.ts) — it deletes the cache entry for any changed path whose
    // file is now missing, which is what previously made the cache-presence guard bail here too.
    await fs.rm(filePath);
    await reconcileBackgroundPull(getFluxStoreDir(), [`${result.id}.md`], getWorkspace());
    expect(getWorkspace().tasks[result.id]).toBeUndefined();

    const entries = await readJournalEntries(getFluxStoreDir());
    const createEntry = entries.find((e) => e.taskId === result.id && e.kind === 'create')!;
    await replayJournalEntry(createEntry, getWorkspace());

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(fileContent);
    expect(getWorkspace().tasks[result.id]).toBeDefined();
  });

  it('does not resurrect a ticket deliberately deleted before its create replayed', async () => {
    const result = await createTask({ title: 'Deleted ticket', author: 'Tester', skipBroadcast: true });
    const filePath = path.join(getActiveFluxDir(), `${result.id}.md`);

    const entries = await readJournalEntries(getFluxStoreDir());
    const createEntry = entries.find((e) => e.taskId === result.id && e.kind === 'create')!;

    // Deliberate delete, mirroring DELETE /api/tasks/:id and extract.ts's rollback (deleteTask):
    // unlink the file, mark it deliberately deleted, drop the cache entry — while the create's
    // journal entry is still pending flush (entries only drop after a successful push). The reset
    // in this scenario also runs reconcileBackgroundPull, which would ALSO clear the cache entry —
    // the marker is what the handler actually keys off, not cache presence.
    await fs.rm(filePath);
    markTaskDeliberatelyDeleted(filePath);
    delete getWorkspace().tasks[result.id];

    await replayJournalEntry(createEntry, getWorkspace());

    await expect(fs.access(filePath)).rejects.toThrow();
    expect(getWorkspace().tasks[result.id]).toBeUndefined();
  });

  it('replays a create at a reused id after an earlier deliberate delete of that same id', async () => {
    const first = await createTask({ title: 'Rolled back', author: 'Tester', skipBroadcast: true });
    await deleteTask(first.id, getWorkspace());

    // The allocator max-scans the cache, so the next create re-mints the same id and path.
    const second = await createTask({ title: 'Unrelated new ticket', author: 'Tester', skipBroadcast: true });
    expect(second.id).toBe(first.id);
    const filePath = path.join(getActiveFluxDir(), `${second.id}.md`);
    const fileContent = await fs.readFile(filePath, 'utf-8');

    // The second create is lost to a reset; the stale deletion marker must not suppress its replay.
    await fs.rm(filePath);
    await reconcileBackgroundPull(getFluxStoreDir(), [`${second.id}.md`], getWorkspace());

    const entries = await readJournalEntries(getFluxStoreDir());
    const createEntry = entries.filter((e) => e.taskId === second.id && e.kind === 'create').at(-1)!;
    await replayJournalEntry(createEntry, getWorkspace());

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(fileContent);
    expect(getWorkspace().tasks[second.id]).toBeDefined();
  });

  it('replays the winning ticket, not the deleted one, when a reused id\'s earlier create was still pending (FLUX-1634 round 4)', async () => {
    // Without dropPendingCreateEntries, a delete never removed its own still-pending create entry —
    // so after createTask A -> deleteTask -> createTask B, TWO kind:'create' entries were pending for
    // the identical path (same reused id). Replaying only the last one (as the round-3 regression
    // test above does) would pass even with that bug present; this asserts the delete actually
    // voided A's entry (only B's remains pending) and that replaying it restores B, not A.
    const first = await createTask({ title: 'Rolled back A', author: 'Tester', skipBroadcast: true });
    await deleteTask(first.id, getWorkspace());

    const second = await createTask({ title: 'Unrelated new ticket B', author: 'Tester', skipBroadcast: true });
    expect(second.id).toBe(first.id);
    const filePath = path.join(getActiveFluxDir(), `${second.id}.md`);
    const secondContent = await fs.readFile(filePath, 'utf-8');

    // Simulate a losing reset that discards both engines' un-pushed commits (A's create, A's delete,
    // and B's create all land in the same unflushed journal window).
    await fs.rm(filePath);
    await reconcileBackgroundPull(getFluxStoreDir(), [`${second.id}.md`], getWorkspace());

    const pending = (await readJournalEntries(getFluxStoreDir())).filter(
      (e) => e.taskId === second.id && e.kind === 'create'
    );
    // Pins the round-4 fix directly: deleteTask must have dropped A's still-pending create entry, or
    // this would be 2 and replaying both would resurrect A and then lose B to the id-collision guard.
    expect(pending.length).toBe(1);
    for (const entry of pending) {
      await replayJournalEntry(entry, getWorkspace());
    }

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(secondContent);
    expect(getWorkspace().tasks[second.id]?.title).toBe('Unrelated new ticket B');
    expect(getNotifications(getWorkspace())).toEqual([]);
  });

  it('does not overwrite a file another engine already created at the same id, and notifies instead of silently dropping', async () => {
    const result = await createTask({ title: 'Collided ticket', author: 'Tester', skipBroadcast: true });
    const filePath = path.join(getActiveFluxDir(), `${result.id}.md`);

    const entries = await readJournalEntries(getFluxStoreDir());
    const createEntry = entries.find((e) => e.taskId === result.id && e.kind === 'create')!;

    // Simulate a second engine winning the id race: after the reset, the remote's own ticket
    // (different content) already occupies this path.
    const remoteContent = `---\nid: ${result.id}\ntitle: Remote winner\nstatus: Todo\n---\n\nRemote body.\n`;
    await fs.writeFile(filePath, remoteContent, 'utf-8');

    await replayJournalEntry(createEntry, getWorkspace());

    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(remoteContent); // untouched, not overwritten
    const notifications = getNotifications(getWorkspace());
    expect(notifications.some((n) => n.ticketId === result.id && n.type === 'error')).toBe(true);
  });
});

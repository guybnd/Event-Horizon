import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot, getActiveFluxDir } from './workspace.js';
import {
  appendTranscriptEvent,
  flushTranscript,
  getTranscriptFile,
  gatherTurnsForView,
  readTranscriptMessages,
  clearTranscript,
} from './transcript.js';
import { projectTranscript } from './projection.js';
import { extractTicket } from './extract.js';
import { readCurationOps, getCurationOpsFile } from './curation-ops.js';
import { createTask, tasksCache } from './task-store.js';
import { proposeBoardRebase, resolveBoardRebase } from './board-rebase.js';

/**
 * FLUX-656 — the `extract` curation verb. Locks the invariants the epic rests on: extract is
 * additive (the source substrate is byte-for-byte untouched), the new card's view is
 * RE-DERIVED from substrate + op-log (not a copy), the gathered turns carry source
 * attribution, guards reject bad ranges before any ticket is created, and the board-rebase
 * `promote` executor drives the same engine path.
 */
describe('extract verb (FLUX-656)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-extract-'));
    setWorkspaceRoot(root);
    // The substrate seq counter is a module-global keyed by streamId; '__board__' is reused
    // across tests, so reset it to seq 0 for each fresh workspace root (clearTranscript also
    // drops the cached count). Without this the seq cache leaks between tests.
    await clearTranscript('__board__');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Seed the `__board__` orchestrator stream with N user turns (texts t0..t{N-1}). */
  async function seedBoard(n: number): Promise<void> {
    for (let i = 0; i < n; i++) appendTranscriptEvent('__board__', { type: 'user', text: `t${i}` });
    await flushTranscript('__board__');
  }

  it('carves a slice into a new card; source untouched; view re-derives with attribution', async () => {
    await seedBoard(5);
    const before = await fs.readFile(getTranscriptFile('__board__'), 'utf8');

    const res = await extractTicket({ from: '__board__', fromSeq: 1, toSeq: 3, title: 'Carved topic' });
    expect(res.title).toBe('Carved topic');
    expect(res.turnsExtracted).toBe(3);
    expect(res.id).toMatch(/^FLUX-\d+$/);

    // AC3: the source __board__ substrate is byte-for-byte unchanged (additive, never mutated).
    const after = await fs.readFile(getTranscriptFile('__board__'), 'utf8');
    expect(after).toBe(before);

    // AC1: exactly one extract op recorded, addressing the slice by seq range.
    const ops = await readCurationOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'extract', into: res.id, from: '__board__', fromSeq: 1, toSeq: 3 });

    // AC3: the new card renders the extracted slice (t1..t3), each tagged with its source.
    const msgs = await readTranscriptMessages(res.id);
    expect(msgs).toEqual([
      { role: 'user', text: 't1', ts: '', sourceStream: '__board__' },
      { role: 'user', text: 't2', ts: '', sourceStream: '__board__' },
      { role: 'user', text: 't3', ts: '', sourceStream: '__board__' },
    ]);
  });

  it('re-running the projection from substrate + op-log reproduces the same view (round-trip)', async () => {
    await seedBoard(4);
    const res = await extractTicket({ from: '__board__', fromSeq: 0, toSeq: 2, title: 'RT' });

    const view = await readTranscriptMessages(res.id);
    // Re-derive independently from the gathered turns + op-log — must match the reader output.
    const { turns, ops } = await gatherTurnsForView(res.id);
    expect(projectTranscript(turns, ops, res.id)).toEqual(view);
  });

  it('the new card merges its OWN later turns after the extracted slice', async () => {
    await seedBoard(3);
    const res = await extractTicket({ from: '__board__', fromSeq: 0, toSeq: 1, title: 'Own turns' });
    // A session later runs on the new card and appends its own turn.
    appendTranscriptEvent(res.id, { type: 'user', text: 'native', timestamp: 'TX' });
    await flushTranscript(res.id);

    const msgs = await readTranscriptMessages(res.id);
    expect(msgs).toEqual([
      { role: 'user', text: 't0', ts: '', sourceStream: '__board__' },
      { role: 'user', text: 't1', ts: '', sourceStream: '__board__' },
      // The card's own turn is NOT foreign → no sourceStream tag.
      { role: 'user', text: 'native', ts: 'TX' },
    ]);
  });

  describe('guards (AC5 — no ticket created, no op recorded)', () => {
    async function expectRejected(p: Promise<unknown>): Promise<void> {
      await expect(p).rejects.toThrow();
      // No op was appended for the rejected request.
      expect(await readCurationOps()).toHaveLength(0);
    }

    it('rejects an inverted range', async () => {
      await seedBoard(5);
      await expectRejected(extractTicket({ from: '__board__', fromSeq: 4, toSeq: 1, title: 'x' }));
    });

    it('rejects an unknown source stream', async () => {
      await seedBoard(2);
      await expectRejected(extractTicket({ from: '__nope__', fromSeq: 0, toSeq: 1, title: 'x' }));
    });

    it('rejects a range with no turns', async () => {
      await seedBoard(2);
      await expectRejected(extractTicket({ from: '__board__', fromSeq: 50, toSeq: 60, title: 'x' }));
    });

    it('rejects a missing title', async () => {
      await seedBoard(3);
      await expectRejected(extractTicket({ from: '__board__', fromSeq: 0, toSeq: 1, title: '   ' }));
    });
  });

  it('FLUX-738: if persisting the extract op fails, the just-created card is removed (no orphan)', async () => {
    await seedBoard(3);
    const before = await fs.readFile(getTranscriptFile('__board__'), 'utf8');
    const cardsBefore = Object.keys(tasksCache).length;

    // Force appendCurationOp to throw a real I/O error of the class FLUX-738 protects against:
    // create the op-log PATH as a directory so the internal fs.appendFile rejects (EISDIR).
    await fs.mkdir(getCurationOpsFile(), { recursive: true });

    await expect(
      extractTicket({ from: '__board__', fromSeq: 0, toSeq: 1, title: 'doomed' }),
    ).rejects.toThrow();

    // The card created mid-flight was compensated away — no orphan left in the cache.
    // The source substrate is still byte-for-byte untouched.
    expect(Object.keys(tasksCache).length).toBe(cardsBefore);
    expect(await fs.readFile(getTranscriptFile('__board__'), 'utf8')).toBe(before);

    // Remove the blocker dir, then confirm no extract op was ever persisted (no orphan ref).
    await fs.rm(getCurationOpsFile(), { recursive: true, force: true });
    expect(await readCurationOps()).toHaveLength(0);
  });

  it('the board-rebase promote executor drives the same extract path', async () => {
    await seedBoard(4);
    const batch = proposeBoardRebase(
      [{
        kind: 'promote',
        targets: ['__board__'],
        summary: 'Carve t0..t1',
        fromSeq: 0,
        toSeq: 1,
        title: 'Promoted card',
      }],
      null,
    );
    const itemId = batch.items[0]!.id;

    const resolved = await resolveBoardRebase(batch.id, [itemId]);
    expect(resolved?.ok).toBe(true);
    const result = resolved!.results[0]!;
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/extracted FLUX-\d+ \(2 turns from __board__\)/);

    // The promote went through extractTicket → one op + a re-derivable card view.
    const ops = await readCurationOps();
    expect(ops).toHaveLength(1);
    const newId = ops[0]!.into;
    expect(await readTranscriptMessages(newId)).toEqual([
      { role: 'user', text: 't0', ts: '', sourceStream: '__board__' },
      { role: 'user', text: 't1', ts: '', sourceStream: '__board__' },
    ]);
  });

  it('promote without a seq range reports a clear error and creates nothing', async () => {
    await seedBoard(3);
    const batch = proposeBoardRebase(
      [{ kind: 'promote', targets: ['__board__'], summary: 'no range' }],
      null,
    );
    const resolved = await resolveBoardRebase(batch.id, [batch.items[0]!.id]);
    expect(resolved!.results[0]!.ok).toBe(false);
    expect(resolved!.results[0]!.message).toMatch(/fromSeq and toSeq are required/);
    expect(await readCurationOps()).toHaveLength(0);
  });

  /**
   * FLUX-1249 — promoting a `kind:"scratch"` source CONSUMES it: the scratch is tombstoned +
   * archived after the new card is minted, so exactly one live card remains. Promoting any
   * non-scratch source stays purely additive (the scratch kind guard is the only trigger).
   */
  describe('scratch consume (FLUX-1249)', () => {
    /** Create a `kind:"scratch"` scratchpad and seed its stream with N user turns. */
    async function makeScratch(n: number): Promise<string> {
      await fs.mkdir(getActiveFluxDir(), { recursive: true });
      const { id } = await createTask({ title: 'Scratch pad', author: 'Tester', kind: 'scratch', skipBroadcast: true });
      for (let i = 0; i < n; i++) appendTranscriptEvent(id, { type: 'user', text: `s${i}` });
      await flushTranscript(id);
      return id;
    }

    it('promoting a scratch archives it (mergedInto + pinned tombstone) and mints a real FLUX-###', async () => {
      const scratch = await makeScratch(3);
      expect(scratch).toMatch(/^SCRATCH-\d+$/);

      const res = await extractTicket({ from: scratch, fromSeq: 0, toSeq: 2, title: 'Promoted from scratch' });
      // AC: the promoted card is a real FLUX-### (not SCRATCH-n), and consume is reported.
      expect(res.id).toMatch(/^FLUX-\d+$/);
      expect(res.turnsExtracted).toBe(3);
      expect(res.sourceConsumed).toBe(true);
      expect(res.consumeError).toBeUndefined();

      // AC: the scratch is tombstoned (mergedInto pointer + pinned comment) and archived — not deleted.
      const src = tasksCache[scratch];
      expect(src).toBeTruthy();
      expect(src.mergedInto).toBe(res.id);
      expect(src.status).toBe('Archived');
      const pinned = ((src.history || []) as Array<{ type?: string; pin?: boolean; comment?: string }>).find(
        (h) => h.type === 'comment' && h.pin && /Promoted into/.test(h.comment || ''),
      );
      expect(pinned).toBeTruthy();

      // AC: the promoted card's transcript STILL re-derives from the (untouched) scratch substrate
      // after the archive — a status change never touches the transcript files.
      expect(await readTranscriptMessages(res.id)).toEqual([
        { role: 'user', text: 's0', ts: '', sourceStream: scratch },
        { role: 'user', text: 's1', ts: '', sourceStream: scratch },
        { role: 'user', text: 's2', ts: '', sourceStream: scratch },
      ]);
    });

    it('the board-rebase promote gate consumes a scratch too (shared engine path)', async () => {
      const scratch = await makeScratch(2);
      const batch = proposeBoardRebase(
        [{ kind: 'promote', targets: [scratch], summary: 'Promote scratch', fromSeq: 0, toSeq: 1, title: 'Promoted' }],
        null,
      );
      const resolved = await resolveBoardRebase(batch.id, [batch.items[0]!.id]);
      expect(resolved!.results[0]!.ok).toBe(true);

      const newId = (await readCurationOps())[0]!.into;
      expect(newId).toMatch(/^FLUX-\d+$/);
      // The scratch was consumed via the same extractTicket path.
      expect(tasksCache[scratch].mergedInto).toBe(newId);
      expect(tasksCache[scratch].status).toBe('Archived');
    });

    it('promoting a NON-scratch source (__board__) leaves the source untouched (no regression)', async () => {
      await seedBoard(4);
      const res = await extractTicket({ from: '__board__', fromSeq: 0, toSeq: 1, title: 'Additive promote' });
      // Non-scratch: no consume — the additive contract is preserved.
      expect(res.sourceConsumed).toBeUndefined();
      expect(res.consumeError).toBeUndefined();
      // __board__ has no card, so nothing to archive; the op stands and the view re-derives.
      expect(await readTranscriptMessages(res.id)).toEqual([
        { role: 'user', text: 't0', ts: '', sourceStream: '__board__' },
        { role: 'user', text: 't1', ts: '', sourceStream: '__board__' },
      ]);
    });

    it('is best-effort: an archive failure leaves the promote intact (card + op stand)', async () => {
      const scratch = await makeScratch(2);
      // Force the archive WRITE to fail while leaving the scratch card in the cache (so the kind
      // guard still fires and the read falls back to cache): replace its on-disk .md with a
      // DIRECTORY at the same path, so updateTaskWithHistory's atomic rename onto it rejects.
      const scratchPath = tasksCache[scratch]._path as string;
      await fs.rm(scratchPath, { force: true });
      await fs.mkdir(scratchPath, { recursive: true });

      const res = await extractTicket({ from: scratch, fromSeq: 0, toSeq: 1, title: 'Promote despite archive fail' });
      // The promote still succeeded: real card + a durable extract op + a re-derivable view.
      expect(res.id).toMatch(/^FLUX-\d+$/);
      expect(res.sourceConsumed).toBeUndefined();
      expect(res.consumeError).toBeTruthy();
      expect((await readCurationOps()).some((o) => o.op === 'extract' && o.into === res.id)).toBe(true);
      expect(await readTranscriptMessages(res.id)).toEqual([
        { role: 'user', text: 's0', ts: '', sourceStream: scratch },
        { role: 'user', text: 's1', ts: '', sourceStream: scratch },
      ]);
    });
  });
});

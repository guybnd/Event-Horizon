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
} from './transcript.js';
import { projectTranscript } from './projection.js';
import { mergeTickets } from './merge.js';
import { extractTicket } from './extract.js';
import { readCurationOps } from './curation-ops.js';
import { createTask, tasksCache } from './task-store.js';
import { proposeBoardRebase, resolveBoardRebase } from './board-rebase.js';

/**
 * FLUX-657 — the `merge` curation verb. Locks the invariants the epic rests on: merge is
 * additive (every source substrate is byte-for-byte untouched), the survivor's view is
 * RE-DERIVED as the chronological union of its own turns + every folded stream's turns
 * (source attribution preserved), the sources are tombstoned + archived (never deleted),
 * guards reject bad requests before any op/mutation, and the board-rebase `fold` executor
 * drives the same engine path.
 */
describe('merge verb (FLUX-657)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-merge-'));
    setWorkspaceRoot(root);
    // createTask writes `<flux>/<id>.md` via an atomic rename that does NOT mkdir the dir;
    // ensure the flux dir exists before the first ticket is created (no transcript seeded yet).
    await fs.mkdir(getActiveFluxDir(), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Create a bare ticket, returning its id. */
  async function makeTicket(title: string): Promise<string> {
    const { id } = await createTask({ title, author: 'Tester', skipBroadcast: true } as any);
    return id;
  }

  /** Seed a stream with user turns (each `{ text, ts }`). */
  async function seed(streamId: string, turns: Array<{ text: string; ts: string }>): Promise<void> {
    for (const t of turns) appendTranscriptEvent(streamId, { type: 'user', text: t.text, timestamp: t.ts });
    await flushTranscript(streamId);
  }

  it('folds sources into the survivor as a chronological union with source attribution', async () => {
    const survivor = await makeTicket('Survivor effort');
    const a = await makeTicket('Source A');
    const b = await makeTicket('Source B');

    // Interleaved timestamps across the three streams.
    await seed(survivor, [{ text: 's-own', ts: '2025-01-01T00:00:02.000Z' }]);
    await seed(a, [
      { text: 'a1', ts: '2025-01-01T00:00:01.000Z' },
      { text: 'a2', ts: '2025-01-01T00:00:04.000Z' },
    ]);
    await seed(b, [{ text: 'b1', ts: '2025-01-01T00:00:03.000Z' }]);

    const beforeA = await fs.readFile(getTranscriptFile(a), 'utf8');
    const beforeB = await fs.readFile(getTranscriptFile(b), 'utf8');

    const res = await mergeTickets({ into: survivor, from: [a, b] });
    expect(res).toMatchObject({ into: survivor, merged: [a, b], turnsFolded: 3, archiveFailures: [] });

    // AC: exactly one merge op recorded; no substrate mutation.
    const ops = await readCurationOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'merge', into: survivor, from: [a, b] });
    expect(await fs.readFile(getTranscriptFile(a), 'utf8')).toBe(beforeA);
    expect(await fs.readFile(getTranscriptFile(b), 'utf8')).toBe(beforeB);

    // AC: survivor view = chronological union by ts; foreign turns tagged with their source.
    const msgs = await readTranscriptMessages(survivor);
    expect(msgs).toEqual([
      { role: 'user', text: 'a1', ts: '2025-01-01T00:00:01.000Z', sourceStream: a },
      { role: 'user', text: 's-own', ts: '2025-01-01T00:00:02.000Z' }, // own turn → no tag
      { role: 'user', text: 'b1', ts: '2025-01-01T00:00:03.000Z', sourceStream: b },
      { role: 'user', text: 'a2', ts: '2025-01-01T00:00:04.000Z', sourceStream: a },
    ]);
  });

  it('tombstones + archives each source (mergedInto pointer + pinned comment), none deleted', async () => {
    const survivor = await makeTicket('Survivor');
    const a = await makeTicket('Folded A');
    const b = await makeTicket('Folded B');
    await seed(a, [{ text: 'a', ts: '2025-01-01T00:00:01.000Z' }]);
    await seed(b, [{ text: 'b', ts: '2025-01-01T00:00:02.000Z' }]);

    await mergeTickets({ into: survivor, from: [a, b] });

    for (const src of [a, b]) {
      const task = tasksCache[src];
      expect(task).toBeTruthy(); // not deleted
      expect(task.mergedInto).toBe(survivor);
      expect(task.status).toBe('Archived');
      const pinnedTombstone = (task.history || []).find(
        (h: any) => h.type === 'comment' && h.pin && /Merged into/.test(h.comment || ''),
      );
      expect(pinnedTombstone).toBeTruthy();
    }
    // The survivor itself is untouched metadata-wise (not archived).
    expect(tasksCache[survivor].mergedInto).toBeUndefined();
    expect(tasksCache[survivor].status).not.toBe('Archived');
  });

  it('re-running the projection from substrate + op-log reproduces the merged view (round-trip)', async () => {
    const survivor = await makeTicket('RT survivor');
    const a = await makeTicket('RT A');
    await seed(survivor, [{ text: 'own', ts: '2025-01-01T00:00:02.000Z' }]);
    await seed(a, [{ text: 'foreign', ts: '2025-01-01T00:00:01.000Z' }]);

    await mergeTickets({ into: survivor, from: [a] });

    const view = await readTranscriptMessages(survivor);
    const { turns, ops } = await gatherTurnsForView(survivor);
    expect(projectTranscript(turns, ops, survivor)).toEqual(view);
  });

  it('breaks ts ties deterministically by (streamId, seq)', async () => {
    const survivor = await makeTicket('Tie survivor');
    const a = await makeTicket('Tie A');
    const b = await makeTicket('Tie B');
    const SAME = '2025-01-01T00:00:00.000Z';
    await seed(a, [{ text: 'a', ts: SAME }]);
    await seed(b, [{ text: 'b', ts: SAME }]);
    await seed(survivor, [{ text: 's', ts: SAME }]);

    await mergeTickets({ into: survivor, from: [a, b] });
    const texts = (await readTranscriptMessages(survivor)).map((m) => m.text);

    // Same ts everywhere → order is the streamId sort (then seq). Compute the expected order
    // from the known ids so the assertion documents the rule rather than hard-coding ids.
    const byStream: Record<string, string> = { [a]: 'a', [b]: 'b', [survivor]: 's' };
    const expected = [a, b, survivor].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).map((id) => byStream[id]);
    expect(texts).toEqual(expected);
  });

  describe('guards (no op recorded, no partial state)', () => {
    async function expectRejected(p: Promise<unknown>): Promise<void> {
      await expect(p).rejects.toThrow();
      expect(await readCurationOps()).toHaveLength(0);
    }

    it('rejects an unknown survivor', async () => {
      const a = await makeTicket('A');
      await expectRejected(mergeTickets({ into: 'FLUX-99999', from: [a] }));
    });

    it('rejects an empty from[]', async () => {
      const survivor = await makeTicket('S');
      await expectRejected(mergeTickets({ into: survivor, from: [] }));
    });

    it('rejects a self-merge (into ∈ from)', async () => {
      const survivor = await makeTicket('S');
      const a = await makeTicket('A');
      await expectRejected(mergeTickets({ into: survivor, from: [a, survivor] }));
    });

    it('rejects an unknown source', async () => {
      const survivor = await makeTicket('S');
      await expectRejected(mergeTickets({ into: survivor, from: ['FLUX-88888'] }));
    });

    it('rejects a source already merged into another effort', async () => {
      const survivor1 = await makeTicket('S1');
      const survivor2 = await makeTicket('S2');
      const a = await makeTicket('A');
      await seed(a, [{ text: 'a', ts: '2025-01-01T00:00:01.000Z' }]);
      await mergeTickets({ into: survivor1, from: [a] }); // a now folded into survivor1
      // Re-merging the same source elsewhere is refused, and adds no second op.
      await expect(mergeTickets({ into: survivor2, from: [a] })).rejects.toThrow(/already merged/);
      expect(await readCurationOps()).toHaveLength(1);
    });

    // FLUX-657 chaining guards: `gatherTurnsForView` folds a source by reading its *substrate*,
    // not its re-derived view, so chaining merges through a prior survivor would silently drop
    // turns. Both directions are rejected before any second op, keeping the view loss-free.
    it("rejects a prior survivor reused as a source (would lose the survivor's folded-in turns)", async () => {
      const a = await makeTicket('A');
      const b = await makeTicket('B');
      const c = await makeTicket('C');
      await seed(a, [{ text: 'a1', ts: '2025-01-01T00:00:01.000Z' }]);
      await seed(b, [{ text: 'b1', ts: '2025-01-01T00:00:02.000Z' }]);
      await mergeTickets({ into: a, from: [b] }); // a is now a survivor folding b
      // Folding a (a survivor) into c would lose b1 → refused, no second op.
      await expect(mergeTickets({ into: c, from: [a] })).rejects.toThrow(/prior merge survivor/);
      expect(await readCurationOps()).toHaveLength(1);
    });

    // FLUX-657 review (BLOCKER): an extracted card's view re-derives its seed slice from the SOURCE
    // stream via the extract op — its own substrate is empty at birth. Folding it as a merge source
    // reads only that (empty/work-only) substrate, so the slice would silently vanish from the
    // survivor. Generalizing the guard from merge-survivors to ALL derived-view streams
    // (`streamsWithDerivedView`) rejects it loudly instead of losing turns.
    it('rejects folding an extracted card as a source (its re-derived slice would be lost)', async () => {
      const survivor = await makeTicket('S');
      await seed('__board__', [
        { text: 'orch-0', ts: '2025-01-01T00:00:00.000Z' },
        { text: 'orch-1', ts: '2025-01-01T00:00:01.000Z' },
      ]);
      const { id: x } = await extractTicket({ from: '__board__', fromSeq: 0, toSeq: 1, title: 'Extracted X' });
      // X re-derives the slice from __board__; folding it would read only X's own substrate.
      await expect(mergeTickets({ into: survivor, from: [x] })).rejects.toThrow(/re-derived view/);
      // Only the extract op exists — no merge op was appended (no partial state).
      const ops = await readCurationOps();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ op: 'extract', into: x });
    });

    it('rejects folding into a survivor that was itself already merged away', async () => {
      const a = await makeTicket('A');
      const b = await makeTicket('B');
      const c = await makeTicket('C');
      await seed(b, [{ text: 'b1', ts: '2025-01-01T00:00:01.000Z' }]);
      await seed(c, [{ text: 'c1', ts: '2025-01-01T00:00:02.000Z' }]);
      await mergeTickets({ into: a, from: [b] }); // b folded away into a
      // b now redirects to a; folding c into the tombstoned b would orphan c → refused.
      await expect(mergeTickets({ into: b, from: [c] })).rejects.toThrow(/already merged away/);
      expect(await readCurationOps()).toHaveLength(1);
    });
  });

  it('the board-rebase fold executor drives the same merge path', async () => {
    const survivor = await makeTicket('Fold survivor');
    const a = await makeTicket('Fold A');
    await seed(survivor, [{ text: 'own', ts: '2025-01-01T00:00:02.000Z' }]);
    await seed(a, [{ text: 'foreign', ts: '2025-01-01T00:00:01.000Z' }]);

    const batch = proposeBoardRebase(
      [{ kind: 'fold', targets: [a], into: survivor, summary: `Fold ${a} into ${survivor}` }],
      null,
    );
    const resolved = await resolveBoardRebase(batch.id, [batch.items[0]!.id]);
    expect(resolved?.ok).toBe(true);
    expect(resolved!.results[0]!.ok).toBe(true);
    expect(resolved!.results[0]!.message).toMatch(/folded .* into .* \(1 turns\)/);

    expect(await readCurationOps()).toHaveLength(1);
    expect((await readTranscriptMessages(survivor)).map((m) => m.text)).toEqual(['foreign', 'own']);
  });
});

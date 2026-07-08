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

/** Minimal `tasksCache` ticket shape as read by this test — only the fields it inspects. */
interface CachedTask {
  mergedInto?: string;
  status?: string;
  history?: Array<{ type?: string; pin?: boolean; comment?: string }>;
}

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
    const { id } = await createTask({ title, author: 'Tester', skipBroadcast: true });
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
      const task = tasksCache[src] as CachedTask;
      expect(task).toBeTruthy(); // not deleted
      expect(task.mergedInto).toBe(survivor);
      expect(task.status).toBe('Archived');
      const pinnedTombstone = (task.history || []).find(
        (h) => h.type === 'comment' && h.pin && /Merged into/.test(h.comment || ''),
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

  describe('fold composition (FLUX-861 Fix B — folds compose, promote→fold round-trips)', () => {
    it("chains a fold (B→A then A→C) and preserves B's turns in C's view", async () => {
      const a = await makeTicket('A');
      const b = await makeTicket('B');
      const c = await makeTicket('C');
      await seed(c, [{ text: 'c-own', ts: '2025-01-01T00:00:03.000Z' }]);
      await seed(a, [{ text: 'a1', ts: '2025-01-01T00:00:02.000Z' }]);
      await seed(b, [{ text: 'b1', ts: '2025-01-01T00:00:01.000Z' }]);

      await mergeTickets({ into: a, from: [b] }); // a is now a survivor folding b
      // Folding a (a prior survivor) into c now composes instead of being rejected: c's view
      // carries b1 through via a's re-derived view, not just a's own substrate.
      const res = await mergeTickets({ into: c, from: [a] });
      expect(res.turnsFolded).toBe(2); // a's re-derived view: a1 + folded-in b1

      expect(await readCurationOps()).toHaveLength(2);
      const texts = (await readTranscriptMessages(c)).map((m) => m.text);
      expect(texts).toEqual(['b1', 'a1', 'c-own']);
    });

    it('folds an extracted card as a source, surfacing its re-derived slice (promote→fold round-trip)', async () => {
      const survivor = await makeTicket('S');
      await seed('__board__', [
        { text: 'orch-0', ts: '2025-01-01T00:00:00.000Z' },
        { text: 'orch-1', ts: '2025-01-01T00:00:01.000Z' },
      ]);
      const { id: x } = await extractTicket({ from: '__board__', fromSeq: 0, toSeq: 1, title: 'Extracted X' });
      await seed(survivor, [{ text: 's-own', ts: '2025-01-01T00:00:02.000Z' }]);

      // X re-derives its slice from __board__; folding it now composes via X's own view.
      const res = await mergeTickets({ into: survivor, from: [x] });
      expect(res.turnsFolded).toBe(2); // X's re-derived view: the extracted orch-0/orch-1 slice

      const texts = (await readTranscriptMessages(survivor)).map((m) => m.text);
      expect(texts).toEqual(['orch-0', 'orch-1', 's-own']);
    });
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

    // FLUX-861 (Fix B): folds compose now, but a genuine cycle is still rejected — folding a
    // source back in when its own re-derived view already (transitively) includes the survivor
    // would make the survivor's view depend on itself and recurse forever.
    it('rejects folding a source that would create a cycle (an extracted card folded back into its own source)', async () => {
      const x = await makeTicket('X');
      await seed(x, [{ text: 'x1', ts: '2025-01-01T00:00:01.000Z' }]);
      const { id: y } = await extractTicket({ from: x, fromSeq: 0, toSeq: 0, title: 'Extracted Y' });
      // Y's view re-derives its slice from X's own substrate; folding Y into X would make X's
      // view depend on itself (X → Y → X) — rejected as a cycle before any second op is appended.
      await expect(mergeTickets({ into: x, from: [y] })).rejects.toThrow(/cycle/);
      const ops = await readCurationOps();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ op: 'extract', into: y });
    });

    // Cycle detection must walk the FULL transitive closure of the op-log graph, not just direct
    // edges: X → Y (extract) → Z (merge) is two hops, mixing both op kinds.
    it('rejects a transitive (multi-hop, mixed extract+merge) cycle', async () => {
      const x = await makeTicket('X');
      const z = await makeTicket('Z');
      await seed(x, [{ text: 'x1', ts: '2025-01-01T00:00:01.000Z' }]);
      await seed(z, [{ text: 'z1', ts: '2025-01-01T00:00:02.000Z' }]);
      const { id: y } = await extractTicket({ from: x, fromSeq: 0, toSeq: 0, title: 'Extracted Y' });
      await mergeTickets({ into: z, from: [y] }); // z now folds y (which re-derives a slice of x)
      // z's view already (transitively) includes x via y; folding z into x would loop.
      await expect(mergeTickets({ into: x, from: [z] })).rejects.toThrow(/cycle/);
      expect(await readCurationOps()).toHaveLength(2);
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

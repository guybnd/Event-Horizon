// The Furnace — route/store/stoker integration tests (FLUX-1057).
//
// The FLUX-1053 batch redesign collapsed three test files into furnace-batch.test.ts, which only covers
// pure functions. Nothing exercises the route/store level: the slot guard under real contention, feedCoal
// across two concurrently-burning batches, the merge route, or a trigger's positive auto-ignite path.
// These spin up the real store + Stoker (+ the real Express route for ignite/merge), mocking only the
// two external edges: the agent-session spawn (`fetch` to `/cli-session/start`) and the `gh` CLI
// (`./git-exec.js`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot } from './workspace.js';
import { requireWorkspace } from './middleware.js';
import furnaceRouter from './routes/furnace.js';
import {
  createFurnaceBatch,
  mutateFurnaceBatch,
  getFurnaceBatch,
  globalSlotsInUse,
  FURNACE_SLOT_CAP,
  ensureFurnaceLoaded,
  __resetFurnaceStoreForTests,
} from './furnace-store.js';
import { igniteBatch, stokerTick, checkTriggers, reconcileBatch, handBackTicket, retryTicket, resumeBatch, dismissTicketFlag, takeoverTicket, SOLE_REVIEWER_FOCUS } from './furnace-stoker.js';
import { newBatchTicket, type BatchTicket } from './models/furnace.js';
import { cliSessionsById, cliSessionsByTaskId, registerSession } from './session-store.js';
import { tasksCache } from './task-store.js';
import type { CliSessionRecord } from './agents/types.js';

const runGh = vi.fn();
vi.mock('./git-exec.js', () => ({
  runGh: (args: string[]) => runGh(args),
  runGit: vi.fn(),
}));

/**
 * Minimal shape of the second argument to the stubbed `/cli-session/start` fetch — the test only
 * ever reads the JSON `body` string off it (real `RequestInit` has many more optional fields).
 */
interface StubFetchInit {
  body: string;
}

/** Minimal shape of the outgoing `/cli-session/start` request body the FLUX-1080 assertions read. */
interface CliSessionStartRequestBody {
  phase: string;
  focusComment?: string;
}

describe('Furnace integration (FLUX-1057)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;
  let sessCounter = 0;
  let fetchMock: ReturnType<typeof vi.fn>;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-int-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    // Load once up front (mirrors production: the store loads at boot, before any request races in) so
    // the concurrent-ignite test below races on `claimSlotsAndIgnite` itself, not on the separate
    // first-load-wins-the-cache race in `ensureFurnaceLoaded`.
    await ensureFurnaceLoaded();
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    sessCounter = 0;
    runGh.mockReset();

    // Stub the spawn route the Stoker calls to start an implementation/review session — register a
    // running session for (taskId, phase) and hand back its id, mirroring what POST /cli-session/start
    // does for real, minus an actual agent. Anything else (the test's own calls into the local HTTP
    // harness below) passes through to the real fetch.
    realFetch = globalThis.fetch;
    fetchMock = vi.fn(async (url: unknown, init: StubFetchInit) => {
      const m = String(url).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/);
      if (!m || !m[1]) return realFetch(url as RequestInfo | URL, init);
      const taskId = decodeURIComponent(m[1]);
      const id = `sess-${++sessCounter}`;
      const body = JSON.parse(init.body);
      cliSessionsById.set(id, { id, taskId, status: 'running', phase: body.phase } as CliSessionRecord);
      registerSession(taskId, id);
      return { ok: true, json: async () => ({ session: { id } }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = express();
    app.use(express.json());
    app.use('/api/furnace', requireWorkspace, furnaceRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Occupy `n` worktree slots with sequential filler batches (a sequential burning batch reserves its
   *  one slot unconditionally — no need to also drive its ticket into an active state). */
  async function fillSlots(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const b = await createFurnaceBatch({ title: `filler-${i}`, kind: 'sequential', tickets: [newBatchTicket(`FILLER-${i}`, 0)] });
      await mutateFurnaceBatch(b.id, (draft) => { draft.status = 'burning'; });
    }
  }

  /** Every ticketId a `/cli-session/start` call was made for. */
  function dispatchedTicketIds(): string[] {
    return fetchMock.mock.calls
      .map((c) => String(c[0]).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/))
      .filter((m: RegExpMatchArray | null): m is RegExpMatchArray => !!m)
      .map((m) => decodeURIComponent(m[1]!));
  }

  describe('POST /:id/ignite — 409 no_slots when the worktree pool is full', () => {
    it('rejects with 409 {error:"no_slots"} once every slot is taken', async () => {
      await fillSlots(FURNACE_SLOT_CAP);
      const draft = await createFurnaceBatch({ title: 'one too many', kind: 'sequential', tickets: [newBatchTicket('X', 0)] });

      const res = await fetch(`${baseUrl}/api/furnace/${draft.id}/ignite`, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      // FLUX-1158: fillSlots reserves via burning batches with no matching physical worktree, so
      // describeSlotHolders names each reservation as not-yet-materialized rather than leaving it unnamed.
      expect(body.error).toBe('no_slots');
      expect(body.used).toBe(FURNACE_SLOT_CAP);
      expect(body.max).toBe(FURNACE_SLOT_CAP);
      expect(body.holders).toHaveLength(FURNACE_SLOT_CAP);
      expect(body.holders.every((h: { reason: string }) => h.reason === 'reserved — worktree not yet created')).toBe(true);
      expect(getFurnaceBatch(draft.id)?.status).toBe('draft'); // never claimed
    });
  });

  describe('POST /:id/ticket — one-active-batch invariant (FLUX-1051)', () => {
    it('rejects appending a ticket already queued in another non-terminal batch, naming the owner', async () => {
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
      const owner = await createFurnaceBatch({ title: 'Owner', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });
      const other = await createFurnaceBatch({ title: 'Other' });

      const res = await fetch(`${baseUrl}/api/furnace/${other.id}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'FLUX-1' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain(owner.id);
      expect(getFurnaceBatch(other.id)?.tickets).toEqual([]);
    });

    it('allows appending once the owning batch reaches a terminal state (done)', async () => {
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
      const owner = await createFurnaceBatch({ title: 'Owner', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });
      await mutateFurnaceBatch(owner.id, (draft) => { draft.status = 'done'; });
      const other = await createFurnaceBatch({ title: 'Other' });

      const res = await fetch(`${baseUrl}/api/furnace/${other.id}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'FLUX-1' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tickets.map((t: BatchTicket) => t.ticketId)).toEqual(['FLUX-1']);
    });
  });

  describe('two concurrent ignites racing for the last free slot', () => {
    it('exactly one wins; the other gets no_slots (claimSlotsAndIgnite is an atomic check-then-set)', async () => {
      await fillSlots(FURNACE_SLOT_CAP - 1); // exactly one slot left
      const d1 = await createFurnaceBatch({ title: 'D1', kind: 'sequential', tickets: [newBatchTicket('D1-T', 0)] });
      const d2 = await createFurnaceBatch({ title: 'D2', kind: 'sequential', tickets: [newBatchTicket('D2-T', 0)] });

      const [r1, r2] = await Promise.all([igniteBatch(d1.id), igniteBatch(d2.id)]);
      const results = [r1, r2];
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(losses[0]?.error).toBe('no_slots');

      // The invariant this guard exists to protect: never more burning batches than the cap allows.
      expect(globalSlotsInUse()).toBe(FURNACE_SLOT_CAP);
      const burningCount = [getFurnaceBatch(d1.id), getFurnaceBatch(d2.id)].filter((b) => b?.status === 'burning').length;
      expect(burningCount).toBe(1);
    });
  });

  describe('feedCoal enforces the global slot cap across two concurrently-burning batches', () => {
    it('the second batch only gets as many tickets started as slots remain free', async () => {
      // Batch A: parallel, burn rate 3, 3 tickets — fully fills 3 of the 4 global slots.
      const a = await createFurnaceBatch({
        title: 'A', kind: 'parallel', burnRate: 3,
        tickets: [newBatchTicket('A1', 0), newBatchTicket('A2', 1), newBatchTicket('A3', 2)],
      });
      await mutateFurnaceBatch(a.id, (b) => { b.status = 'burning'; });
      await stokerTick(a.id);
      expect(getFurnaceBatch(a.id)?.tickets.map((t) => t.state)).toEqual(['implementing', 'implementing', 'implementing']);
      expect(globalSlotsInUse()).toBe(3);

      // Batch B: parallel, burn rate 4, 2 tickets — only 1 global slot remains, so only ONE of its
      // tickets may start even though its OWN burn rate would allow both concurrently.
      const b = await createFurnaceBatch({
        title: 'B', kind: 'parallel', burnRate: 4,
        tickets: [newBatchTicket('B1', 0), newBatchTicket('B2', 1)],
      });
      await mutateFurnaceBatch(b.id, (bb) => { bb.status = 'burning'; });
      await stokerTick(b.id);

      const bStates = getFurnaceBatch(b.id)?.tickets.map((t) => [t.ticketId, t.state]);
      expect(bStates).toEqual([['B1', 'implementing'], ['B2', 'queued']]);
      expect(globalSlotsInUse()).toBe(FURNACE_SLOT_CAP); // 3 (A) + 1 (B1) = the whole cap
      expect(dispatchedTicketIds().sort()).toEqual(['A1', 'A2', 'A3', 'B1']); // B2 never dispatched
    });
  });

  describe('POST /:id/merge — partial success/failure, reviewState flips to merged only on success', () => {
    it('merges the succeeding PR, reports the failing one, and leaves its reviewState untouched', async () => {
      const batch = await createFurnaceBatch({
        title: 'merge me', kind: 'parallel',
        tickets: [newBatchTicket('M1', 0), newBatchTicket('M2', 1)],
      });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.prs = [
          { url: 'https://github.com/o/r/pull/1', branch: 'flux/m1', ticketId: 'M1', reviewState: 'approved' },
          { url: 'https://github.com/o/r/pull/2', branch: 'flux/m2', ticketId: 'M2', reviewState: 'approved' },
        ];
      });
      runGh.mockImplementation(async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'merge' && args[2] === 'flux/m1') return { stdout: '', stderr: '' };
        if (args[0] === 'pr' && args[1] === 'merge' && args[2] === 'flux/m2') throw new Error('merge conflict on flux/m2');
        throw new Error(`unexpected gh call: ${args.join(' ')}`);
      });

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.merged).toEqual(['flux/m1']);
      expect(body.failed).toEqual([{ branch: 'flux/m2', error: 'merge conflict on flux/m2' }]);

      const prs = getFurnaceBatch(batch.id)?.prs ?? [];
      expect(prs.find((p) => p.branch === 'flux/m1')?.reviewState).toBe('merged');
      expect(prs.find((p) => p.branch === 'flux/m2')?.reviewState).toBe('approved'); // unchanged — merge failed
    });
  });

  describe('trigger auto-ignite — positive path (a merged PR satisfies a pr-type trigger)', () => {
    it('checkTriggers auto-ignites a draft batch once its referenced PR is marked merged', async () => {
      const prUrl = 'https://github.com/o/r/pull/99';
      // A prior (terminal) batch whose PR just got merged out-of-band (the portal "Merge" action).
      const upstream = await createFurnaceBatch({ title: 'upstream', kind: 'parallel', tickets: [newBatchTicket('U1', 0)] });
      await mutateFurnaceBatch(upstream.id, (b) => {
        b.status = 'done';
        b.prs = [{ url: prUrl, branch: 'flux/u1', ticketId: 'U1', reviewState: 'merged' }];
      });

      const draft = await createFurnaceBatch({
        title: 'triggered', kind: 'parallel',
        tickets: [newBatchTicket('T1', 0)],
        trigger: { type: 'pr', ref: prUrl },
      });
      expect(getFurnaceBatch(draft.id)?.status).toBe('draft');

      await checkTriggers();

      expect(getFurnaceBatch(draft.id)?.status).toBe('burning');
      expect(getFurnaceBatch(draft.id)?.ignitedAt).toBeTruthy();
    });

    it('does not ignite while the referenced PR is still open (negative control)', async () => {
      const prUrl = 'https://github.com/o/r/pull/100';
      const upstream = await createFurnaceBatch({ title: 'upstream2', kind: 'parallel', tickets: [newBatchTicket('U2', 0)] });
      await mutateFurnaceBatch(upstream.id, (b) => {
        b.prs = [{ url: prUrl, branch: 'flux/u2', ticketId: 'U2', reviewState: 'approved' }]; // not merged yet
      });
      const draft = await createFurnaceBatch({
        title: 'not yet', kind: 'parallel',
        tickets: [newBatchTicket('T2', 0)],
        trigger: { type: 'pr', ref: prUrl },
      });

      await checkTriggers();

      expect(getFurnaceBatch(draft.id)?.status).toBe('draft');
    });
  });

  describe('PUT /:id — trigger set/clear/validation (FLUX-1142)', () => {
    it('sets a batch-type trigger, then clears it with trigger: null', async () => {
      const upstream = await createFurnaceBatch({ title: 'upstream' });
      const draft = await createFurnaceBatch({ title: 'downstream' });

      const setRes = await fetch(`${baseUrl}/api/furnace/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { type: 'batch', ref: upstream.id } }),
      });
      expect(setRes.status).toBe(200);
      expect((await setRes.json()).trigger).toEqual({ type: 'batch', ref: upstream.id });
      expect(getFurnaceBatch(draft.id)?.trigger).toEqual({ type: 'batch', ref: upstream.id });

      const clearRes = await fetch(`${baseUrl}/api/furnace/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: null }),
      });
      expect(clearRes.status).toBe(200);
      expect(getFurnaceBatch(draft.id)?.trigger).toBeUndefined();
    });

    it('rejects a batch triggering off itself with 400, leaving the trigger unset', async () => {
      const draft = await createFurnaceBatch({ title: 'self-ref' });

      const res = await fetch(`${baseUrl}/api/furnace/${draft.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { type: 'batch', ref: draft.id } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/itself/);
      expect(getFurnaceBatch(draft.id)?.trigger).toBeUndefined();
    });

    it('rejects a direct A→B→A cycle with 400, leaving both triggers as they were', async () => {
      const a = await createFurnaceBatch({ title: 'A' });
      const b = await createFurnaceBatch({ title: 'B' });
      // B already triggers after A.
      await fetch(`${baseUrl}/api/furnace/${b.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { type: 'batch', ref: a.id } }),
      });
      expect(getFurnaceBatch(b.id)?.trigger).toEqual({ type: 'batch', ref: a.id });

      // Now try to also make A trigger after B — a direct cycle.
      const res = await fetch(`${baseUrl}/api/furnace/${a.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: { type: 'batch', ref: b.id } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cycle/);
      expect(getFurnaceBatch(a.id)?.trigger).toBeUndefined();
    });
  });

  describe('FLUX-1090 — a reconcile mid-spawn does not misdetect the Furnace\'s own session as a human takeover', () => {
    it('holds the ticket queued (owner untouched) while the spawn is in flight, then completes normally', async () => {
      const batch = await createFurnaceBatch({ title: 'race', kind: 'parallel', tickets: [newBatchTicket('RACE-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; });
      tasksCache['RACE-1'] = { id: 'RACE-1', status: 'In Progress' };

      // The session goes live in the store the moment it's dispatched (mirrors the real spawn path,
      // where the CLI session registers well before the multi-second worktree creation finishes) — the
      // HTTP response (and therefore `setInFlight` recording it onto the ticket) is what's delayed.
      let releaseSpawn: () => void = () => {};
      const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
      fetchMock.mockImplementation(async (url: unknown, init: StubFetchInit) => {
        const m = String(url).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/);
        if (!m || !m[1]) throw new Error(`unexpected fetch in race test: ${String(url)}`);
        const taskId = decodeURIComponent(m[1]);
        const id = `sess-${++sessCounter}`;
        const body = JSON.parse(init.body);
        cliSessionsById.set(id, { id, taskId, status: 'running', phase: body.phase } as CliSessionRecord);
        registerSession(taskId, id);
        await spawnGate;
        return { ok: true, json: async () => ({ session: { id } }) };
      });

      const tickPromise = stokerTick(batch.id); // feedCoal dispatches RACE-1 and blocks mid-spawn
      await new Promise((r) => setTimeout(r, 100)); // let it reach the paused fetch

      // TWO polls landing squarely in the spawn window (e.g. two portal GET polls, or a tick + a poll) —
      // pre-FLUX-1090 a SINGLE such poll already misidentified the Furnace's own freshly-spawned session
      // as a human's; two also defeats the debounce (item 2) to isolate the `dispatching` guard (item 1).
      await reconcileBatch(batch.id);
      await reconcileBatch(batch.id);
      const mid = getFurnaceBatch(batch.id)!;
      expect(mid.tickets[0]!.owner).toBeUndefined();
      expect(mid.tickets[0]!.state).toBe('queued');

      releaseSpawn();
      await tickPromise;

      const done = getFurnaceBatch(batch.id)!;
      expect(done.tickets[0]!.state).toBe('implementing');
      expect(done.tickets[0]!.owner).toBeUndefined();
    });
  });

  describe('FLUX-1095 — removing a ticket while its spawn is in flight does not orphan the session', () => {
    it('rejects the removal (409) during the dispatch window; the session lands normally once it resolves', async () => {
      const batch = await createFurnaceBatch({ title: 'remove-race', kind: 'parallel', tickets: [newBatchTicket('RM-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; });
      tasksCache['RM-1'] = { id: 'RM-1', status: 'In Progress' };

      let releaseSpawn: () => void = () => {};
      const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
      fetchMock.mockImplementation(async (url: unknown, init: StubFetchInit) => {
        const m = String(url).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/);
        if (!m || !m[1]) return realFetch(url as RequestInfo | URL, init);
        const taskId = decodeURIComponent(m[1]);
        const id = `sess-${++sessCounter}`;
        const body = JSON.parse(init.body);
        cliSessionsById.set(id, { id, taskId, status: 'running', phase: body.phase } as CliSessionRecord);
        registerSession(taskId, id);
        await spawnGate;
        return { ok: true, json: async () => ({ session: { id } }) };
      });

      const tickPromise = stokerTick(batch.id); // feedCoal dispatches RM-1 and blocks mid-spawn
      await new Promise((r) => setTimeout(r, 100)); // let it reach the paused fetch

      // Pre-fix: RM-1 is still `queued` at this instant, so the "queued tickets are always removable"
      // rule let this through and orphaned the session landing underneath it.
      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/ticket/RM-1`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect(getFurnaceBatch(batch.id)?.tickets.map((t) => t.ticketId)).toEqual(['RM-1']);

      releaseSpawn();
      await tickPromise;

      const done = getFurnaceBatch(batch.id)!;
      expect(done.tickets[0]!.state).toBe('implementing');
      expect(done.tickets[0]!.currentSessionId).toBeTruthy();
    });
  });

  describe('FLUX-1095 — setInFlight defense-in-depth: an orphaned spawn gets its session stopped', () => {
    it('stops the freshly-spawned session if the ticket is no longer in the batch by the time setInFlight runs', async () => {
      const batch = await createFurnaceBatch({ title: 'orphan', kind: 'parallel', tickets: [newBatchTicket('OR-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; });
      tasksCache['OR-1'] = { id: 'OR-1', status: 'In Progress' };

      let capturedSessionId = '';
      let releaseSpawn: () => void = () => {};
      const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
      fetchMock.mockImplementation(async (url: unknown, init: StubFetchInit) => {
        const m = String(url).match(/\/api\/tasks\/([^/]+)\/cli-session\/start/);
        if (!m || !m[1]) return realFetch(url as RequestInfo | URL, init);
        const taskId = decodeURIComponent(m[1]);
        const id = `sess-${++sessCounter}`;
        capturedSessionId = id;
        const body = JSON.parse(init.body);
        cliSessionsById.set(id, { id, taskId, status: 'running', phase: body.phase } as CliSessionRecord);
        registerSession(taskId, id);
        await spawnGate;
        return { ok: true, json: async () => ({ session: { id } }) };
      });

      const tickPromise = stokerTick(batch.id); // feedCoal dispatches OR-1 and blocks mid-spawn
      await new Promise((r) => setTimeout(r, 100)); // let it reach the paused fetch

      // Simulate the ticket vanishing from the batch despite the dispatching guard (e.g. a path this fix
      // doesn't cover) — strip it directly via the store, bypassing the MCP/REST removal guard entirely.
      await mutateFurnaceBatch(batch.id, (b) => { b.tickets = b.tickets.filter((t) => t.ticketId !== 'OR-1'); });

      releaseSpawn();
      await tickPromise;

      expect(capturedSessionId).toBeTruthy();
      expect(cliSessionsById.get(capturedSessionId)?.status).toBe('cancelled');
    });
  });

  describe('FLUX-1090 — debounce: a takeover is confirmed only on the SECOND consecutive reconcile pass', () => {
    it('does not flip ownership on the first pass; confirms + settles (parity with explicit takeover) on the second', async () => {
      const batch = await createFurnaceBatch({ title: 'debounce', kind: 'parallel', tickets: [newBatchTicket('DB-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'cooling-down'; // not `isActiveTicketState` — reconcileBatch's per-ticket loop does visit it
        t.rateLimitFirstSeenAt = new Date().toISOString();
        t.nextRetryAt = new Date(Date.now() + 999_999).toISOString();
        t.preCooldownState = 'implementing';
      });
      cliSessionsById.set('human-sess', { id: 'human-sess', taskId: 'DB-1', status: 'running', phase: 'implementation' } as CliSessionRecord);
      registerSession('DB-1', 'human-sess');
      tasksCache['DB-1'] = { id: 'DB-1', status: 'In Progress' };

      await reconcileBatch(batch.id);
      const mid = getFurnaceBatch(batch.id)!;
      expect(mid.tickets[0]!.owner).toBeUndefined(); // first pass: suspected, not yet confirmed

      await reconcileBatch(batch.id);
      const after = getFurnaceBatch(batch.id)!;
      expect(after.tickets[0]!.owner).toBe('human');
      // FLUX-1090 (unify with explicit takeover): settled like takeoverTicket — parked, cooldown cleared.
      expect(after.tickets[0]!.state).toBe('parked');
      expect(after.tickets[0]!.currentSessionId).toBeUndefined();
      expect(after.tickets[0]!.nextRetryAt).toBeUndefined();
    });
  });

  describe('FLUX-1094 — reconcileBatch TOCTOU: a confirmed takeover still settles when the ticket goes active between decide and mutate', () => {
    it('force-parks (the isActiveTicketState half of the settling guard) instead of leaving an active-state human takeover unparked', async () => {
      const batch = await createFurnaceBatch({ title: 'toctou', kind: 'parallel', tickets: [newBatchTicket('TT-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; });
      cliSessionsById.set('human-sess', { id: 'human-sess', taskId: 'TT-1', status: 'running', phase: 'implementation' } as CliSessionRecord);
      registerSession('TT-1', 'human-sess');
      tasksCache['TT-1'] = { id: 'TT-1', status: 'In Progress' };

      // Pass 1 seeds the debounce — ticket stays `queued`, not yet confirmed (mirrors the FLUX-1090 debounce
      // test above, but with the ticket left `queued` instead of `cooling-down`, since that's the untested
      // half of the settling guard: furnace-stoker.ts's `isActiveTicketState(t.state) || t.state ===
      // 'cooling-down'`).
      await reconcileBatch(batch.id);
      expect(getFurnaceBatch(batch.id)!.tickets[0]!.owner).toBeUndefined();

      // Pass 2 lands the actual TOCTOU race: `mutateFurnaceBatch` always re-reads `cache[id]` fresh under
      // its per-batch lock rather than reusing the snapshot `reconcileBatch` read at function entry. `flip`
      // (standing in for a concurrent `feedCoal`/`setInFlight` dispatching this same ticket) attaches to the
      // per-batch mutate lock chain FIRST but hasn't executed yet, so `reconcileBatch`'s synchronous
      // decide-loop — which runs immediately, before any microtask can run `flip`'s write — still observes
      // `queued` and is not skipped by the loop-entry `isActiveTicketState` guard. By the time
      // `reconcileBatch`'s own mutate callback runs (queued behind `flip` on the same lock), the ticket is
      // already `implementing`.
      const flip = mutateFurnaceBatch(batch.id, (b) => {
        const t = b.tickets.find((x) => x.ticketId === 'TT-1')!;
        t.state = 'implementing';
        t.currentPhase = 'implementation';
        t.currentSessionId = 'furnace-sess';
        t.sessionIds.push('furnace-sess');
      });
      const reconcile = reconcileBatch(batch.id);
      await Promise.all([flip, reconcile]);

      const after = getFurnaceBatch(batch.id)!;
      expect(after.tickets[0]!.owner).toBe('human');
      expect(after.tickets[0]!.state).toBe('parked');
      expect(after.tickets[0]!.currentSessionId).toBeUndefined();
      expect(after.tickets[0]!.currentPhase).toBeUndefined();
    });
  });

  describe('FLUX-1090 — handBackTicket reclaims a ticket stuck in an active state (a zombie takeover)', () => {
    it('stops the live session and re-queues under Furnace ownership, bypassing the still-burning rejection', async () => {
      const batch = await createFurnaceBatch({ title: 'zombie', kind: 'parallel', tickets: [newBatchTicket('Z-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        // Models a pre-fix zombie: owner flipped to human but the state was never settled, so it's stuck
        // `implementing` — the exact shape that made `retryRejectionReason` reject hand-back before FLUX-1090.
        t.state = 'implementing';
        t.owner = 'human';
        t.currentSessionId = 'zombie-sess';
        t.currentPhase = 'implementation';
        t.sessionIds = ['zombie-sess'];
      });
      cliSessionsById.set('zombie-sess', { id: 'zombie-sess', taskId: 'Z-1', status: 'running', phase: 'implementation' } as CliSessionRecord);
      registerSession('Z-1', 'zombie-sess');

      const r = await handBackTicket(batch.id, 'Z-1');
      expect(r.ok).toBe(true);
      expect(cliSessionsById.get('zombie-sess')?.status).toBe('cancelled');

      const after = getFurnaceBatch(batch.id)!;
      expect(after.tickets[0]!.state).toBe('queued');
      expect(after.tickets[0]!.owner).toBe('furnace');
      expect(after.tickets[0]!.currentSessionId).toBeUndefined();
    });
  });

  // FLUX-1070: the manual recovery controllers (retryTicket/resumeBatch/dismissTicketFlag/takeoverTicket)
  // had zero test coverage — only their pure decision helpers (retryRejectionReason, etc., in
  // furnace-batch.test.ts) were exercised. These cover the actual state transitions against the real store.
  describe('FLUX-1070 — retryTicket (M2 pr-open guard + fresh attempt budget)', () => {
    it('resets a parked ticket to queued with a fresh attempt budget, owner back to furnace', async () => {
      const batch = await createFurnaceBatch({ title: 'retry me', kind: 'parallel', tickets: [newBatchTicket('RT-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'parked';
        t.attempts = 2;
        t.failureClass = 'needs-input';
        t.note = 'needs input';
        t.owner = 'human';
      });

      const r = await retryTicket(batch.id, 'RT-1');
      expect(r.ok).toBe(true);

      const after = getFurnaceBatch(batch.id)!;
      const t = after.tickets[0]!;
      expect(t.state).toBe('queued');
      expect(t.attempts).toBe(0);
      expect(t.owner).toBe('furnace');
      expect(t.failureClass).toBeUndefined();
      expect(t.note).toBeUndefined();
    });

    it('rejects a pr-open ticket without force (would drop the open PR + duplicate the burn), leaving it untouched', async () => {
      const batch = await createFurnaceBatch({ title: 'already shipped', kind: 'parallel', tickets: [newBatchTicket('RT-2', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        const t = b.tickets[0]!;
        t.state = 'pr-open';
        t.prUrl = 'http://pr/1';
      });

      const r = await retryTicket(batch.id, 'RT-2');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/open PR/);

      const after = getFurnaceBatch(batch.id)!;
      expect(after.tickets[0]!.state).toBe('pr-open');
      expect(after.tickets[0]!.prUrl).toBe('http://pr/1');
    });
  });

  describe('FLUX-1070 — resumeBatch (halted → burning, breaker reset, halt-skipped tickets re-queued)', () => {
    it('resets the breaker, clears the stop request, re-queues halt-skipped tickets, and starts burning', async () => {
      const batch = await createFurnaceBatch({ title: 'halted', kind: 'parallel', tickets: [newBatchTicket('RB-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'parked';
        b.consecutiveFailures = 3;
        b.stopRequested = true;
        b.stopReason = 'prior halt';
        const t = b.tickets[0]!;
        t.state = 'skipped';
        t.note = 'batch halted before this ticket started';
      });

      const r = await resumeBatch(batch.id);
      expect(r.ok).toBe(true);
      expect(r.batch?.status).toBe('burning');
      expect(r.batch?.consecutiveFailures).toBe(0);
      expect(r.batch?.stopRequested).toBeUndefined();

      const after = getFurnaceBatch(batch.id)!;
      const t = after.tickets[0]!;
      expect(t.state).toBe('queued');
      expect(t.owner).toBe('furnace');
      expect(t.note).toBeUndefined();
    });

    it('is idempotent for an already-burning batch', async () => {
      const batch = await createFurnaceBatch({ title: 'already burning', kind: 'parallel', tickets: [newBatchTicket('RB-2', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; });

      const r = await resumeBatch(batch.id);
      expect(r.ok).toBe(true);
      expect(r.batch?.status).toBe('burning');
    });

    it('rejects a draft batch — ignite it instead', async () => {
      const batch = await createFurnaceBatch({ title: 'still a draft', kind: 'parallel', tickets: [newBatchTicket('RB-3', 0)] });

      const r = await resumeBatch(batch.id);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/ignite/);
    });

    it('returns no_slots when every worktree slot is already in use', async () => {
      await fillSlots(FURNACE_SLOT_CAP);
      const batch = await createFurnaceBatch({ title: 'halted, no room', kind: 'sequential', tickets: [newBatchTicket('RB-4', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'parked'; });

      const r = await resumeBatch(batch.id);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('no_slots');
      expect(getFurnaceBatch(batch.id)?.status).toBe('parked'); // never claimed
    });
  });

  describe('FLUX-1070 — dismissTicketFlag ("I\'ve got this" — clears the flag WITHOUT re-queuing)', () => {
    it('marks the ticket flagDismissed but leaves its state exactly as parked (no re-queue)', async () => {
      const batch = await createFurnaceBatch({ title: 'dismiss me', kind: 'parallel', tickets: [newBatchTicket('DF-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        const t = b.tickets[0]!;
        t.state = 'parked';
        t.failureClass = 'needs-input';
        t.note = 'needs input';
      });

      const r = await dismissTicketFlag(batch.id, 'DF-1');
      expect(r.ok).toBe(true);

      const after = getFurnaceBatch(batch.id)!;
      const t = after.tickets[0]!;
      expect(t.flagDismissed).toBe(true);
      expect(t.state).toBe('parked'); // NOT re-queued — this is the "I've got this" path, not retry
      expect(t.note).toBe('needs input'); // untouched
    });

    it('errors clearly when the ticket is not in the batch', async () => {
      const batch = await createFurnaceBatch({ title: 'empty', kind: 'parallel', tickets: [newBatchTicket('DF-2', 0)] });
      const r = await dismissTicketFlag(batch.id, 'NOT-IN-BATCH');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Ticket not in batch');
    });
  });

  describe('FLUX-1070 — takeoverTicket (owner → human)', () => {
    it('settles an active ticket to parked, stops its live session, and flips owner to human', async () => {
      const batch = await createFurnaceBatch({ title: 'takeover active', kind: 'parallel', tickets: [newBatchTicket('TO-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'implementing';
        t.currentSessionId = 'sess-live';
        t.currentPhase = 'implementation';
        t.sessionIds = ['sess-live'];
      });
      cliSessionsById.set('sess-live', { id: 'sess-live', taskId: 'TO-1', status: 'running', phase: 'implementation' } as CliSessionRecord);
      registerSession('TO-1', 'sess-live');

      const r = await takeoverTicket(batch.id, 'TO-1');
      expect(r.ok).toBe(true);
      expect(cliSessionsById.get('sess-live')?.status).toBe('cancelled');

      const after = getFurnaceBatch(batch.id)!;
      const t = after.tickets[0]!;
      expect(t.owner).toBe('human');
      expect(t.state).toBe('parked');
      expect(t.failureClass).toBeUndefined();
      expect(t.currentSessionId).toBeUndefined();
    });

    it('a queued (not-yet-active) ticket is owner-flipped without touching its state', async () => {
      const batch = await createFurnaceBatch({ title: 'takeover queued', kind: 'parallel', tickets: [newBatchTicket('TO-2', 0)] });

      const r = await takeoverTicket(batch.id, 'TO-2');
      expect(r.ok).toBe(true);

      const after = getFurnaceBatch(batch.id)!;
      expect(after.tickets[0]!.owner).toBe('human');
      expect(after.tickets[0]!.state).toBe('queued');
    });
  });

  // FLUX-1080: the sole-reviewer focusComment (the FLUX-1078 root-cause fix that authorizes a reviewer
  // persona to call change_status) was previously verified only by manual code tracing. Assert it actually
  // reaches the outgoing /cli-session/start body for every dispatch path that can (re-)start a review
  // session, so a future refactor of any of these paths can't silently drop it.
  describe('FLUX-1080 — sole-reviewer focusComment reaches every review-phase dispatch path', () => {
    function reviewStartBodyFor(ticketId: string): CliSessionStartRequestBody {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(`/${ticketId}/cli-session/start`));
      expect(call, `expected a /cli-session/start dispatch for ${ticketId}`).toBeTruthy();
      return JSON.parse(call![1].body);
    }

    it('review — dispatched once an implementation session completes', async () => {
      const batch = await createFurnaceBatch({ title: 'review dispatch', kind: 'parallel', tickets: [newBatchTicket('FR-1', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'implementing';
        t.currentSessionId = 'sess-fr1-impl';
        t.sessionIds = ['sess-fr1-impl'];
      });
      cliSessionsById.set('sess-fr1-impl', { id: 'sess-fr1-impl', taskId: 'FR-1', status: 'completed', phase: 'implementation' } as CliSessionRecord);
      tasksCache['FR-1'] = { id: 'FR-1', status: 'In Progress' };

      await stokerTick(batch.id);

      const body = reviewStartBodyFor('FR-1');
      expect(body.phase).toBe('review');
      expect(body.focusComment).toBe(SOLE_REVIEWER_FOCUS);
    });

    it('redrive — dispatched when a reviewing ticket has no observable session (e.g. after an engine restart)', async () => {
      const batch = await createFurnaceBatch({ title: 'redrive dispatch', kind: 'parallel', tickets: [newBatchTicket('FR-2', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => { b.status = 'burning'; b.tickets[0]!.state = 'reviewing'; });
      tasksCache['FR-2'] = { id: 'FR-2', status: 'In Progress' };

      await stokerTick(batch.id);

      const body = reviewStartBodyFor('FR-2');
      expect(body.phase).toBe('review');
      expect(body.focusComment).toBe(SOLE_REVIEWER_FOCUS);
    });

    it('retry-exhausted — dispatched when a reviewing session dies from context exhaustion', async () => {
      const batch = await createFurnaceBatch({ title: 'retry-exhausted dispatch', kind: 'parallel', tickets: [newBatchTicket('FR-3', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'reviewing';
        t.currentSessionId = 'sess-fr3-rev';
        t.sessionIds = ['sess-fr3-rev'];
      });
      cliSessionsById.set('sess-fr3-rev', { id: 'sess-fr3-rev', taskId: 'FR-3', status: 'failed', phase: 'review', terminalReason: 'context-exhausted' } as CliSessionRecord);
      tasksCache['FR-3'] = { id: 'FR-3', status: 'In Progress' };

      await stokerTick(batch.id);

      const body = reviewStartBodyFor('FR-3');
      expect(body.phase).toBe('review');
      expect(body.focusComment).toBe(SOLE_REVIEWER_FOCUS);
    });

    it("retry-rate-limited — dispatched when a reviewing ticket's rate-limit cooldown elapses", async () => {
      const batch = await createFurnaceBatch({ title: 'retry-rate-limited dispatch', kind: 'parallel', tickets: [newBatchTicket('FR-4', 0)] });
      await mutateFurnaceBatch(batch.id, (b) => {
        b.status = 'burning';
        const t = b.tickets[0]!;
        t.state = 'cooling-down';
        t.preCooldownState = 'reviewing';
        t.rateLimitFirstSeenAt = new Date(Date.now() - 60_000).toISOString();
        t.nextRetryAt = new Date(Date.now() - 1_000).toISOString();
      });
      tasksCache['FR-4'] = { id: 'FR-4', status: 'In Progress' };

      await stokerTick(batch.id);

      const body = reviewStartBodyFor('FR-4');
      expect(body.phase).toBe('review');
      expect(body.focusComment).toBe(SOLE_REVIEWER_FOCUS);
    });
  });
});

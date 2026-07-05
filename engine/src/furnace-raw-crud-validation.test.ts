// The Furnace — raw-CRUD ticket validation + kind coercion (FLUX-1029).
//
// The raw REST endpoints let a caller hand-build a batch's ticket list from arbitrary ids, bypassing
// the builder's existence/status gate. These tests pin the shared `validateBatchTickets` gate, the
// route-level `resolveTickets` resolver that wires it into POST/PUT/append, and a regression guard for
// the already-closed `kind` enum gap (`coerceKind` drops any non-`sequential`/`parallel` value).
//
// The route-level describe block below (FLUX-1074) additionally drives the real Express routes over
// HTTP — resolveTickets/validateBatchTickets are pure-function-tested above, but nothing previously
// exercised POST /, PUT /:id, and POST /:id/ticket end-to-end to confirm the 400 `{ error, rejected }`
// wiring (and the happy-path 201/200) actually reaches the wire.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { validateBatchTickets } from './furnace-builder.js';
import furnaceRouter, { coerceKind, resolveTickets } from './routes/furnace.js';
import { requireWorkspace } from './middleware.js';
import { tasksCache } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';
import { createFurnaceBatch, getFurnaceBatch, ensureFurnaceLoaded, __resetFurnaceStoreForTests } from './furnace-store.js';
import { newBatchTicket, type FurnaceBatch } from './models/furnace.js';

describe('validateBatchTickets', () => {
  const cache = {
    'FLUX-1': { status: 'Todo', title: 'One' },
    'FLUX-2': { status: 'Todo', title: 'Two' },
    'FLUX-3': { status: 'In Progress', title: 'Three' },
  };

  it('accepts existing groomed tickets, contiguously ordered with denormalized titles', () => {
    const { ok, rejected } = validateBatchTickets(['FLUX-1', 'FLUX-2'], cache);
    expect(rejected).toEqual([]);
    expect(ok.map((t) => [t.ticketId, t.order, t.title])).toEqual([
      ['FLUX-1', 0, 'One'],
      ['FLUX-2', 1, 'Two'],
    ]);
    expect(ok.every((t) => t.state === 'queued')).toBe(true);
  });

  it('rejects an unknown id as `unknown`', () => {
    const { ok, rejected } = validateBatchTickets(['FLUX-1', 'FLUX-999'], cache);
    expect(ok.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    expect(rejected).toEqual([{ ticketId: 'FLUX-999', reason: 'unknown' }]);
  });

  it('rejects a ticket whose status is not in the allowed set as `bad-status`', () => {
    const { rejected } = validateBatchTickets(['FLUX-3'], cache);
    expect(rejected).toEqual([{ ticketId: 'FLUX-3', reason: 'bad-status' }]);
  });

  it('honours an allowedStatuses override to widen the gate', () => {
    const { ok, rejected } = validateBatchTickets(['FLUX-3'], cache, { allowedStatuses: ['Todo', 'In Progress'] });
    expect(rejected).toEqual([]);
    expect(ok.map((t) => t.ticketId)).toEqual(['FLUX-3']);
  });

  it('keeps accepted ordering contiguous even when ids interleave with rejects', () => {
    const { ok, rejected } = validateBatchTickets(['FLUX-999', 'FLUX-1', 'FLUX-3', 'FLUX-2'], cache);
    expect(ok.map((t) => [t.ticketId, t.order])).toEqual([['FLUX-1', 0], ['FLUX-2', 1]]);
    expect(rejected).toEqual([
      { ticketId: 'FLUX-999', reason: 'unknown' },
      { ticketId: 'FLUX-3', reason: 'bad-status' },
    ]);
  });
});

describe('validateBatchTickets — one-active-batch invariant (FLUX-1051)', () => {
  const cache = {
    'FLUX-1': { status: 'Todo', title: 'One' },
    'FLUX-2': { status: 'Todo', title: 'Two' },
  };

  it('rejects a ticket already queued in another non-terminal batch as `already-active`, naming the owner', () => {
    const activeBatches = [
      { id: 'batch-a', status: 'burning', tickets: [{ ticketId: 'FLUX-1' }] },
    ] as unknown as FurnaceBatch[];
    const { ok, rejected } = validateBatchTickets(['FLUX-1', 'FLUX-2'], cache, { activeBatches });
    expect(ok.map((t) => t.ticketId)).toEqual(['FLUX-2']);
    expect(rejected).toEqual([{ ticketId: 'FLUX-1', reason: 'already-active', batchId: 'batch-a' }]);
  });

  it('excludeBatchId lets a batch keep/re-save its own tickets without self-conflicting', () => {
    const activeBatches = [
      { id: 'batch-a', status: 'burning', tickets: [{ ticketId: 'FLUX-1' }] },
    ] as unknown as FurnaceBatch[];
    const { ok, rejected } = validateBatchTickets(['FLUX-1'], cache, { activeBatches, excludeBatchId: 'batch-a' });
    expect(rejected).toEqual([]);
    expect(ok.map((t) => t.ticketId)).toEqual(['FLUX-1']);
  });

  it('a ticket in a terminal (done/parked) batch is not considered active', () => {
    const activeBatches = [
      { id: 'batch-a', status: 'done', tickets: [{ ticketId: 'FLUX-1' }] },
    ] as unknown as FurnaceBatch[];
    const { ok, rejected } = validateBatchTickets(['FLUX-1'], cache, { activeBatches });
    expect(rejected).toEqual([]);
    expect(ok.map((t) => t.ticketId)).toEqual(['FLUX-1']);
  });

  it('bad-status is still checked before the cross-batch check', () => {
    const wideCache = { 'FLUX-3': { status: 'Done', title: 'Three' } };
    const activeBatches = [
      { id: 'batch-a', status: 'burning', tickets: [{ ticketId: 'FLUX-3' }] },
    ] as unknown as FurnaceBatch[];
    const { rejected } = validateBatchTickets(['FLUX-3'], wideCache, { activeBatches });
    expect(rejected).toEqual([{ ticketId: 'FLUX-3', reason: 'bad-status' }]);
  });
});

describe('resolveTickets (route resolver over tasksCache)', () => {
  // resolveTickets now also reads the furnace-store batch cache (activeBatches, FLUX-1051) — reset it so
  // this block's assertions never depend on batch state leaked from another describe block/test order.
  beforeEach(() => {
    __resetFurnaceStoreForTests();
  });

  afterEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  });

  it('returns {} when the body carries no tickets', () => {
    expect(resolveTickets({ title: 'x' })).toEqual({});
  });

  it('passes full ticket entries already in the batch through unvalidated (re-sequencing)', () => {
    // A burning ticket (status not Todo) must survive a round-trip — full entries already in the
    // batch are curated state being re-sequenced, not a hand-supplied id list.
    const entries = [{ ticketId: 'GONE-1', order: 0, state: 'implementing', attempts: 0, sessionIds: [] }];
    const res = resolveTickets({ tickets: entries }, { currentTicketIds: ['GONE-1'] });
    expect(res.tickets).toBe(entries);
  });

  it('FLUX-1103: validates a full-object entry naming an id NOT already in the batch', () => {
    // Without currentTicketIds (or with an id missing from it), a full-object `tickets` array can no
    // longer smuggle in a brand-new id unvalidated — it must exist and be groomed like any other id.
    const entries = [{ ticketId: 'NOPE-9', order: 0, state: 'queued', attempts: 0, sessionIds: [] }];
    const res = resolveTickets({ tickets: entries });
    expect(res.tickets).toBeUndefined();
    expect(res.rejected).toEqual([{ ticketId: 'NOPE-9', reason: 'unknown' }]);
  });

  it('FLUX-1103: validates only the new id in a mixed full-object array, leaving existing ids alone', () => {
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    const entries = [
      { ticketId: 'GONE-1', order: 0, state: 'implementing', attempts: 0, sessionIds: [] },
      { ticketId: 'FLUX-1', order: 1, state: 'queued', attempts: 0, sessionIds: [] },
    ];
    const res = resolveTickets({ tickets: entries }, { currentTicketIds: ['GONE-1'] });
    expect(res.rejected).toBeUndefined();
    // The existing-batch entry passes through untouched (same object)...
    expect(res.tickets?.[0]).toBe(entries[0]);
    // ...but the newly-validated entry is rebuilt fresh rather than trusted verbatim (FLUX-1111).
    expect(res.tickets?.[1]).toEqual({ ticketId: 'FLUX-1', order: 1, state: 'queued', attempts: 0, sessionIds: [], title: 'One' });
  });

  it('FLUX-1111: rebuilds a newly-validated entry from scratch, dropping forged Stoker state', () => {
    // Before the fix, a brand-new id that legitimately exists/is Todo/isn't queued elsewhere still had
    // its entire client-supplied object trusted verbatim — including a forged `state`, inflated
    // `attempts`, fabricated `sessionIds`/`currentSessionId`/`prUrl`, or `owner: 'human'`. Only the
    // client-requested `order` and the real ticket title should survive.
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    const entries = [
      { ticketId: 'GONE-1', order: 0, state: 'implementing', attempts: 0, sessionIds: [] },
      {
        ticketId: 'FLUX-1',
        order: 1,
        state: 'pr-open',
        attempts: 7,
        sessionIds: ['sess-forged'],
        currentSessionId: 'sess-forged',
        prUrl: 'https://github.com/example/example/pull/999',
        owner: 'human',
        failureClass: 'rate-limit',
      },
    ];
    const res = resolveTickets({ tickets: entries }, { currentTicketIds: ['GONE-1'] });
    expect(res.rejected).toBeUndefined();
    expect(res.tickets?.[0]).toBe(entries[0]);
    expect(res.tickets?.[1]).toEqual({ ticketId: 'FLUX-1', order: 1, state: 'queued', attempts: 0, sessionIds: [], title: 'One' });
  });

  it('validates a ticketIds list and rejects unknown ids with a 400-shaped result', () => {
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    const res = resolveTickets({ ticketIds: ['FLUX-1', 'NOPE-9'] });
    expect(res.tickets).toBeUndefined();
    expect(res.rejected).toEqual([{ ticketId: 'NOPE-9', reason: 'unknown' }]);
  });

  it('resolves a fully-groomed ticketIds list into queued tickets', () => {
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    tasksCache['FLUX-2'] = { status: 'Todo', title: 'Two' };
    const res = resolveTickets({ ticketIds: ['FLUX-1', 'FLUX-2'] });
    expect(res.rejected).toBeUndefined();
    expect(res.tickets?.map((t) => t.ticketId)).toEqual(['FLUX-1', 'FLUX-2']);
  });

  it('rejects a bad-status id in a string `tickets` list', () => {
    tasksCache['FLUX-3'] = { status: 'Done', title: 'Three' };
    const res = resolveTickets({ tickets: ['FLUX-3'] });
    expect(res.rejected).toEqual([{ ticketId: 'FLUX-3', reason: 'bad-status' }]);
  });
});

describe('resolveTickets — one-active-batch invariant wiring against the real store (FLUX-1051)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-resolve-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a ticketIds create/update payload naming an id already queued elsewhere', async () => {
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    const owner = await createFurnaceBatch({ title: 'Owner batch', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });

    const res = resolveTickets({ ticketIds: ['FLUX-1'] });
    expect(res.tickets).toBeUndefined();
    expect(res.rejected).toEqual([{ ticketId: 'FLUX-1', reason: 'already-active', batchId: owner.id }]);
  });

  it('excludeBatchId lets a PUT re-save the batch\'s own tickets without self-conflicting', async () => {
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    const owner = await createFurnaceBatch({ title: 'Owner batch', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });

    const res = resolveTickets({ ticketIds: ['FLUX-1'] }, { excludeBatchId: owner.id });
    expect(res.rejected).toBeUndefined();
    expect(res.tickets?.map((t) => t.ticketId)).toEqual(['FLUX-1']);
  });

  it('FLUX-1103: rejects a full-object tickets payload introducing an id already queued elsewhere', async () => {
    tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
    const owner = await createFurnaceBatch({ title: 'Owner batch', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });
    const target = await createFurnaceBatch({ title: 'Target batch' });

    const entries = [{ ticketId: 'FLUX-1', order: 0, state: 'queued', attempts: 0, sessionIds: [] }];
    const res = resolveTickets({ tickets: entries }, { excludeBatchId: target.id, currentTicketIds: [] });
    expect(res.tickets).toBeUndefined();
    expect(res.rejected).toEqual([{ ticketId: 'FLUX-1', reason: 'already-active', batchId: owner.id }]);
  });
});

describe('coerceKind (regression guard for the already-closed kind enum gap)', () => {
  it('passes the two valid kinds through', () => {
    expect(coerceKind('sequential')).toBe('sequential');
    expect(coerceKind('parallel')).toBe('parallel');
  });
  it('drops any other value so the store keeps its default (no raw string persisted)', () => {
    expect(coerceKind('garbage')).toBeUndefined();
    expect(coerceKind('')).toBeUndefined();
    expect(coerceKind(undefined)).toBeUndefined();
    expect(coerceKind(42)).toBeUndefined();
    expect(coerceKind(null)).toBeUndefined();
  });
});

/** The subset of a POST/PUT /api/furnace JSON response body these route tests assert on. */
interface FurnaceRouteBody {
  title?: string;
  error?: string;
  rejected?: { ticketId: string; reason: string; batchId?: string }[];
  tickets: { ticketId: string; state?: string }[];
}

describe('Furnace routes — raw-CRUD validation over HTTP (FLUX-1074)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-route-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    await ensureFurnaceLoaded();
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];

    const app = express();
    app.use(express.json());
    app.use('/api/furnace', requireWorkspace, furnaceRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  describe('POST /api/furnace', () => {
    it('rejects an unknown / bad-status ticket id with 400 { error, rejected }', async () => {
      tasksCache['FLUX-3'] = { status: 'Done', title: 'Three' };

      const res = await fetch(`${baseUrl}/api/furnace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Bad batch', ticketIds: ['FLUX-3', 'NOPE-9'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.rejected).toEqual([
        { ticketId: 'FLUX-3', reason: 'bad-status' },
        { ticketId: 'NOPE-9', reason: 'unknown' },
      ]);
      expect(body.error).toMatch(/cannot be added to a batch/);
    });

    it('creates a batch (201) with a fully-groomed ticketIds list', async () => {
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };

      const res = await fetch(`${baseUrl}/api/furnace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Good batch', ticketIds: ['FLUX-1'] }),
      });

      expect(res.status).toBe(201);
      const body: FurnaceRouteBody = await res.json();
      expect(body.title).toBe('Good batch');
      expect(body.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    });
  });

  describe('PUT /api/furnace/:id', () => {
    it('rejects an unknown / bad-status ticket id with 400 { error, rejected }', async () => {
      const batch = await createFurnaceBatch({ title: 'Existing' });
      tasksCache['FLUX-3'] = { status: 'Done', title: 'Three' };

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketIds: ['FLUX-3'] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.rejected).toEqual([{ ticketId: 'FLUX-3', reason: 'bad-status' }]);
      expect(getFurnaceBatch(batch.id)?.tickets).toEqual([]); // rejected update never touched the batch
    });

    it('updates a batch (200) with a fully-groomed ticketIds list', async () => {
      const batch = await createFurnaceBatch({ title: 'Existing' });
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed', ticketIds: ['FLUX-1'] }),
      });

      expect(res.status).toBe(200);
      const body: FurnaceRouteBody = await res.json();
      expect(body.title).toBe('Renamed');
      expect(body.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    });

    it('FLUX-1103: reorders a full-object tickets payload of the batch\'s own tickets unvalidated', async () => {
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
      tasksCache['FLUX-2'] = { status: 'Todo', title: 'Two' };
      const batch = await createFurnaceBatch({
        title: 'Existing',
        tickets: [newBatchTicket('FLUX-1', 0, 'One'), newBatchTicket('FLUX-2', 1, 'Two')],
      });
      // Re-sequence with a ticket mid-burn (status not Todo) — a reorder must survive even though this
      // state could never pass the id-list validation gate.
      const reordered = [
        { ticketId: 'FLUX-2', order: 0, state: 'implementing', attempts: 0, sessionIds: [] },
        { ticketId: 'FLUX-1', order: 1, state: 'queued', attempts: 0, sessionIds: [] },
      ];

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickets: reordered }),
      });

      expect(res.status).toBe(200);
      const body: FurnaceRouteBody = await res.json();
      expect(body.tickets.map((t) => [t.ticketId, t.state])).toEqual([
        ['FLUX-2', 'implementing'],
        ['FLUX-1', 'queued'],
      ]);
    });

    it('FLUX-1103: rejects a full-object tickets payload introducing a brand-new id already active elsewhere', async () => {
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };
      const owner = await createFurnaceBatch({ title: 'Owner batch', tickets: [newBatchTicket('FLUX-1', 0, 'One')] });
      const target = await createFurnaceBatch({ title: 'Target batch' });

      const smuggled = [{ ticketId: 'FLUX-1', order: 0, state: 'queued', attempts: 0, sessionIds: [] }];
      const res = await fetch(`${baseUrl}/api/furnace/${target.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickets: smuggled }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.rejected).toEqual([{ ticketId: 'FLUX-1', reason: 'already-active', batchId: owner.id }]);
      expect(getFurnaceBatch(target.id)?.tickets).toEqual([]); // rejected update never touched the batch
    });

    it('FLUX-1103: rejects a full-object tickets payload introducing an unknown id', async () => {
      const batch = await createFurnaceBatch({ title: 'Existing' });

      const smuggled = [{ ticketId: 'NOPE-9', order: 0, state: 'queued', attempts: 0, sessionIds: [] }];
      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickets: smuggled }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.rejected).toEqual([{ ticketId: 'NOPE-9', reason: 'unknown' }]);
    });
  });

  describe('POST /api/furnace/:id/ticket', () => {
    it('rejects appending an unknown ticket id with 400 { error, rejected }', async () => {
      const batch = await createFurnaceBatch({ title: 'Append target' });

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'NOPE-9' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.rejected).toEqual([{ ticketId: 'NOPE-9', reason: 'unknown' }]);
      expect(getFurnaceBatch(batch.id)?.tickets).toEqual([]);
    });

    it('rejects appending a bad-status ticket id with 400 { error, rejected }', async () => {
      const batch = await createFurnaceBatch({ title: 'Append target' });
      tasksCache['FLUX-3'] = { status: 'Done', title: 'Three' };

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'FLUX-3' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.rejected).toEqual([{ ticketId: 'FLUX-3', reason: 'bad-status' }]);
      expect(getFurnaceBatch(batch.id)?.tickets).toEqual([]);
    });

    it('appends a valid ticket id (200)', async () => {
      const batch = await createFurnaceBatch({ title: 'Append target' });
      tasksCache['FLUX-1'] = { status: 'Todo', title: 'One' };

      const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/ticket`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'FLUX-1' }),
      });

      expect(res.status).toBe(200);
      const body: FurnaceRouteBody = await res.json();
      expect(body.tickets.map((t) => t.ticketId)).toEqual(['FLUX-1']);
    });
  });
});

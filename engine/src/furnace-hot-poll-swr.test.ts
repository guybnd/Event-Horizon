// The Furnace — GET routes must not block on the reconcile/pool-refresh pass (FLUX-1185).
//
// FLUX-1145/1069 already TTL-gate + single-flight `reconcileBatchCached`/`reconcileAllBatchesCached`
// and `refreshWorktreePool`, but the ROUTE HANDLERS still awaited them before answering — so any poll
// landing past the TTL (nearly every one, since the portal's ~3s cadence sits right against the
// ~3s/1.5s TTLs) paid the full reconcile / `git worktree list` cost inline (694-906ms measured in
// production). These mock the three gated functions with promises the test controls, so a route that
// regressed to awaiting them would leave `fetch` hanging until the test times out — proving the
// response comes from the already-cached state instead.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot } from './workspace.js';
import { requireWorkspace } from './middleware.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

let reconcileGate = deferred();
let poolGate = deferred();
// Defaults to "already scanned" so these tests exercise steady-state SWR behavior; the FLUX-1187
// describe block below flips this to false to exercise the very-first-call-after-boot exception.
let hasScannedPool = true;
const reconcileAllBatchesCached = vi.fn(() => reconcileGate.promise);
const reconcileBatchCached = vi.fn((_id: string) => reconcileGate.promise);
const refreshWorktreePool = vi.fn(() => poolGate.promise);
const hasScannedWorktreePool = vi.fn(() => hasScannedPool);

vi.mock('./furnace-stoker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./furnace-stoker.js')>();
  return {
    ...actual,
    reconcileAllBatchesCached: () => reconcileAllBatchesCached(),
    reconcileBatchCached: (id: string) => reconcileBatchCached(id),
    refreshWorktreePool: () => refreshWorktreePool(),
    hasScannedWorktreePool: () => hasScannedWorktreePool(),
  };
});

import furnaceRouter from './routes/furnace.js';
import { createFurnaceBatch, __resetFurnaceStoreForTests } from './furnace-store.js';
import { newBatchTicket } from './models/furnace.js';
import { tasksCache } from './task-store.js';

describe('Furnace GET routes serve stale-while-revalidate (FLUX-1185)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-swr-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];

    reconcileGate = deferred();
    poolGate = deferred();
    hasScannedPool = true;
    reconcileAllBatchesCached.mockClear();
    reconcileBatchCached.mockClear();
    refreshWorktreePool.mockClear();
    hasScannedWorktreePool.mockClear();

    const app = express();
    app.use(express.json());
    app.use('/api/furnace', requireWorkspace, furnaceRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    // Never leave a gated mock hanging into the next test.
    reconcileGate.resolve();
    poolGate.resolve();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('GET / answers from the cache without waiting for the background reconcile/pool-refresh', async () => {
    await createFurnaceBatch({ title: 'test', tickets: [newBatchTicket('R-1', 0, 'R-1')] });

    const res = await fetch(`${baseUrl}/api/furnace`);
    expect(res.status).toBe(200);
    const batches = await res.json();
    expect(batches).toHaveLength(1);
    // Both gates are still unresolved at this point — a route that awaited them would still be
    // pending, and the `fetch` above would never have settled.
    expect(reconcileAllBatchesCached).toHaveBeenCalledTimes(1);
    expect(refreshWorktreePool).toHaveBeenCalledTimes(1);
  });

  it('GET /slots answers from the cache without waiting for the background pool-refresh', async () => {
    const res = await fetch(`${baseUrl}/api/furnace/slots`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('used');
    expect(body).toHaveProperty('free');
    expect(refreshWorktreePool).toHaveBeenCalledTimes(1);
  });

  it('GET /:id answers from the cache without waiting for the background reconcile', async () => {
    const batch = await createFurnaceBatch({ title: 'test', tickets: [newBatchTicket('R-2', 0, 'R-2')] });

    const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(batch.id);
    expect(reconcileBatchCached).toHaveBeenCalledTimes(1);
  });

  it('a rejected background reconcile does not surface as a 500 to the poller', async () => {
    await createFurnaceBatch({ title: 'test', tickets: [newBatchTicket('R-3', 0, 'R-3')] });
    reconcileAllBatchesCached.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const res = await fetch(`${baseUrl}/api/furnace`);
    expect(res.status).toBe(200);
    const batches = await res.json();
    expect(batches).toHaveLength(1);
  });
});

describe('Furnace GET / and GET /slots block on the very first worktree-pool scan after boot (FLUX-1187)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-swr-first-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    __resetFurnaceStoreForTests();
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];

    reconcileGate = deferred();
    poolGate = deferred();
    hasScannedPool = false; // no scan since boot yet — the case this ticket fixes
    reconcileAllBatchesCached.mockClear();
    reconcileBatchCached.mockClear();
    refreshWorktreePool.mockClear();
    hasScannedWorktreePool.mockClear();

    const app = express();
    app.use(express.json());
    app.use('/api/furnace', requireWorkspace, furnaceRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    reconcileGate.resolve();
    poolGate.resolve();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('GET /slots awaits the first refreshWorktreePool() scan before responding', async () => {
    let settled = false;
    const req = fetch(`${baseUrl}/api/furnace/slots`).then((res) => { settled = true; return res; });

    // Give the pending request every chance to resolve prematurely; it must not, since the pool has
    // never been scanned and there is no cached value yet to serve.
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    poolGate.resolve();
    const res = await req;
    expect(settled).toBe(true);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('used');
    expect(refreshWorktreePool).toHaveBeenCalledTimes(1);
  });

  it('GET / awaits the first refreshWorktreePool() scan before responding', async () => {
    await createFurnaceBatch({ title: 'test', tickets: [newBatchTicket('R-4', 0, 'R-4')] });

    let settled = false;
    const req = fetch(`${baseUrl}/api/furnace`).then((res) => { settled = true; return res; });

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    poolGate.resolve();
    const res = await req;
    expect(settled).toBe(true);
    expect(res.status).toBe(200);
    const batches = await res.json();
    expect(batches).toHaveLength(1);
    expect(refreshWorktreePool).toHaveBeenCalledTimes(1);
  });

  it('a failed initial scan still serves a response rather than 500ing', async () => {
    refreshWorktreePool.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const res = await fetch(`${baseUrl}/api/furnace/slots`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('used');
  });
});

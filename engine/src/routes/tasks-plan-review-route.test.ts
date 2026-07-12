// FLUX-1306: route-level regression coverage for the `/plan-review/start` and `/plan-review/revise`
// HTTP status mapping. Both routes used to map EVERY `ok:false` reason to a blanket 409 — correct by
// REST convention for `wrong-status`/`already-running`/`furnace-owned` (genuine conflicts with
// current ticket state), but `notes-required` (a missing required field) reads as caller error (400)
// and `persist-failed` (a server-side write failure) as 500. Only the pure gate-runner functions had
// coverage before this; nothing exercised the route's HTTP-status translation.
//
// Both cases below are refused BEFORE any session dispatch (`planGateStartRefusal` / the
// `notes-required` check in `startPlanReviseNow` both return early), so this can run against the
// real router with no furnace-stoker/dispatch mocking, exactly like
// tasks-put-history-reconciliation.test.ts.

import { getWorkspace } from '../workspace-context.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';

import { getConfig } from '../config.js';
import { __resetGateRunnerForTests } from '../gate-runner.js';
import { __resetFurnaceStoreForTests } from '../furnace-store.js';

describe('POST /api/tasks/:id/plan-review/(start|revise) — status mapping (FLUX-1306)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-plan-review-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    __resetGateRunnerForTests();
    __resetFurnaceStoreForTests();
    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
    getConfig().columns = [
      { name: 'Grooming' }, { name: 'Todo' }, { name: 'In Progress' }, { name: 'Ready' }, { name: 'Done' },
    ];

    const { default: tasksRouter } = await import('./tasks.js');
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', requireWorkspace, tasksRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('revise: 400 (not a blanket 409) when overriding an approved verdict with no notes', async () => {
    getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', title: 'T', status: 'Grooming', body: '', planReviewState: 'approved', history: [] };

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/plan-review/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe('notes-required');
  });

  it('start: still 409 for a genuine ticket-state conflict (not in Grooming)', async () => {
    getWorkspace().tasks['FLUX-2'] = { id: 'FLUX-2', title: 'T', status: 'Todo', body: '', history: [] };

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-2/plan-review/start`, { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('wrong-status');
  });

  it('revise: still 409 for a genuine ticket-state conflict (not in Grooming)', async () => {
    getWorkspace().tasks['FLUX-3'] = { id: 'FLUX-3', title: 'T', status: 'Todo', body: '', history: [] };

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-3/plan-review/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'change this' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('wrong-status');
  });

  it('404 for an unknown ticket on either route (unaffected by the reason mapping)', async () => {
    const startRes = await fetch(`${baseUrl}/api/tasks/NOPE/plan-review/start`, { method: 'POST' });
    expect(startRes.status).toBe(404);
    const reviseRes = await fetch(`${baseUrl}/api/tasks/NOPE/plan-review/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(reviseRes.status).toBe(404);
  });
});

// FLUX-1613: route-level coverage that `POST /:id/plan-review/revise` parses `interrupt` from the
// request body and threads it into `startPlanReviseNow`'s opts — the actual interrupt BEHAVIOR
// (stopping the in-flight session, tearing down the old run) is covered against the real gate-runner
// in gate-runner.test.ts; this file only proves the route's boolean-guard parsing and passthrough,
// so `startPlanGateNow`/`startPlanReviseNow` are mocked here rather than exercised for real.

import { getWorkspace } from '../workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';

const startPlanGateNow = vi.fn(async (_id: string, _opts: { mode: string }) => ({ ok: true, message: 'ok' }));
const startPlanReviseNow = vi.fn(async (_id: string, _opts?: { notes?: string; user?: string; interrupt?: boolean }) => ({ ok: true, message: 'ok' }));

vi.mock('../gate-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gate-runner.js')>();
  return {
    ...actual,
    startPlanGateNow: (id: string, opts: { mode: string }) => startPlanGateNow(id, opts),
    startPlanReviseNow: (id: string, opts?: { notes?: string; user?: string; interrupt?: boolean }) => startPlanReviseNow(id, opts),
  };
});

describe('POST /api/tasks/:id/plan-review/revise — interrupt passthrough (FLUX-1613)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-plan-review-interrupt-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', title: 'T', status: 'Grooming', body: '', history: [] };
    startPlanGateNow.mockClear();
    startPlanReviseNow.mockClear();

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

  async function revise(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/tasks/FLUX-1/plan-review/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('threads interrupt:true from the request body into startPlanReviseNow opts', async () => {
    const res = await revise({ notes: 'stop the review, do this instead', interrupt: true });
    expect(res.status).toBe(200);
    expect(startPlanReviseNow).toHaveBeenCalledTimes(1);
    const [ticketId, opts] = startPlanReviseNow.mock.calls[0]!;
    expect(ticketId).toBe('FLUX-1');
    expect(opts).toMatchObject({ notes: 'stop the review, do this instead', interrupt: true });
  });

  it('backward compat: interrupt absent from the body is absent from opts (not coerced to false)', async () => {
    const res = await revise({ notes: 'just revise' });
    expect(res.status).toBe(200);
    const [, opts] = startPlanReviseNow.mock.calls[0]!;
    expect(opts).not.toHaveProperty('interrupt');
  });

  it('backward compat: interrupt:false is threaded through as false, not dropped', async () => {
    const res = await revise({ notes: 'just revise', interrupt: false });
    expect(res.status).toBe(200);
    const [, opts] = startPlanReviseNow.mock.calls[0]!;
    expect(opts).toMatchObject({ interrupt: false });
  });

  it('a non-boolean interrupt value is ignored (same typeof guard idiom as the other optional fields)', async () => {
    const res = await revise({ notes: 'just revise', interrupt: 'true' });
    expect(res.status).toBe(200);
    const [, opts] = startPlanReviseNow.mock.calls[0]!;
    expect(opts).not.toHaveProperty('interrupt');
  });
});

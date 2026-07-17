// FLUX-1485: route-level regression coverage for PUT /:id's plan-approve fast-fail guard. Before
// this fix, an already-consumed plan-approval verdict (cleared by MCP change_status, the auto
// gate, or another surface) would still route a stale Approve click through the full
// updateTaskWithHistory write chain — the reported hang was that chain wedging behind an
// unrelated pending write, with no short-circuit possible before it. This suite exercises the
// route directly (not the write chain) to prove the guard fires BEFORE any real work, and never
// fires for the genuinely-pending case.

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

describe('PUT /api/tasks/:id — plan-approve fast-fail on an already-consumed verdict (FLUX-1485)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-plan-approve-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];

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

  function seedTask(overrides: Record<string, unknown>) {
    getWorkspace().tasks['FLUX-1'] = {
      id: 'FLUX-1',
      title: 'Test ticket',
      status: 'Grooming',
      body: '',
      history: [{ type: 'activity', id: 'a-1', user: 'Agent', date: '2026-07-17T00:00:00.000Z', comment: 'Created ticket.' }],
      _path: path.join(root, '.flux', 'FLUX-1.md'),
      ...overrides,
    };
  }

  it('no-ops instead of writing when the ticket already left Grooming (consumed by another surface)', async () => {
    seedTask({ status: 'Todo', planReviewState: null });

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Todo',
        planReviewState: null,
        planReviewBodyHash: null,
        appendHistory: [{ type: 'status_change', from: 'Grooming', to: 'Todo', user: 'stale-click', comment: 'Approved.' }],
        updatedBy: 'stale-click',
      }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('Todo');
    // The stale click's history entry must never have been appended — the guard returns the
    // current task as-is, proving no write chain ran.
    expect(updated.history).toHaveLength(1);
  });

  it('no-ops when still in Grooming but the verdict was already cleared (e.g. dismissed elsewhere)', async () => {
    seedTask({ status: 'Grooming', planReviewState: null });

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planReviewState: null, planReviewBodyHash: null, updatedBy: 'stale-click' }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.history).toHaveLength(1);
  });

  it('does NOT short-circuit the FLUX-1339 standing approve (Grooming, no verdict yet, plan body present)', async () => {
    // A Grooming ticket with a plan body but no formal review verdict is a legitimate "standing
    // approve" state (canApprovePlan) — the guard must not mistake `planReviewState == null` here
    // for an already-consumed verdict just because it also happens to match the "nothing pending"
    // shape when no status transition is involved.
    seedTask({ status: 'Grooming', planReviewState: null, body: 'The plan.' });

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Todo',
        planReviewState: null,
        planReviewBodyHash: null,
        appendHistory: [{ type: 'status_change', from: 'Grooming', to: 'Todo', user: 'alice', comment: 'Approved.' }],
        updatedBy: 'alice',
      }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('Todo');
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment);
    expect(comments).toContain('Approved.');
    expect(updated.history).toHaveLength(2);
  });

  it('does not drop a still-set needsAction clear when short-circuiting a bare dismiss', async () => {
    seedTask({ status: 'Grooming', planReviewState: null, needsAction: 'plan-review' });

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planReviewState: null, needsAction: null, updatedBy: 'stale-click' }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.needsAction == null).toBe(true);
  });

  it('does NOT short-circuit the genuinely-pending happy path — still moves Grooming -> Todo', async () => {
    seedTask({ status: 'Grooming', planReviewState: 'approved' });

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Todo',
        planReviewState: null,
        planReviewBodyHash: null,
        appendHistory: [{ type: 'status_change', from: 'Grooming', to: 'Todo', user: 'alice', comment: 'Approved.' }],
        updatedBy: 'alice',
      }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.status).toBe('Todo');
    expect(updated.planReviewState == null).toBe(true);
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment);
    expect(comments).toContain('Approved.');
    expect(updated.history).toHaveLength(2);
  });

  it('does not apply the guard to unrelated writes that happen not to touch planReviewState', async () => {
    seedTask({ status: 'Todo', planReviewState: null, priority: 'Low' });

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'High', updatedBy: 'alice' }),
    });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.priority).toBe('High');
  });
});

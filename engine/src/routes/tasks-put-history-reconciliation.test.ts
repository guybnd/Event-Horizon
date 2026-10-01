// FLUX-1308: route-level regression coverage for PUT /:id's history reconciliation. Before this
// fix, a client submitting a full `history` array from a snapshot stale by N entries had its
// first N genuinely-novel entries silently dropped (`nextHistory.slice(existingHistory.length)`
// sliced from the SERVER's length against the CLIENT's shorter array). See history.ts's
// `reconcileNovelHistoryEntries` for the identity-based replacement.

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
import { cliSessionsById, registerSession, unregisterSession } from '../session-store.js';
import type { CliSessionRecord } from '../agents/types.js';


describe('PUT /api/tasks/:id — history reconciliation by identity (FLUX-1308)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  const baseHistory = [
    { type: 'activity', id: 'a-1', user: 'Agent', date: '2026-07-08T00:00:00.000Z', comment: 'Created ticket.' },
    { type: 'comment', id: 'c-1', user: 'alice', date: '2026-07-08T00:01:00.000Z', comment: 'first' },
    { type: 'comment', id: 'c-2', user: 'bob', date: '2026-07-08T00:02:00.000Z', comment: 'second (client will not have seen this)' },
  ];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-put-history-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getWorkspace().tasks['FLUX-1'] = {
      id: 'FLUX-1',
      title: 'Test ticket',
      status: 'Todo',
      body: '',
      history: baseHistory.map((e) => ({ ...e })),
      _path: path.join(root, '.flux', 'FLUX-1.md'),
    };

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

  it('a client snapshot stale by one entry loses none of its submitted new entries', async () => {
    // Client only ever fetched the first two entries (its snapshot predates c-2), then rebuilds
    // a full `history` array with its own two new comments appended.
    const staleSubmission = [
      baseHistory[0],
      baseHistory[1],
      { type: 'comment', user: 'carol', date: '2026-07-08T00:03:00.000Z', comment: 'new A' },
      { type: 'comment', user: 'dave', date: '2026-07-08T00:04:00.000Z', comment: 'new B' },
    ];

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: staleSubmission, updatedBy: 'carol' }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment);

    // Both of the client's genuinely new entries must survive...
    expect(comments).toContain('new A');
    expect(comments).toContain('new B');
    // ...alongside everything the server already had, including the entry the client's stale
    // snapshot never saw.
    expect(comments).toContain('second (client will not have seen this)');
    expect(updated.history).toHaveLength(5);
  });

  it('two interleaved writers (second stale relative to the first) both keep their new entry', async () => {
    // Writer 1 has a fresh snapshot (all 3 base entries) and appends its own entry.
    const writer1Submission = [...baseHistory, { type: 'comment', user: 'writer1', date: '2026-07-08T00:03:00.000Z', comment: 'from writer 1' }];
    const res1 = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: writer1Submission, updatedBy: 'writer1' }),
    });
    expect(res1.status).toBe(200);

    // Writer 2's snapshot predates writer 1's write (still just the 3 base entries) but its PUT
    // lands AFTER writer 1's — the server's existing history has already grown to 4 entries by
    // the time this request is reconciled, one longer than writer 2's own base + new entry.
    const writer2Submission = [...baseHistory, { type: 'comment', user: 'writer2', date: '2026-07-08T00:03:30.000Z', comment: 'from writer 2' }];
    const res2 = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: writer2Submission, updatedBy: 'writer2' }),
    });
    expect(res2.status).toBe(200);
    const updated = await res2.json();
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment);

    expect(comments).toContain('from writer 1');
    expect(comments).toContain('from writer 2');
    expect(updated.history).toHaveLength(5);
  });

  it('appendHistory deltas remain immune to staleness regardless of the submitted history array', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appendHistory: [{ type: 'comment', user: 'erin', comment: 'delta comment' }], updatedBy: 'erin' }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment);
    expect(comments).toContain('delta comment');
    expect(comments).toContain('second (client will not have seen this)');
    expect(updated.history).toHaveLength(4);
  });
});

// FLUX-1746: the portal-PUT half of the review-handoff note's two independently-wired Ready
// paths (the other is MCP change_status, mcp-compaction-handoff.test.ts). Deleting the
// `entriesToAppend.push` in routes/tasks/update.ts must fail this test.
describe('PUT /api/tasks/:id — compaction review-handoff note on Ready (FLUX-1746)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;
  const SESSION_ID = 'flux1746-test-session';
  // adapter-boundary: keep the framework value out of a `framework: 'claude'` literal (see
  // check-adapter-boundary.mjs's framework-literal-assign pattern) — this fixture doesn't
  // exercise per-CLI behavior, it just needs a valid CliFramework value.
  const TEST_FRAMEWORK = 'claude';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-put-compaction-'));
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
    cliSessionsById.delete(SESSION_ID);
    unregisterSession('FLUX-2', SESSION_ID);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('a ticket with a registered compacted implementation session moved to Ready via PUT lands the handoff entry in the written history', async () => {
    getWorkspace().tasks['FLUX-2'] = {
      id: 'FLUX-2',
      title: 'Compaction handoff test',
      status: 'In Progress',
      body: '',
      history: [],
      _path: path.join(root, '.flux', 'FLUX-2.md'),
    };
    cliSessionsById.set(SESSION_ID, {
      id: SESSION_ID,
      taskId: 'FLUX-2',
      framework: TEST_FRAMEWORK,
      status: 'completed',
      command: 'claude',
      args: [],
      startedAt: new Date().toISOString(),
      label: 'Test',
      phase: 'implementation',
      compactionCount: 2,
      cumulativeDroppedTokens: 50_000,
    } as unknown as CliSessionRecord);
    registerSession('FLUX-2', SESSION_ID);

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Ready',
        appendHistory: [{ type: 'comment', user: 'reviewer', comment: 'Looks good, moving to Ready.' }],
      }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment ?? '');
    expect(comments.some((c) => c.includes('compacted 2 times') && c.includes('50k'))).toBe(true);
  });

  it('a ticket with no compacted sessions moved to Ready adds no handoff entry', async () => {
    getWorkspace().tasks['FLUX-2'] = {
      id: 'FLUX-2',
      title: 'Compaction handoff test (clean)',
      status: 'In Progress',
      body: '',
      history: [],
      _path: path.join(root, '.flux', 'FLUX-2.md'),
    };

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'Ready',
        appendHistory: [{ type: 'comment', user: 'reviewer', comment: 'Looks good, moving to Ready.' }],
      }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    const comments = (updated.history as Array<{ comment?: string }>).map((e) => e.comment ?? '');
    expect(comments.some((c) => c.includes('compacted'))).toBe(false);
  });
});

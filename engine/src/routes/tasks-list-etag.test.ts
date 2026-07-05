// FLUX-1144: `GET /api/tasks` used to re-serialize + re-transfer the whole task list on every
// poll, even when nothing had changed since the client's last fetch. These guard the conditional-
// GET added on top: a version-keyed ETag that answers an unchanged poll with a bodyless 304, and
// bumps (invalidating cached ETags) the instant any task mutation broadcasts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';
import { tasksCache } from '../task-store.js';
import { broadcastEvent } from '../events.js';
import { cliSessionsById, cliSessionsByTaskId, registerSession } from '../session-store.js';
import type { CliSessionRecord } from '../agents/types.js';
import type { ChildProcessWithoutNullStreams } from 'child_process';

describe('GET /api/tasks — conditional GET / ETag (FLUX-1144)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-list-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    tasksCache['FLUX-1'] = {
      id: 'FLUX-1',
      title: 'Test ticket',
      status: 'Todo',
      body: '',
      _path: path.join(root, '.flux', 'FLUX-1.md'),
    };
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();

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

  it('serves an ETag and answers a matching If-None-Match with a bodyless 304', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    await first.text();

    const second = await fetch(`${baseUrl}/api/tasks`, { headers: { 'If-None-Match': etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('bumps the ETag and serves fresh 200 data once a task mutation broadcasts', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`);
    const etag = first.headers.get('etag')!;
    await first.text();

    // Every task mutation path (task-store.ts, mcp-server.ts, the routes) calls broadcastEvent
    // with one of these three names — that's the hook the version counter bumps on.
    broadcastEvent('taskUpdated', { id: 'FLUX-1' });

    const second = await fetch(`${baseUrl}/api/tasks`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(etag);
  });

  it('keeps the full list and the ?active=true list on independent ETag variants', async () => {
    const full = await fetch(`${baseUrl}/api/tasks`);
    const fullEtag = full.headers.get('etag');
    await full.text();
    const active = await fetch(`${baseUrl}/api/tasks?active=true`);
    const activeEtag = active.headers.get('etag');
    await active.text();
    expect(fullEtag).not.toBe(activeEtag);

    // A stale ETag from the OTHER query variant must never be treated as a match — that would
    // mask real content behind a 304 the first time a client switches between full/active polls.
    const crossCheck = await fetch(`${baseUrl}/api/tasks?active=true`, { headers: { 'If-None-Match': fullEtag! } });
    expect(crossCheck.status).toBe(200);
  });

  it('still self-heals a session whose exit event was missed, even behind a matching ETag (FLUX-846 x FLUX-1144)', async () => {
    // Regression for the changes-requested review: the 304 short-circuit used to run BEFORE
    // reconcileDeadSessions(), so a poller whose cached ETag had already settled would never
    // observe a reap — the exact scenario a missed exit event never broadcasts on its own.
    const first = await fetch(`${baseUrl}/api/tasks`);
    const etag = first.headers.get('etag')!;
    await first.text();

    // Simulate a missed exit event landing *between* two polls that share the same cached ETag —
    // no broadcastEvent fires here, exactly like a lost child-process exit in production.
    const deadProc = { exitCode: 0, signalCode: null } as unknown as ChildProcessWithoutNullStreams;
    const session = {
      id: 'sess-dead',
      taskId: 'FLUX-1',
      framework: 'test-cli',
      status: 'running',
      command: 'claude',
      args: [],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      lastOutputAt: new Date(Date.now() - 60_000).toISOString(),
      label: 'Claude Code',
      proc: deadProc,
    } as unknown as CliSessionRecord;
    cliSessionsById.set(session.id, session);
    registerSession('FLUX-1', session.id);

    // Same ETag the client would have cached — but the dead session is well past the grace
    // window, so this poll must self-heal it instead of trusting the stale If-None-Match.
    const second = await fetch(`${baseUrl}/api/tasks`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(etag);
    const secondBody = await second.json();
    expect(secondBody[0].cliSession?.status).toBe('completed');
    expect(session.status).toBe('completed');
  });
});

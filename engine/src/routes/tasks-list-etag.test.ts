// FLUX-1144: `GET /api/tasks` used to re-serialize + re-transfer the whole task list on every
// poll, even when nothing had changed since the client's last fetch. These guard the conditional-
// GET added on top: a version-keyed ETag that answers an unchanged poll with a bodyless 304, and
// bumps (invalidating cached ETags) the instant any task mutation broadcasts.

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

import { broadcastEvent, bumpTasksVersion } from '../events.js';
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

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    getWorkspace().tasks['FLUX-1'] = {
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

  // FLUX-1338: a workspace switch replaces the whole task set but fires no per-task mutation event,
  // so the version counter would stay put and the client's cached ETag would still match — the
  // engine answered the first post-switch poll with a 304 and the board kept showing the OLD
  // workspace's tickets. doActivateWorkspace now calls bumpTasksVersion() to invalidate that cache.
  it('invalidates a cached ETag when the tasks version is bumped (workspace switch)', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`);
    const etag = first.headers.get('etag')!;
    await first.text();

    bumpTasksVersion(); // what a workspace switch now does

    const second = await fetch(`${baseUrl}/api/tasks`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(etag);
  });

  // FLUX-1338 (bump placement): activation clears the task set seconds before initDir() repopulates
  // it, and the engine keeps serving GET /api/tasks in between — so the portal's 3s poll can land
  // inside that window and cache an ETag over the EMPTY set. doActivateWorkspace therefore bumps in
  // its `finally`, AFTER the reload: any ETag handed out mid-activation must mismatch once
  // activation completes, or the board would stick on an empty board behind a 304 (nothing in the
  // bulk reload broadcasts a per-task event that would bump the version).
  it('does not let an ETag captured mid-activation 304 after activation completes', async () => {
    bumpTasksVersion(); // stand-in for a hypothetical early bump / any version state mid-window
    const midActivation = await fetch(`${baseUrl}/api/tasks`); // poll lands in the cleared window
    const midEtag = midActivation.headers.get('etag')!;
    await midActivation.text();

    bumpTasksVersion(); // the real bump — end of doActivateWorkspace's finally, after initDir()

    const after = await fetch(`${baseUrl}/api/tasks`, { headers: { 'If-None-Match': midEtag } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(midEtag);
  });

  // FLUX-1338 (defense-in-depth): the ETag is also keyed by the active workspace root, so two
  // workspaces can never collide on the shared module-global version counter even at the same value.
  it('keys the ETag by workspace root — a cached ETag from another workspace never 304s', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`);
    const etag = first.headers.get('etag')!;
    await first.text();

    setWorkspaceRoot('/tmp/some-other-workspace'); // simulate the engine now bound elsewhere

    const second = await fetch(`${baseUrl}/api/tasks`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).not.toBe(etag);
  });

  // FLUX-1460: the mid-activation window used to still serve a cacheable 200 + ETag over a partial
  // task set — the client would cache that ETag and every later poll would 304 onto it forever
  // (only a hard refresh, which drops the client's in-memory ETag map, ever recovered). The engine
  // now refuses to answer at all while activating, mirroring the existing POST guard, so no partial
  // snapshot is ever cacheable in the first place.
  it('returns 503 with no ETag while the workspace is activating, for both list variants', async () => {
    getWorkspace().isActivating = true;
    try {
      const full = await fetch(`${baseUrl}/api/tasks`);
      expect(full.status).toBe(503);
      expect(full.headers.get('etag')).toBeNull();
      await full.text();

      const active = await fetch(`${baseUrl}/api/tasks?active=true`);
      expect(active.status).toBe(503);
      expect(active.headers.get('etag')).toBeNull();
      await active.text();
    } finally {
      getWorkspace().isActivating = false;
    }
  });

  it('serves 200 with a fresh ETag and the full task set once activation completes', async () => {
    getWorkspace().isActivating = true;
    const duringActivation = await fetch(`${baseUrl}/api/tasks`);
    expect(duringActivation.status).toBe(503);
    await duringActivation.text();

    getWorkspace().isActivating = false;
    const after = await fetch(`${baseUrl}/api/tasks`);
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).toBeTruthy();
    const body = await after.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('FLUX-1');
  });
});

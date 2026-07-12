// FLUX-1304 (FLUX-1297 follow-up): POST /:id/pr/merge's "Tier 2 — parked sessions" branch
// (`stopParkedSessions:true`) stops a waiting-input session directly, the same shape as
// `cleanupMergedBranch`'s own session-stop loop — which FLUX-1297 fixed by disarming Temper FIRST
// so its own tick can never observe the resulting 'cancelled' session and park a ticket whose work
// just landed. This route had the identical stop-then-race shape but wasn't updated in lockstep.
//
// `checkGhAuth` is mocked to fail fast (no real `gh` dependency) — the disarm+stop loop under test
// runs BEFORE the route's `checkGhAuth` call, so the request still exercises it even though the
// merge itself never proceeds.

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

import { cliSessionsById, cliSessionsByTaskId, registerSession, __resetSessionStubStateForTests } from '../session-store.js';
import { rehydrateTemper, isTempering, __resetTemperForTests } from '../temper.js';
import type { CliSessionRecord } from '../agents/types.js';

const checkGhAuthMock = vi.fn(async () => false);

vi.mock('../branch-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../branch-manager.js')>();
  return { ...actual, checkGhAuth: () => checkGhAuthMock() };
});

/** Register a resting waiting-input (parked) session — the state the merge route's Tier 2 branch stops. */
function addParkedSession(taskId: string, sessionId: string): void {
  cliSessionsById.set(sessionId, {
    id: sessionId,
    taskId,
    status: 'waiting-input',
    args: [] as string[],
    startedAt: new Date().toISOString(),
    label: 'agent session',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
  } as CliSessionRecord);
  registerSession(taskId, sessionId);
}

describe('POST /api/tasks/:id/pr/merge disarms Temper before stopping parked sessions (FLUX-1304)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-pr-merge-disarm-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    __resetSessionStubStateForTests();
    __resetTemperForTests();
    checkGhAuthMock.mockClear();
    checkGhAuthMock.mockResolvedValue(false);

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
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    __resetSessionStubStateForTests();
    __resetTemperForTests();
  });

  it('disarms an in-flight Temper loop before stopping the parked review session', async () => {
    getWorkspace().tasks['FLUX-1'] = {
      id: 'FLUX-1',
      title: 'Test ticket',
      status: 'Ready',
      branch: 'flux/FLUX-1',
      body: '',
      tempering: true,
      temperAttempts: 0,
      _path: path.join(root, '.flux', 'FLUX-1.md'),
    };
    rehydrateTemper();
    expect(isTempering('FLUX-1')).toBe(true);
    addParkedSession('FLUX-1', 'sess-1');

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/pr/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopParkedSessions: true }),
    });

    // The merge itself doesn't proceed (checkGhAuth is mocked to fail) — that's fine, the
    // disarm+stop loop under test runs BEFORE that check.
    expect(res.status).toBe(409);
    expect(checkGhAuthMock).toHaveBeenCalled();

    // Disarmed — Temper is no longer tracking this ticket, so no later tick can ever park it.
    expect(isTempering('FLUX-1')).toBe(false);
    // The parked session was actually stopped, same as before this fix.
    expect(cliSessionsById.get('sess-1')?.status).toBe('cancelled');
  });

  it('is a no-op when Temper is not driving the ticket', async () => {
    getWorkspace().tasks['FLUX-2'] = {
      id: 'FLUX-2',
      title: 'Test ticket',
      status: 'Ready',
      branch: 'flux/FLUX-2',
      body: '',
      _path: path.join(root, '.flux', 'FLUX-2.md'),
    };
    addParkedSession('FLUX-2', 'sess-2');

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-2/pr/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopParkedSessions: true }),
    });

    expect(res.status).toBe(409);
    expect(isTempering('FLUX-2')).toBe(false);
    expect(cliSessionsById.get('sess-2')?.status).toBe('cancelled');
  });
});

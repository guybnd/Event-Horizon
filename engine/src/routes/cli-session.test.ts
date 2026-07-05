// FLUX-1002 — spawning an agent must not block the HTTP response on slow network ops
// (ensureTicketIsolation's branch push + worktree add, then the adapter spawn itself). These
// tests mock both edges and assert the route responds with a 'pending' session BEFORE either
// resolves, and that the session converges (running, or failed with the error surfaced) once
// the backgrounded work settles — never a hung request.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { setWorkspaceRoot } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';
import { tasksCache } from '../task-store.js';
import { cliSessionsById, cliSessionsByTaskId } from '../session-store.js';
import { ensureTicketIsolation } from '../ticket-isolation.js';
import { getAdapter } from '../agents/index.js';
import type { AgentAdapter, CliSessionRecord, ProviderManifest } from '../agents/types.js';

// A concrete framework value is unavoidable to drive the route, but the adapter-boundary guard
// (check-adapter-boundary.mjs) bans repeating the 'claude' literal outside engine/src/agents/ — a
// single hoisted constant keeps this file to zero bare-literal matches instead of growing the guard's
// allowlist for a test that isn't actually claude-specific.
const { TEST_FRAMEWORK } = vi.hoisted(() => ({ TEST_FRAMEWORK: 'claude' }));

vi.mock('../ticket-isolation.js', () => ({
  ensureTicketIsolation: vi.fn(),
}));

// Keep the baseline-commit stamp (a real git rev-parse/merge-base call) out of these tests —
// it's pure local plumbing unrelated to what FLUX-1002 changes, and spawning real git subprocesses
// here (with the S1 runner's gh-auth probe on the first call) makes timing assertions flaky.
vi.mock('../branch-manager.js', () => ({
  captureDiffForPrompt: vi.fn(),
  getMergeBase: vi.fn(),
  isAncestor: vi.fn(),
  resolveBaselineCommit: vi.fn().mockResolvedValue(null),
}));

vi.mock('../agents/index.js', () => ({
  getAdapter: vi.fn(),
  getBoardAdapter: vi.fn(),
  resolveDefaultFramework: () => TEST_FRAMEWORK,
  isKnownFramework: (v: string) => v === TEST_FRAMEWORK,
  getRuntimeFrameworks: () => [TEST_FRAMEWORK],
}));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('POST /:id/cli-session/start — off the request path (FLUX-1002)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;
  let startMock: ReturnType<typeof vi.fn<(session: CliSessionRecord) => Promise<void>>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-cli-session-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();

    // A real _path (inside the temp workspace) so updateTaskWithHistory's best-effort history
    // writes (e.g. the isolation-failure test below) land in the temp dir instead of falling back
    // to a stray `undefined.tmp` in the process cwd.
    tasksCache['FLUX-1'] = {
      id: 'FLUX-1',
      title: 'Test ticket',
      status: 'Todo',
      _path: path.join(root, '.flux', 'FLUX-1.md'),
    };

    startMock = vi.fn(async (session: CliSessionRecord) => {
      session.status = 'running';
      session.pid = 4242;
    });
    const manifest: ProviderManifest = {
      id: 'claude',
      displayName: 'Claude',
      configSchema: {},
      costModel: { inputPerMToken: 0, outputPerMToken: 0, currency: 'usd' },
      capabilities: { compacting: false, effortLevels: [], memoryFiles: false },
    };
    const adapterMock: AgentAdapter = {
      labelForFramework: () => 'Claude',
      start: startMock,
      sendInput: vi.fn(),
      stop: vi.fn(),
      manifest,
    };
    vi.mocked(getAdapter).mockReturnValue(adapterMock);

    const { default: cliSessionRouter } = await import('./cli-session.js');
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', requireWorkspace, cliSessionRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('responds 201 with a pending session before ensureTicketIsolation resolves, then converges to running', async () => {
    let releaseIsolation: (() => void) | undefined;
    vi.mocked(ensureTicketIsolation).mockImplementation(
      () => new Promise((resolve) => { releaseIsolation = () => resolve({ branch: 'flux/FLUX-1-test' }); }),
    );

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree' }),
    });

    expect(res.status).toBe(201);
    const { session } = await res.json();
    expect(session.status).toBe('pending');

    // The response landed without ensureTicketIsolation ever resolving — proves isolation is
    // off the request path, not just fast in this test.
    expect(startMock).not.toHaveBeenCalled();
    expect(releaseIsolation).toBeDefined();

    // Let the backgrounded prep proceed and confirm it actually completes the launch.
    releaseIsolation!();
    await waitFor(() => startMock.mock.calls.length > 0);
    await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
  });

  it('marks the session failed (not a hung request) when ensureTicketIsolation rejects', async () => {
    vi.mocked(ensureTicketIsolation).mockRejectedValue(new Error('git push timed out'));

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree' }),
    });

    expect(res.status).toBe(201);
    const { session } = await res.json();
    expect(session.status).toBe('pending');

    await waitFor(() => cliSessionsById.get(session.id)?.status === 'failed');
    const record = cliSessionsById.get(session.id)!;
    expect(record.liveOutputBuffer).toContain('git push timed out');
    // The adapter never started — the failure happened during isolation prep.
    expect(startMock).not.toHaveBeenCalled();

    // FLUX-1156: a pre-spawn failure must still leave a durable agent_session history entry —
    // this is what the chat timeline renders and what get_session_log resolves against, not just
    // the in-memory live buffer asserted above (which is lost once the session record is evicted).
    await waitFor(() => {
      const history = tasksCache['FLUX-1']?.history;
      return Array.isArray(history) && history.some((e) => e?.type === 'agent_session' && e?.sessionId === session.id);
    });
    const persisted = tasksCache['FLUX-1'].history.find((e: { sessionId?: string }) => e.sessionId === session.id);
    expect(persisted.status).toBe('failed');
    expect(persisted.outcome).toContain('git push timed out');
    expect(persisted.startedAt).toBeTruthy();
    expect(persisted.endedAt).toBeTruthy();
    // The in-memory record is updated too, so an immediate furnace reconcile pass can read the
    // failure reason straight off the live session without waiting on a re-read from disk.
    expect(record.sessionHistoryEntry?.sessionId).toBe(session.id);
    expect(record.sessionHistoryEntry?.outcome).toContain('git push timed out');
  });

  it('does not wait on the adapter spawn either (Serena/MCP handshake) — session stays pending until it settles', async () => {
    vi.mocked(ensureTicketIsolation).mockResolvedValue({ branch: 'flux/FLUX-1-test' });
    let releaseStart: (() => void) | undefined;
    startMock.mockImplementation(
      (session: CliSessionRecord) => new Promise<void>((resolve) => {
        releaseStart = () => { session.status = 'running'; resolve(); };
      }),
    );

    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree' }),
    });
    expect(res.status).toBe(201);
    const { session } = await res.json();
    expect(session.status).toBe('pending');

    await waitFor(() => startMock.mock.calls.length > 0);
    // Spawn is in flight but hasn't resolved — the session record must still read pending.
    expect(cliSessionsById.get(session.id)?.status).toBe('pending');

    releaseStart!();
    await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
  });

  it('stopping a pending session while isolation is still in flight prevents the backgrounded spawn from reviving it', async () => {
    let releaseIsolation: (() => void) | undefined;
    vi.mocked(ensureTicketIsolation).mockImplementation(
      () => new Promise((resolve) => { releaseIsolation = () => resolve({ branch: 'flux/FLUX-1-test' }); }),
    );

    const startRes = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree' }),
    });
    expect(startRes.status).toBe(201);
    const { session } = await startRes.json();
    expect(session.status).toBe('pending');
    await waitFor(() => releaseIsolation !== undefined);

    // User hits stop before ensureTicketIsolation (the backgrounded git push + worktree add)
    // has resolved — mirrors clicking "stop" on a session still reading "Preparing workspace…".
    const stopRes = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    expect(cliSessionsById.get(session.id)?.status).toBe('cancelled');

    // Now let the backgrounded isolation resolve — the adapter must NOT spawn a session the
    // user already cancelled, and 'cancelled' must not be silently reverted to 'running'.
    releaseIsolation!();
    await new Promise((r) => setTimeout(r, 50));
    expect(startMock).not.toHaveBeenCalled();
    expect(cliSessionsById.get(session.id)?.status).toBe('cancelled');
  });

  it('does not clobber a cancelled session back to failed when the backgrounded isolation rejects after stop', async () => {
    let rejectIsolation: ((e: Error) => void) | undefined;
    vi.mocked(ensureTicketIsolation).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectIsolation = reject; }),
    );

    const startRes = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree' }),
    });
    const { session } = await startRes.json();
    await waitFor(() => rejectIsolation !== undefined);

    const stopRes = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    expect(cliSessionsById.get(session.id)?.status).toBe('cancelled');

    // The backgrounded isolation call throws (e.g. a transient git push failure) AFTER the user
    // already cancelled — the catch block's requestedStop guard must leave 'cancelled' alone
    // instead of overwriting it with 'failed' (FLUX-1002 review).
    rejectIsolation!(new Error('git push timed out'));
    await new Promise((r) => setTimeout(r, 50));
    expect(cliSessionsById.get(session.id)?.status).toBe('cancelled');
  });
});

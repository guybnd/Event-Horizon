// FLUX-1002 — spawning an agent must not block the HTTP response on slow network ops
// (ensureTicketIsolation's branch push + worktree add, then the adapter spawn itself). These
// tests mock both edges and assert the route responds with a 'pending' session BEFORE either
// resolves, and that the session converges (running, or failed with the error surfaced) once
// the backgrounded work settles — never a hung request.

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
  let sendInputMock: ReturnType<typeof vi.fn<AgentAdapter['sendInput']>>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-cli-session-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();

    // A real _path (inside the temp workspace) so updateTaskWithHistory's best-effort history
    // writes (e.g. the isolation-failure test below) land in the temp dir instead of falling back
    // to a stray `undefined.tmp` in the process cwd.
    getWorkspace().tasks['FLUX-1'] = {
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
    sendInputMock = vi.fn().mockResolvedValue(undefined);
    const adapterMock: AgentAdapter = {
      labelForFramework: () => 'Claude',
      start: startMock,
      sendInput: sendInputMock,
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
      const history = getWorkspace().tasks['FLUX-1']?.history;
      return Array.isArray(history) && history.some((e) => e?.type === 'agent_session' && e?.sessionId === session.id);
    });
    const persisted = getWorkspace().tasks['FLUX-1'].history.find((e: { sessionId?: string }) => e.sessionId === session.id);
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

  // FLUX-1235: the active-session guard's take-over contract. A roleless start is refused when the
  // ticket has a blocking session — but an authoritative driver (the Furnace) sets `supersedeParked` to
  // reclaim an IDLE (waiting-input) session even when it is resumable, while a LIVE (running/pending)
  // session is never clobbered, flag or not. Without the flag the portal's resume-preferring UX stands.
  function seedBlockingSession(over: Partial<CliSessionRecord>): CliSessionRecord {
    const s = {
      id: 'pre', taskId: 'FLUX-1', framework: TEST_FRAMEWORK, status: 'waiting-input',
      command: 'claude', args: [], startedAt: new Date().toISOString(), label: 'Claude Code',
      outputBuffer: '', liveOutputBuffer: '', pendingAssistantText: '', skipPermissions: true,
      requestedStop: false, writeQueue: Promise.resolve(), inputTokens: 0, outputTokens: 0, costUSD: 0,
      ...over,
    } as unknown as CliSessionRecord;
    cliSessionsById.set(s.id, s);
    cliSessionsByTaskId.set('FLUX-1', [s.id]);
    return s;
  }

  async function startRoleless(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'go', ...body }),
    });
  }

  describe('active-session guard take-over (FLUX-1235)', () => {
    it('a resumable parked session still 409s WITHOUT the flag (portal resume UX unchanged)', async () => {
      seedBlockingSession({ status: 'waiting-input', resumeSessionId: 'resume-me' });
      const res = await startRoleless({});
      expect(res.status).toBe(409);
      expect(cliSessionsById.get('pre')?.status).toBe('waiting-input'); // untouched
    });

    it('supersedeParked takes over a resumable parked session and starts the worker', async () => {
      seedBlockingSession({ status: 'waiting-input', resumeSessionId: 'resume-me' });
      const res = await startRoleless({ supersedeParked: true });
      expect(res.status).toBe(201);
      expect(cliSessionsById.get('pre')?.status).toBe('cancelled'); // superseded
    });

    it('supersedeParked does NOT clobber a live (running) session — still 409', async () => {
      seedBlockingSession({ status: 'running' });
      const res = await startRoleless({ supersedeParked: true });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/live CLI session/);
      expect(cliSessionsById.get('pre')?.status).toBe('running'); // untouched
    });

    it('supersedeParked does NOT clobber a live (pending) session — still 409', async () => {
      seedBlockingSession({ status: 'pending' });
      const res = await startRoleless({ supersedeParked: true });
      expect(res.status).toBe(409);
      expect(cliSessionsById.get('pre')?.status).toBe('pending'); // untouched
    });

    // FLUX-1396 group F test 17: distinct from the resumable-parked-session tests above — this is a
    // genuinely LIVE (running) session with no supersedeParked flag at all, hitting the baseline
    // duplicate-session guard rather than the resume/supersede branch. The no-duplicate-review
    // guarantee rests on this: a second roleless start must never register a sibling session.
    it('a second standalone start on a ticket with a live session 409s and registers no second session', async () => {
      seedBlockingSession({ status: 'running' });
      const res = await startRoleless({});
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already has a live CLI session/);
      expect(cliSessionsById.get('pre')?.status).toBe('running'); // untouched
      expect(startMock).not.toHaveBeenCalled();
      // Only the pre-seeded session is registered for the ticket — the blocked start did not
      // sneak a second session into either store.
      expect(cliSessionsByTaskId.get('FLUX-1')).toEqual(['pre']);
      expect([...cliSessionsById.values()].filter((s) => s.taskId === 'FLUX-1')).toHaveLength(1);
    });

    it('the pre-existing FLUX-915 self-heal still supersedes a NON-resumable parked session without the flag', async () => {
      seedBlockingSession({ status: 'waiting-input' }); // no resumeSessionId
      const res = await startRoleless({});
      expect(res.status).toBe(201);
      expect(cliSessionsById.get('pre')?.status).toBe('cancelled');
    });
  });

  // FLUX-1392: a stuck 'running' session (sendCliSessionInput sets status='running' before a later
  // awaited step throws, leaving it never reset) must 409 rather than accept a follow-up turn — a
  // blind retry against the real route (unlike resume-or-dispatch.test.ts's mocked-fetch suite) would
  // otherwise spawn a second concurrent `claude --resume`, mirroring the FLUX-714 board guard.
  describe('mid-turn guard on the ticket-session branch (FLUX-1392)', () => {
    async function sendInput(body: Record<string, unknown> = {}) {
      return fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'go', user: 'Guy', ...body }),
      });
    }

    it('409s a follow-up turn against a running session instead of double-dispatching', async () => {
      seedBlockingSession({ status: 'running', resumeSessionId: 'resume-me' });
      const res = await sendInput();
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/mid-turn/);
      expect(cliSessionsById.get('pre')?.status).toBe('running'); // untouched
      expect(sendInputMock).not.toHaveBeenCalled();
    });

    it('still accepts a follow-up turn against a waiting-input session', async () => {
      seedBlockingSession({ status: 'waiting-input', resumeSessionId: 'resume-me' });
      const res = await sendInput();
      expect(res.status).toBe(200);
      expect(sendInputMock).toHaveBeenCalledTimes(1);
    });

    // Role-aware no-target fallback: a supervisor lead spawns its delegates AFTER itself, so the
    // old "last registered session" fallback resumed the most recent worker — even a completed
    // one ('completed' is resumable per FLUX-606) — instead of the lead the user was addressing.
    it('routes a no-target message to the supervisor lead, not the last-registered completed delegate', async () => {
      const base = {
        taskId: 'FLUX-1', framework: TEST_FRAMEWORK, command: 'claude', args: [],
        startedAt: new Date().toISOString(), label: 'Claude Code', outputBuffer: '',
        liveOutputBuffer: '', pendingAssistantText: '', skipPermissions: true,
        requestedStop: false, writeQueue: Promise.resolve(),
      };
      const lead = { ...base, id: 'lead', status: 'waiting-input', resumeSessionId: 'resume-lead', pattern: 'supervisor', patternPosition: 'lead', groupId: 'g1' } as unknown as CliSessionRecord;
      const worker = { ...base, id: 'worker', status: 'completed', resumeSessionId: 'resume-worker', pattern: 'supervisor', patternPosition: 'assistant', groupId: 'g1' } as unknown as CliSessionRecord;
      cliSessionsById.set(lead.id, lead);
      cliSessionsById.set(worker.id, worker);
      cliSessionsByTaskId.set('FLUX-1', [lead.id, worker.id]); // worker registered last

      const res = await sendInput();
      expect(res.status).toBe(200);
      expect(sendInputMock).toHaveBeenCalledTimes(1);
      expect((sendInputMock.mock.calls[0]![0] as CliSessionRecord).id).toBe('lead');
    });

    it('an explicit sessionId still targets that exact session, bypassing the role-aware fallback', async () => {
      const base = {
        taskId: 'FLUX-1', framework: TEST_FRAMEWORK, command: 'claude', args: [],
        startedAt: new Date().toISOString(), label: 'Claude Code', outputBuffer: '',
        liveOutputBuffer: '', pendingAssistantText: '', skipPermissions: true,
        requestedStop: false, writeQueue: Promise.resolve(),
      };
      const lead = { ...base, id: 'lead', status: 'waiting-input', resumeSessionId: 'resume-lead', pattern: 'supervisor', patternPosition: 'lead', groupId: 'g1' } as unknown as CliSessionRecord;
      const worker = { ...base, id: 'worker', status: 'completed', resumeSessionId: 'resume-worker', pattern: 'supervisor', patternPosition: 'assistant', groupId: 'g1' } as unknown as CliSessionRecord;
      cliSessionsById.set(lead.id, lead);
      cliSessionsById.set(worker.id, worker);
      cliSessionsByTaskId.set('FLUX-1', [lead.id, worker.id]);

      const res = await sendInput({ sessionId: 'worker' });
      expect(res.status).toBe(200);
      expect((sendInputMock.mock.calls[0]![0] as CliSessionRecord).id).toBe('worker');
    });
  });

  it('phase:"grooming" skips ensureTicketIsolation regardless of requested isolation (FLUX-1214)', async () => {
    // Grooming never writes code or opens a PR — it has no use for a branch/worktree. Request
    // 'worktree' isolation anyway (as start_session/board-rebase dispatch always do) to prove the
    // route itself refuses to isolate a grooming session rather than relying on callers to know.
    const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree', phase: 'grooming' }),
    });

    expect(res.status).toBe(201);
    const { session } = await res.json();

    await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
    expect(ensureTicketIsolation).not.toHaveBeenCalled();
    expect(getWorkspace().tasks['FLUX-1'].branch).toBeUndefined();
  });

  // FLUX-1380: fast-path grooms AND implements an XS/S ticket in one session — unlike grooming
  // it writes code, so (unlike the FLUX-1214 grooming carve-out above) it keeps isolation. The
  // route also refuses it deterministically for work too big for one unattended pass.
  describe('phase:"fast-path" (FLUX-1380)', () => {
    it('is accepted and keeps isolation (unlike grooming)', async () => {
      vi.mocked(ensureTicketIsolation).mockResolvedValue({ branch: 'flux/FLUX-1-test' });
      const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework: TEST_FRAMEWORK, appendPrompt: 'hello', isolation: 'worktree', phase: 'fast-path' }),
      });

      expect(res.status).toBe(201);
      const { session } = await res.json();
      await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
      expect(ensureTicketIsolation).toHaveBeenCalled();
    });

    it('refuses an L-effort ticket', async () => {
      getWorkspace().tasks['FLUX-1'].effort = 'L';
      const res = await startRoleless({ phase: 'fast-path' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/L-effort/);
      expect(startMock).not.toHaveBeenCalled();
    });

    it('refuses an XL-effort ticket', async () => {
      getWorkspace().tasks['FLUX-1'].effort = 'XL';
      const res = await startRoleless({ phase: 'fast-path' });
      expect(res.status).toBe(400);
      expect(startMock).not.toHaveBeenCalled();
    });

    it('refuses a ticket that has its own subtasks (an epic parent)', async () => {
      getWorkspace().tasks['FLUX-1'].subtasks = ['FLUX-2'];
      const res = await startRoleless({ phase: 'fast-path' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/subtasks/);
      expect(startMock).not.toHaveBeenCalled();
    });

    it('allows a ticket that merely has a parentId (an epic MEMBER with no subtasks of its own)', async () => {
      getWorkspace().tasks['FLUX-1'].parentId = 'FLUX-0';
      vi.mocked(ensureTicketIsolation).mockResolvedValue({ branch: 'flux/FLUX-1-test' });
      const res = await startRoleless({ phase: 'fast-path', isolation: 'worktree' });
      expect(res.status).toBe(201);
    });

    it('allows a ticket with unset/None effort (grooming happens inline)', async () => {
      vi.mocked(ensureTicketIsolation).mockResolvedValue({ branch: 'flux/FLUX-1-test' });
      const res = await startRoleless({ phase: 'fast-path', isolation: 'worktree' });
      expect(res.status).toBe(201);
    });

    // Fast-path writes code, so isolation must not depend on the caller remembering to request
    // it: the MCP dispatcher always sends `isolation`, but the portal's fast-path launch sends
    // none — and, launching from Grooming, it never routes through the Todo Start-Task prompt
    // that pre-creates a branch for normal implementation launches. Without this server-side
    // default the session spawned branchless in the shared checkout, committing to master.
    it('defaults to worktree isolation when the caller omits it (the portal launch path)', async () => {
      vi.mocked(ensureTicketIsolation).mockResolvedValue({ branch: 'flux/FLUX-1-test' });
      const res = await startRoleless({ phase: 'fast-path' });
      expect(res.status).toBe(201);
      const { session } = await res.json();
      await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
      expect(ensureTicketIsolation).toHaveBeenCalledWith('FLUX-1', { worktree: true });
    });

    it('still honors an explicit branch-only isolation request (MCP worktree:false)', async () => {
      vi.mocked(ensureTicketIsolation).mockResolvedValue({ branch: 'flux/FLUX-1-test' });
      const res = await startRoleless({ phase: 'fast-path', isolation: 'branch' });
      expect(res.status).toBe(201);
      const { session } = await res.json();
      await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
      expect(ensureTicketIsolation).toHaveBeenCalledWith('FLUX-1', { worktree: false });
    });

    it('does not force isolation for non-fast-path phases (caller-driven, unchanged)', async () => {
      const res = await startRoleless({ phase: 'implementation' });
      expect(res.status).toBe(201);
      const { session } = await res.json();
      await waitFor(() => cliSessionsById.get(session.id)?.status === 'running');
      expect(ensureTicketIsolation).not.toHaveBeenCalled();
    });
  });

  // A fresh-spawn pre-spawn failure (worktree pool full, git push failure, …) previously surfaced
  // only inside the ticket chat + history — no board flag, unlike a resume-time failure
  // (surfaceResumeFailure raises needsAction). Dispatched launches are fire-and-forget, so the
  // failure must land the ticket in the board's "Needs Action" group.
  it('raises the persistent needsAction flag when the backgrounded launch fails', async () => {
    vi.mocked(ensureTicketIsolation).mockRejectedValue(new Error('Task worktree limit reached (4/4).'));

    const res = await startRoleless({ isolation: 'worktree' });
    expect(res.status).toBe(201);
    const { session } = await res.json();

    await waitFor(() => cliSessionsById.get(session.id)?.status === 'failed');
    await waitFor(() => typeof getWorkspace().tasks['FLUX-1']?.needsAction === 'string');
    expect(getWorkspace().tasks['FLUX-1'].needsAction).toContain('failed to start');
    expect(getWorkspace().tasks['FLUX-1'].needsAction).toContain('Task worktree limit reached');
  });

  // A delegated group member (scatter-gather worker, supervisor delegate) shares the ticket with
  // an actively-running orchestrator that owns the status transition — mirrors flagIfParked's
  // isDelegatedMember guard (parked-ticket.ts). Flagging the ticket on a delegate's pre-spawn
  // failure would be a false positive: the orchestrator is still working and may resolve it.
  it('does NOT raise needsAction when a delegated group member (groupId set) fails to spawn', async () => {
    vi.mocked(ensureTicketIsolation).mockRejectedValue(new Error('Task worktree limit reached (4/4).'));

    const res = await startRoleless({ isolation: 'worktree', groupId: 'group-1', patternPosition: 'step' });
    expect(res.status).toBe(201);
    const { session } = await res.json();

    await waitFor(() => cliSessionsById.get(session.id)?.status === 'failed');
    // Give the (best-effort, non-awaited) needsAction path a tick to have fired if it were going to.
    await new Promise((r) => setTimeout(r, 50));
    expect(getWorkspace().tasks['FLUX-1']?.needsAction).toBeFalsy();
  });

  // The inverse: a group LEAD (supervisor orchestrator / scatter-gather combiner) carries the same
  // groupId but IS the orchestrator — if it fails to spawn, nobody is driving the ticket, so the
  // delegated-member exemption must not swallow the flag (FLUX-1436, a FLUX-651 coverage hole:
  // the old blanket `groupId` check exempted leads too).
  it('DOES raise needsAction when a group LEAD fails to spawn', async () => {
    vi.mocked(ensureTicketIsolation).mockRejectedValue(new Error('Task worktree limit reached (4/4).'));

    const res = await startRoleless({ isolation: 'worktree', groupId: 'group-1', patternPosition: 'lead' });
    expect(res.status).toBe(201);
    const { session } = await res.json();

    await waitFor(() => cliSessionsById.get(session.id)?.status === 'failed');
    await waitFor(() => typeof getWorkspace().tasks['FLUX-1']?.needsAction === 'string');
    expect(getWorkspace().tasks['FLUX-1'].needsAction).toContain('failed to start');
  });

  // FLUX-1469: the launch focus must land as a single copy in the persisted history entry, not
  // duplicated across `comment` and a separate `launchFocus` metadata field.
  describe('launch focus persistence (FLUX-1469)', () => {
    function launchFocusEntry() {
      const history = getWorkspace().tasks['FLUX-1']?.history ?? [];
      return history.find((e: { comment?: string }) => typeof e.comment === 'string' && e.comment.startsWith('🎯 Launch focus: '));
    }

    it('a short focus is stored once, in `comment` only — no separate launchFocus field, no summary', async () => {
      const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework: TEST_FRAMEWORK, focusComment: 'Dynamic Delegation: short focus' }),
      });
      expect(res.status).toBe(201);

      const entry = launchFocusEntry();
      expect(entry).toBeDefined();
      expect(entry.comment).toBe('🎯 Launch focus: Dynamic Delegation: short focus');
      expect(entry.launchFocus).toBeUndefined();
      expect(entry.summary).toBeUndefined();
    });

    it('a large, pull-backed focus is stored once and gets a compact summary for the agent digest', async () => {
      const bigFocus = `${'A long plan-review focus body. '.repeat(20)} read_skill('review', 'Plan-review methodology').`;
      const res = await fetch(`${baseUrl}/api/tasks/FLUX-1/cli-session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework: TEST_FRAMEWORK, focusComment: bigFocus }),
      });
      expect(res.status).toBe(201);

      const entry = launchFocusEntry();
      expect(entry).toBeDefined();
      expect(entry.comment).toBe(`🎯 Launch focus: ${bigFocus}`);
      expect(entry.launchFocus).toBeUndefined();
      expect(typeof entry.summary).toBe('string');
      expect(entry.comment).not.toBe(entry.summary);
      expect(entry.summary).toContain("read_skill('review', 'Plan-review methodology')");
    });
  });
});

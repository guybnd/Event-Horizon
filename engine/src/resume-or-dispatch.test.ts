// FLUX-1378: "resume, don't respawn" — `resumeOrDispatchSession` is the seam that resumes a ticket's
// prior phase session (warm context, `--resume`) instead of always cold-spawning a fresh one. These
// tests pin the viability decision table (resumable / context headroom / turn-count proxy / staleness /
// engine-restart guard / wrong-phase) plus the worktree-recreation self-heal and the resume-POST retry,
// and separately `deltaReviewFocus`'s delta-scoping addendum. Only `./task-worktree.js`'s two async git
// checks are stubbed (importActual for everything else) — no real git repo or child process involved.

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setWorkspaceRoot } from './workspace.js';
import { cliSessionsById, cliSessionsByTaskId, registerSession } from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

vi.mock('./task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-worktree.js')>();
  return { ...actual, isRegisteredWorktree: vi.fn(), resolveTaskExecutionRoot: vi.fn() };
});

import { isRegisteredWorktree, resolveTaskExecutionRoot } from './task-worktree.js';
import { resumeOrDispatchSession, deltaReviewFocus } from './furnace-stoker.js';

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

describe('resumeOrDispatchSession (FLUX-1378)', () => {
  let root: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let coldSeq: number;

  /** `omit` drops a default field entirely (exactOptionalPropertyTypes forbids `field: undefined`
   *  in an override object typed as Partial<CliSessionRecord> when the field itself is non-optional
   *  in value type, e.g. `sessionHistoryEntry`/`resumeSessionId`/`contextWindow`). */
  function makeSession(
    overrides: Partial<CliSessionRecord> & { taskId: string },
    omit: (keyof CliSessionRecord)[] = [],
  ): CliSessionRecord {
    const now = new Date().toISOString();
    // No `: CliSessionRecord` annotation here — spreading `overrides` (typed Partial<CliSessionRecord>)
    // into an explicitly-typed object literal widens optional-field types to include `undefined` under
    // exactOptionalPropertyTypes even though `omit` (not `field: undefined`) is how a test opts a field
    // out. Infer instead, then assert once on return.
    const session = {
      id: 'sess-default',
      framework: 'claude',
      status: 'waiting-input',
      command: 'claude',
      args: [],
      startedAt: now,
      label: 'Claude Code',
      outputBuffer: '',
      liveOutputBuffer: '',
      pendingAssistantText: '',
      cumulativeOutput: '',
      requestedStop: false,
      writeQueue: Promise.resolve(),
      skipPermissions: true,
      resumeSessionId: 'resume-abc',
      phase: 'implementation',
      sessionHistoryEntry: { sessionId: 'hist-1', progress: [] } as unknown as CliSessionRecord['sessionHistoryEntry'],
      lastOutputAt: now,
      ...overrides,
    };
    for (const key of omit) delete (session as Record<string, unknown>)[key];
    return session as CliSessionRecord;
  }

  function registerTicketSession(session: CliSessionRecord) {
    cliSessionsById.set(session.id, session);
    registerSession(session.taskId, session.id);
  }

  function calls(): FetchCall[] {
    return fetchMock.mock.calls.map((call: unknown[]) => ({
      url: String(call[0]),
      body: JSON.parse((call[1] as { body: string }).body),
    }));
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-resume-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
    vi.mocked(isRegisteredWorktree).mockReset();
    vi.mocked(resolveTaskExecutionRoot).mockReset();
    coldSeq = 0;

    fetchMock = vi.fn(async (url: unknown, init: { body: string }) => {
      const s = String(url);
      if (s.includes('/cli-session/input')) {
        return { ok: true, json: async () => ({}) };
      }
      if (s.includes('/cli-session/start')) {
        const m = s.match(/\/api\/tasks\/([^/]+)\//);
        const taskId = decodeURIComponent(m![1]!);
        const body = JSON.parse(init.body);
        const id = `cold-${++coldSeq}`;
        registerTicketSession(makeSession({ id, taskId, status: 'running', phase: body.phase }));
        return { ok: true, json: async () => ({ session: { id } }) };
      }
      throw new Error(`unexpected fetch: ${s}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('resumes a viable waiting-input session instead of cold-spawning', async () => {
    const ticketId = 'TICK-1';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-1', taskId: ticketId }));

    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(true);
    expect(outcome.sid).toBe('sess-1');
    const made = calls();
    expect(made.some((c) => c.url.includes('/cli-session/start'))).toBe(false);
    expect(made.some((c) => c.url.includes('/cli-session/input') && c.body.message === 'go')).toBe(true);
  });

  it('cold-spawns when no session exists for the phase', async () => {
    const ticketId = 'TICK-2';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
    expect(outcome.sid).toBe('cold-1');
  });

  it('cold-spawns when the prior session status is terminal (failed)', async () => {
    const ticketId = 'TICK-3';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-3', taskId: ticketId, status: 'failed' }));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
  });

  it('cold-spawns a session with no resumeSessionId yet', async () => {
    const ticketId = 'TICK-3b';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-3b', taskId: ticketId }, ['resumeSessionId']));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
  });

  it('ignores a session dispatched for a DIFFERENT phase', async () => {
    const ticketId = 'TICK-4';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-4', taskId: ticketId, phase: 'review' }));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
  });

  it('cold-spawns a session rehydrated from an on-disk stub (engine restarted since dispatch)', async () => {
    const ticketId = 'TICK-5';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-5', taskId: ticketId }, ['sessionHistoryEntry']));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
  });

  describe('context headroom / turn-count proxy', () => {
    it('cold-spawns when the last recorded context exceeds 60% of the known window', async () => {
      const ticketId = 'TICK-6';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
      registerTicketSession(makeSession({ id: 'sess-6', taskId: ticketId, lastTurnContextTokens: 700_000, contextWindow: 1_000_000 }));
      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(false);
    });

    it('resumes when comfortably under the 60% threshold', async () => {
      const ticketId = 'TICK-7';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
      registerTicketSession(makeSession({ id: 'sess-7', taskId: ticketId, lastTurnContextTokens: 100_000, contextWindow: 1_000_000 }));
      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(true);
    });

    it('applies the 150k fallback window when contextWindow was never reported', async () => {
      const ticketId = 'TICK-8';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
      // 100k / 150k fallback = 67% > 60% threshold → cold spawn.
      registerTicketSession(makeSession({ id: 'sess-8', taskId: ticketId, lastTurnContextTokens: 100_000 }, ['contextWindow']));
      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(false);
    });

    it('falls back to the turn-count proxy (cap 8) when no usage was ever recorded', async () => {
      const ticketId = 'TICK-9';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
      registerTicketSession(makeSession({ id: 'sess-9', taskId: ticketId, resumeTurnCount: 8 }, ['lastTurnContextTokens']));
      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(false);
    });

    it('resumes under the turn-count cap when no usage was recorded', async () => {
      const ticketId = 'TICK-10';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
      registerTicketSession(makeSession({ id: 'sess-10', taskId: ticketId, resumeTurnCount: 3 }, ['lastTurnContextTokens']));
      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(true);
    });
  });

  it('cold-spawns a stale session (idle > 30 minutes)', async () => {
    const ticketId = 'TICK-11';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({
      id: 'sess-11', taskId: ticketId, lastOutputAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    }));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
  });

  it('resumes a session idle just under 30 minutes', async () => {
    const ticketId = 'TICK-12';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({
      id: 'sess-12', taskId: ticketId, lastOutputAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    }));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(true);
  });

  it('does not resume a running session even with fresh output (FLUX-1396 H1: running excluded from resumable set)', async () => {
    const ticketId = 'TICK-19';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-19', taskId: ticketId, status: 'running' }));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);

    // Isolate the status exclusion (not staleness or some other factor): an otherwise-identical
    // candidate that is 'waiting-input' instead of 'running' WOULD resume.
    const controlTicketId = 'TICK-19-control';
    getWorkspace().tasks[controlTicketId] = { id: controlTicketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-19-control', taskId: controlTicketId, status: 'waiting-input' }));
    const controlOutcome = await resumeOrDispatchSession(controlTicketId, 'implementation', { resumeMessage: 'go' });
    expect(controlOutcome.resumed).toBe(true);
  });

  it('does not resume a stale running session either (belt-and-suspenders: pre-H1 staleness path still holds)', async () => {
    const ticketId = 'TICK-20';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({
      id: 'sess-20', taskId: ticketId, status: 'running',
      lastOutputAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    }));
    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(outcome.resumed).toBe(false);
  });

  describe('worktree recreation', () => {
    it('recreates a reclaimed-but-live-branch worktree BEFORE the resume POST, then resumes with a warning', async () => {
      const ticketId = 'TICK-13';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress', branch: 'flux/tick-13' };
      registerTicketSession(makeSession({ id: 'sess-13', taskId: ticketId, executionRoot: path.join(root, 'worktree-13') }));
      vi.mocked(isRegisteredWorktree).mockResolvedValue(false);
      vi.mocked(resolveTaskExecutionRoot).mockResolvedValue(path.join(root, 'worktree-13-recreated'));

      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(true);
      expect(resolveTaskExecutionRoot).toHaveBeenCalledWith(
        expect.objectContaining({ id: ticketId, branch: 'flux/tick-13' }),
        root,
        expect.objectContaining({ create: true }),
      );

      const made = calls();
      const inputCall = made.find((c) => c.url.includes('/cli-session/input'));
      expect(inputCall).toBeDefined();
      expect(String(inputCall!.body.message)).toMatch(/recreated from the branch tip/);

      // Recreation happened strictly before the resume POST (pre-flight — never discovered via the
      // resume route's own terminal failure path).
      const recreateOrder = vi.mocked(resolveTaskExecutionRoot).mock.invocationCallOrder[0]!;
      const inputCallIdx = fetchMock.mock.calls.findIndex((call: unknown[]) => String(call[0]).includes('/cli-session/input'));
      const inputOrder = fetchMock.mock.invocationCallOrder[inputCallIdx]!;
      expect(recreateOrder).toBeLessThan(inputOrder);
    });

    it('falls back to cold spawn (session stays resumable) when recreation fails', async () => {
      const ticketId = 'TICK-14';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress', branch: 'flux/tick-14' };
      const session = makeSession({ id: 'sess-14', taskId: ticketId, executionRoot: path.join(root, 'worktree-14') });
      registerTicketSession(session);
      vi.mocked(isRegisteredWorktree).mockResolvedValue(false);
      vi.mocked(resolveTaskExecutionRoot).mockRejectedValue(new Error('branch deleted'));

      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(false);
      expect(outcome.sid).toBe('cold-1');
      // The original session was never terminalized by this path — still resumable.
      expect(session.status).toBe('waiting-input');
      expect(calls().some((c) => c.url.includes('/cli-session/input'))).toBe(false);
    });

    it('a still-registered worktree needs no recreation and carries no warning', async () => {
      const ticketId = 'TICK-15';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress', branch: 'flux/tick-15' };
      registerTicketSession(makeSession({ id: 'sess-15', taskId: ticketId, executionRoot: path.join(root, 'worktree-15') }));
      vi.mocked(isRegisteredWorktree).mockResolvedValue(true);

      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(true);
      expect(resolveTaskExecutionRoot).not.toHaveBeenCalled();
      const inputCall = calls().find((c) => c.url.includes('/cli-session/input'));
      expect(String(inputCall!.body.message)).toBe('go');
    });

    it('skips the worktree check entirely for a branchless ticket', async () => {
      const ticketId = 'TICK-16';
      getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
      registerTicketSession(makeSession({ id: 'sess-16', taskId: ticketId }));
      const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
      expect(outcome.resumed).toBe(true);
      expect(isRegisteredWorktree).not.toHaveBeenCalled();
    });
  });

  it('retries the resume POST once on a transient failure before falling back to cold spawn', async () => {
    const ticketId = 'TICK-17';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    registerTicketSession(makeSession({ id: 'sess-17', taskId: ticketId }));
    let inputCalls = 0;
    fetchMock.mockImplementation(async (url: unknown, init: { body: string }) => {
      const s = String(url);
      if (s.includes('/cli-session/input')) {
        inputCalls++;
        return { ok: false, status: 500, json: async () => ({ error: 'EBUSY' }) };
      }
      const m = s.match(/\/api\/tasks\/([^/]+)\//);
      const taskId = decodeURIComponent(m![1]!);
      const body = JSON.parse(init.body);
      const id = `cold-${++coldSeq}`;
      registerTicketSession(makeSession({ id, taskId, status: 'running', phase: body.phase }));
      return { ok: true, json: async () => ({ session: { id } }) };
    });

    const outcome = await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(inputCalls).toBe(2); // one retry, then give up on resume
    expect(outcome.resumed).toBe(false);
    expect(outcome.sid).toBe('cold-1');
  });

  it('advances resumeTurnCount on a successful resume', async () => {
    const ticketId = 'TICK-18';
    getWorkspace().tasks[ticketId] = { id: ticketId, status: 'In Progress' };
    const session = makeSession({ id: 'sess-18', taskId: ticketId, resumeTurnCount: 2 });
    registerTicketSession(session);
    await resumeOrDispatchSession(ticketId, 'implementation', { resumeMessage: 'go' });
    expect(session.resumeTurnCount).toBe(3);
  });
});

describe('deltaReviewFocus (FLUX-1378)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-delta-review-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('is empty for a ticket with no lastReviewedCommit (first review)', () => {
    getWorkspace().tasks['DR-1'] = { id: 'DR-1' };
    expect(deltaReviewFocus('DR-1')).toBe('');
  });

  it('names the delta commit and points at named findings + the diff for a re-review', () => {
    getWorkspace().tasks['DR-2'] = { id: 'DR-2', lastReviewedCommit: 'abcdef1234567890' };
    const focus = deltaReviewFocus('DR-2');
    expect(focus).toContain('abcdef123456');
    expect(focus).toMatch(/named findings/);
    expect(focus).toContain('git diff abcdef1234567890..HEAD');
    expect(focus).toMatch(/do not need to re-review the whole PR from scratch/);
  });

  it('is empty when the task is missing entirely', () => {
    expect(deltaReviewFocus('DR-NONEXISTENT')).toBe('');
  });
});

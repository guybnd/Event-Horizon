import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./agents/index.js', () => ({
  getAdapter: () => ({
    labelForFramework: () => 'Claude Code',
    start: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    manifest: { id: 'claude', displayName: 'Claude Code', configSchema: {}, costModel: { inputPerMToken: 3, outputPerMToken: 15, currency: 'usd' }, capabilities: { compacting: true, effortLevels: ['low', 'medium', 'high'], memoryFiles: true } },
  }),
}));

vi.mock('./task-store.js', () => ({
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./history.js', () => ({
  buildActivityEntry: (msg: string, user: string, date: string) => ({ type: 'activity', comment: msg, user, date }),
}));

vi.mock('../workspace.js', () => ({
  getWorkspaceRoot: () => '/tmp/test',
}));

import {
  cliSessionsById,
  cliSessionsByTaskId,
  cliSessionIdByTaskId,
  registerSession,
  unregisterSession,
  getCliSessionSummaryForTask,
  getListCliSessionSummaryForTask,
  getAllSessionSummariesForTask,
  getListSessionSummariesForTask,
  getActiveSessionsForTask,
  getLiveStandaloneSessionForTask,
  getPreferredInputSessionId,
  slimSessionSummaryForAgent,
  checkPathConflicts,
  validatePatternSupport,
  stopAllSessionsForTask,
  reapStaleParkedSessions,
  reconcileDeadSessions,
  getActiveSessionCount,
  getLiveProcessSessionCount,
} from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';
import type { ChildProcessWithoutNullStreams } from 'child_process';

/** Test-only view of `slimSessionSummaryForAgent`'s result — it strips args/command/pid from
 *  CliSessionSummary, so these assertions check they're really gone (typed `unknown`, not real fields). */
interface SlimSessionSummaryTestView {
  id: string;
  framework: string;
  status: string;
  argsChars?: number;
  liveOutput?: string;
  args?: unknown;
  command?: unknown;
  pid?: unknown;
}

function createMockSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    taskId: 'FLUX-TEST',
    framework: 'test-cli',
    status: 'running',
    command: 'claude',
    args: [],
    startedAt: new Date().toISOString(),
    label: 'Claude Code',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    skipPermissions: true,
    requestedStop: false,
    writeQueue: Promise.resolve(),
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    ...overrides,
  } as CliSessionRecord;
}

describe('session-store', () => {
  beforeEach(() => {
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
  });

  describe('registerSession / unregisterSession', () => {
    it('registers a session for a task', () => {
      registerSession('FLUX-1', 'sess-a');
      expect(cliSessionsByTaskId.get('FLUX-1')).toEqual(['sess-a']);
    });

    it('allows multiple sessions per task', () => {
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');
      expect(cliSessionsByTaskId.get('FLUX-1')).toEqual(['sess-a', 'sess-b']);
    });

    it('does not duplicate session IDs', () => {
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-a');
      expect(cliSessionsByTaskId.get('FLUX-1')).toEqual(['sess-a']);
    });

    it('unregisters a session', () => {
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');
      unregisterSession('FLUX-1', 'sess-a');
      expect(cliSessionsByTaskId.get('FLUX-1')).toEqual(['sess-b']);
    });

    it('removes task entry when last session is unregistered', () => {
      registerSession('FLUX-1', 'sess-a');
      unregisterSession('FLUX-1', 'sess-a');
      expect(cliSessionsByTaskId.has('FLUX-1')).toBe(false);
    });
  });

  describe('cliSessionIdByTaskId (backwards-compat shim)', () => {
    it('get returns the most recent session ID', () => {
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');
      expect(cliSessionIdByTaskId.get('FLUX-1')).toBe('sess-b');
    });

    it('get returns undefined when no sessions', () => {
      expect(cliSessionIdByTaskId.get('FLUX-NONE')).toBeUndefined();
    });

    it('has returns true when sessions exist', () => {
      registerSession('FLUX-1', 'sess-a');
      expect(cliSessionIdByTaskId.has('FLUX-1')).toBe(true);
    });
  });

  describe('getCliSessionSummaryForTask', () => {
    it('returns most recent active session', () => {
      const sessA = createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'cancelled' });
      const sessB = createMockSession({ id: 'sess-b', taskId: 'FLUX-1', status: 'running' });
      cliSessionsById.set('sess-a', sessA);
      cliSessionsById.set('sess-b', sessB);
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');

      const summary = getCliSessionSummaryForTask('FLUX-1');
      expect(summary?.id).toBe('sess-b');
      expect(summary?.status).toBe('running');
    });

    it('falls back to last session when none active', () => {
      const sessA = createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'cancelled' });
      cliSessionsById.set('sess-a', sessA);
      registerSession('FLUX-1', 'sess-a');

      const summary = getCliSessionSummaryForTask('FLUX-1');
      expect(summary?.id).toBe('sess-a');
    });

    it('returns undefined when no sessions exist', () => {
      expect(getCliSessionSummaryForTask('FLUX-NONE')).toBeUndefined();
    });
  });

  describe('getPreferredInputSessionId (role-aware no-target chat fallback)', () => {
    function register(task: string, s: CliSessionRecord) {
      cliSessionsById.set(s.id, s);
      registerSession(task, s.id);
    }

    it('prefers the supervisor lead over a later-registered completed delegate (the incident shape)', () => {
      register('FLUX-1', createMockSession({ id: 'lead', taskId: 'FLUX-1', status: 'waiting-input', pattern: 'supervisor', patternPosition: 'lead', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'worker-1', taskId: 'FLUX-1', status: 'completed', patternPosition: 'assistant', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'worker-2', taskId: 'FLUX-1', status: 'completed', patternPosition: 'assistant', groupId: 'g1' }));
      expect(getPreferredInputSessionId('FLUX-1')).toBe('lead');
    });

    it('a newer solo session outranks an older lead — recency wins within addressable sessions', () => {
      register('FLUX-1', createMockSession({ id: 'lead', taskId: 'FLUX-1', status: 'completed', patternPosition: 'lead', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'solo-chat', taskId: 'FLUX-1', status: 'waiting-input' }));
      expect(getPreferredInputSessionId('FLUX-1')).toBe('solo-chat');
    });

    it('prefers a scatter-gather combiner over its steps', () => {
      register('FLUX-1', createMockSession({ id: 'step-1', taskId: 'FLUX-1', status: 'completed', patternPosition: 'step', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'combiner', taskId: 'FLUX-1', status: 'waiting-input', patternPosition: 'combiner', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'step-late', taskId: 'FLUX-1', status: 'completed', patternPosition: 'step', groupId: 'g1' }));
      expect(getPreferredInputSessionId('FLUX-1')).toBe('combiner');
    });

    it('falls back to the most recent resumable subordinate when no addressable session is resumable (relay mid-chain)', () => {
      register('FLUX-1', createMockSession({ id: 'step-1', taskId: 'FLUX-1', status: 'completed', patternPosition: 'step', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'step-2', taskId: 'FLUX-1', status: 'waiting-input', patternPosition: 'step', groupId: 'g1' }));
      expect(getPreferredInputSessionId('FLUX-1')).toBe('step-2');
    });

    it('skips non-resumable sessions (failed/cancelled) when picking the addressable one', () => {
      register('FLUX-1', createMockSession({ id: 'lead', taskId: 'FLUX-1', status: 'waiting-input', patternPosition: 'lead', groupId: 'g1' }));
      register('FLUX-1', createMockSession({ id: 'solo-dead', taskId: 'FLUX-1', status: 'failed' }));
      expect(getPreferredInputSessionId('FLUX-1')).toBe('lead');
    });

    it('returns the last-registered id when nothing is resumable, preserving the 409-with-summary path', () => {
      register('FLUX-1', createMockSession({ id: 'a', taskId: 'FLUX-1', status: 'failed' }));
      register('FLUX-1', createMockSession({ id: 'b', taskId: 'FLUX-1', status: 'cancelled' }));
      expect(getPreferredInputSessionId('FLUX-1')).toBe('b');
    });

    it('returns undefined when no sessions exist', () => {
      expect(getPreferredInputSessionId('FLUX-NONE')).toBeUndefined();
    });
  });

  describe('getLiveStandaloneSessionForTask (FLUX-1235)', () => {
    function register(task: string, s: CliSessionRecord) {
      cliSessionsById.set(s.id, s);
      registerSession(task, s.id);
    }

    it('returns a roleless running session (the one that blocks a Furnace dispatch)', () => {
      register('FLUX-1', createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'running' }));
      expect(getLiveStandaloneSessionForTask('FLUX-1')?.id).toBe('sess-a');
    });

    it('returns a roleless pending session', () => {
      register('FLUX-1', createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'pending' }));
      expect(getLiveStandaloneSessionForTask('FLUX-1')?.id).toBe('sess-a');
    });

    it('ignores an IDLE (waiting-input) session — the Furnace takes it over, never a live block', () => {
      register('FLUX-1', createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'waiting-input', resumeSessionId: 'r1' }));
      expect(getLiveStandaloneSessionForTask('FLUX-1')).toBeUndefined();
    });

    it('ignores a roleful (multi-session) live session — it does not block a roleless dispatch', () => {
      register('FLUX-1', createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'running', role: 'reviewer' }));
      expect(getLiveStandaloneSessionForTask('FLUX-1')).toBeUndefined();
    });

    it('returns undefined when the task has no sessions', () => {
      expect(getLiveStandaloneSessionForTask('FLUX-NONE')).toBeUndefined();
    });
  });

  describe('getAllSessionSummariesForTask', () => {
    it('returns all sessions for a task', () => {
      const sessA = createMockSession({ id: 'sess-a', taskId: 'FLUX-1', role: 'reviewer' });
      const sessB = createMockSession({ id: 'sess-b', taskId: 'FLUX-1', role: 'implementer' });
      cliSessionsById.set('sess-a', sessA);
      cliSessionsById.set('sess-b', sessB);
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');

      const summaries = getAllSessionSummariesForTask('FLUX-1');
      expect(summaries).toHaveLength(2);
      expect(summaries[0]!.role).toBe('reviewer');
      expect(summaries[1]!.role).toBe('implementer');
    });

    it('returns empty array when no sessions', () => {
      expect(getAllSessionSummariesForTask('FLUX-NONE')).toEqual([]);
    });
  });

  describe('reconcileDeadSessions (FLUX-846)', () => {
    const STALE = '2026-06-27T15:00:00.000Z';
    const NOW = Date.parse('2026-06-27T15:30:00.000Z'); // 30m after STALE — well past the grace
    const deadProc = (exitCode: number | null, signalCode: string | null = null) =>
      ({ exitCode, signalCode } as unknown as ChildProcessWithoutNullStreams);

    it('terminalizes a running session whose process exited cleanly (missed exit event)', () => {
      const s = createMockSession({ id: 'sess-dead', taskId: 'FLUX-1', status: 'running', startedAt: STALE, lastOutputAt: STALE, proc: deadProc(0) });
      cliSessionsById.set('sess-dead', s);
      const reaped = reconcileDeadSessions(NOW);
      expect(reaped).toBe(1);
      expect(s.status).toBe('completed');
      expect(s.endedAt).toBe(new Date(NOW).toISOString());
    });

    it('marks a non-zero exit session as failed', () => {
      const nonZero = createMockSession({ id: 'sess-nz', taskId: 'FLUX-1', status: 'running', startedAt: STALE, lastOutputAt: STALE, proc: deadProc(1) });
      cliSessionsById.set('sess-nz', nonZero);
      expect(reconcileDeadSessions(NOW)).toBe(1);
      expect(nonZero.status).toBe('failed');
    });

    it('never reaps a pre-spawn pending session with no proc (live, still starting)', () => {
      // A null `proc` is the pre-spawn window (`startedAt` stamped before the spawn completes), not a
      // dead process. Reaping it would stamp a bogus endedAt that the later status='running' leaves
      // behind, making a genuinely-live session read as inactive forever (FLUX-846, opposite direction).
      const noProc = createMockSession({ id: 'sess-np', taskId: 'FLUX-1', status: 'pending', startedAt: STALE, lastOutputAt: STALE });
      cliSessionsById.set('sess-np', noProc);
      expect(reconcileDeadSessions(NOW)).toBe(0);
      expect(noProc.status).toBe('pending');
      expect(noProc.endedAt).toBeUndefined();
    });

    it('leaves a live process alone', () => {
      const s = createMockSession({ id: 'sess-live', taskId: 'FLUX-1', status: 'running', startedAt: STALE, lastOutputAt: STALE, proc: deadProc(null) });
      cliSessionsById.set('sess-live', s);
      expect(reconcileDeadSessions(NOW)).toBe(0);
      expect(s.status).toBe('running');
    });

    it('respects the grace window (does not race the exit handler)', () => {
      const justExited = createMockSession({ id: 'sess-fresh', taskId: 'FLUX-1', status: 'running', startedAt: STALE, lastOutputAt: new Date(NOW - 5_000).toISOString(), proc: deadProc(0) });
      cliSessionsById.set('sess-fresh', justExited);
      expect(reconcileDeadSessions(NOW)).toBe(0);
      expect(justExited.status).toBe('running');
    });

    it('never reaps a waiting-input session (resumable, keeps a dead proc between turns)', () => {
      const parked = createMockSession({ id: 'sess-wait', taskId: 'FLUX-1', status: 'waiting-input', startedAt: STALE, lastOutputAt: STALE, proc: deadProc(0) });
      cliSessionsById.set('sess-wait', parked);
      expect(reconcileDeadSessions(NOW)).toBe(0);
      expect(parked.status).toBe('waiting-input');
    });
  });

  describe('getListSessionSummariesForTask', () => {
    const reg = (s: CliSessionRecord) => {
      cliSessionsById.set(s.id, s);
      registerSession(s.taskId, s.id);
    };

    it('returns empty array when no sessions', () => {
      expect(getListSessionSummariesForTask('FLUX-NONE')).toEqual([]);
    });

    it('keeps active sessions and the most-recent completed group, dropping older groups', () => {
      // Older completed group
      reg(createMockSession({ id: 'old-1', taskId: 'FLUX-1', status: 'completed', groupId: 'g-old', startedAt: '2026-06-01T00:00:00.000Z', endedAt: '2026-06-01T00:01:00.000Z' }));
      reg(createMockSession({ id: 'old-2', taskId: 'FLUX-1', status: 'completed', groupId: 'g-old', startedAt: '2026-06-01T00:00:00.000Z', endedAt: '2026-06-01T00:02:00.000Z' }));
      // Newer completed group
      reg(createMockSession({ id: 'new-1', taskId: 'FLUX-1', status: 'completed', groupId: 'g-new', startedAt: '2026-06-02T00:00:00.000Z', endedAt: '2026-06-02T00:01:00.000Z' }));
      reg(createMockSession({ id: 'new-2', taskId: 'FLUX-1', status: 'failed', groupId: 'g-new', startedAt: '2026-06-02T00:00:00.000Z', endedAt: '2026-06-02T00:02:00.000Z' }));
      // An active session (separate group)
      reg(createMockSession({ id: 'act-1', taskId: 'FLUX-1', status: 'running', groupId: 'g-live', startedAt: '2026-06-03T00:00:00.000Z' }));

      const ids = getListSessionSummariesForTask('FLUX-1').map(s => s.id);
      expect(ids).toContain('act-1');
      expect(ids).toContain('new-1');
      expect(ids).toContain('new-2');
      expect(ids).not.toContain('old-1');
      expect(ids).not.toContain('old-2');
    });

    it('truncates liveOutput to a short tail', () => {
      const big = 'x'.repeat(5000);
      reg(createMockSession({ id: 'big-1', taskId: 'FLUX-2', status: 'completed', startedAt: '2026-06-02T00:00:00.000Z', endedAt: '2026-06-02T00:01:00.000Z', liveOutputBuffer: big }));

      const [summary] = getListSessionSummariesForTask('FLUX-2');
      expect(summary!.liveOutput!.length).toBe(2048);
      expect(summary!.liveOutput).toBe(big.slice(-2048));
    });
  });

  describe('getListCliSessionSummaryForTask (FLUX-1144)', () => {
    const reg = (s: CliSessionRecord) => {
      cliSessionsById.set(s.id, s);
      registerSession(s.taskId, s.id);
    };

    it('returns undefined when there are no sessions', () => {
      expect(getListCliSessionSummaryForTask('FLUX-NONE')).toBeUndefined();
    });

    it('truncates liveOutput to the same short tail as the plural list summaries', () => {
      const big = 'x'.repeat(5000);
      reg(createMockSession({ id: 'solo-1', taskId: 'FLUX-3', status: 'running', liveOutputBuffer: big }));

      const summary = getListCliSessionSummaryForTask('FLUX-3');
      expect(summary!.liveOutput!.length).toBe(2048);
      expect(summary!.liveOutput).toBe(big.slice(-2048));
    });

    it('does not truncate the untruncated getCliSessionSummaryForTask result (detail endpoint stays full-fat)', () => {
      const big = 'x'.repeat(5000);
      reg(createMockSession({ id: 'solo-2', taskId: 'FLUX-4', status: 'running', liveOutputBuffer: big }));

      expect(getListCliSessionSummaryForTask('FLUX-4')!.liveOutput!.length).toBe(2048);
      expect(getCliSessionSummaryForTask('FLUX-4')!.liveOutput!.length).toBe(5000);
    });
  });

  describe('getActiveSessionsForTask', () => {
    it('returns only active sessions (pending/running/waiting-input)', () => {
      const active = createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'running' });
      const done = createMockSession({ id: 'sess-b', taskId: 'FLUX-1', status: 'cancelled' });
      const waiting = createMockSession({ id: 'sess-c', taskId: 'FLUX-1', status: 'waiting-input' });
      cliSessionsById.set('sess-a', active);
      cliSessionsById.set('sess-b', done);
      cliSessionsById.set('sess-c', waiting);
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');
      registerSession('FLUX-1', 'sess-c');

      const result = getActiveSessionsForTask('FLUX-1');
      expect(result).toHaveLength(2);
      expect(result.map(s => s.id).sort()).toEqual(['sess-a', 'sess-c']);
    });
  });

  describe('reapStaleParkedSessions', () => {
    it('cancels parked phase sessions but leaves running, pending, and chat sessions', () => {
      const grooming = createMockSession({ id: 'sess-groom', taskId: 'FLUX-1', status: 'waiting-input', phase: 'grooming' });
      const planner = createMockSession({ id: 'sess-plan', taskId: 'FLUX-1', status: 'waiting-input', phase: 'implementation', role: 'planner' });
      const chat = createMockSession({ id: 'sess-chat', taskId: 'FLUX-1', status: 'waiting-input', phase: 'chat' });
      const running = createMockSession({ id: 'sess-run', taskId: 'FLUX-1', status: 'running', phase: 'review' });
      const pending = createMockSession({ id: 'sess-pend', taskId: 'FLUX-1', status: 'pending', phase: 'grooming' });
      for (const s of [grooming, planner, chat, running, pending]) {
        cliSessionsById.set(s.id, s);
        registerSession('FLUX-1', s.id);
      }

      const reaped = reapStaleParkedSessions('FLUX-1', 'test');

      expect(reaped.map(s => s.id).sort()).toEqual(['sess-groom', 'sess-plan']);
      expect(grooming.status).toBe('cancelled');
      expect(grooming.requestedStop).toBe(true);
      expect(grooming.endedAt).toBeTruthy();
      expect(planner.status).toBe('cancelled');
      // Preserved: persistent chat conversation + live sessions.
      expect(chat.status).toBe('waiting-input');
      expect(running.status).toBe('running');
      expect(pending.status).toBe('pending');
    });

    it('is idempotent — a second call reaps nothing', () => {
      const grooming = createMockSession({ id: 'sess-groom', taskId: 'FLUX-1', status: 'waiting-input', phase: 'grooming' });
      cliSessionsById.set('sess-groom', grooming);
      registerSession('FLUX-1', 'sess-groom');

      expect(reapStaleParkedSessions('FLUX-1', 'test')).toHaveLength(1);
      expect(reapStaleParkedSessions('FLUX-1', 'test')).toHaveLength(0);
    });

    it('returns empty for a task with no sessions', () => {
      expect(reapStaleParkedSessions('FLUX-UNKNOWN', 'test')).toEqual([]);
    });
  });

  describe('checkPathConflicts', () => {
    it('detects prefix overlap (dir locks file)', () => {
      const sessC = createMockSession({
        id: 'sess-c',
        taskId: 'FLUX-1',
        status: 'running',
        lockedPaths: ['src/models/'],
      });
      cliSessionsById.set('sess-c', sessC);
      registerSession('FLUX-1', 'sess-c');

      const result = checkPathConflicts('FLUX-1', ['src/models/user.ts']);
      expect(result.conflict).toBe(true);
      expect(result.holder).toBe('sess-c');
      expect(result.paths).toContain('src/models/user.ts');
    });

    it('detects prefix overlap (file locks dir)', () => {
      const sessC = createMockSession({
        id: 'sess-c',
        taskId: 'FLUX-1',
        status: 'running',
        lockedPaths: ['src/models/user.ts'],
      });
      cliSessionsById.set('sess-c', sessC);
      registerSession('FLUX-1', 'sess-c');

      const result = checkPathConflicts('FLUX-1', ['src/models/']);
      expect(result.conflict).toBe(true);
    });

    it('allows non-overlapping paths', () => {
      const sessC = createMockSession({
        id: 'sess-c',
        taskId: 'FLUX-1',
        status: 'running',
        lockedPaths: ['src/models/'],
      });
      cliSessionsById.set('sess-c', sessC);
      registerSession('FLUX-1', 'sess-c');

      const result = checkPathConflicts('FLUX-1', ['src/routes/']);
      expect(result.conflict).toBe(false);
    });

    it('returns no conflict when no locked paths on existing sessions', () => {
      const sessPlain = createMockSession({ id: 'sess-p', taskId: 'FLUX-1', status: 'running' });
      cliSessionsById.set('sess-p', sessPlain);
      registerSession('FLUX-1', 'sess-p');

      const result = checkPathConflicts('FLUX-1', ['src/anything/']);
      expect(result.conflict).toBe(false);
    });

    it('returns no conflict for empty requested paths', () => {
      const result = checkPathConflicts('FLUX-1', []);
      expect(result.conflict).toBe(false);
    });

    it('ignores cancelled sessions for conflicts', () => {
      const sessCancelled = createMockSession({
        id: 'sess-dead',
        taskId: 'FLUX-1',
        status: 'cancelled',
        lockedPaths: ['src/models/'],
      });
      cliSessionsById.set('sess-dead', sessCancelled);
      registerSession('FLUX-1', 'sess-dead');

      const result = checkPathConflicts('FLUX-1', ['src/models/user.ts']);
      expect(result.conflict).toBe(false);
    });
  });

  describe('validatePatternSupport', () => {
    it('allows gemini as supervisor lead', () => {
      const err = validatePatternSupport('gemini', 'supervisor', 'lead');
      expect(err).toBeNull();
    });

    it('allows claude as supervisor lead', () => {
      const err = validatePatternSupport('claude', 'supervisor', 'lead');
      expect(err).toBeNull();
    });

    it('allows gemini as scatter-gather step', () => {
      const err = validatePatternSupport('gemini', 'scatter-gather', 'step');
      expect(err).toBeNull();
    });

    it('allows claude scatter-gather', () => {
      const err = validatePatternSupport('claude', 'scatter-gather', 'step');
      expect(err).toBeNull();
    });

    it('rejects copilot as supervisor lead', () => {
      const err = validatePatternSupport('copilot', 'supervisor', 'lead');
      expect(err).toBeTruthy();
    });
  });

  describe('stopAllSessionsForTask', () => {
    it('cancels all active sessions for a task', () => {
      const sessA = createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'running' });
      const sessB = createMockSession({ id: 'sess-b', taskId: 'FLUX-1', status: 'waiting-input' });
      const sessC = createMockSession({ id: 'sess-c', taskId: 'FLUX-1', status: 'cancelled' });
      cliSessionsById.set('sess-a', sessA);
      cliSessionsById.set('sess-b', sessB);
      cliSessionsById.set('sess-c', sessC);
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');
      registerSession('FLUX-1', 'sess-c');

      stopAllSessionsForTask('FLUX-1', 'ticket moved to Ready');

      expect(sessA.status).toBe('cancelled');
      expect(sessA.requestedStop).toBe(true);
      expect(sessA.endedAt).toBeDefined();
      expect(sessB.status).toBe('cancelled');
      expect(sessB.requestedStop).toBe(true);
      // Already-cancelled session should remain unchanged
      expect(sessC.status).toBe('cancelled');
    });

    it('does nothing when no active sessions', () => {
      const sessDone = createMockSession({ id: 'sess-done', taskId: 'FLUX-1', status: 'completed' });
      cliSessionsById.set('sess-done', sessDone);
      registerSession('FLUX-1', 'sess-done');

      stopAllSessionsForTask('FLUX-1', 'test');
      expect(sessDone.status).toBe('completed');
    });
  });

  describe('multi-session scenario: two concurrent sessions with roles', () => {
    it('tracks two active sessions independently', () => {
      const sessA = createMockSession({
        id: 'sess-reviewer',
        taskId: 'FLUX-1',
        status: 'running',
        role: 'reviewer',
        pattern: 'scatter-gather',
        patternPosition: 'step',
      });
      const sessB = createMockSession({
        id: 'sess-impl',
        taskId: 'FLUX-1',
        status: 'running',
        role: 'implementer',
        pattern: 'scatter-gather',
        patternPosition: 'step',
      });
      cliSessionsById.set('sess-reviewer', sessA);
      cliSessionsById.set('sess-impl', sessB);
      registerSession('FLUX-1', 'sess-reviewer');
      registerSession('FLUX-1', 'sess-impl');

      const all = getAllSessionSummariesForTask('FLUX-1');
      expect(all).toHaveLength(2);
      expect(all.map(s => s.role).sort()).toEqual(['implementer', 'reviewer']);

      // getCliSessionSummaryForTask returns the most recent active (last registered)
      const single = getCliSessionSummaryForTask('FLUX-1');
      expect(single?.id).toBe('sess-impl');
    });
  });

  describe('targeted stop: stop specific session by ID', () => {
    it('stopping one session leaves others active', () => {
      const sessA = createMockSession({ id: 'sess-a', taskId: 'FLUX-1', status: 'running', role: 'reviewer' });
      const sessB = createMockSession({ id: 'sess-b', taskId: 'FLUX-1', status: 'running', role: 'implementer' });
      cliSessionsById.set('sess-a', sessA);
      cliSessionsById.set('sess-b', sessB);
      registerSession('FLUX-1', 'sess-a');
      registerSession('FLUX-1', 'sess-b');

      // Simulate targeted stop of sess-a
      sessA.requestedStop = true;
      sessA.status = 'cancelled';
      sessA.endedAt = new Date().toISOString();

      const active = getActiveSessionsForTask('FLUX-1');
      expect(active).toHaveLength(1);
      expect(active[0]!.id).toBe('sess-b');
      expect(active[0]!.status).toBe('running');
    });
  });

  describe('backwards compatibility: single session without role', () => {
    it('single session works with all query methods', () => {
      const sess = createMockSession({ id: 'sess-single', taskId: 'FLUX-1', status: 'running' });
      cliSessionsById.set('sess-single', sess);
      registerSession('FLUX-1', 'sess-single');

      // GET single session
      const single = getCliSessionSummaryForTask('FLUX-1');
      expect(single?.id).toBe('sess-single');

      // GET all sessions
      const all = getAllSessionSummariesForTask('FLUX-1');
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe('sess-single');

      // Stop it
      sess.status = 'cancelled';
      sess.endedAt = new Date().toISOString();
      const activeAfter = getActiveSessionsForTask('FLUX-1');
      expect(activeAfter).toHaveLength(0);
    });
  });

  describe('slimSessionSummaryForAgent', () => {
    it('drops args, command, and pid but keeps an argsChars size hint', () => {
      const launchPrompt = 'You are working on ticket FLUX-1. '.repeat(200);
      const session = createMockSession({ id: 'sess-slim', args: ['-p', launchPrompt], pid: 4242 });
      cliSessionsById.set(session.id, session);
      registerSession('FLUX-1', session.id);

      const summary = getCliSessionSummaryForTask('FLUX-1')!;
      const slim = slimSessionSummaryForAgent(summary) as unknown as SlimSessionSummaryTestView;

      expect(slim.args).toBeUndefined();
      expect(slim.command).toBeUndefined();
      expect(slim.pid).toBeUndefined();
      expect(slim.argsChars).toBe(2 + launchPrompt.length);
      expect(JSON.stringify(slim)).not.toContain('You are working on ticket');
      expect(slim.id).toBe('sess-slim');
      expect(slim.framework).toBe('test-cli');
      expect(slim.status).toBe('running');
    });

    it('omits argsChars when there are no args and truncates liveOutput', () => {
      const session = createMockSession({ id: 'sess-empty', args: [], liveOutputBuffer: 'x'.repeat(5000) });
      cliSessionsById.set(session.id, session);
      registerSession('FLUX-2', session.id);

      const slim = slimSessionSummaryForAgent(getCliSessionSummaryForTask('FLUX-2')!) as unknown as SlimSessionSummaryTestView;

      expect(slim.argsChars).toBeUndefined();
      expect(slim.liveOutput!.length).toBe(2048);
    });
  });
});

// FLUX-1338: the workspace-switch guard must count only sessions backed by a live OS process, not
// resumable resting sessions rehydrated from disk stubs (waiting-input, no proc) — those are what
// made the switch dialog falsely warn "N agent sessions running" when nothing was running.
describe('getLiveProcessSessionCount vs getActiveSessionCount (FLUX-1338)', () => {
  const liveProc = { exitCode: null, signalCode: null } as unknown as ChildProcessWithoutNullStreams;
  const deadProc = { exitCode: 0, signalCode: null } as unknown as ChildProcessWithoutNullStreams;

  beforeEach(() => {
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
  });

  it('counts a session backed by a live process', () => {
    const s = createMockSession({ id: 'sess-live', status: 'running', proc: liveProc });
    cliSessionsById.set(s.id, s);
    expect(getLiveProcessSessionCount()).toBe(1);
  });

  it('counts a proc-less pending session (dispatch still in the pre-spawn window)', () => {
    // createPendingSession registers the record before worktree creation + spawn attach a `proc` —
    // a multi-second window on cold starts. A switch during it would strand the spawn in a
    // switched-out workspace, so the guard must still warn.
    const s = createMockSession({ id: 'sess-prespawn', status: 'pending' });
    cliSessionsById.set(s.id, s);
    expect(getLiveProcessSessionCount()).toBe(1);
  });

  it('does NOT count a proc-less waiting-input session (rehydrated resumable stub)', () => {
    // Mirrors rehydratedRecord(): waiting-input, no `proc`. This is the phantom the guard was counting.
    const s = createMockSession({ id: 'sess-stub', status: 'waiting-input' });
    cliSessionsById.set(s.id, s);
    expect(getLiveProcessSessionCount()).toBe(0);
    // ...but the broad count still treats it as active — unchanged, so checkAutoRestart still sees
    // the board as "not idle" and won't auto-restart over a resumable session.
    expect(getActiveSessionCount()).toBe(1);
  });

  it('does NOT count a session whose process has already exited', () => {
    // A `waiting-input` session with a dead proc is likewise not "running" for switch purposes.
    const s = createMockSession({ id: 'sess-exited', status: 'waiting-input', proc: deadProc });
    cliSessionsById.set(s.id, s);
    expect(getLiveProcessSessionCount()).toBe(0);
  });

  it('diverges from getActiveSessionCount exactly on the phantom stubs', () => {
    const live = createMockSession({ id: 'sess-a', status: 'running', proc: liveProc });
    const stub1 = createMockSession({ id: 'sess-b', status: 'waiting-input' });
    const stub2 = createMockSession({ id: 'sess-c', status: 'waiting-input' });
    for (const s of [live, stub1, stub2]) cliSessionsById.set(s.id, s);
    expect(getActiveSessionCount()).toBe(3); // 1 live + 2 resumable stubs
    expect(getLiveProcessSessionCount()).toBe(1); // only the live process — no phantom warning
  });
});

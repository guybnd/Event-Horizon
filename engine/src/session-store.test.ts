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
  tasksCache: {},
  updateTaskWithHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./history.js', () => ({
  buildActivityEntry: (msg: string, user: string, date: string) => ({ type: 'activity', comment: msg, user, date }),
}));

vi.mock('../workspace.js', () => ({
  workspaceRoot: '/tmp/test',
}));

import {
  cliSessionsById,
  cliSessionsByTaskId,
  cliSessionIdByTaskId,
  registerSession,
  unregisterSession,
  getCliSessionSummaryForTask,
  getAllSessionSummariesForTask,
  getActiveSessionsForTask,
  checkPathConflicts,
  validatePatternSupport,
  stopAllSessionsForTask,
} from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

function createMockSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  return {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    taskId: 'FLUX-TEST',
    framework: 'claude',
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
  };
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
      expect(summaries[0].role).toBe('reviewer');
      expect(summaries[1].role).toBe('implementer');
    });

    it('returns empty array when no sessions', () => {
      expect(getAllSessionSummariesForTask('FLUX-NONE')).toEqual([]);
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
    it('rejects gemini as supervisor lead', () => {
      const err = validatePatternSupport('gemini', 'supervisor', 'lead');
      expect(err).toBeTruthy();
      expect(err).toContain('gemini');
      expect(err).toContain('supervisor');
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
      expect(active[0].id).toBe('sess-b');
      expect(active[0].status).toBe('running');
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
      expect(all[0].id).toBe('sess-single');

      // Stop it
      sess.status = 'cancelled';
      sess.endedAt = new Date().toISOString();
      const activeAfter = getActiveSessionsForTask('FLUX-1');
      expect(activeAfter).toHaveLength(0);
    });
  });
});

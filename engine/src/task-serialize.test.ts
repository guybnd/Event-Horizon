import { describe, it, expect, afterEach } from 'vitest';
import { serializeTaskForAgent, type TaskRecord } from './task-serialize.js';
import { cliSessionsById, cliSessionsByTaskId } from './session-store.js';
import { LAUNCH_FOCUS_PREFIX } from './history.js';
import type { CliSessionRecord } from './agents/types.js';

// FLUX-1788 review Major 2: serializeTaskForAgent's activePhase glue (task-serialize.ts:176-180) is
// the only code that makes get_ticket.launchFocus phase-scoped for a real caller — nothing exercised
// it. These tests seed a registered CLI session the same way routes/cli-session.test.ts's
// seedBlockingSession helper does, then assert the phase-scoped lookup and its terminal-session
// fallback.

function launchFocusEntry(text: string, phase: string, date: string) {
  return { type: 'activity', user: 'Furnace', comment: `${LAUNCH_FOCUS_PREFIX}${text}`, phase, date, id: `a-${date}` };
}

const TEST_FRAMEWORK = 'claude';

function seedSession(over: Partial<CliSessionRecord>): CliSessionRecord {
  const s = {
    id: 'sess-1', taskId: 'FLUX-1', framework: TEST_FRAMEWORK, status: 'running',
    command: 'claude', args: [], startedAt: new Date().toISOString(), label: 'Claude Code',
    outputBuffer: '', liveOutputBuffer: '', pendingAssistantText: '', skipPermissions: true,
    requestedStop: false, writeQueue: Promise.resolve(), inputTokens: 0, outputTokens: 0, costUSD: 0,
    ...over,
  } as unknown as CliSessionRecord;
  cliSessionsById.set(s.id, s);
  cliSessionsByTaskId.set('FLUX-1', [s.id]);
  return s;
}

function makeTask(history: unknown[]): TaskRecord {
  return {
    id: 'FLUX-1', title: 'Test ticket', status: 'In Progress', body: 'body', _path: '/tmp/FLUX-1.md',
    history,
  };
}

describe('serializeTaskForAgent — launch focus phase scoping (FLUX-1788)', () => {
  afterEach(() => {
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
  });

  it('returns the grooming focus, not a newer review focus, when the active session is grooming', () => {
    const history = [
      launchFocusEntry('groom this ticket', 'grooming', '2026-06-01T10:00:00.000Z'),
      launchFocusEntry('review this plan', 'review', '2026-06-01T11:00:00.000Z'),
    ];
    seedSession({ phase: 'grooming', status: 'running' });

    const out = serializeTaskForAgent(makeTask(history));

    expect(out.launchFocus).toBe('groom this ticket');
  });

  it('falls back to the newest focus overall when the only session is terminal', () => {
    const history = [
      launchFocusEntry('groom this ticket', 'grooming', '2026-06-01T10:00:00.000Z'),
      launchFocusEntry('review this plan', 'review', '2026-06-01T11:00:00.000Z'),
    ];
    seedSession({ phase: 'grooming', status: 'completed' });

    const out = serializeTaskForAgent(makeTask(history));

    expect(out.launchFocus).toBe('review this plan');
  });
});

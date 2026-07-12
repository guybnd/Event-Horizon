import { describe, it, expect } from 'vitest';
import { selectChatRunGroup } from './orchestration';
import type { CliSessionSummary } from './types';

// framework is irrelevant to grouping/selection logic — use a non-'claude' literal so this test
// mock doesn't trip the adapter-boundary guard (engine/scripts/check-adapter-boundary.mjs).
function makeSession(overrides: Partial<CliSessionSummary> = {}): CliSessionSummary {
  return {
    id: 's1',
    taskId: 'FLUX-1',
    framework: 'copilot',
    status: 'completed',
    command: 'claude',
    args: [],
    startedAt: '2026-07-10T00:00:00.000Z',
    label: 'Claude Code',
    ...overrides,
  } as CliSessionSummary;
}

describe('selectChatRunGroup (FLUX-1334)', () => {
  it('returns null when there are no sessions', () => {
    expect(selectChatRunGroup({ cliSessions: [] })).toBeNull();
  });

  it('returns null for a solo chat with no delegates, even with a supervisor groupId', () => {
    const sessions = [makeSession({ id: 's1', groupId: 'g1', groupType: 'supervisor' })];
    expect(selectChatRunGroup({ cliSession: sessions[0], cliSessions: sessions })).toBeNull();
  });

  it('prefers the group matching the current chat session groupId', () => {
    const sessions = [
      makeSession({ id: 'lead', groupId: 'g1', groupType: 'supervisor', startedAt: '2026-07-10T00:00:00.000Z' }),
      makeSession({ id: 'worker', groupId: 'g1', groupType: 'supervisor', startedAt: '2026-07-10T00:00:01.000Z' }),
    ];
    const group = selectChatRunGroup({ cliSession: sessions[0], cliSessions: sessions });
    expect(group?.groupId).toBe('g1');
  });

  // Regression guard for the "disappears after minimize/reopen" bug: once a hand-off run finishes,
  // cliSession.groupId no longer matches (it gets repointed/cleared) and no session is active — the
  // durable fallback must still surface the most-recent 2+ group instead of returning null.
  it('falls back to the most-recent finished 2+ group when no session is active and cliSession no longer matches', () => {
    const sessions = [
      makeSession({ id: 'lead', groupId: 'g1', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T00:05:00.000Z', startedAt: '2026-07-10T00:00:00.000Z' }),
      makeSession({ id: 'worker', groupId: 'g1', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T00:05:00.000Z', startedAt: '2026-07-10T00:00:01.000Z' }),
    ];
    // cliSession has been repointed away from the finished run's group.
    const group = selectChatRunGroup({ cliSession: makeSession({ id: 'chat', groupId: undefined }), cliSessions: sessions });
    expect(group?.groupId).toBe('g1');
  });

  it('does not let a stale finished group shadow a newer finished group', () => {
    const oldRun = [
      makeSession({ id: 'old-lead', groupId: 'g-old', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T00:05:00.000Z', startedAt: '2026-07-10T00:00:00.000Z' }),
      makeSession({ id: 'old-worker', groupId: 'g-old', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T00:05:00.000Z', startedAt: '2026-07-10T00:00:01.000Z' }),
    ];
    const newRun = [
      makeSession({ id: 'new-lead', groupId: 'g-new', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T01:05:00.000Z', startedAt: '2026-07-10T01:00:00.000Z' }),
      makeSession({ id: 'new-worker', groupId: 'g-new', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T01:05:00.000Z', startedAt: '2026-07-10T01:00:01.000Z' }),
    ];
    const group = selectChatRunGroup({ cliSessions: [...oldRun, ...newRun] });
    expect(group?.groupId).toBe('g-new');
  });

  // Regression guard (review feedback on FLUX-1334): a later, unrelated phase's own solo `delegate`
  // call must NOT be shadowed by an earlier finished 2+ group. Otherwise ChatView's tool-name-only
  // suppression (isDelegationTool) drops the solo call's transcript row with no replacement, since
  // only one block (for the wrongly-selected stale group) gets spliced back in.
  it('returns null once a later solo session starts, instead of resurrecting a stale finished 2+ group', () => {
    const handOffRun = [
      makeSession({ id: 'lead', groupId: 'g1', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T00:05:00.000Z', startedAt: '2026-07-10T00:00:00.000Z' }),
      makeSession({ id: 'worker', groupId: 'g1', groupType: 'supervisor', status: 'completed', endedAt: '2026-07-10T00:05:00.000Z', startedAt: '2026-07-10T00:00:01.000Z' }),
    ];
    // A later, unrelated phase makes its own solo delegate call — never grows to 2+ sessions.
    const laterSoloSession = makeSession({ id: 'solo', groupId: 'g2', status: 'completed', endedAt: '2026-07-10T02:00:00.000Z', startedAt: '2026-07-10T01:00:00.000Z' });
    const group = selectChatRunGroup({
      cliSession: makeSession({ id: 'chat', groupId: undefined }),
      cliSessions: [...handOffRun, laterSoloSession],
    });
    expect(group).toBeNull();
  });

  it('still resolves a live run via the active fallback', () => {
    const sessions = [
      makeSession({ id: 'lead', groupId: 'g1', groupType: 'supervisor', status: 'running', startedAt: '2026-07-10T00:00:00.000Z' }),
      makeSession({ id: 'worker', groupId: 'g1', groupType: 'supervisor', status: 'running', startedAt: '2026-07-10T00:00:01.000Z' }),
    ];
    const group = selectChatRunGroup({ cliSessions: sessions });
    expect(group?.groupId).toBe('g1');
  });
});

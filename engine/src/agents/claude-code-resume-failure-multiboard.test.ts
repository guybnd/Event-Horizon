import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CliSessionRecord } from './types.js';

const storeTargets = vi.hoisted(() => ({
  updateTaskWithHistoryRoots: [] as Array<string | undefined>,
  updateAgentSessionRoots: [] as Array<string | undefined>,
}));

// FLUX-1574: surfaceResumeFailure (shared.ts) is reached from sendCliSessionInput when
// resolveResumeExecutionRoot throws BEFORE any child process spawns (e.g. a reclaimed worktree) —
// notably from tryResumeStaleWait, itself called from finalizeTerminalSession's raw child-process
// 'exit' handler, which has NO ambient runWithWorkspace binding of its own. FLUX-1563 wrapped every
// OTHER reachable raiseNeedsAction call site in that exit handler with
// runWithWorkspace(resolveWorkspaceByRoot(workspaceRoot), …); surfaceResumeFailure's own
// raiseNeedsAction call was the one sibling left unbound (no workspaceRoot param at all). Left
// unbound, a background (non-default) board's resume failure would flag + notify the DEFAULT board
// (FLUX-1557) instead of its own. This test drives sendCliSessionInput directly — unwrapped in any
// runWithWorkspace, exactly like the real unbound exit-handler call site — with no ambient binding,
// so a pass here is only possible if surfaceResumeFailure rebinds internally via its own
// workspaceRoot parameter, not by inheriting an ambient one.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, getConfig: () => ({}) };
});
// Real parked-ticket.ts writes the needsAction flag via task-store's updateTaskWithHistory — fake it
// with a workspace-aware in-memory mutation (mirrors claude-code-needs-action-multiboard.test.ts).
vi.mock('../task-store.js', () => ({
  updateTaskWithHistory: vi.fn(async (taskId: string, options: { extraFields?: Record<string, unknown>; entries?: unknown[] }, ws?: unknown) => {
    const { getWorkspace } = await import('../workspace-context.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetWs = (ws as any) ?? getWorkspace();
    storeTargets.updateTaskWithHistoryRoots.push(targetWs.root);
    const task = targetWs.tasks[taskId];
    if (task && options.extraFields) Object.assign(task, options.extraFields);
    if (task && options.entries) {
      const history = Array.isArray(task.history) ? task.history : [];
      task.history = [...history, ...options.entries];
    }
  }),
  updateAgentSession: vi.fn(async (taskId: string, sessionId: string, updater: (entry: Record<string, unknown>) => void, ws?: unknown) => {
    const { getWorkspace } = await import('../workspace-context.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const targetWs = (ws as any) ?? getWorkspace();
    storeTargets.updateAgentSessionRoots.push(targetWs.root);
    const task = targetWs.tasks[taskId];
    const history = Array.isArray(task?.history) ? task.history : [];
    const entry = history.find((candidate: Record<string, unknown>) => candidate?.type === 'agent_session' && candidate?.sessionId === sessionId);
    if (entry) updater(entry as Record<string, unknown>);
  }),
}));
vi.mock('../events.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../transcript.js', () => ({
  appendTranscriptLine: vi.fn(),
  appendTranscriptEvent: vi.fn(),
}));
// Keep generateNeedsActionNotification/getNotifications REAL — only stub the two health-check calls
// that would otherwise scan the real filesystem for framework/skill installs.
vi.mock('../notifications.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notifications.js')>();
  return { ...actual, checkFrameworkHealth: vi.fn().mockResolvedValue(undefined), checkSkillStaleness: vi.fn().mockResolvedValue(undefined) };
});
// The exact failure this ticket targets: resolveResumeExecutionRoot throwing before any child
// process starts (a reclaimed worktree) — stubbed directly rather than exercised through real
// git plumbing.
vi.mock('../task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-worktree.js')>();
  return {
    ...actual,
    resolveResumeExecutionRoot: vi.fn().mockRejectedValue(new Error('Worktree for FLUX-TEST has been reclaimed')),
  };
});

function fakeSession(overrides: Partial<CliSessionRecord> = {}): CliSessionRecord {
  const session = {
    id: 'sess-1',
    taskId: 'FLUX-TEST',
    framework: 'claude',
    status: 'running',
    command: 'claude',
    args: [] as string[],
    startedAt: new Date().toISOString(),
    label: 'Claude Code',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    ...overrides,
  };
  return session as unknown as CliSessionRecord;
}

describe('surfaceResumeFailure — needsAction/notification binds to the OWNING board, not the default (FLUX-1574)', () => {
  const boardARoot = '/tmp/board-A';
  const boardBRoot = '/tmp/board-B';

  beforeEach(async () => {
    vi.clearAllMocks();
    storeTargets.updateTaskWithHistoryRoots.length = 0;
    storeTargets.updateAgentSessionRoots.length = 0;
    const { resolveResumeExecutionRoot } = await import('../task-worktree.js');
    vi.mocked(resolveResumeExecutionRoot).mockRejectedValue(new Error('Worktree for FLUX-TEST has been reclaimed'));

    const { clearNotifications } = await import('../notifications.js');
    clearNotifications();
  });

  afterEach(async () => {
    const { closeWorkspace } = await import('../workspace-context.js');
    await closeWorkspace(boardBRoot);
  });

  /** Board A is the default/"active" board (what unbound `getWorkspace()` resolves to per
   *  FLUX-1557); Board B is a second, non-default board that is NOT ambiently active. Both carry a
   *  same-numbered ticket so a misroute is observable as a flag/notification landing on the WRONG
   *  board's record instead of just silently vanishing. */
  async function seedTwoBoards() {
    const { getDefaultWorkspace, openWorkspace } = await import('../workspace-context.js');
    const wsA = getDefaultWorkspace();
    wsA.root = boardARoot;
    wsA.tasks['FLUX-TEST'] = { status: 'In Progress' };
    const wsB = openWorkspace(boardBRoot);
    wsB.tasks['FLUX-TEST'] = { status: 'In Progress' };
    return { wsA, wsB };
  }

  it('a resume failure on board B flags + notifies board B, not the default board A', async () => {
    const { wsA, wsB } = await seedTwoBoards();
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { getNotifications } = await import('../notifications.js');
    const session = fakeSession();

    // No runWithWorkspace wrapper here — matching how the real call from
    // finalizeTerminalSession's raw child-process 'exit' handler (via tryResumeStaleWait) fires
    // with no ambient binding of its own.
    await expect(sendCliSessionInput(session, 'resume message', 'Agent', boardBRoot)).rejects.toThrow(
      'reclaimed',
    );

    await vi.waitFor(() => expect(wsB.tasks['FLUX-TEST'].needsAction).toBeTruthy());

    expect(wsA.tasks['FLUX-TEST'].needsAction).toBeFalsy();
    expect(getNotifications(wsB).some((n) => n.ticketId === 'FLUX-TEST')).toBe(true);
    expect(getNotifications(wsA).some((n) => n.ticketId === 'FLUX-TEST')).toBe(false);
  });

  it('a resume failure with an existing session history entry persists failure details on board B', async () => {
    const { wsA, wsB } = await seedTwoBoards();
    const { sendCliSessionInput } = await import('./claude-code.js');
    const { updateAgentSession } = await import('../task-store.js');
    const session = fakeSession({
      sessionHistoryEntry: {
        type: 'agent_session',
        sessionId: 'hist-1',
        status: 'active',
        progress: [],
        user: 'Agent',
        date: new Date().toISOString(),
      },
    } as never);
    wsA.tasks['FLUX-TEST'].history = [{ type: 'agent_session', sessionId: 'hist-1', status: 'active', progress: [] }];
    wsB.tasks['FLUX-TEST'].history = [{ type: 'agent_session', sessionId: 'hist-1', status: 'active', progress: [] }];

    // No runWithWorkspace wrapper here — matching the stale-wait resume path that enters
    // surfaceResumeFailure from a raw child-process 'exit' handler.
    await expect(sendCliSessionInput(session, 'resume message', 'Agent', boardBRoot)).rejects.toThrow(
      'reclaimed',
    );

    await vi.waitFor(() => expect(updateAgentSession).toHaveBeenCalled());

    expect(storeTargets.updateAgentSessionRoots).toEqual([boardBRoot]);
    expect(storeTargets.updateTaskWithHistoryRoots).toEqual([boardBRoot]);
    expect(wsB.tasks['FLUX-TEST'].history?.[0]).toMatchObject({
      type: 'agent_session',
      sessionId: 'hist-1',
      status: 'failed',
      outcome: 'Worktree for FLUX-TEST has been reclaimed',
      endedAt: session.endedAt,
    });
    expect(wsA.tasks['FLUX-TEST'].history?.[0]).toMatchObject({
      type: 'agent_session',
      sessionId: 'hist-1',
      status: 'active',
    });
  });
});

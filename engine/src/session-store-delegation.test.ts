import { describe, it, expect, afterEach } from 'vitest';
import {
  awaitDelegation,
  notifyDelegationComplete,
  cancelDelegation,
  attachToExistingDelegation,
  findLiveDelegateSession,
  reserveDispatch,
  dispatchKey,
  cliSessionsById,
  registerSession,
  unregisterSession,
  type DelegationResult,
} from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

const tracked = new Set<string>();

afterEach(() => {
  for (const id of tracked) {
    const s = cliSessionsById.get(id);
    if (s) unregisterSession(s.taskId, id);
    cliSessionsById.delete(id);
  }
  tracked.clear();
});

function fakeSession(partial: Partial<CliSessionRecord> & { id: string; taskId: string }): CliSessionRecord {
  const session = {
    status: 'running',
    framework: 'grok',
    patternPosition: 'assistant',
    startedAt: new Date().toISOString(),
    ...partial,
  } as CliSessionRecord;
  cliSessionsById.set(session.id, session);
  registerSession(session.taskId, session.id);
  tracked.add(session.id);
  return session;
}

describe('awaitDelegation multi-waiter (FLUX-1735)', () => {
  it('resolves every waiter when the child completes', async () => {
    const a = awaitDelegation('sess-1');
    const b = awaitDelegation('sess-1');
    notifyDelegationComplete({
      id: 'sess-1',
      status: 'completed',
      outputData: 'scout findings',
    } as CliSessionRecord);
    await expect(a).resolves.toEqual({
      sessionId: 'sess-1',
      status: 'completed',
      output: 'scout findings',
      succeeded: true,
    });
    await expect(b).resolves.toEqual({
      sessionId: 'sess-1',
      status: 'completed',
      output: 'scout findings',
      succeeded: true,
    });
  });

  it('broadcasts cancel to every waiter', async () => {
    const a = awaitDelegation('sess-2');
    const b = awaitDelegation('sess-2');
    cancelDelegation('sess-2', 'timed out');
    const failed = { sessionId: 'sess-2', status: 'cancelled', output: 'timed out', succeeded: false };
    await expect(a).resolves.toEqual(failed);
    await expect(b).resolves.toEqual(failed);
  });
});

describe('attachToExistingDelegation', () => {
  it('reattaches via the exact dispatch key after a dropped wait', async () => {
    const key = dispatchKey('FLUX-1733', 'context-scout', 'ground oneshot', 'high');
    const reservation = reserveDispatch(key);
    reservation.setSessionId('scout-1');
    const pending = attachToExistingDelegation('FLUX-1733', 'context-scout', 'ground oneshot', 'high');
    const result: DelegationResult = { sessionId: 'scout-1', status: 'completed', output: 'ok', succeeded: true };
    reservation.settle(result);
    await expect(pending).resolves.toEqual(result);
  });

  it('reattaches a rewritten-task retry to the live persona session', async () => {
    fakeSession({
      id: 'scout-live',
      taskId: 'FLUX-1733',
      personaId: 'context-scout',
      role: 'assistant:context-scout',
    });
    const key = dispatchKey('FLUX-1733', 'context-scout', 'original task', 'high');
    const reservation = reserveDispatch(key);
    reservation.setSessionId('scout-live');
    const pending = attachToExistingDelegation('FLUX-1733', 'context-scout', 'rewritten retry task', 'high');
    const result: DelegationResult = { sessionId: 'scout-live', status: 'completed', output: 'from live', succeeded: true };
    reservation.settle(result);
    await expect(pending).resolves.toEqual(result);
  });

  it('findLiveDelegateSession matches personaId or assistant:role', () => {
    fakeSession({
      id: 'scout-role',
      taskId: 'FLUX-9',
      role: 'assistant:context-scout',
    });
    expect(findLiveDelegateSession('FLUX-9', 'context-scout')?.id).toBe('scout-role');
  });

  it('reattaches a rewritten-task retry to a just-finished persona session', async () => {
    fakeSession({
      id: 'scout-done',
      taskId: 'FLUX-1733',
      personaId: 'context-scout',
      role: 'assistant:context-scout',
      status: 'completed',
      endedAt: new Date().toISOString(),
      outputData: 'posted CONTEXT SCOUT',
    });
    await expect(
      attachToExistingDelegation('FLUX-1733', 'context-scout', 'rewritten retry task', 'high'),
    ).resolves.toEqual({
      sessionId: 'scout-done',
      status: 'completed',
      output: 'posted CONTEXT SCOUT',
      succeeded: true,
    });
  });

  it('does not attach to a long-finished persona session (genuine later re-delegate)', async () => {
    fakeSession({
      id: 'scout-old',
      taskId: 'FLUX-1733',
      personaId: 'context-scout',
      role: 'assistant:context-scout',
      status: 'completed',
      endedAt: new Date(Date.now() - 120_000).toISOString(),
      outputData: 'stale',
    });
    await expect(
      attachToExistingDelegation('FLUX-1733', 'context-scout', 'fresh second scout', 'high'),
    ).resolves.toBeUndefined();
  });
});

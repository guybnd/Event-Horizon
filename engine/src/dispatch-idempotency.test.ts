import { describe, it, expect, vi, afterEach } from 'vitest';
import { dispatchKey, findDispatch, reserveDispatch, type DelegationResult } from './session-store.js';

// FLUX-842 — delegation idempotency. When the MCP transport drops a delegate
// response after the child spawned, the orchestrator retries the identical
// delegation. The registry lets that retry attach to the in-flight (or
// freshly-settled) dispatch instead of spawning a second child (~3× cost).
// FLUX-844 — the reservation is taken BEFORE spawn so a retry landing *during*
// spawnSession() attaches rather than double-launching; a failed spawn releases
// the key so a genuine later retry can start fresh.

afterEach(() => {
  vi.useRealTimers();
});

describe('dispatchKey', () => {
  it('is stable for identical inputs', () => {
    expect(dispatchKey('FLUX-1', 'security-auditor', 'audit the diff', 'high'))
      .toBe(dispatchKey('FLUX-1', 'security-auditor', 'audit the diff', 'high'));
  });

  it('differs when any input differs', () => {
    const base = dispatchKey('FLUX-1', 'security-auditor', 'audit the diff', 'high');
    expect(dispatchKey('FLUX-2', 'security-auditor', 'audit the diff', 'high')).not.toBe(base);
    expect(dispatchKey('FLUX-1', 'qa-correctness', 'audit the diff', 'high')).not.toBe(base);
    expect(dispatchKey('FLUX-1', 'security-auditor', 'audit the tests', 'high')).not.toBe(base);
    expect(dispatchKey('FLUX-1', 'security-auditor', 'audit the diff', 'low')).not.toBe(base);
  });
});

describe('dispatch registry', () => {
  it('returns nothing for an unknown key', () => {
    expect(findDispatch('never-registered')).toBeUndefined();
  });

  it('lets a retry attach to the reservation before the sessionId is known (spawn window)', async () => {
    const key = dispatchKey('FLUX-3', 'security-auditor', 'in flight', 'high');

    // Reserved BEFORE spawn resolves: a retry landing now finds the placeholder
    // (sessionId still empty) and attaches to its deferred promise — no 2nd spawn.
    const reservation = reserveDispatch(key);
    const duringSpawn = findDispatch(key);
    expect(duringSpawn).toBeDefined();
    expect(duringSpawn?.sessionId).toBe('');

    // spawnSession resolves → the real sessionId is filled in, same promise kept.
    reservation.setSessionId('session-a');
    const afterSpawn = findDispatch(key);
    expect(afterSpawn?.sessionId).toBe('session-a');
    expect(afterSpawn?.promise).toBe(duringSpawn?.promise);

    const settled: DelegationResult = { sessionId: 'session-a', status: 'completed', output: 'done', succeeded: true };
    reservation.settle(settled);
    await expect(afterSpawn!.promise).resolves.toEqual(settled);
  });

  it('garbage-collects a settled reservation after the TTL so later runs re-spawn', async () => {
    vi.useFakeTimers();
    const key = dispatchKey('FLUX-4', 'qa-correctness', 'settled', 'low');
    const result: DelegationResult = { sessionId: 'session-b', status: 'completed', output: 'ok', succeeded: true };
    const reservation = reserveDispatch(key);
    reservation.setSessionId('session-b');
    reservation.settle(result);

    // The freshly-settled result is still dedupable right after completion.
    await vi.advanceTimersByTimeAsync(0);
    expect(findDispatch(key)?.sessionId).toBe('session-b');

    // After the TTL window it is evicted, so a genuinely new run spawns again.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(findDispatch(key)).toBeUndefined();
  });

  it('releases the key when spawn fails so a genuine later retry starts fresh', async () => {
    const key = dispatchKey('FLUX-5', 'security-auditor', 'spawn boom', 'high');
    const reservation = reserveDispatch(key);

    // A retry that attached during the doomed spawn observes the rejection…
    const attached = findDispatch(key)!.promise;
    reservation.fail(new Error('spawn failed'));
    await expect(attached).rejects.toThrow('spawn failed');

    // …and the key is gone, so the next real attempt isn't stuck on a dead reservation.
    expect(findDispatch(key)).toBeUndefined();
  });
});

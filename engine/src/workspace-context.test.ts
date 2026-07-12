import { describe, it, expect, afterEach } from 'vitest';
import { ActivationLock, Workspace, getWorkspace } from './workspace-context.js';

/**
 * FLUX-1328 (FLUX-343 follow-up). ActivationLock is the concurrency primitive that made
 * workspace switching safe — every activateWorkspace call funnels through runExclusive so two
 * concurrent switches can't interleave cache-clear / watcher teardown / root reassignment.
 * Nothing else red-flags a refactor that subtly breaks the chain (e.g. dropping the rejection
 * handler that keeps `tail` alive after a failed activation), so these tests pin its semantics
 * before FLUX-1230 builds parallel-workspaces on top of it.
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain microtasks (and anything they schedule) so "has fn started yet?" reads are stable. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ActivationLock.runExclusive', () => {
  it('serializes: the second fn does not start until the first fully settles, including its finally', async () => {
    const lock = new ActivationLock();
    const order: string[] = [];
    const gate = deferred();

    const first = lock.runExclusive(async () => {
      order.push('first:start');
      try {
        await gate.promise;
      } finally {
        order.push('first:finally');
      }
    });
    const second = lock.runExclusive(async () => {
      order.push('second:start');
    });

    await flush();
    // First is parked on its gate; second must be queued, not running.
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:finally', 'second:start']);
  });

  it('queued calls run strictly in submission order even when each fn yields internally', async () => {
    const lock = new ActivationLock();
    const order: string[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        lock.runExclusive(async () => {
          order.push(`${n}:start`);
          await flush(); // give any wrongly-unqueued fn the chance to interleave here
          order.push(`${n}:end`);
        }),
      ),
    );

    expect(order).toEqual(['1:start', '1:end', '2:start', '2:end', '3:start', '3:end']);
  });

  it('a rejection propagates to its own caller and does not poison the chain for a queued call', async () => {
    const lock = new ActivationLock();
    const gate = deferred();

    const first = lock.runExclusive(async () => {
      await gate.promise;
      throw new Error('activation failed');
    });
    // Queued while first is still pending — must run despite first rejecting.
    const second = lock.runExclusive(async () => 'still alive');

    gate.resolve();
    await expect(first).rejects.toThrow('activation failed');
    await expect(second).resolves.toBe('still alive');
  });

  it('a call issued after a rejection has settled still runs (tail stays alive)', async () => {
    const lock = new ActivationLock();

    await expect(lock.runExclusive(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // Without the internal rejection handler on `tail`, this would reject with 'boom' too.
    await expect(lock.runExclusive(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('a synchronously-throwing fn behaves like a rejection: propagates, chain survives', async () => {
    const lock = new ActivationLock();

    await expect(lock.runExclusive(() => {
      throw new Error('sync throw');
    })).rejects.toThrow('sync throw');

    await expect(lock.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it("resolves with fn's return value (same reference, not a copy)", async () => {
    const lock = new ActivationLock();
    const sentinel = { root: '/tmp/ws' };

    await expect(lock.runExclusive(async () => sentinel)).resolves.toBe(sentinel);
  });
});

/**
 * The isActivating signal, composed the way activateWorkspace/doActivateWorkspace use it
 * (task-store.ts): set inside the lock-held fn, cleared in its finally, read LOCK-FREE by
 * downstream write guards. Driving the real activateWorkspace() here would boot the whole
 * engine (watchers, global settings, skills install) — the ticket's "optional if heavy"
 * case — so this pins the primitive-level behaviors that pattern depends on: side effects
 * inside fn are visible to lock-free readers while fn runs, and the finally has run by the
 * time runExclusive settles, on the success and failure paths alike.
 */
describe('Workspace.isActivating through the activationLock (activateWorkspace composition)', () => {
  function activate(ws: Workspace, work: () => Promise<void>): Promise<void> {
    return ws.activationLock.runExclusive(async () => {
      ws.isActivating = true;
      try {
        await work();
      } finally {
        ws.isActivating = false;
      }
    });
  }

  it('reads true mid-activation and false once it settles', async () => {
    const ws = new Workspace();
    expect(ws.isActivating).toBe(false);

    const gate = deferred();
    const run = activate(ws, () => gate.promise);

    await flush();
    expect(ws.isActivating).toBe(true); // a lock-free observer sees the switch in progress

    gate.resolve();
    await run;
    expect(ws.isActivating).toBe(false);
  });

  it('a failed activation clears the flag too', async () => {
    const ws = new Workspace();

    await expect(activate(ws, async () => {
      throw new Error('switch failed');
    })).rejects.toThrow('switch failed');

    expect(ws.isActivating).toBe(false);
  });
});

/**
 * The "consumers must not capture fields at module scope" contract (workspace-context.ts,
 * Scope A comment): doActivateWorkspace REASSIGNS `tasks`/`docs`/`parseErrors` wholesale on a
 * switch, so only call-time `getWorkspace().field` reads observe the new workspace — a captured
 * reference silently keeps serving the previous workspace's state.
 */
describe('workspace state ownership (getWorkspace contract)', () => {
  afterEach(() => {
    const ws = getWorkspace();
    ws.tasks = {};
    ws.docs = {};
    ws.parseErrors = {};
  });

  it('getWorkspace() returns the same instance on every call', () => {
    expect(getWorkspace()).toBe(getWorkspace());
  });

  it('call-time readers see wholesale reassignment; a captured reference does not', () => {
    const capturedTasks = getWorkspace().tasks; // the forbidden capture-at-module-scope pattern
    capturedTasks['FLUX-1'] = { id: 'FLUX-1', title: 'pre-switch ticket' };

    // What doActivateWorkspace does on a workspace switch:
    getWorkspace().tasks = { 'FLUX-2': { id: 'FLUX-2', title: 'post-switch ticket' } };
    getWorkspace().docs = {};
    getWorkspace().parseErrors = {};

    const readTasksAtCallTime = () => getWorkspace().tasks;
    expect(readTasksAtCallTime()['FLUX-2']).toEqual({ id: 'FLUX-2', title: 'post-switch ticket' });
    expect(readTasksAtCallTime()['FLUX-1']).toBeUndefined();

    // The stale capture still holds the pre-switch object — exactly why the contract forbids it.
    expect(capturedTasks).not.toBe(getWorkspace().tasks);
    expect(capturedTasks['FLUX-1']).toEqual({ id: 'FLUX-1', title: 'pre-switch ticket' });
  });
});

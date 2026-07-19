import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  ActivationLock,
  Workspace,
  getWorkspace,
  getWorkspaceByRoot,
  runWithWorkspace,
  openWorkspace,
  closeWorkspace,
  evictWorkspace,
  listWorkspaces,
} from './workspace-context.js';
import path from 'path';
import os from 'os';
import type { FSWatcher } from 'chokidar';

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

/** A fake chokidar watcher: just enough of the shape teardownWorkspace touches. */
function fakeWatcher(): FSWatcher {
  return { close: async () => {} } as unknown as FSWatcher;
}

function tmpRoot(name: string): string {
  return path.join(os.tmpdir(), 'flux-workspace-registry-test', name);
}

/**
 * FLUX-1446 (epic FLUX-1230 S1) — the `Map<path, Workspace>` registry that is the keystone every
 * later Scope-B subtask routes through. Each test closes whatever it opened so `activeKey`/the
 * registry are back to empty before the next test (and before the legacy-default tests above/below
 * run) — the registry is module state shared across this whole file.
 */
describe('workspace registry (openWorkspace / closeWorkspace / evictWorkspace / listWorkspaces)', () => {
  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
  });

  it('open registers a new workspace, retrievable via getWorkspaceByRoot/runWithWorkspace', () => {
    const root = tmpRoot('a');
    const ws = openWorkspace(root);
    expect(ws.root).toBe(path.resolve(root));
    expect(getWorkspaceByRoot(root)).toBe(ws);
    expect(runWithWorkspace(ws, () => getWorkspace())).toBe(ws);
    // FLUX-1557: unbound getWorkspace() no longer follows the newly-opened board.
    expect(getWorkspace()).not.toBe(ws);
  });

  it('two workspaces can be registered and held live simultaneously', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b'));

    expect(wsA).not.toBe(wsB);
    expect(listWorkspaces()).toEqual(expect.arrayContaining([wsA, wsB]));
    expect(listWorkspaces()).toHaveLength(2);
    // FLUX-1557: unbound getWorkspace() no longer follows "the most recently opened one" — it's
    // deterministically the default workspace regardless of registry state; each board is reached
    // via its own runWithWorkspace binding.
    expect(runWithWorkspace(wsA, () => getWorkspace())).toBe(wsA);
    expect(runWithWorkspace(wsB, () => getWorkspace())).toBe(wsB);
  });

  it('re-opening an already-registered root returns the same instance, not a new one', () => {
    const root = tmpRoot('a');
    const first = openWorkspace(root);
    openWorkspace(tmpRoot('b'));
    const second = openWorkspace(root);

    expect(second).toBe(first);
    expect(listWorkspaces()).toHaveLength(2);
    expect(getWorkspaceByRoot(root)).toBe(first);
  });

  it('each registered workspace keeps its own ActivationLock instance', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b'));

    expect(wsA.activationLock).toBeInstanceOf(ActivationLock);
    expect(wsB.activationLock).toBeInstanceOf(ActivationLock);
    expect(wsA.activationLock).not.toBe(wsB.activationLock);
  });

  it("opening/closing one workspace cannot race another's activation", async () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b'));
    const order: string[] = [];

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });

    const activationA = wsA.activationLock.runExclusive(async () => {
      order.push('a:start');
      await gateA;
      order.push('a:end');
    });
    // B's lock is independent — its activation runs to completion without waiting on A's gate.
    const activationB = wsB.activationLock.runExclusive(async () => {
      order.push('b:start');
      order.push('b:end');
    });

    await activationB;
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);

    releaseA();
    await activationA;
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('closeWorkspace tears down watchers and deregisters', async () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b'));
    wsB.fluxWatcher = fakeWatcher();
    wsB.docsWatcher = fakeWatcher();

    await closeWorkspace(tmpRoot('b'));

    expect(listWorkspaces()).toEqual([wsA]);
    expect(wsB.fluxWatcher).toBeNull();
    expect(wsB.docsWatcher).toBeNull();
    expect(getWorkspaceByRoot(tmpRoot('b'))).toBeUndefined();
  });

  it('closeWorkspace on an unregistered root is a no-op', async () => {
    await expect(closeWorkspace(tmpRoot('never-opened'))).resolves.toBeUndefined();
  });

  it('closing the only open workspace deregisters it; unbound getWorkspace() stays on defaultWorkspace throughout', async () => {
    const before = getWorkspace();
    const root = tmpRoot('solo');
    const ws = openWorkspace(root);
    // FLUX-1557: opening a board no longer moves the unbound resolution target.
    expect(getWorkspace()).toBe(before);

    await closeWorkspace(root);

    expect(getWorkspaceByRoot(root)).toBeUndefined();
    expect(getWorkspace()).toBe(before);
    expect(getWorkspace()).not.toBe(ws);
  });

  it('evictWorkspace tears down and deregisters just like closeWorkspace', async () => {
    const root = tmpRoot('a');
    const ws = openWorkspace(root);
    ws.groupDocsWatcher = fakeWatcher();

    await evictWorkspace(root);

    expect(listWorkspaces()).toHaveLength(0);
    expect(ws.groupDocsWatcher).toBeNull();
  });

  it('single-workspace (no registry use) behavior is unchanged: getWorkspace() keeps returning defaultWorkspace', () => {
    const before = getWorkspace();
    expect(getWorkspace()).toBe(before); // no openWorkspace() call in this test — pure legacy path
  });

  it('opening past the generous cap evicts the least-recently-used workspace', () => {
    const roots = Array.from({ length: 9 }, (_, i) => tmpRoot(`cap-${i}`));
    const opened = roots.map((r) => openWorkspace(r));

    // 9 opens against an 8-slot cap: the first (least-recently-touched) must have been evicted.
    expect(listWorkspaces()).toHaveLength(8);
    expect(listWorkspaces()).not.toContain(opened[0]);
    expect(listWorkspaces()).toContain(opened[opened.length - 1]);
  });
});

/**
 * FLUX-1557: `getWorkspace()`'s unbound fallback demoted from `activeKey` (last-opened board) to
 * the deterministic `defaultWorkspace`, with a throttled dev warning when it's hit while other
 * boards are open (a sign of an unmigrated call site — every legitimate background loop is
 * expected to bind via `runWithWorkspace` per FLUX-1548).
 */
describe('getWorkspace() unbound fallback (FLUX-1557)', () => {
  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves to defaultWorkspace even with a second board registered and "active"', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // this test doesn't assert on the dev warning
    const before = getWorkspace();
    openWorkspace(tmpRoot('warn-a'));
    openWorkspace(tmpRoot('warn-b')); // most-recently-opened — would have won under the old activeKey fallback

    expect(getWorkspace()).toBe(before);
  });

  it('a bound runWithWorkspace call still resolves to the bound workspace, not the default', () => {
    const ws = openWorkspace(tmpRoot('warn-bound'));
    expect(runWithWorkspace(ws, () => getWorkspace())).toBe(ws);
  });

  it('warns (throttled) when hit unbound while the registry is non-empty; silent when the registry is empty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Jump the clock well past any throttle window a previous test in this file may have armed —
    // the warn throttle is module-level state, not reset between tests.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);

    getWorkspace(); // empty registry — no other board open, nothing to diagnose
    expect(warn).not.toHaveBeenCalled();

    openWorkspace(tmpRoot('warn-loud'));
    getWorkspace();
    getWorkspace(); // second call within the throttle window must not double-log
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('getWorkspace()');
  });
});

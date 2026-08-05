import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { killDescendantsByPid, killProcessTree, indexProcessTable, isSameOrDescendantPid } from './kill-process-tree.js';
import { execFile as mockedExecFile } from 'child_process';
import type { ChildProcess } from 'child_process';

// FLUX-1645: `killProcessTree`'s exemption behavior fires real `execFile('taskkill', ...)` calls
// (unlike killDescendantsByPid, which is fully injectable) — vitest's ESM module namespace can't
// be `vi.spyOn`'d directly ("Cannot redefine property"), so mock the whole module instead. Scoped
// to this file only; the killDescendantsByPid suite above never hits this (it always injects
// listProcesses/kill), so mocking it here is safe.
vi.mock('child_process', () => ({ execFile: vi.fn(), exec: vi.fn() }));

// FLUX-1207: killDescendantsByPid is a Windows-only BFS graph-walk reaper (it returns [] immediately
// when `process.platform !== 'win32'`). These tests inject a fake process table + fake killer via
// `deps` so no real process is ever spawned — mirrors the dependency-injection style already used
// elsewhere in this file's sibling test suites (task-worktree.test.ts's injectable `gitRunner`).
//
// FLUX-1303: pin `process.platform` to 'win32' for the BFS-behavior tests so they exercise the real
// walk on ANY runner. Previously the suite silently assumed a Windows runner (as the "no-op on
// non-win32" test's own comment noted) — on the Linux CI runner the function short-circuited to []
// before touching the injected deps, so three tests failed (`expected Set{} to equal Set{100,…}`).
describe('killDescendantsByPid (FLUX-1207)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }); });
  afterEach(() => { Object.defineProperty(process, 'platform', realPlatform); });

  const table = [
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 1 },
    { pid: 999, ppid: 5000 },
  ];

  it('BFS-walks the process table and resolves every transitive descendant, excluding unrelated trees and the pid itself', async () => {
    const kill = vi.fn();
    const listProcesses = vi.fn(async () => table);

    const result = await killDescendantsByPid(1, { listProcesses, kill });

    expect(new Set(result)).toEqual(new Set([100, 200, 300]));
    expect(result).not.toContain(1);
    expect(result).not.toContain(999);
  });

  it('kills every found descendant exactly once', async () => {
    const kill = vi.fn();
    const listProcesses = vi.fn(async () => table);

    await killDescendantsByPid(1, { listProcesses, kill });

    expect(kill).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledWith(100);
    expect(kill).toHaveBeenCalledWith(200);
    expect(kill).toHaveBeenCalledWith(300);
  });

  it('resolves to [] and never calls kill for a pid with no descendants in the table', async () => {
    const kill = vi.fn();
    const listProcesses = vi.fn(async () => table);

    const result = await killDescendantsByPid(999, { listProcesses, kill });

    expect(result).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('resolves to [] (never throws) when listProcesses rejects', async () => {
    const kill = vi.fn();
    const listProcesses = vi.fn(async () => {
      throw new Error('simulated WMI query failure');
    });

    await expect(killDescendantsByPid(1, { listProcesses, kill })).resolves.toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('is best-effort: one descendant\'s kill throwing does not abort the others or reject the overall promise', async () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 200) throw new Error('already gone');
    });
    const listProcesses = vi.fn(async () => table);

    const result = await killDescendantsByPid(1, { listProcesses, kill });

    expect(new Set(result)).toEqual(new Set([100, 200, 300]));
    expect(kill).toHaveBeenCalledWith(100);
    expect(kill).toHaveBeenCalledWith(200);
    expect(kill).toHaveBeenCalledWith(300);
  });

  // FLUX-1645: a background-process hold's exempt root must survive the reap, AND the reaper must
  // never traverse past it (a "held parent skips all descendants" — a child spawned by a held
  // build must not be independently reachable and killed either).
  it('skips killing an exempt pid AND never enqueues/kills its descendants', async () => {
    const kill = vi.fn();
    const listProcesses = vi.fn(async () => table);

    // 100 is exempt: neither 100 nor its own descendant 200 should be killed, but the unrelated
    // sibling 300 (also a child of 1) must still be reaped exactly as before.
    const result = await killDescendantsByPid(1, { listProcesses, kill, exemptPids: new Set([100]) });

    expect(new Set(result)).toEqual(new Set([300]));
    expect(result).not.toContain(100);
    expect(result).not.toContain(200);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(300);
  });

  it('with no exemptions, behaves byte-for-byte like the original (unheld) path', async () => {
    const kill = vi.fn();
    const listProcesses = vi.fn(async () => table);

    const result = await killDescendantsByPid(1, { listProcesses, kill, exemptPids: new Set() });

    expect(new Set(result)).toEqual(new Set([100, 200, 300]));
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it('is a no-op on non-win32 platforms — resolves to [] without calling listProcesses/kill', async () => {
    // process.platform is a configurable (but not writable) value property — redefine it for the
    // duration of this one assertion, then restore, so no other test in the suite observes a
    // platform override (this repo's test runner is Windows, so this is the only way to exercise
    // the POSIX no-op branch).
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
    try {
      const kill = vi.fn();
      const listProcesses = vi.fn(async () => table);

      const result = await killDescendantsByPid(1, { listProcesses, kill });

      expect(result).toEqual([]);
      expect(listProcesses).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});

// FLUX-1645: pure ancestry helpers factored out of killDescendantsByPid's BFS for reuse by the
// background-process-hold registry's overlap/descendant checks.
describe('indexProcessTable / isSameOrDescendantPid (FLUX-1645)', () => {
  const table = [
    { pid: 1, ppid: 0 },
    { pid: 100, ppid: 1 },
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 1 },
  ];

  it('reports a pid as a descendant of any ancestor in its chain, and of itself', () => {
    const idx = indexProcessTable(table);
    expect(isSameOrDescendantPid(idx, 200, 1)).toBe(true);
    expect(isSameOrDescendantPid(idx, 200, 100)).toBe(true);
    expect(isSameOrDescendantPid(idx, 200, 200)).toBe(true);
  });

  it('reports false for unrelated / sibling pids', () => {
    const idx = indexProcessTable(table);
    expect(isSameOrDescendantPid(idx, 300, 100)).toBe(false);
    expect(isSameOrDescendantPid(idx, 1, 200)).toBe(false); // wrong direction — 1 is the ancestor, not the descendant
  });
});

// FLUX-1645 (AC4): the plan-review's load-bearing detail — killProcessTree must NEVER invoke
// `taskkill /T` when an exemption is in play, since `/T` cannot selectively spare a subtree; it
// must fall back to a non-tree single-PID kill for the root plus the exemption-aware BFS reaper.
describe('killProcessTree exemption behavior (FLUX-1645)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }); });
  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
    vi.mocked(mockedExecFile).mockReset();
  });

  function spyOnExecFile() {
    const spy = vi.mocked(mockedExecFile);
    spy.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === 'function') (cb as (err: unknown, stdout: string, stderr: string) => void)(null, '', '');
      return {} as ChildProcess;
    });
    return spy;
  }

  it('never passes /T to taskkill when exemptPids is non-empty', async () => {
    const execFileSpy = spyOnExecFile();
    const fakeProc = { pid: 1 } as unknown as ChildProcess;

    killProcessTree(fakeProc, undefined, { exemptPids: new Set([100]) });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget descendant reap settle

    const taskkillCalls = execFileSpy.mock.calls.filter((c) => c[0] === 'taskkill');
    expect(taskkillCalls.length).toBeGreaterThan(0);
    for (const call of taskkillCalls) {
      expect(call[1] as string[]).not.toContain('/T');
    }
  });

  it('does not kill the root at all when the root pid itself is the exempt one', async () => {
    const execFileSpy = spyOnExecFile();
    const fakeProc = { pid: 100 } as unknown as ChildProcess;

    killProcessTree(fakeProc, undefined, { exemptPids: new Set([100]) });
    await new Promise((r) => setTimeout(r, 0));

    const rootKillCalls = execFileSpy.mock.calls.filter(
      (c) => c[0] === 'taskkill' && Array.isArray(c[1]) && (c[1] as string[]).includes('100'),
    );
    expect(rootKillCalls).toHaveLength(0);
  });

  it('with no exemptions, still uses the original fast /F /T taskkill path unchanged', async () => {
    const execFileSpy = spyOnExecFile();
    const fakeProc = { pid: 1 } as unknown as ChildProcess;

    killProcessTree(fakeProc);
    await new Promise((r) => setTimeout(r, 0));

    const taskkillCalls = execFileSpy.mock.calls.filter((c) => c[0] === 'taskkill');
    expect(taskkillCalls.length).toBeGreaterThan(0);
    expect(taskkillCalls[0]![1] as string[]).toEqual(['/F', '/T', '/PID', '1']);
  });
});

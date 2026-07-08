import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { killDescendantsByPid } from './kill-process-tree.js';

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

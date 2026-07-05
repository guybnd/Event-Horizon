// FLUX-1161: route-level coverage for the two hot-poll GET routes' stale-while-revalidate memo.
// FLUX-1126 introduced the memo (then `memoAsync`); FLUX-1185 reworked it into `swrAsync`, whose
// coalescing/TTL/failure semantics already have thorough UNIT coverage in
// tasks-hot-poll-swr.test.ts (calling `swrAsync` directly with fake timers). What's still missing
// per this ticket is proof that the REAL HTTP routes are actually wired through that memo: a burst
// of concurrent requests must collapse into a single underlying git computation, not one per
// request. `listTaskWorktrees`/`worktreeChangeCount`/`currentBranchName` are mocked (call-counted)
// so the assertion is about wiring, not re-testing task-worktree.ts's own git logic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from '../workspace.js';
import { requireWorkspace } from '../middleware.js';

const execFileAsync = promisify(execFile);

const listTaskWorktreesMock = vi.fn(async (..._args: unknown[]) => [] as Array<{ path: string; branch: string }>);
const worktreeChangeCountMock = vi.fn(async (..._args: unknown[]) => 0);
const worktreeChangeCountsMock = vi.fn(async (..._args: unknown[]) => ({ HEAD: 0, master: 0 }) as Record<string, number>);
const currentBranchNameMock = vi.fn(async (..._args: unknown[]) => 'master' as string | null);

vi.mock('../task-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-worktree.js')>();
  return {
    ...actual,
    listTaskWorktrees: (...args: Parameters<typeof actual.listTaskWorktrees>) => listTaskWorktreesMock(...args),
    worktreeChangeCount: (...args: Parameters<typeof actual.worktreeChangeCount>) => worktreeChangeCountMock(...args),
    worktreeChangeCounts: (...args: Parameters<typeof actual.worktreeChangeCounts>) => worktreeChangeCountsMock(...args),
    currentBranchName: (...args: Parameters<typeof actual.currentBranchName>) => currentBranchNameMock(...args),
  };
});

import tasksRouter from './tasks.js';

describe('GET /worktrees + /uncommitted-count — route-level SWR memo coverage (FLUX-1161)', () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-tasks-hotpoll-route-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    // A real (tiny) git repo so `resolveDefaultBranch` — unmocked, it uses the local `git()`
    // helper rather than task-worktree.js — resolves 'master' directly instead of falling
    // through its not-a-repo catch path on every call.
    await execFileAsync('git', ['-C', root, 'init', '-b', 'master'], { windowsHide: true });
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test'], { windowsHide: true });
    await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
    await execFileAsync('git', ['-C', root, 'add', '.'], { windowsHide: true });
    await execFileAsync('git', ['-C', root, 'commit', '-m', 'init'], { windowsHide: true });
    setWorkspaceRoot(root);

    listTaskWorktreesMock.mockClear();
    worktreeChangeCountMock.mockClear();
    worktreeChangeCountsMock.mockClear();
    currentBranchNameMock.mockClear();

    const app = express();
    app.use(express.json());
    app.use('/api/tasks', requireWorkspace, tasksRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('GET /worktrees hit twice rapidly only triggers one listTaskWorktrees call', async () => {
    // Neither request is awaited before the other fires, so both land while the very first-ever
    // compute for this route is still in flight — the module-level swrAsync memo
    // (getWorktreesMemoized in tasks.ts) must single-flight them into ONE compute() call.
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/tasks/worktrees`),
      fetch(`${baseUrl}/api/tasks/worktrees`),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    expect(firstBody).toEqual({ worktrees: [] });
    expect(secondBody).toEqual({ worktrees: [] });
    expect(listTaskWorktreesMock).toHaveBeenCalledTimes(1);
  });

  it('GET /uncommitted-count hit twice rapidly only triggers one underlying compute pass', async () => {
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/tasks/uncommitted-count`),
      fetch(`${baseUrl}/api/tasks/uncommitted-count`),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    expect(firstBody).toEqual({ count: 0, branch: 'master', diverged: 0 });
    expect(secondBody).toEqual({ count: 0, branch: 'master', diverged: 0 });
    // computeUncommittedCount calls worktreeChangeCount (main tree vs HEAD) and listTaskWorktrees
    // once per compute pass — two concurrent requests coalescing into one compute means exactly
    // one call each, not two.
    expect(worktreeChangeCountMock).toHaveBeenCalledTimes(1);
    expect(listTaskWorktreesMock).toHaveBeenCalledTimes(1);
  });
});

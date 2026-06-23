import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createScheduler, runSync, getSyncStatus, _resetSyncStateForTests } from './sync-watcher.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync('git', args, { cwd, windowsHide: true });

describe('createScheduler — debounce + max-wait', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires after debounce when activity stops', () => {
    const onSync = vi.fn();
    const { schedule } = createScheduler(() => 30_000, () => 300_000, onSync);

    schedule();
    vi.advanceTimersByTime(29_999);
    expect(onSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('resets the debounce timer on each new change', () => {
    const onSync = vi.fn();
    const { schedule } = createScheduler(() => 30_000, () => 300_000, onSync);

    schedule();
    vi.advanceTimersByTime(20_000);
    schedule(); // resets debounce
    vi.advanceTimersByTime(20_000); // only 20s since last change
    expect(onSync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000); // now 30s since last change
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('fires at max-wait even if changes keep arriving', () => {
    const onSync = vi.fn();
    const DEBOUNCE = 30_000;
    const MAX_WAIT = 300_000;
    const { schedule } = createScheduler(() => DEBOUNCE, () => MAX_WAIT, onSync);

    // Simulate a change every second for 6 minutes
    for (let i = 0; i < 360; i++) {
      schedule();
      vi.advanceTimersByTime(1_000);
    }

    // Should have fired once at the 5-minute mark, not deferred the whole time
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('fires again after max-wait resets on the next batch of changes', () => {
    const onSync = vi.fn();
    const { schedule } = createScheduler(() => 30_000, () => 300_000, onSync);

    // First burst: triggers at max-wait
    for (let i = 0; i < 310; i++) {
      schedule();
      vi.advanceTimersByTime(1_000);
    }
    expect(onSync).toHaveBeenCalledTimes(1);

    // Second burst: deadline resets after sync
    for (let i = 0; i < 310; i++) {
      schedule();
      vi.advanceTimersByTime(1_000);
    }
    expect(onSync).toHaveBeenCalledTimes(2);
  });

  it('reset cancels the pending sync', () => {
    const onSync = vi.fn();
    const { schedule, reset } = createScheduler(() => 30_000, () => 300_000, onSync);

    schedule();
    vi.advanceTimersByTime(20_000);
    reset();
    vi.advanceTimersByTime(60_000);
    expect(onSync).not.toHaveBeenCalled();
  });
});

describe('runSync — never commits conflict markers (FLUX-703)', () => {
  let remote: string;   // bare origin holding flux-data
  let storeDir: string; // local flux-data clone (stands in for .flux-store)
  let other: string;    // a second clone simulating the other machine

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');

  async function commitAll(dir: string, msg: string) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', msg]);
  }

  beforeEach(async () => {
    _resetSyncStateForTests();

    // Bare origin holding the flux-data branch.
    remote = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-remote-'));
    await git(remote, ['init', '--bare', '-b', 'flux-data']);

    // Seed flux-data with the ticket.
    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-seed-'));
    await git(seed, ['init', '-b', 'flux-data']);
    await git(seed, ['config', 'user.email', 'seed@test.com']);
    await git(seed, ['config', 'user.name', 'Seed']);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(seed, TICKET), baseContent, 'utf8');
    await commitAll(seed, 'seed ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    // Local store (the machine running the engine).
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);

    // Other machine: push a conflicting change to the SAME line on origin/flux-data.
    other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, TICKET), baseContent.replace('status: Todo', 'status: Done'), 'utf8');
    await commitAll(other, 'other machine: status Done');
    await git(other, ['push', 'origin', 'flux-data']);
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    for (const d of [remote, storeDir, other]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Local edits the same line differently (uncommitted) — guarantees a merge conflict.
  async function makeLocalDiverge() {
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
  }

  it('parks in conflict and never commits markers when branches diverge', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);

    expect(getSyncStatus().state).toBe('conflict');
    const committed = (await git(storeDir, ['show', 'HEAD:FLUX-1.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
    expect(committed).not.toMatch(/^={7}$/m);
  }, 30_000);

  it('a re-triggered tick (watcher self-trigger) creates no commit and no markers', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);                                       // first: produces conflict
    const headAfterFirst = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await runSync(storeDir);                                       // second: the dangerous re-trigger
    const headAfterSecond = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    expect(headAfterSecond).toBe(headAfterFirst);                 // no new commit created
    expect(getSyncStatus().state).toBe('conflict');
    const committed = (await git(storeDir, ['show', 'HEAD:FLUX-1.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
  }, 30_000);

  it('recovers the conflict after a restart (in-memory state lost) without committing markers', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);                                       // produces conflict + MERGE_HEAD
    const headAfterFirst = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    _resetSyncStateForTests();                                    // simulate restart: pendingConflicts lost, merge still on disk
    await runSync(storeDir);                                       // on-disk guard must catch it

    const headAfterSecond = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headAfterSecond).toBe(headAfterFirst);
    expect(getSyncStatus().state).toBe('conflict');
    const committed = (await git(storeDir, ['show', 'HEAD:FLUX-1.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
  }, 30_000);
});

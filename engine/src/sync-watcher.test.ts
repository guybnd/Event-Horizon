import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createScheduler, runSync, getSyncStatus, _resetSyncStateForTests, mergeAppendOnlyHistory, isSyncUnhealthy, maybeResurfaceConflictNotification, maybeResurfaceAuthNotification, _simulateAuthFailureForTests, resolveConflicts, revalidateConflictState } from './sync-watcher.js';
import { getNotifications, dismissNotification, clearNotifications } from './notifications.js';
import { setWorkspaceRoot, workspaceRoot } from './workspace.js';

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

describe('mergeAppendOnlyHistory — pure append-only conflict resolution (FLUX-1076)', () => {
  const base = [
    '---',
    'id: FLUX-1',
    'title: Test ticket',
    'status: Todo',
    'history:',
    '  - type: activity',
    '    user: Agent',
    '    date: \'2026-07-01T00:00:00.000Z\'',
    '    comment: Created.',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');

  function withExtraEntry(content: string, comment: string, date: string): string {
    return content.replace(
      '    comment: Created.\n',
      `    comment: Created.\n  - type: activity\n    user: Agent\n    date: '${date}'\n    comment: ${comment}\n`,
    );
  }

  it('unions two pure-append histories chronologically when nothing else differs', () => {
    const ours = withExtraEntry(base, 'Local progress.', '2026-07-02T00:00:00.000Z');
    const theirs = withExtraEntry(base, 'Remote progress.', '2026-07-01T12:00:00.000Z');

    const merged = mergeAppendOnlyHistory(base, ours, theirs);

    expect(merged).not.toBeNull();
    expect(merged).toContain('Created.');
    expect(merged).toContain('Remote progress.');
    expect(merged).toContain('Local progress.');
    // Chronological: Created (07-01 00:00) < Remote (07-01 12:00) < Local (07-02 00:00).
    const remoteIdx = merged!.indexOf('Remote progress.');
    const localIdx = merged!.indexOf('Local progress.');
    expect(remoteIdx).toBeLessThan(localIdx);
  });

  it('refuses when a non-history field genuinely disagrees (a real status race)', () => {
    const ours = base.replace('status: Todo', 'status: In Progress');
    const theirs = base.replace('status: Todo', 'status: Done');

    expect(mergeAppendOnlyHistory(base, ours, theirs)).toBeNull();
  });

  it('refuses when the markdown body itself diverged', () => {
    const ours = base.replace('Body.', 'Local body edit.');
    const theirs = base;

    expect(mergeAppendOnlyHistory(base, ours, theirs)).toBeNull();
  });

  it('refuses when one side dropped/mutated a base history entry (not a pure append)', () => {
    const ours = withExtraEntry(base, 'Local progress.', '2026-07-02T00:00:00.000Z');
    const theirsWithMutatedBase = ours.replace('Created.', 'Created (edited).');

    expect(mergeAppendOnlyHistory(base, ours, theirsWithMutatedBase)).toBeNull();
  });

  it('refuses when the YAML frontmatter is unparseable', () => {
    expect(mergeAppendOnlyHistory(base, '<<<<<<< HEAD\nbroken', base)).toBeNull();
  });
});

describe('isSyncUnhealthy (FLUX-1076)', () => {
  afterEach(() => { _resetSyncStateForTests(); });

  it('is false when idle', () => {
    expect(isSyncUnhealthy()).toBe(false);
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

describe('conflict notification resurfacing after dismiss (FLUX-1079)', () => {
  let remote: string;
  let storeDir: string;
  let other: string;

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');
  const CONFLICT_TITLE = 'Sync conflict needs resolution';
  const RESURFACE_INTERVAL_MS = 4 * 60 * 60_000;

  async function commitAll(dir: string, msg: string) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', msg]);
  }

  beforeEach(async () => {
    _resetSyncStateForTests();
    clearNotifications();

    remote = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-remote-'));
    await git(remote, ['init', '--bare', '-b', 'flux-data']);

    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-seed-'));
    await git(seed, ['init', '-b', 'flux-data']);
    await git(seed, ['config', 'user.email', 'seed@test.com']);
    await git(seed, ['config', 'user.name', 'Seed']);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(seed, TICKET), baseContent, 'utf8');
    await commitAll(seed, 'seed ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);

    other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, TICKET), baseContent.replace('status: Todo', 'status: Done'), 'utf8');
    await commitAll(other, 'other machine: status Done');
    await git(other, ['push', 'origin', 'flux-data']);

    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    clearNotifications();
    for (const d of [remote, storeDir, other]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not re-fire before the resurface interval elapses', async () => {
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    const first = getNotifications().find(n => n.title === CONFLICT_TITLE);
    expect(first).toBeTruthy();
    expect(dismissNotification(first!.id)).toBe(true);
    expect(getNotifications().some(n => n.title === CONFLICT_TITLE)).toBe(false);

    maybeResurfaceConflictNotification(Date.now() + 1000);
    expect(getNotifications().some(n => n.title === CONFLICT_TITLE)).toBe(false);
  }, 30_000);

  it('re-fires a fresh notification once dismissed and the conflict is still unresolved past the interval', async () => {
    await runSync(storeDir);
    const first = getNotifications().find(n => n.title === CONFLICT_TITLE);
    expect(first).toBeTruthy();
    expect(dismissNotification(first!.id)).toBe(true);

    maybeResurfaceConflictNotification(Date.now() + RESURFACE_INTERVAL_MS + 1000);

    const resurfaced = getNotifications().find(n => n.title === CONFLICT_TITLE);
    expect(resurfaced).toBeTruthy();
    expect(resurfaced!.id).not.toBe(first!.id);
    expect(resurfaced!.dismissed).toBe(false);
  }, 30_000);

  it('no-ops once the conflict has resolved (state no longer conflict)', async () => {
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');
    const first = getNotifications().find(n => n.title === CONFLICT_TITLE);
    expect(dismissNotification(first!.id)).toBe(true);

    _resetSyncStateForTests(); // simulates the conflict having resolved (state back to idle)

    maybeResurfaceConflictNotification(Date.now() + RESURFACE_INTERVAL_MS + 1000);
    expect(getNotifications().some(n => n.title === CONFLICT_TITLE)).toBe(false);
  }, 30_000);
});

describe('auth notification resurfacing after dismiss (FLUX-1088)', () => {
  const AUTH_TITLE = 'GitHub sign-in needed';
  const RESURFACE_INTERVAL_MS = 4 * 60 * 60_000;

  beforeEach(() => {
    _resetSyncStateForTests();
    clearNotifications();
  });

  afterEach(() => {
    _resetSyncStateForTests();
    clearNotifications();
  });

  it('does not re-fire before the resurface interval elapses', () => {
    _simulateAuthFailureForTests();
    expect(getSyncStatus().state).toBe('error');

    const first = getNotifications().find(n => n.title === AUTH_TITLE);
    expect(first).toBeTruthy();
    expect(dismissNotification(first!.id)).toBe(true);
    expect(getNotifications().some(n => n.title === AUTH_TITLE)).toBe(false);

    maybeResurfaceAuthNotification(Date.now() + 1000);
    expect(getNotifications().some(n => n.title === AUTH_TITLE)).toBe(false);
  });

  it('re-fires a fresh notification once dismissed and the auth failure is still unresolved past the interval', () => {
    _simulateAuthFailureForTests();
    const first = getNotifications().find(n => n.title === AUTH_TITLE);
    expect(first).toBeTruthy();
    expect(dismissNotification(first!.id)).toBe(true);

    maybeResurfaceAuthNotification(Date.now() + RESURFACE_INTERVAL_MS + 1000);

    const resurfaced = getNotifications().find(n => n.title === AUTH_TITLE);
    expect(resurfaced).toBeTruthy();
    expect(resurfaced!.id).not.toBe(first!.id);
    expect(resurfaced!.dismissed).toBe(false);
  });

  it('no-ops once the auth failure has resolved (state no longer error)', () => {
    _simulateAuthFailureForTests();
    expect(getSyncStatus().state).toBe('error');
    const first = getNotifications().find(n => n.title === AUTH_TITLE);
    expect(dismissNotification(first!.id)).toBe(true);

    _resetSyncStateForTests(); // simulates the auth issue having resolved (state back to idle)

    maybeResurfaceAuthNotification(Date.now() + RESURFACE_INTERVAL_MS + 1000);
    expect(getNotifications().some(n => n.title === AUTH_TITLE)).toBe(false);
  });
});

describe('runSync — auto-resolves pure append-only history conflicts (FLUX-1076)', () => {
  let remote: string;
  let storeDir: string;
  let other: string;

  const TICKET = 'FLUX-1.md';
  const baseContent = [
    '---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo',
    'history:',
    '  - type: activity',
    '    user: Agent',
    "    date: '2026-07-01T00:00:00.000Z'",
    '    comment: Created.',
    '---', '', 'Body.', '',
  ].join('\n');

  function withExtraEntry(content: string, comment: string, date: string): string {
    return content.replace(
      '    comment: Created.\n',
      `    comment: Created.\n  - type: activity\n    user: Agent\n    date: '${date}'\n    comment: ${comment}\n`,
    );
  }

  async function commitAll(dir: string, msg: string) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', msg]);
  }

  beforeEach(async () => {
    _resetSyncStateForTests();

    remote = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-remote-'));
    await git(remote, ['init', '--bare', '-b', 'flux-data']);

    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-seed-'));
    await git(seed, ['init', '-b', 'flux-data']);
    await git(seed, ['config', 'user.email', 'seed@test.com']);
    await git(seed, ['config', 'user.name', 'Seed']);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(seed, TICKET), baseContent, 'utf8');
    await commitAll(seed, 'seed ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);

    // Other machine appends its own progress entry — a pure append, not a real disagreement.
    other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, TICKET), withExtraEntry(baseContent, 'Remote progress.', '2026-07-01T12:00:00.000Z'), 'utf8');
    await commitAll(other, 'other machine: appended remote progress');
    await git(other, ['push', 'origin', 'flux-data']);
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    for (const d of [remote, storeDir, other]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("unions both sides' new history entries and completes the sync instead of parking a conflict", async () => {
    // Local machine also just appends its own progress entry (uncommitted — runSync commits it).
    await fs.writeFile(path.join(storeDir, TICKET), withExtraEntry(baseContent, 'Local progress.', '2026-07-02T00:00:00.000Z'), 'utf8');

    await runSync(storeDir);

    expect(getSyncStatus().state).not.toBe('conflict');
    expect(getSyncStatus().state).not.toBe('error');
    const committed = (await git(storeDir, ['show', 'HEAD:FLUX-1.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
    expect(committed).toContain('Remote progress.');
    expect(committed).toContain('Local progress.');
    // No unmerged state left behind — the merge genuinely completed.
    const { stdout: unmerged } = await git(storeDir, ['diff', '--name-only', '--diff-filter=U']);
    expect(unmerged.trim()).toBe('');
  }, 30_000);
});

describe('resolveConflicts / revalidateConflictState — mutex + stale-conflict recovery (FLUX-994)', () => {
  let workspaceDir: string;
  let remote: string;
  let storeDir: string; // lives at <workspaceDir>/.flux-store — resolveConflicts() resolves its
                         // target directory via getFluxStoreDir(), not a passed-in argument.
  let other: string;
  let originalWorkspaceRoot: string | null;

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');

  async function commitAll(dir: string, msg: string) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', msg]);
  }

  async function makeLocalDiverge() {
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
  }

  beforeEach(async () => {
    _resetSyncStateForTests();
    originalWorkspaceRoot = workspaceRoot;

    remote = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-remote-'));
    await git(remote, ['init', '--bare', '-b', 'flux-data']);

    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-seed-'));
    await git(seed, ['init', '-b', 'flux-data']);
    await git(seed, ['config', 'user.email', 'seed@test.com']);
    await git(seed, ['config', 'user.name', 'Seed']);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(seed, TICKET), baseContent, 'utf8');
    await commitAll(seed, 'seed ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-workspace-'));
    storeDir = path.join(workspaceDir, '.flux-store');
    await fs.mkdir(storeDir);
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);
    setWorkspaceRoot(workspaceDir);

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
    setWorkspaceRoot(originalWorkspaceRoot as unknown as string);
    for (const d of [remote, storeDir, other, workspaceDir]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a resolveConflicts() in flight causes a concurrent runSync() tick to no-op', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    // syncInFlight flips true synchronously inside resolveConflicts() before any git
    // subprocess runs, so a runSync() tick started right after (without awaiting the
    // resolveConflicts() call first) must observe the mutex and no-op immediately.
    const resolvePromise = resolveConflicts([{ ticketId: 'FLUX-1', strategy: 'use-remote' }]);
    const concurrentSyncPromise = runSync(storeDir);

    await Promise.all([resolvePromise, concurrentSyncPromise]);

    expect(getSyncStatus().state).toBe('synced');
    // If the concurrent runSync() hadn't no-op'd, it would have raced its own commit
    // (or corrupted the index) instead of leaving only resolveConflicts()'s merge commit.
    const { stdout: subject } = await git(storeDir, ['show', '-s', '--format=%s', 'HEAD']);
    expect(subject.trim()).toBe('flux: sync (resolved conflicts)');
  }, 30_000);

  it('revalidateConflictState() clears a conflict once the worktree is fixed out-of-band', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    // Simulate the merge being fixed directly on disk, out-of-band from the engine (e.g. a
    // human/other tool running `git merge --abort`) — the in-memory conflict is now stale.
    await git(storeDir, ['merge', '--abort']);

    const status = await revalidateConflictState();

    expect(status.state).toBe('idle');
    expect(getSyncStatus().state).toBe('idle');
  }, 30_000);

  it('revalidateConflictState() refreshes (not clears) a conflict that is still genuinely unresolved', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    const status = await revalidateConflictState();

    expect(status.state).toBe('conflict');
    expect(getSyncStatus().state).toBe('conflict');
  }, 30_000);

  it('an add/commit failure inside resolveConflicts reports sync failure instead of stranding status at "syncing" (FLUX-994)', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    // Wedge a stale index.lock so every retry of `git add -A` inside
    // applyConflictResolutions fails — exercising the failure path that previously fell
    // through uncaught, leaving status stuck at 'syncing' with no reportSyncFailure() call.
    const lockPath = path.join(storeDir, '.git', 'index.lock');
    await fs.writeFile(lockPath, '', 'utf8');

    try {
      await expect(resolveConflicts([{ ticketId: 'FLUX-1', strategy: 'use-remote' }])).rejects.toThrow(/index\.lock/);
      expect(getSyncStatus().state).toBe('error');
    } finally {
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }, 30_000);
});

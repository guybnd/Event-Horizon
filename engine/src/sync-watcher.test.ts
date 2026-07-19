import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createScheduler, runSync, getSyncStatus, _resetSyncStateForTests, mergeAppendOnlyHistory, mergePrTicketConflict, isSyncUnhealthy, maybeResurfaceConflictNotification, maybeResurfaceAuthNotification, _simulateAuthFailureForTests, resolveConflicts, revalidateConflictState, SUPPORTED_SYNC_PROTOCOL, _setPostResetHookForTests, SyncWorker } from './sync-watcher.js';
import { getNotifications, dismissNotification, clearNotifications } from './notifications.js';
import { setWorkspaceRoot, getWorkspaceRoot } from './workspace.js';
import { Workspace } from './workspace-context.js';
import { appendJournalEntry, readJournalEntries, setJournalReplayHandler, setJournalCacheReloadHandler } from './sync-journal.js';

describe('SyncWorker — per-workspace isolation (FLUX-1453)', () => {
  it('two workers keep independent status, conflicts, and listeners', () => {
    const workerA = new SyncWorker(new Workspace());
    const workerB = new SyncWorker(new Workspace());

    workerA.reportDivergedStatus(3, 1);
    expect(workerA.getSyncStatus()).toEqual({ state: 'diverged', ahead: 3, behind: 1 });
    // B never saw A's mutation — still its own independent default.
    expect(workerB.getSyncStatus()).toEqual({ state: 'idle' });

    const listenerA = vi.fn();
    workerA.onSyncStatusChange(listenerA);
    workerB.reportDivergedStatus(5, 0);
    expect(listenerA).not.toHaveBeenCalled();

    workerA.reportDivergedStatus(1, 1);
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(workerB.getSyncStatus()).toEqual({ state: 'diverged', ahead: 5, behind: 0 });
  });

  it('start()/stop() tears down the watcher, scheduler, and resurface timer — no leaked handles', async () => {
    const ws = new Workspace();
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-syncworker-'));
    await fs.mkdir(path.join(tmpRoot, '.flux-store'));
    ws.root = tmpRoot;
    const worker = new SyncWorker(ws);

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    try {
      worker.start(ws);
      worker.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();
      // Idempotent: stopping an already-stopped worker is a safe no-op.
      expect(() => worker.stop()).not.toThrow();
    } finally {
      clearIntervalSpy.mockRestore();
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

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

describe('mergePrTicketConflict — field-aware PR-mirror-card resolution (FLUX-1427)', () => {
  const prBase = [
    '---',
    'id: PR-68',
    'kind: pr',
    'title: "PR #68: Add widget"',
    'branch: flux/widget',
    'prNumber: 68',
    'prState: OPEN',
    'reviewDecision: null',
    'isDraft: false',
    'ciStatus: pending',
    'implementationLink: https://github.com/example/repo/pull/68',
    'members: []',
    'swimlane: null',
    'status: Ready',
    'history:',
    '  - type: activity',
    '    id: a-created',
    '    user: Agent',
    "    date: '2026-07-01T00:00:00.000Z'",
    '    comment: Created (engine-managed).',
    '---',
    '',
    'PR description.',
    '',
  ].join('\n');

  function withField(content: string, field: string, value: string): string {
    const re = new RegExp(`^${field}: .*$`, 'm');
    return content.replace(re, `${field}: ${value}`);
  }

  it('resolves a GitHub-owned scalar divergence (PR-68 shape) by taking the remote value', () => {
    const ours = withField(withField(prBase, 'ciStatus', 'pending'), 'prState', 'OPEN');
    const theirs = withField(withField(prBase, 'ciStatus', 'passing'), 'prState', 'MERGED');

    const merged = mergePrTicketConflict(prBase, ours, theirs);

    expect(merged).not.toBeNull();
    expect(merged).toContain('ciStatus: passing');
    expect(merged).toContain('prState: MERGED');
  });

  it('auto-resolves an add/add brand-new PR card with no merge-base (PR-419/420/421 shape)', () => {
    // Both sides independently upserted the same new PR-<n> ticket from a live gh poll — slightly
    // different timestamps/ciStatus, no shared history entry, and no base version exists at all.
    const ours = withField(prBase, 'ciStatus', 'pending')
      .replace("date: '2026-07-01T00:00:00.000Z'", "date: '2026-07-01T00:00:01.000Z'");
    const theirs = withField(prBase, 'ciStatus', 'passing')
      .replace("date: '2026-07-01T00:00:00.000Z'", "date: '2026-07-01T00:00:02.000Z'");

    const merged = mergePrTicketConflict('', ours, theirs);

    expect(merged).not.toBeNull();
    expect(merged).toContain('ciStatus: passing');
    expect(merged).not.toMatch(/<{7}/);
  });

  it('survives a one-sided locally-authored history entry alongside a scalar divergence', () => {
    const oursWithComment = prBase.replace(
      '    comment: Created (engine-managed).\n',
      '    comment: Created (engine-managed).\n  - type: comment\n    id: c-review\n    user: Guy\n' +
        "    date: '2026-07-02T00:00:00.000Z'\n    comment: Looks good, just one nit.\n",
    );
    const ours = withField(oursWithComment, 'ciStatus', 'pending');
    const theirs = withField(prBase, 'ciStatus', 'passing');

    const merged = mergePrTicketConflict(prBase, ours, theirs);

    expect(merged).not.toBeNull();
    expect(merged).toContain('Looks good, just one nit.');
    expect(merged).toContain('ciStatus: passing');
  });

  it('a send-for-review In Progress (with a recorded status_change) beats a poll-set Ready', () => {
    const oursInProgress = withField(prBase, 'status', 'In Progress').replace(
      '    comment: Created (engine-managed).\n',
      '    comment: Created (engine-managed).\n  - type: status_change\n    from: Ready\n    to: In Progress\n' +
        "    user: Guy\n    date: '2026-07-02T00:00:00.000Z'\n",
    );
    const theirsReady = withField(prBase, 'ciStatus', 'passing'); // status stays Ready — bare poll refresh

    const merged = mergePrTicketConflict(prBase, oursInProgress, theirsReady);

    expect(merged).not.toBeNull();
    expect(merged).toContain('status: In Progress');
    expect(merged).toContain('ciStatus: passing'); // GitHub-owned scalar still re-derived from remote
  });

  it('falls back to non-default when status differs with no status_change entry on either side', () => {
    const oursInProgress = withField(prBase, 'status', 'In Progress');
    const theirsReady = prBase; // status: Ready, no status_change entry anywhere

    const merged = mergePrTicketConflict(prBase, oursInProgress, theirsReady);

    expect(merged).toContain('status: In Progress');
  });

  it('preserves a sticky merge-conflict swimlane over a changes-requested tint', () => {
    const oursConflict = withField(prBase, 'swimlane', 'merge-conflict');
    const theirsChangesRequested = withField(prBase, 'swimlane', 'changes-requested');

    const merged = mergePrTicketConflict(prBase, oursConflict, theirsChangesRequested);

    expect(merged).toContain('swimlane: merge-conflict');
  });

  it('unions work-gated members from both sides', () => {
    const ours = withField(prBase, 'members', '["FLUX-1"]');
    const theirs = withField(prBase, 'members', '["FLUX-2"]');

    const merged = mergePrTicketConflict(prBase, ours, theirs);

    expect(merged).toContain('FLUX-1');
    expect(merged).toContain('FLUX-2');
  });

  it('returns null for a non-PR ticket (falls back to manual resolution)', () => {
    const nonPrBase = [
      '---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo',
      'history:', '  - type: activity', '    user: Agent', "    date: '2026-07-01T00:00:00.000Z'", '    comment: Created.',
      '---', '', 'Body.', '',
    ].join('\n');
    const nonPrOurs = nonPrBase.replace('status: Todo', 'status: In Progress');
    expect(mergePrTicketConflict(nonPrBase, nonPrOurs, nonPrBase)).toBeNull();
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

  // Local edits the same line differently (uncommitted) — a raw file edit made outside
  // updateTaskWithHistory, i.e. NOT a journaled intent (FLUX-1428: only journaled writes are
  // replayed on a lost race — this exercises the "just a raw edit" case, never real production
  // traffic, which always goes through the engine's write path).
  async function makeLocalDiverge() {
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
  }

  // FLUX-1428: runSync no longer merges at all, so a git conflict marker can never be produced by
  // it, structurally — stronger than the old "detect and park" guarantee. A raw (un-journaled)
  // local edit that races a remote change is simply superseded: push is rejected (CAS), the local
  // commit is discarded via `reset --hard` onto the remote head, nothing is replayed (there was no
  // journal entry for it), and the tick converges to `synced` adopting the remote's content.
  it('never produces conflict markers when branches diverge — converges to remote, no park', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);

    expect(getSyncStatus().state).toBe('synced');
    const { stdout: remoteHead } = await git(remote, ['rev-parse', 'flux-data']);
    const { stdout: localHead } = await git(storeDir, ['rev-parse', 'HEAD']);
    expect(localHead.trim()).toBe(remoteHead.trim()); // adopted the remote's winning commit outright
    const committed = (await git(storeDir, ['show', 'HEAD:FLUX-1.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
    expect(committed).not.toMatch(/^={7}$/m);
    expect(committed).toContain('status: Done'); // the other machine's commit, not the discarded local edit
  }, 30_000);

  it('a re-triggered tick (watcher self-trigger) is a clean no-op once converged', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);                                       // first: converges via CAS reset
    const headAfterFirst = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await runSync(storeDir);                                       // second: the re-trigger
    const headAfterSecond = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    expect(headAfterSecond).toBe(headAfterFirst);                 // no new commit created
    expect(getSyncStatus().state).toBe('synced');
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

    // FLUX-1428: runSync's own merge step is gone, so a genuine conflict for these notification
    // tests (which exercise maybeResurfaceConflictNotification, unrelated to runSync's merge
    // logic) is seeded directly here via a real `git merge` — runSync's entry guard (unchanged)
    // still detects any PRE-EXISTING MERGE_HEAD/conflict-marked worktree exactly as before.
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
    await commitAll(storeDir, 'local: status In Progress');
    await git(storeDir, ['fetch', 'origin', 'flux-data']);
    await git(storeDir, ['merge', '--no-edit', 'origin/flux-data']).catch(() => {}); // expected to fail, leaving MERGE_HEAD + markers
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

  // FLUX-1428: this scenario ("both sides independently appended a new history entry") used to be
  // resolved by runSync's text-level append-only union merge. That merge step is gone; the
  // equivalent — and now the ONLY — path to survive a lost race is a JOURNALED local mutation
  // replayed through the real handler after `reset --hard`. A raw uncommitted file edit (no
  // journal entry) is simply superseded — see the FLUX-703 block above. This test stubs the
  // replay/cache-reload handlers (task-store.ts's real ones aren't reachable from this
  // sync-watcher-only test file) to demonstrate the new mechanism end to end.
  it("a journaled local mutation lost to a race is replayed and survives", async () => {
    // Production stores gitignore the journal (storage-sync.ts's STORE_LOCAL_IGNORES) so `reset
    // --hard` never touches it; this bare test clone needs the same to avoid the reset deleting
    // the very file runSync is about to read entries from mid-tick.
    await fs.writeFile(path.join(storeDir, '.gitignore'), 'sync-journal.jsonl\n', 'utf8');
    await commitAll(storeDir, 'gitignore the sync journal');

    setJournalReplayHandler(async (taskId, options) => {
      const filePath = path.join(storeDir, `${taskId}.md`);
      // Windows' global core.autocrlf=true rewrites LF -> CRLF on the `reset --hard` checkout;
      // normalize before the LF-anchored splice helper looks for its target line.
      const current = (await fs.readFile(filePath, 'utf8')).replace(/\r\n/g, '\n');
      const entry = (options.entries as Array<{ comment: string; date: string }>)[0]!;
      await fs.writeFile(filePath, withExtraEntry(current, entry.comment, entry.date), 'utf8');
    });
    setJournalCacheReloadHandler(async () => {}); // no in-memory task cache in this test file

    const date = '2026-07-02T00:00:00.000Z';
    await appendJournalEntry(storeDir, {
      opId: 'test-op-1',
      taskId: 'FLUX-1',
      ts: date,
      options: { entries: [{ type: 'activity', user: 'Agent', date, comment: 'Local progress.' }] },
    });
    // What the real handler would already have done to the working file at call time, before this
    // sync tick ever runs — the journal only needs to survive the write being LOST to `reset --hard`.
    const current = await fs.readFile(path.join(storeDir, TICKET), 'utf8');
    await fs.writeFile(path.join(storeDir, TICKET), withExtraEntry(current, 'Local progress.', date), 'utf8');

    await runSync(storeDir);

    expect(getSyncStatus().state).not.toBe('conflict');
    expect(getSyncStatus().state).not.toBe('error');
    const committed = (await git(storeDir, ['show', 'HEAD:FLUX-1.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
    expect(committed).toContain('Remote progress.'); // the winning side's commit
    expect(committed).toContain('Local progress.');  // replayed on top instead of lost to the reset
    const { stdout: unmerged } = await git(storeDir, ['diff', '--name-only', '--diff-filter=U']);
    expect(unmerged.trim()).toBe('');
    expect(await readJournalEntries(storeDir)).toEqual([]); // flushed once the replay's commit pushed clean
  }, 30_000);
});

describe('runSync — auto-resolves PR-mirror-card conflicts end to end (FLUX-1427)', () => {
  let remote: string;
  let storeDir: string;
  let other: string;

  const TICKET = 'PR-68.md';
  const baseContent = [
    '---', 'id: PR-68', 'kind: pr', 'title: "PR #68: Add widget"', 'branch: flux/widget',
    'prNumber: 68', 'prState: OPEN', 'ciStatus: pending', 'members: []', 'swimlane: null', 'status: Ready',
    'history:',
    '  - type: activity',
    '    id: a-created',
    '    user: Agent',
    "    date: '2026-07-01T00:00:00.000Z'",
    '    comment: Created (engine-managed).',
    '---', '', 'PR description.', '',
  ].join('\n');

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
    await commitAll(seed, 'seed PR ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);

    // Other machine's poller observed CI go green — a GitHub-owned scalar update, no history entry.
    other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, TICKET), baseContent.replace('ciStatus: pending', 'ciStatus: passing'), 'utf8');
    await commitAll(other, 'other machine: polled ciStatus passing');
    await git(other, ['push', 'origin', 'flux-data']);
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    for (const d of [remote, storeDir, other]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('resolves a GitHub-owned scalar conflict on a PR card without parking a manual conflict', async () => {
    // Local machine's poller observed a DIFFERENT ciStatus on the SAME line the remote changed
    // above — a genuine git line-conflict, not a clean auto-merge. Neither side touched history.
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('ciStatus: pending', 'ciStatus: unknown'), 'utf8');

    await runSync(storeDir);

    expect(getSyncStatus().state).not.toBe('conflict');
    expect(getSyncStatus().state).not.toBe('error');
    const committed = (await git(storeDir, ['show', 'HEAD:PR-68.md'])).stdout;
    expect(committed).not.toMatch(/<{7}/);
    expect(committed).toContain('ciStatus: passing'); // remote's GitHub-owned scalar wins
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

  // FLUX-1428: runSync's own merge step is gone, so these resolveConflicts()/revalidateConflictState()
  // tests (which exercise THAT endpoint, not runSync's now-removed merge logic) seed a genuine
  // conflict directly via a real `git merge` attempt — runSync's entry guard (unchanged) still
  // detects any PRE-EXISTING MERGE_HEAD/conflict-marked worktree exactly as before.
  async function makeLocalDiverge() {
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
    await commitAll(storeDir, 'local: status In Progress');
    await git(storeDir, ['fetch', 'origin', 'flux-data']);
    await git(storeDir, ['merge', '--no-edit', 'origin/flux-data']).catch(() => {}); // expected to fail, leaving MERGE_HEAD + markers
  }

  beforeEach(async () => {
    _resetSyncStateForTests();
    originalWorkspaceRoot = getWorkspaceRoot();

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

  it('resolveConflicts("use-local") writes the local content and completes the commit/push tail', async () => {
    await makeLocalDiverge();
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    await resolveConflicts([{ ticketId: 'FLUX-1', strategy: 'use-local' }]);

    expect(getSyncStatus().state).toBe('synced');
    const written = await fs.readFile(path.join(storeDir, TICKET), 'utf8');
    expect(written).toContain('status: In Progress');
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

describe('runSync — protocol-mismatch read-only fence (FLUX-1426)', () => {
  let remote: string;
  let storeDir: string;

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');
  const AHEAD_PROTOCOL = SUPPORTED_SYNC_PROTOCOL + 1;

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
    await fs.writeFile(path.join(seed, 'sync-protocol'), `${SUPPORTED_SYNC_PROTOCOL}\n`, 'utf8');
    await commitAll(seed, 'seed ticket');
    await git(seed, ['push', '-u', 'origin', 'flux-data']);
    await fs.rm(seed, { recursive: true, force: true }).catch(() => {});

    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-store-'));
    await git(storeDir, ['clone', remote, '.']);
    await git(storeDir, ['config', 'user.email', 'local@test.com']);
    await git(storeDir, ['config', 'user.name', 'Local']);
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    for (const d of [remote, storeDir]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('gates on a marker already ahead at HEAD — performs zero git ops, not even the local commit', async () => {
    await fs.writeFile(path.join(storeDir, 'sync-protocol'), `${AHEAD_PROTOCOL}\n`, 'utf8');
    await commitAll(storeDir, 'protocol bump');
    const headBefore = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    // A pending local edit that would normally get committed in Step 1.
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');

    await runSync(storeDir);

    const status = getSyncStatus();
    expect(status.state).toBe('protocol-mismatch');
    if (status.state === 'protocol-mismatch') {
      expect(status.required).toBe(AHEAD_PROTOCOL);
      expect(status.supported).toBe(SUPPORTED_SYNC_PROTOCOL);
    }
    // No commit happened — the pending local edit is still sitting uncommitted on disk.
    const headAfter = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headAfter).toBe(headBefore);
    const { stdout: porcelain } = await git(storeDir, ['status', '--porcelain']);
    expect(porcelain).toContain('FLUX-1.md');
  }, 30_000);

  it('gates on a marker bump discovered only after fetch, before merging or pushing it in', async () => {
    const headBefore = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    // Another machine already pushed a protocol bump to the remote — our local worktree's
    // HEAD marker still reads the old (supported) value until we fetch+merge.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, 'sync-protocol'), `${AHEAD_PROTOCOL}\n`, 'utf8');
    await commitAll(other, 'protocol bump');
    await git(other, ['push', 'origin', 'flux-data']);
    await fs.rm(other, { recursive: true, force: true }).catch(() => {});

    await runSync(storeDir);

    const status = getSyncStatus();
    expect(status.state).toBe('protocol-mismatch');
    if (status.state === 'protocol-mismatch') {
      expect(status.required).toBe(AHEAD_PROTOCOL);
    }
    // Local HEAD must NOT have been fast-forwarded onto the bumped remote commit.
    const headAfter = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headAfter).toBe(headBefore);
  }, 30_000);

  it('clears once a later tick observes a marker back within what this engine supports', async () => {
    await fs.writeFile(path.join(storeDir, 'sync-protocol'), `${AHEAD_PROTOCOL}\n`, 'utf8');
    await commitAll(storeDir, 'protocol bump');
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('protocol-mismatch');

    // Revert the bump — stands in for the store itself moving back within range.
    await git(storeDir, ['revert', '--no-edit', 'HEAD']);

    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('synced');
  }, 30_000);

  it('marker at or below the supported version behaves exactly like today (normal sync)', async () => {
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');

    await runSync(storeDir);

    expect(getSyncStatus().state).toBe('synced');
    const { stdout: subject } = await git(storeDir, ['show', '-s', '--format=%s', 'HEAD']);
    expect(subject.trim()).toBe('flux: sync');
  }, 30_000);
});

describe('resolveConflicts — protocol-mismatch read-only fence (FLUX-1426)', () => {
  let workspaceDir: string;
  let remote: string;
  let storeDir: string; // resolveConflicts() resolves its target via getFluxStoreDir(), not an argument.
  let originalWorkspaceRoot: string | null;

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');
  const AHEAD_PROTOCOL = SUPPORTED_SYNC_PROTOCOL + 1;

  async function commitAll(dir: string, msg: string) {
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', msg]);
  }

  beforeEach(async () => {
    _resetSyncStateForTests();
    originalWorkspaceRoot = getWorkspaceRoot();

    remote = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-remote-'));
    await git(remote, ['init', '--bare', '-b', 'flux-data']);

    const seed = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-seed-'));
    await git(seed, ['init', '-b', 'flux-data']);
    await git(seed, ['config', 'user.email', 'seed@test.com']);
    await git(seed, ['config', 'user.name', 'Seed']);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(seed, TICKET), baseContent, 'utf8');
    await fs.writeFile(path.join(seed, 'sync-protocol'), `${SUPPORTED_SYNC_PROTOCOL}\n`, 'utf8');
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
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    setWorkspaceRoot(originalWorkspaceRoot as unknown as string);
    for (const d of [remote, storeDir, workspaceDir]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('refuses to commit/push a conflict resolution when the store is gated', async () => {
    // Produce a genuine pending conflict via a diverging "other machine" push, the same way
    // the FLUX-989 mutex tests do.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-other-'));
    await git(other, ['clone', remote, '.']);
    await git(other, ['config', 'user.email', 'other@test.com']);
    await git(other, ['config', 'user.name', 'Other']);
    await fs.writeFile(path.join(other, TICKET), baseContent.replace('status: Todo', 'status: Done'), 'utf8');
    await commitAll(other, 'other machine: status Done');
    await git(other, ['push', 'origin', 'flux-data']);
    await fs.rm(other, { recursive: true, force: true }).catch(() => {});

    // FLUX-1428: runSync's own merge step is gone — seed a genuine conflict directly via a real
    // `git merge` attempt so runSync's (unchanged) entry guard detects the pre-existing MERGE_HEAD.
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
    await commitAll(storeDir, 'local: status In Progress');
    await git(storeDir, ['fetch', 'origin', 'flux-data']);
    await git(storeDir, ['merge', '--no-edit', 'origin/flux-data']).catch(() => {}); // expected to fail, leaving MERGE_HEAD + markers
    await runSync(storeDir);
    expect(getSyncStatus().state).toBe('conflict');

    // Clear the on-disk unmerged state so the marker-bump commit below can land — git refuses
    // any commit while unresolved paths exist, regardless of pathspec. The in-memory
    // `pendingConflicts` list is untouched, so this still exercises "conflict still awaiting
    // resolution when the protocol gate kicks in", just without a literal MERGE_HEAD.
    await git(storeDir, ['merge', '--abort']);

    // The store moves onto a newer protocol while the conflict is still pending resolution.
    await fs.writeFile(path.join(storeDir, 'sync-protocol'), `${AHEAD_PROTOCOL}\n`, 'utf8');
    await git(storeDir, ['add', 'sync-protocol']);
    await git(storeDir, ['commit', '-m', 'protocol bump']);
    const headBefore = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();

    await expect(resolveConflicts([{ ticketId: 'FLUX-1', strategy: 'use-remote' }])).rejects.toThrow(/sync protocol/i);

    expect(getSyncStatus().state).toBe('protocol-mismatch');
    const headAfter = (await git(storeDir, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(headAfter).toBe(headBefore); // no resolution commit was made
  }, 30_000);
});

describe('runSync — push-as-CAS bounded retries (FLUX-1428)', () => {
  let remote: string;
  let storeDir: string;
  let attacker: string; // keeps advancing the remote so every CAS attempt keeps losing the race

  const TICKET = 'FLUX-1.md';
  const baseContent = ['---', 'id: FLUX-1', 'title: Test ticket', 'status: Todo', '---', '', 'Body.', ''].join('\n');

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

    attacker = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-attacker-'));
    await git(attacker, ['clone', remote, '.']);
    await git(attacker, ['config', 'user.email', 'attacker@test.com']);
    await git(attacker, ['config', 'user.name', 'Attacker']);

    // Deterministically keep the remote moving after every reset — a real concurrent process would
    // work too, but racing it against runSync's internal loop on wall-clock timing would be flaky.
    // _setPostResetHookForTests fires synchronously right after each `reset --hard`, so the next
    // push attempt always finds the remote has moved again, for exactly CAS_MAX_ATTEMPTS rounds.
    _setPostResetHookForTests(async () => {
      await git(attacker, ['commit', '--allow-empty', '-m', 'attacker: keeps moving']);
      await git(attacker, ['push', 'origin', 'flux-data']);
    });

    // Local uncommitted edit — genuinely diverges storeDir from the remote so the FIRST push is
    // already rejected, kicking off the retry loop the attacker hook then sustains.
    await fs.writeFile(path.join(storeDir, TICKET), baseContent.replace('status: Todo', 'status: In Progress'), 'utf8');
    await git(attacker, ['commit', '--allow-empty', '-m', 'attacker: opening move']);
    await git(attacker, ['push', 'origin', 'flux-data']);
  }, 30_000);

  afterEach(async () => {
    _resetSyncStateForTests();
    for (const d of [remote, storeDir, attacker]) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('gives up after CAS_MAX_ATTEMPTS rejections and reports a sync failure instead of looping forever', async () => {
    const onFail = vi.fn();
    await runSync(storeDir, onFail);

    expect(getSyncStatus().state).toBe('error');
    const status = getSyncStatus();
    expect(status.state === 'error' && status.error).toMatch(/could not converge/i);
    expect(onFail).toHaveBeenCalledTimes(1);

    // The run terminated (this assertion is only reachable because the loop is bounded) rather
    // than spinning — no separate timeout assertion needed, `await runSync(...)` above resolving
    // at all is the proof.
  }, 30_000);
});

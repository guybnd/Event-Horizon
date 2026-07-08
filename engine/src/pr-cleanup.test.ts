import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setWorkspaceRoot } from './workspace.js';
import { syncDefaultBranch, isWorktreeReclaimable, reclaimReadyWorktrees, cleanupMergedBranch } from './pr-cleanup.js';
import { clearNotifications, getNotifications } from './notifications.js';
import { createTaskWorktree, listTaskWorktrees } from './task-worktree.js';
import { tasksCache } from './task-store.js';
import {
  cliSessionsById,
  cliSessionsByTaskId,
  registerSession,
  syncActiveSessionStubs,
  rehydrateSessionStubs,
  armReclaimGrace,
  __resetSessionStubStateForTests,
} from './session-store.js';
import { rehydrateTemper, isTempering, __resetTemperForTests } from './temper.js';
import type { CliSessionRecord } from './agents/types.js';

const execFileAsync = promisify(execFile);

// These cases perform real git ops (init/clone/fetch/push to a local bare remote), which are
// slow on Windows under parallel suite load — vitest's default 5000ms testTimeout intermittently
// overruns when the full engine suite runs concurrently (FLUX-749). Raise it file-wide so the
// dirty-root backstop tests don't flake the `check` gate (mirrors group-integration.test.ts).
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-741 AC1 — the dirty-ROOT backstop. The engine-driven post-merge sync fast-forwards
// the main tree in place; a fast-forward that would overwrite a locally-modified file aborts
// (`git merge --ff-only`) — so WITHOUT the backstop the engine either can't sync or, in the
// FLUX-734/739 incident, the surrounding switch discarded the uncommitted root edits.
// stashDirtyTree (wired into syncDefaultBranch/cleanupMergedBranch) stashes the dirty work
// FIRST, so the sync proceeds AND nothing is lost — the work stays recoverable in a stash.
// Built against a real temp repo + bare origin (mirrors branch-manager.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

async function gitC(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
  return stdout.trim();
}

let tmp: string;
let repo: string;
let origin: string;

beforeEach(async () => {
  clearNotifications();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-pr-cleanup-'));
  origin = path.join(tmp, 'origin.git');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo, { recursive: true });

  // Pin the bare remote's HEAD to master too — otherwise on a machine whose
  // init.defaultBranch is `main`, the bare HEAD points at a ref we never push,
  // and a later `git clone` checks out an empty `main` (FLUX-1018 flake).
  await execFileAsync('git', ['init', '--bare', '-b', 'master', origin], { windowsHide: true });
  await gitC(repo, ['init', '-b', 'master']);
  await gitC(repo, ['config', 'user.email', 'test@test.com']);
  await gitC(repo, ['config', 'user.name', 'Test']);
  await gitC(repo, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(repo, 'feat.txt'), 'v1\n', 'utf8');
  await gitC(repo, ['add', '.']);
  await gitC(repo, ['commit', '-m', 'init']);
  await gitC(repo, ['remote', 'add', 'origin', origin]);
  await gitC(repo, ['push', '-u', 'origin', 'master']);

  setWorkspaceRoot(repo);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Push an extra commit to origin/master that MODIFIES feat.txt, so a clean repo is behind. */
async function advanceOrigin(): Promise<void> {
  const work = path.join(tmp, 'work');
  await execFileAsync('git', ['clone', origin, work], { windowsHide: true });
  await gitC(work, ['config', 'user.email', 'test@test.com']);
  await gitC(work, ['config', 'user.name', 'Test']);
  await gitC(work, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(work, 'feat.txt'), 'v-origin\n', 'utf8');
  await gitC(work, ['commit', '-am', 'origin advances feat.txt']);
  await gitC(work, ['push', 'origin', 'master']);
}

describe('syncDefaultBranch dirty-root backstop (FLUX-741)', () => {
  it('syncs a behind master WITHOUT losing a conflicting uncommitted root edit', async () => {
    await advanceOrigin();
    // Local root (on master) is now behind origin AND dirty on the very file the incoming
    // commit changes — the case a plain `merge --ff-only` refuses (would overwrite).
    await fs.writeFile(path.join(repo, 'feat.txt'), 'v2-uncommitted\n', 'utf8');

    const ok = await syncDefaultBranch(repo);

    // The sync proceeded (the backstop unblocked it)...
    expect(ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'feat.txt'), 'utf8')).toContain('v-origin');
    // ...and the dirty edit was NOT discarded — it's preserved in a recoverable stash.
    const stashList = await gitC(repo, ['stash', 'list']);
    expect(stashList).toContain('EH pre-sync');
    const stashDiff = await gitC(repo, ['stash', 'show', '-p', 'stash@{0}']);
    expect(stashDiff).toContain('v2-uncommitted');
    // The user is told where the work went.
    const note = getNotifications().find((n) => n.title === 'Uncommitted root changes stashed');
    expect(note).toBeTruthy();
    expect(note!.message).toContain('git stash apply');
  });

  it('is a clean no-op (no stash, no notification) when the root tree is clean', async () => {
    await advanceOrigin();

    const ok = await syncDefaultBranch(repo);

    expect(ok).toBe(true);
    expect(await fs.readFile(path.join(repo, 'feat.txt'), 'utf8')).toContain('v-origin');
    expect(await gitC(repo, ['stash', 'list'])).toBe('');
    expect(getNotifications().find((n) => n.title === 'Uncommitted root changes stashed')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-1031 — reclaim a task worktree when its ticket reaches Ready so the board-wide
// worktree pool (cap 4) isn't exhausted by tickets resting at Ready awaiting review.
// Real git + real tasksCache/session-store (the sweep reads both), mirroring the file's
// integration style.
// ─────────────────────────────────────────────────────────────────────────────

/** Register a live (running) session on a ticket so isWorktreeReclaimable sees it as busy.
 *  Only the fields the reclaim path reads (id/taskId/status) are populated — the rest of
 *  `CliSessionRecord` is irrelevant to this test, hence the narrowing cast. */
function addLiveSession(taskId: string, sessionId: string): void {
  cliSessionsById.set(sessionId, { id: sessionId, taskId, status: 'running' } as CliSessionRecord);
  registerSession(taskId, sessionId);
}

/** Commit a change on a task branch's worktree (so it has commits ahead, like a real Ready branch). */
async function commitInWorktree(wt: string, file: string): Promise<void> {
  await gitC(wt, ['config', 'user.email', 'test@test.com']);
  await gitC(wt, ['config', 'user.name', 'Test']);
  await gitC(wt, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(wt, file), 'work\n', 'utf8');
  await gitC(wt, ['add', '.']);
  await gitC(wt, ['commit', '-m', `work on ${file}`]);
}

describe('worktree reclamation at Ready (FLUX-1031)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
  });
  afterEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
  });

  describe('isWorktreeReclaimable', () => {
    it('is reclaimable at Ready and at terminal statuses, but not while In Progress', () => {
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready' };
      expect(isWorktreeReclaimable('FLUX-1')).toBe(true);
      for (const s of ['Done', 'Released', 'Archived']) {
        tasksCache['FLUX-1'].status = s;
        expect(isWorktreeReclaimable('FLUX-1')).toBe(true);
      }
      tasksCache['FLUX-1'].status = 'In Progress';
      expect(isWorktreeReclaimable('FLUX-1')).toBe(false);
    });

    it('is NOT reclaimable while a live session is running on the ticket', () => {
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready' };
      addLiveSession('FLUX-1', 'sess-1');
      expect(isWorktreeReclaimable('FLUX-1')).toBe(false);
    });

    it('is not reclaimable for an unknown ticket', () => {
      expect(isWorktreeReclaimable('FLUX-404')).toBe(false);
    });

    it('is NOT reclaimable while a JOINED sibling has a live session on the same branch', () => {
      // FLUX-1031 review (Blocker): ticket A owns the worktree dir and rests at Ready; sibling B
      // JOINED A's branch (review-bug-fix ride-along) and is actively editing in A's worktree.
      // B's live session is invisible if we only check A's own sessions — the sweep would delete
      // A's worktree out from under B. The predicate must be branch-sibling-aware.
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/shared' };
      tasksCache['FLUX-2'] = { id: 'FLUX-2', status: 'In Progress', branch: 'flux/shared' };
      addLiveSession('FLUX-2', 'sess-2');
      expect(isWorktreeReclaimable('FLUX-1')).toBe(false);
    });

    it('stays reclaimable when a same-branch sibling exists but has no live session', () => {
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/shared' };
      tasksCache['FLUX-2'] = { id: 'FLUX-2', status: 'In Progress', branch: 'flux/shared' };
      expect(isWorktreeReclaimable('FLUX-1')).toBe(true);
    });

    it('ignores a live session on a DIFFERENT branch (not a joined sibling)', () => {
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/one' };
      tasksCache['FLUX-2'] = { id: 'FLUX-2', status: 'In Progress', branch: 'flux/two' };
      addLiveSession('FLUX-2', 'sess-2');
      expect(isWorktreeReclaimable('FLUX-1')).toBe(true);
    });
  });

  describe('reclaimReadyWorktrees (proactive sweep)', () => {
    it('frees Ready worktrees so N>cap tickets never exhaust the pool', async () => {
      // Fill the whole pool (cap 2 for speed) with two Ready tickets, each with committed work.
      const wtA = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1', { maxWorktrees: 2 });
      const wtB = await createTaskWorktree(repo, 'FLUX-2', 'flux/FLUX-2', { maxWorktrees: 2 });
      await commitInWorktree(wtA, 'a.txt');
      await commitInWorktree(wtB, 'b.txt');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready' };
      tasksCache['FLUX-2'] = { id: 'FLUX-2', status: 'Ready' };
      expect(await listTaskWorktrees(repo)).toHaveLength(2);

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed.sort()).toEqual(['FLUX-1', 'FLUX-2']);
      expect(await listTaskWorktrees(repo)).toHaveLength(0);
      // The freed slots let a genuinely new (5th-style) task spawn under the same cap — the deadlock
      // this ticket fixes: previously all slots stayed held until merge.
      const fresh = await createTaskWorktree(repo, 'FLUX-3', 'flux/FLUX-3', { maxWorktrees: 2 });
      expect(existsSync(fresh)).toBe(true);
    });

    it('skips a Ready worktree whose ticket still has a live session (never yanks live work)', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await commitInWorktree(wt, 'a.txt');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready' };
      addLiveSession('FLUX-1', 'sess-1');

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });

    it('skips a Ready worktree JOINED by a sibling with a live session (branch-sibling aware)', async () => {
      // The physical worktree is owned by FLUX-1 (Ready), but FLUX-2 joined its branch and is
      // running live in that same tree. The sweep must NOT delete the worktree out from under
      // FLUX-2's session (FLUX-1031 review Blocker).
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/shared');
      await commitInWorktree(wt, 'a.txt');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/shared' };
      tasksCache['FLUX-2'] = { id: 'FLUX-2', status: 'In Progress', branch: 'flux/shared' };
      addLiveSession('FLUX-2', 'sess-2');

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });

    it('leaves In-Progress worktrees alone', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await commitInWorktree(wt, 'a.txt');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'In Progress' };

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FLUX-1214 — an orphaned worktree whose branch never picked up a single commit (e.g. a
  // grooming session that never advances past Todo/Backlog, or a stray manual `branch` call) is
  // safe to reclaim regardless of ticket status — the ordinary 'status' gate exists to protect
  // real in-flight work, which by definition a zero-commit branch never had.
  // ───────────────────────────────────────────────────────────────────────────
  describe('reclaimReadyWorktrees also reclaims a never-committed branch regardless of status (FLUX-1214)', () => {
    it('reclaims a Todo-status worktree whose branch has zero commits ahead of base', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      // No commitInWorktree call — the branch sits exactly where it forked from base.
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', branch: 'flux/FLUX-1' };

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual(['FLUX-1']);
      expect(existsSync(wt)).toBe(false);
    });

    it('still leaves a Todo-status worktree alone once it has a real commit ahead of base', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await commitInWorktree(wt, 'a.txt');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', branch: 'flux/FLUX-1' };

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });

    it('does not widen past a live session even with zero commits ahead', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', branch: 'flux/FLUX-1' };
      addLiveSession('FLUX-1', 'sess-1');

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });

    it('does not widen past a dirty working tree even with zero commits ahead (FLUX-1215)', async () => {
      // isWorktreeReclaimableForSweep only widens the STATUS gate — it says nothing about the
      // working tree, so the lower-level reclaimWorktrees' own `git status --porcelain` check
      // (task-worktree.ts) must independently refuse a zero-commit branch that still has
      // uncommitted work sitting in it (e.g. a session that edited files but never committed).
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await fs.writeFile(path.join(wt, 'scratch.txt'), 'uncommitted\n', 'utf8');
      tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Todo', branch: 'flux/FLUX-1' };

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FLUX-1305 — a worktree just created via the `branch` MCP tool (from a board/chat session,
  // which never registers a live EH session for the ticket) was read as 'status'-refused-but-
  // zero-commits by the FLUX-1214 backstop and swept on the very next ~90s reconcile tick, before
  // the caller even started editing. `ensureTicketIsolation` now stamps a `worktree-created`
  // history marker; the backstop must shield the worktree until that marker ages past the grace
  // window, and resume reclaiming it afterward (the original FLUX-1214 behaviour, delayed not
  // disabled).
  // ───────────────────────────────────────────────────────────────────────────
  describe('reclaimReadyWorktrees shields a freshly-created worktree from the zero-commit backstop (FLUX-1305)', () => {
    it('does NOT reclaim a zero-commit worktree with a recent worktree-created marker', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      // No commitInWorktree call — mirrors the incident: a worktree created moments ago, no work
      // done in it yet, no live session (board/chat session, not a dispatched EH session).
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'In Progress',
        branch: 'flux/FLUX-1',
        history: [{ type: 'activity', event: 'worktree-created', date: new Date().toISOString() }],
      };

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });

    it('reclaims it once the worktree-created marker ages past the grace window', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'In Progress',
        branch: 'flux/FLUX-1',
        history: [{ type: 'activity', event: 'worktree-created', date: new Date(Date.now() - 31 * 60_000).toISOString() }],
      };

      const reclaimed = await reclaimReadyWorktrees(repo);

      expect(reclaimed).toEqual(['FLUX-1']);
      expect(existsSync(wt)).toBe(false);
    });

    it('does not shield a worktree once it has picked up a real commit, even with a recent marker', async () => {
      const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
      await commitInWorktree(wt, 'a.txt');
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'In Progress',
        branch: 'flux/FLUX-1',
        history: [{ type: 'activity', event: 'worktree-created', date: new Date().toISOString() }],
      };

      const reclaimed = await reclaimReadyWorktrees(repo);

      // Not reclaimed — but because it's genuinely mid-work (ahead of base), not because of the
      // marker: the ordinary 'status' gate already protects it once there's a real commit.
      expect(reclaimed).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-1060 — the worktree-reclaim guard reads the IN-MEMORY session map, which is wiped on every
// engine restart. Without persisted stubs, a ticket resting at Ready with a `waiting-input` session
// looks idle after a restart and the reclaim sweep deletes its worktree out from under the still-
// resumable session (incident FLUX-1053). Stubs are synced to disk each reconcile tick and
// rehydrated at boot so the guard survives a restart; a short post-restart grace over the ticket's
// own history covers the sub-sync-interval gap where no stub was written yet.
// ─────────────────────────────────────────────────────────────────────────────

/** Register a waiting-input (resumable, resting) session — the state most vulnerable to the bug.
 *  Framework is intentionally omitted (the stub/reclaim path is CLI-agnostic) so this test stays
 *  clear of the adapter-boundary check; the default resolves at rehydrate time. */
function addWaitingInputSession(taskId: string, sessionId: string, resumeSessionId = 'resume-abc'): void {
  cliSessionsById.set(sessionId, {
    id: sessionId,
    taskId,
    status: 'waiting-input',
    args: [] as string[],
    startedAt: new Date().toISOString(),
    label: 'agent session',
    outputBuffer: '',
    liveOutputBuffer: '',
    pendingAssistantText: '',
    cumulativeOutput: '',
    requestedStop: false,
    writeQueue: Promise.resolve(),
    skipPermissions: true,
    resumeSessionId,
  } as CliSessionRecord);
  registerSession(taskId, sessionId);
}

/** Wipe the in-memory session store the way an engine restart does (cliSessionsById is not persisted). */
function simulateEngineRestart(): void {
  cliSessionsById.clear();
  cliSessionsByTaskId.clear();
  __resetSessionStubStateForTests();
}

describe('restart-safe worktree reclaim (FLUX-1060)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    __resetSessionStubStateForTests();
  });
  afterEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    __resetSessionStubStateForTests();
  });

  it('does NOT reclaim a waiting-input session\'s worktree after an engine restart', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
    await commitInWorktree(wt, 'a.txt');
    tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/FLUX-1' };
    addWaitingInputSession('FLUX-1', 'sess-1');

    // Persist the stub the way the reconcile tick would (rehydrate first flips the boot flag so the
    // sync is allowed to write; the dir is empty so it's a no-op beyond arming the flag).
    await rehydrateSessionStubs();
    await syncActiveSessionStubs();

    simulateEngineRestart();
    // Sanity: with the in-memory map wiped and no rehydration yet, the pre-FLUX-1060 guard is blind.
    expect(isWorktreeReclaimable('FLUX-1')).toBe(true);

    // Boot recovery re-reads the stub into cliSessionsById as a waiting-input record.
    expect(await rehydrateSessionStubs()).toBe(1);

    expect(isWorktreeReclaimable('FLUX-1')).toBe(false);
    const reclaimed = await reclaimReadyWorktrees(repo);
    expect(reclaimed).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  it('rehydrates the session as resumable so the chat can continue it', async () => {
    tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/FLUX-1' };
    addWaitingInputSession('FLUX-1', 'sess-1', 'resume-xyz');
    await rehydrateSessionStubs();
    await syncActiveSessionStubs();

    simulateEngineRestart();
    await rehydrateSessionStubs();

    const restored = cliSessionsById.get('sess-1');
    expect(restored?.status).toBe('waiting-input');
    expect(restored?.resumeSessionId).toBe('resume-xyz'); // resume id preserved → chat resume works
    expect(restored?.taskId).toBe('FLUX-1');
  });

  it('STILL reclaims a worktree whose session truly ended before the restart (FLUX-1031 preserved)', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
    await commitInWorktree(wt, 'a.txt');
    tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Ready', branch: 'flux/FLUX-1' };
    addWaitingInputSession('FLUX-1', 'sess-1');
    await rehydrateSessionStubs();
    await syncActiveSessionStubs(); // stub written while active

    // The session finishes (terminal) before the restart — the next sweep drops its stub.
    cliSessionsById.get('sess-1')!.status = 'completed';
    await syncActiveSessionStubs();

    simulateEngineRestart();
    expect(await rehydrateSessionStubs()).toBe(0); // no stub → nothing rehydrated

    expect(isWorktreeReclaimable('FLUX-1')).toBe(true);
    const reclaimed = await reclaimReadyWorktrees(repo);
    expect(reclaimed).toEqual(['FLUX-1']);
    expect(existsSync(wt)).toBe(false);
  });

  describe('post-restart reclaim grace (belt-and-suspenders)', () => {
    it('protects a ticket with very recent session history only while the grace is armed', () => {
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'Ready',
        branch: 'flux/FLUX-1',
        history: [{ type: 'agent_session', sessionId: 's', status: 'cancelled', endedAt: new Date().toISOString() }],
      };

      // honorReadyGrace:false isolates this from the always-on FLUX-1112 Ready-worktree grace
      // below (which would ALSO protect very-recent history) so this exercises only the
      // post-restart-specific grace it's named for.
      // Not armed (steady state) → recent history is ignored, so reclaim behaves exactly as FLUX-1031.
      expect(isWorktreeReclaimable('FLUX-1', { honorReadyGrace: false })).toBe(true);

      // Armed at boot → the recent session activity re-protects the worktree during the gap.
      armReclaimGrace();
      expect(isWorktreeReclaimable('FLUX-1', { honorReadyGrace: false })).toBe(false);
    });

    it('does not protect a ticket whose last session activity predates the grace window', () => {
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'Ready',
        branch: 'flux/FLUX-1',
        history: [{ type: 'agent_session', sessionId: 's', status: 'cancelled', endedAt: new Date(Date.now() - 30 * 60_000).toISOString() }],
      };
      armReclaimGrace();
      expect(isWorktreeReclaimable('FLUX-1', { honorReadyGrace: false })).toBe(true);
    });
  });

  describe('always-on Ready-worktree grace (FLUX-1112)', () => {
    // Incidents FLUX-1094/1103/1095: a reviewer started looking at a Ready ticket's worktree
    // (e.g. a plain `cd` + `git diff`, not a session dispatched ON that ticket) moments after its
    // last session ended, and the proactive sweep deleted the tree out from under them — the
    // live-session guard has no way to see a reviewer that never registered an EH session for
    // THIS ticket. This buffer protects that window without needing a live session at all.
    it('protects a ticket whose last session ended moments ago, with no live session and outside the post-restart window', () => {
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'Ready',
        branch: 'flux/FLUX-1',
        history: [{ type: 'agent_session', sessionId: 's', status: 'completed', endedAt: new Date().toISOString() }],
      };
      expect(isWorktreeReclaimable('FLUX-1')).toBe(false);
    });

    it('stops protecting once the last session activity is older than the grace window', () => {
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'Ready',
        branch: 'flux/FLUX-1',
        history: [{ type: 'agent_session', sessionId: 's', status: 'completed', endedAt: new Date(Date.now() - 10 * 60_000).toISOString() }],
      };
      expect(isWorktreeReclaimable('FLUX-1')).toBe(true);
    });

    it('is bypassed by honorReadyGrace:false — the under-pressure cap backstop must reclaim instantly', () => {
      tasksCache['FLUX-1'] = {
        id: 'FLUX-1',
        status: 'Ready',
        branch: 'flux/FLUX-1',
        history: [{ type: 'agent_session', sessionId: 's', status: 'completed', endedAt: new Date().toISOString() }],
      };
      expect(isWorktreeReclaimable('FLUX-1', { honorReadyGrace: false })).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FLUX-1297 — cleanupMergedBranch disarms Temper BEFORE stopping sessions, so a review session
// Temper just spawned (e.g. from a bookkeeping Ready move racing this same merge cleanup) can never
// be observed by Temper's own tick as a "cancelled" session on a still-active ticket and get parked.
// ─────────────────────────────────────────────────────────────────────────────
describe('cleanupMergedBranch disarms Temper before stopping sessions (FLUX-1297)', () => {
  beforeEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    __resetSessionStubStateForTests();
    __resetTemperForTests();
  });
  afterEach(() => {
    for (const k of Object.keys(tasksCache)) delete tasksCache[k];
    cliSessionsById.clear();
    cliSessionsByTaskId.clear();
    __resetSessionStubStateForTests();
    __resetTemperForTests();
  });

  it('disarms an in-flight Temper loop on the ticket before the merge cleanup stops its sessions', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-1', 'flux/FLUX-1');
    await commitInWorktree(wt, 'a.txt');
    // The board already reads Done (the finish/merge flow's own status write already landed) while
    // Temper's durable flag is still set — the exact race: a bookkeeping Ready move armed Temper right
    // before this cleanup runs. `rehydrateTemper` seeds the in-memory loop from that durable flag,
    // exactly as an engine restart (or the original Ready-move trigger) would.
    tasksCache['FLUX-1'] = { id: 'FLUX-1', status: 'Done', branch: 'flux/FLUX-1', tempering: true, temperAttempts: 0 };
    rehydrateTemper();
    expect(isTempering('FLUX-1')).toBe(true);

    await cleanupMergedBranch(repo, 'flux/FLUX-1');

    // Disarmed — Temper is no longer tracking this ticket, so no later tick can ever park it.
    expect(isTempering('FLUX-1')).toBe(false);
  });

  it('is a no-op when Temper is not driving the ticket', async () => {
    const wt = await createTaskWorktree(repo, 'FLUX-2', 'flux/FLUX-2');
    await commitInWorktree(wt, 'a.txt');
    tasksCache['FLUX-2'] = { id: 'FLUX-2', status: 'Done', branch: 'flux/FLUX-2' };

    await expect(cleanupMergedBranch(repo, 'flux/FLUX-2')).resolves.toBeDefined();
    expect(isTempering('FLUX-2')).toBe(false);
  });
});

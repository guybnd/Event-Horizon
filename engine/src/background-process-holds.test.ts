import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { indexProcessTable } from './kill-process-tree.js';
import {
  createOrRenewHold,
  releaseHold,
  findHold,
  getHoldsForSession,
  getHoldsForTask,
  getHoldsForWorktree,
  getHoldsForBranch,
  getExemptPidsForSession,
  getAllExemptPids,
  isPidProtected,
  clearHoldsForSession,
  clearHoldsForTask,
  clearHoldsForWorktree,
  clearHoldsForBranch,
  clearAllHoldsForWorkspace,
  clearAllHolds,
  sweepHolds,
  setHoldHistoryWriter,
  syncHoldStubs,
  rehydrateHoldStubs,
  __resetBackgroundProcessHoldsForTest,
} from './background-process-holds.js';
import { getDefaultWorkspace, runWithWorkspace, type Workspace } from './workspace-context.js';
import { setWorkspaceRoot } from './workspace.js';

// A minimal linear chain (1 -> 100 -> 200) plus an unrelated sibling (300) and an independent
// branch (1 -> 400), mirroring the fixtures kill-process-tree.test.ts already uses.
const TABLE = [
  { pid: 1, ppid: 0 },
  { pid: 100, ppid: 1 },
  { pid: 200, ppid: 100 },
  { pid: 300, ppid: 1 },
  { pid: 400, ppid: 1 },
];

function baseParams(overrides: Partial<Parameters<typeof createOrRenewHold>[0]> = {}) {
  return {
    workspaceRoot: 'ws-1',
    taskId: 'FLUX-1',
    sessionId: 'sess-a',
    pid: 100,
    fingerprint: 'fp-100',
    reason: 'long build',
    ttlMinutes: 30,
    worktreePath: '/wt/FLUX-1',
    branch: 'flux/FLUX-1-thing',
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('background-process-holds registry (FLUX-1645)', () => {
  beforeEach(() => {
    __resetBackgroundProcessHoldsForTest();
  });

  it('creates a hold and makes it findable by workspace/pid, session, and task', () => {
    const result = createOrRenewHold(baseParams(), indexProcessTable(TABLE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.renewed).toBe(false);
    expect(result.hold.expiresAt).toBe(new Date(Date.parse('2026-01-01T00:00:00.000Z') + 30 * 60_000).toISOString());

    expect(findHold('ws-1', 100)?.sessionId).toBe('sess-a');
    expect(getHoldsForSession('sess-a')).toHaveLength(1);
    expect(getHoldsForTask('ws-1', 'FLUX-1')).toHaveLength(1);
    expect(getHoldsForWorktree('/wt/FLUX-1')).toHaveLength(1);
    expect(getHoldsForBranch('ws-1', 'flux/FLUX-1-thing')).toHaveLength(1);
    expect(getExemptPidsForSession('sess-a')).toEqual(new Set([100]));
    expect(getAllExemptPids()).toEqual(new Set([100]));
  });

  it('re-holding the same pid by its OWNER renews deadline/reason instead of erroring', () => {
    createOrRenewHold(baseParams(), indexProcessTable(TABLE));
    const renewed = createOrRenewHold(
      baseParams({ reason: 'still building', now: Date.parse('2026-01-01T00:10:00.000Z') }),
      indexProcessTable(TABLE),
    );
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.renewed).toBe(true);
    expect(renewed.hold.reason).toBe('still building');
    expect(renewed.hold.expiresAt).toBe(new Date(Date.parse('2026-01-01T00:10:00.000Z') + 30 * 60_000).toISOString());
    // createdAt is preserved across a renew, not reset.
    expect(renewed.hold.createdAt).toBe(new Date(Date.parse('2026-01-01T00:00:00.000Z')).toISOString());
  });

  it('rejects re-holding the same pid from a DIFFERENT session as owned-by-other-session', () => {
    createOrRenewHold(baseParams(), indexProcessTable(TABLE));
    const result = createOrRenewHold(baseParams({ sessionId: 'sess-b' }), indexProcessTable(TABLE));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('owned-by-other-session');
    expect(result.owner).toBe('sess-a');
  });

  it('rejects a new hold whose pid is a DESCENDANT of an existing hold as overlap', () => {
    createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE)); // 100 held
    const result = createOrRenewHold(baseParams({ pid: 200, sessionId: 'sess-b' }), indexProcessTable(TABLE)); // 200 is a child of 100
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('overlap');
  });

  it('rejects a new hold whose pid is an ANCESTOR of an existing hold as overlap', () => {
    createOrRenewHold(baseParams({ pid: 200 }), indexProcessTable(TABLE)); // 200 held
    const result = createOrRenewHold(baseParams({ pid: 100, sessionId: 'sess-b' }), indexProcessTable(TABLE)); // 100 is 200's parent
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('overlap');
  });

  it('allows independent sibling holds to coexist', () => {
    const a = createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE));
    const b = createOrRenewHold(baseParams({ pid: 400, sessionId: 'sess-b' }), indexProcessTable(TABLE));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(getHoldsForTask('ws-1', 'FLUX-1')).toHaveLength(2);
  });

  it('release is owner-only and idempotent, and never signals the process', () => {
    createOrRenewHold(baseParams(), indexProcessTable(TABLE));

    const wrongOwner = releaseHold('ws-1', 100, 'sess-b');
    expect(wrongOwner.ok).toBe(false);
    if (!wrongOwner.ok) expect(wrongOwner.error).toBe('owned-by-other-session');
    expect(findHold('ws-1', 100)).toBeDefined(); // still held — wrong-owner release is a no-op

    const ok = releaseHold('ws-1', 100, 'sess-a');
    expect(ok.ok).toBe(true);
    expect(findHold('ws-1', 100)).toBeUndefined();

    const again = releaseHold('ws-1', 100, 'sess-a');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe('not-found'); // idempotent, not an error condition
  });

  it('isPidProtected is true for the exempt root, its descendants, AND its ancestors (never kill a containing ancestor)', () => {
    const idx = indexProcessTable(TABLE);
    const exempt = new Set([100]);
    expect(isPidProtected(idx, 100, exempt)).toBe(true); // the root itself
    expect(isPidProtected(idx, 200, exempt)).toBe(true); // its descendant
    expect(isPidProtected(idx, 1, exempt)).toBe(true); // its ancestor
    expect(isPidProtected(idx, 300, exempt)).toBe(false); // unrelated sibling
    expect(isPidProtected(idx, 400, exempt)).toBe(false); // unrelated branch
  });

  describe('force clear-and-kill — never ownership-gated, always wins', () => {
    it('clearHoldsForSession removes every hold for that session regardless of who "owns" the call', () => {
      createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE));
      createOrRenewHold(baseParams({ pid: 400, taskId: 'FLUX-2' }), indexProcessTable(TABLE));
      const cleared = clearHoldsForSession('sess-a');
      expect(cleared.map((h) => h.pid).sort()).toEqual([100, 400]);
      expect(getHoldsForSession('sess-a')).toHaveLength(0);
    });

    it('clearHoldsForTask/Worktree/Branch each scope correctly', () => {
      createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE));
      expect(clearHoldsForTask('ws-1', 'FLUX-1')).toHaveLength(1);
      expect(findHold('ws-1', 100)).toBeUndefined();

      createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE));
      expect(clearHoldsForWorktree('/wt/FLUX-1')).toHaveLength(1);
      expect(findHold('ws-1', 100)).toBeUndefined();

      createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE));
      expect(clearHoldsForBranch('ws-1', 'flux/FLUX-1-thing')).toHaveLength(1);
      expect(findHold('ws-1', 100)).toBeUndefined();
    });

    it('clearAllHoldsForWorkspace/clearAllHolds scope correctly across workspaces', () => {
      createOrRenewHold(baseParams({ pid: 100, workspaceRoot: 'ws-1' }), indexProcessTable(TABLE));
      createOrRenewHold(baseParams({ pid: 400, workspaceRoot: 'ws-2', sessionId: 'sess-b' }), indexProcessTable(TABLE));

      expect(clearAllHoldsForWorkspace('ws-1')).toHaveLength(1);
      expect(findHold('ws-1', 100)).toBeUndefined();
      expect(findHold('ws-2', 400)).toBeDefined();

      expect(clearAllHolds()).toHaveLength(1);
      expect(findHold('ws-2', 400)).toBeUndefined();
    });
  });

  describe('AC9 — every forced-clear/expiry/stale-clear outcome logs exactly one ticket activity', () => {
    afterEach(() => {
      setHoldHistoryWriter(() => {}); // reset to a no-op so other describes don't log
    });

    it('clearHoldsForSession logs one message per cleared hold, addressed to that hold\'s own task/workspace', () => {
      const logged: Array<{ workspaceRoot: string | null; taskId: string; message: string }> = [];
      setHoldHistoryWriter((workspaceRoot, taskId, message) => logged.push({ workspaceRoot, taskId, message }));

      createOrRenewHold(baseParams({ pid: 100, taskId: 'FLUX-1' }), indexProcessTable(TABLE));
      clearHoldsForSession('sess-a', 'session stopped');

      expect(logged).toHaveLength(1);
      expect(logged[0]!.taskId).toBe('FLUX-1');
      expect(logged[0]!.workspaceRoot).toBe('ws-1');
      expect(logged[0]!.message).toContain('pid 100');
      expect(logged[0]!.message).toContain('session stopped');
    });

    it('a rejected create/renew/release never logs anything (only successful mutations do)', () => {
      const logged: unknown[] = [];
      setHoldHistoryWriter((...args) => logged.push(args));

      createOrRenewHold(baseParams({ pid: 100 }), indexProcessTable(TABLE));
      createOrRenewHold(baseParams({ pid: 100, sessionId: 'sess-b' }), indexProcessTable(TABLE)); // rejected: owned-by-other
      releaseHold('ws-1', 100, 'sess-b'); // rejected: owned-by-other

      // create/renew/release themselves never call the history writer — mcp-server.ts's tool
      // handlers own that wording for the SUCCESS case; this registry only auto-logs FORCED clears.
      expect(logged).toHaveLength(0);
    });
  });

  describe('sweepHolds (AC5/AC6 — expiry, dead-process, and stale-fingerprint handling)', () => {
    it('force-kills and clears an expired hold whose fingerprint still matches', async () => {
      createOrRenewHold(baseParams({ pid: 100, fingerprint: 'fp-100', ttlMinutes: 1 }), indexProcessTable(TABLE));
      const kill = vi.fn();
      const now = Date.parse('2026-01-01T00:00:00.000Z') + 2 * 60_000; // 2 min later, past the 1-min TTL
      const outcomes = await sweepHolds(now, {
        snapshot: async () => [{ pid: 100, creationDate: 'fp-100' }],
        kill,
      });

      expect(outcomes).toEqual([{ hold: expect.objectContaining({ pid: 100 }), outcome: 'expired-killed' }]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls[0]![0]).toMatchObject({ pid: 100 });
      expect(findHold('ws-1', 100)).toBeUndefined();
    });

    it('clears (without killing) a hold whose pid is no longer in the live process table', async () => {
      createOrRenewHold(baseParams({ pid: 100, fingerprint: 'fp-100' }), indexProcessTable(TABLE));
      const kill = vi.fn();
      const outcomes = await sweepHolds(Date.parse('2026-01-01T00:00:00.000Z'), {
        snapshot: async () => [], // pid 100 absent — process already exited on its own
        kill,
      });

      expect(outcomes).toEqual([{ hold: expect.objectContaining({ pid: 100 }), outcome: 'cleared-dead' }]);
      expect(kill).not.toHaveBeenCalled();
      expect(findHold('ws-1', 100)).toBeUndefined();
    });

    it('clears (without killing) a hold whose pid was reused — fingerprint mismatch — even though the TTL has not expired', async () => {
      createOrRenewHold(baseParams({ pid: 100, fingerprint: 'fp-100', ttlMinutes: 120 }), indexProcessTable(TABLE));
      const kill = vi.fn();
      const outcomes = await sweepHolds(Date.parse('2026-01-01T00:00:00.000Z'), {
        snapshot: async () => [{ pid: 100, creationDate: 'DIFFERENT-fingerprint' }], // same pid, different process
        kill,
      });

      expect(outcomes).toEqual([{ hold: expect.objectContaining({ pid: 100 }), outcome: 'cleared-stale-fingerprint' }]);
      expect(kill).not.toHaveBeenCalled(); // AC5: never signal the reused pid
      expect(findHold('ws-1', 100)).toBeUndefined();
    });

    it('leaves a live, fingerprint-matching, unexpired hold untouched', async () => {
      createOrRenewHold(baseParams({ pid: 100, fingerprint: 'fp-100', ttlMinutes: 30 }), indexProcessTable(TABLE));
      const kill = vi.fn();
      const outcomes = await sweepHolds(Date.parse('2026-01-01T00:05:00.000Z'), {
        snapshot: async () => [{ pid: 100, creationDate: 'fp-100' }],
        kill,
      });

      expect(outcomes).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
      expect(findHold('ws-1', 100)).toBeDefined();
    });
  });
});

/**
 * Restart-durability: real temp workspace + the real workspace.js/workspace-context.ts (mirrors
 * session-store.test.ts's two-board stub-persistence fixture) so syncHoldStubs/rehydrateHoldStubs
 * genuinely touch disk under the board's own `.flux/process-holds/` dir.
 */
describe('background-process-holds persistence (FLUX-1645 AC8)', () => {
  let root: string;
  let ws: Workspace;

  function holdsDirFor(r: string): string {
    return path.join(r, '.flux', 'process-holds');
  }
  async function readHoldFiles(r: string): Promise<string[]> {
    return (await fsp.readdir(holdsDirFor(r)).catch(() => [] as string[])).sort();
  }

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-hold-'));
    setWorkspaceRoot(root);
    ws = getDefaultWorkspace();
    root = ws.root ?? root; // realpath-canonicalized form, mirrors session-store.test.ts's rootB realignment
    __resetBackgroundProcessHoldsForTest();
  });

  afterEach(async () => {
    __resetBackgroundProcessHoldsForTest();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('writes a hold to disk, then restores it on rehydrate (a fresh module-state stand-in for a restart)', async () => {
    createOrRenewHold(
      { workspaceRoot: root, taskId: 'FLUX-1', sessionId: 'sess-a', pid: process.pid, fingerprint: 'fp', reason: 'long build', ttlMinutes: 30, worktreePath: null, branch: null },
      indexProcessTable([]),
    );
    await runWithWorkspace(ws, () => rehydrateHoldStubs(ws)); // arms the sync-guard, same as production boot
    await runWithWorkspace(ws, () => syncHoldStubs(root));
    expect(await readHoldFiles(root)).toHaveLength(1);

    // Simulate a restart: wipe in-memory state, then rehydrate from the stub just written.
    __resetBackgroundProcessHoldsForTest();
    expect(findHold(root, process.pid)).toBeUndefined();
    const count = await runWithWorkspace(ws, () => rehydrateHoldStubs(ws));
    expect(count).toBe(1);
    expect(findHold(root, process.pid)?.sessionId).toBe('sess-a');
  });

  it('drops an overdue lease on rehydrate instead of resuming it (AC8)', async () => {
    await fsp.mkdir(holdsDirFor(root), { recursive: true });
    await fsp.writeFile(
      path.join(holdsDirFor(root), 'sess-a__' + process.pid + '.json'),
      JSON.stringify({
        pid: process.pid,
        fingerprint: 'fp',
        taskId: 'FLUX-1',
        sessionId: 'sess-a',
        reason: 'long build',
        worktreePath: null,
        branch: null,
        createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min overdue
        workspaceRoot: root,
      }),
      'utf-8',
    );

    const count = await runWithWorkspace(ws, () => rehydrateHoldStubs(ws));
    expect(count).toBe(0);
    expect(findHold(root, process.pid)).toBeUndefined();
    expect(await readHoldFiles(root)).toHaveLength(0); // the overdue stub is pruned, not left behind
  });

  it('drops a lease for a pid that is no longer alive on rehydrate (AC8)', async () => {
    const deadPid = 999_999; // astronomically unlikely to be a live pid on the test runner
    await fsp.mkdir(holdsDirFor(root), { recursive: true });
    await fsp.writeFile(
      path.join(holdsDirFor(root), 'sess-a__' + deadPid + '.json'),
      JSON.stringify({
        pid: deadPid,
        fingerprint: 'fp',
        taskId: 'FLUX-1',
        sessionId: 'sess-a',
        reason: 'long build',
        worktreePath: null,
        branch: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        workspaceRoot: root,
      }),
      'utf-8',
    );

    const count = await runWithWorkspace(ws, () => rehydrateHoldStubs(ws));
    expect(count).toBe(0);
    expect(findHold(root, deadPid)).toBeUndefined();
  });

  it('prunes a stub tagged for a DIFFERENT workspace root — foreign residue never adopted (mirrors SessionStub Fix A2)', async () => {
    const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'eh-hold-other-'));
    try {
      await fsp.mkdir(holdsDirFor(root), { recursive: true });
      await fsp.writeFile(
        path.join(holdsDirFor(root), 'sess-a__' + process.pid + '.json'),
        JSON.stringify({
          pid: process.pid,
          fingerprint: 'fp',
          taskId: 'FLUX-1',
          sessionId: 'sess-a',
          reason: 'long build',
          worktreePath: null,
          branch: null,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          workspaceRoot: other, // tagged for a DIFFERENT board
        }),
        'utf-8',
      );

      const count = await runWithWorkspace(ws, () => rehydrateHoldStubs(ws));
      expect(count).toBe(0);
      expect(await readHoldFiles(root)).toHaveLength(0); // pruned, not adopted
    } finally {
      await fsp.rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('syncHoldStubs prunes a stale on-disk stub for a hold that has since been released', async () => {
    createOrRenewHold(
      { workspaceRoot: root, taskId: 'FLUX-1', sessionId: 'sess-a', pid: process.pid, fingerprint: 'fp', reason: 'long build', ttlMinutes: 30, worktreePath: null, branch: null },
      indexProcessTable([]),
    );
    await runWithWorkspace(ws, () => rehydrateHoldStubs(ws));
    await runWithWorkspace(ws, () => syncHoldStubs(root));
    expect(await readHoldFiles(root)).toHaveLength(1);

    releaseHold(root, process.pid, 'sess-a');
    await runWithWorkspace(ws, () => syncHoldStubs(root));
    expect(await readHoldFiles(root)).toHaveLength(0);
  });
});

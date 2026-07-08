import { describe, it, expect } from 'vitest';
import path from 'path';
import { findWorktreeLockHolders } from './worktree-lock-holders.js';

// FLUX-1216: findWorktreeLockHolders is a Windows-only command-line-substring matcher (it
// returns [] immediately when `process.platform !== 'win32'`). Pin process.platform to 'win32'
// for the behavior tests so they exercise the real match logic on ANY runner — mirrors the same
// pattern already used in kill-process-tree.test.ts for killDescendantsByPid (FLUX-1207/FLUX-1303,
// which hit exactly this cross-platform CI gap).
//
// Path fixtures are built from `path.resolve(...)` (not raw string literals like `C:\...`) so the
// substring match stays self-consistent whether the actual host OS resolves paths with win32 or
// POSIX semantics — only the SUT's own `process.platform` branch is being pinned here, not the
// `path` module's platform (which is bound to the real OS and unaffected by the override).
describe('findWorktreeLockHolders (FLUX-1216)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const withPlatform = (value: string, fn: () => void | Promise<void>) => async () => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  };

  const base = path.resolve(path.join('tmp-eh-worktrees-base'));
  const worktreePath = path.join(base, 'EventHorizon-FLUX-61');

  it(
    'matches processes whose command line references a path under the worktree',
    withPlatform('win32', async () => {
      const table = [
        { pid: 100, commandLine: `node ${path.join(worktreePath, 'node_modules', '.bin', 'vitest')} run --watch` },
        { pid: 200, commandLine: 'notepad.exe C:\\Users\\test\\Desktop\\notes.txt' },
        { pid: 300, commandLine: `some-shell -Command "cd ${worktreePath}; npm test"` },
      ];
      const listProcesses = async () => table;

      const result = await findWorktreeLockHolders(worktreePath, base, { listProcesses });

      expect(new Set(result)).toEqual(new Set([100, 300]));
    }),
  );

  it(
    // FLUX-1216 review fix: worktree dirs are named `<repo>-<ticketId>` with numeric-suffixed
    // ids (FLUX-1, FLUX-11, FLUX-131, FLUX-1319, ...) — a plain substring match would let
    // "flux-1"'s needle match as a literal PREFIX of an unrelated "flux-11"/"flux-131" process's
    // command line and kill a live, unrelated session.
    'does not match a sibling ticket whose id is a numeric extension of this one (prefix-collision guard)',
    withPlatform('win32', async () => {
      const shortWorktree = path.join(base, 'EventHorizon-FLUX-1');
      const table = [
        // A live, unrelated process actually operating in FLUX-11's worktree — must NOT match
        // FLUX-1's needle even though FLUX-1's path is a character-prefix of FLUX-11's.
        { pid: 100, commandLine: `node ${path.join(base, 'EventHorizon-FLUX-11', 'node_modules', '.bin', 'vitest')} --watch` },
        // A real hit: a process actually inside FLUX-1's own worktree.
        { pid: 200, commandLine: `node ${path.join(shortWorktree, 'node_modules', '.bin', 'vitest')} --watch` },
        // A real hit at exactly the worktree path with nothing after it (end-of-string boundary).
        { pid: 300, commandLine: `some-shell -Command "cd ${shortWorktree}"` },
      ];
      const listProcesses = async () => table;

      const result = await findWorktreeLockHolders(shortWorktree, base, { listProcesses });

      expect(new Set(result)).toEqual(new Set([200, 300]));
    }),
  );

  it(
    'is case-insensitive on the matched path',
    withPlatform('win32', async () => {
      const table = [{ pid: 1, commandLine: `node ${worktreePath.toUpperCase()}${path.sep}index.js` }];
      const listProcesses = async () => table;

      const result = await findWorktreeLockHolders(worktreePath, base, { listProcesses });

      expect(result).toEqual([1]);
    }),
  );

  it(
    'fails CLOSED (never queries) when worktreePath does not resolve under baseDir',
    withPlatform('win32', async () => {
      let called = false;
      const listProcesses = async () => {
        called = true;
        return [{ pid: 1, commandLine: 'anything' }];
      };

      const outsidePath = path.resolve(path.join(path.dirname(base), 'not-the-worktrees-dir'));
      const result = await findWorktreeLockHolders(outsidePath, base, { listProcesses });

      expect(result).toEqual([]);
      expect(called).toBe(false);
    }),
  );

  it(
    'resolves to [] (never throws) when the process query rejects',
    withPlatform('win32', async () => {
      const listProcesses = async (): Promise<Array<{ pid: number; commandLine: string }>> => {
        throw new Error('simulated WMI query failure');
      };

      await expect(findWorktreeLockHolders(worktreePath, base, { listProcesses })).resolves.toEqual([]);
    }),
  );

  it(
    'is a no-op on non-win32 platforms — resolves to [] without calling listProcesses',
    withPlatform('linux', async () => {
      let called = false;
      const listProcesses = async () => {
        called = true;
        return [{ pid: 1, commandLine: worktreePath }];
      };

      const result = await findWorktreeLockHolders(worktreePath, base, { listProcesses });

      expect(result).toEqual([]);
      expect(called).toBe(false);
    }),
  );
});

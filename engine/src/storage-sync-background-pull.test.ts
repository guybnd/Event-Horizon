// FLUX-1002 — the workspace-activation `git pull --ff-only origin flux-data` (attachWorktreeIfPresent,
// the "already attached" branch) must not block activation (and the /workspaces/switch response) on a
// slow/unreachable remote. storage-sync.ts spawns git via its own `execFile`+`buildGitSyncEnv` helper
// (pre-dating the git-exec.ts unification), so this mocks `child_process.execFile` directly — matching
// its custom-promisify contract — rather than storage-sync.test.ts's real-git-against-a-temp-repo style,
// so the pull can be held open deterministically without a real remote.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const { execFileImpl } = vi.hoisted(() => ({ execFileImpl: vi.fn() }));

vi.mock('child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  function execFile(): void {
    throw new Error('execFile invoked directly (non-promisified) — unsupported in this mock');
  }
  // The mock stands in for `util.promisify(execFile)` — Node resolves that via the well-known
  // `promisify.custom` symbol, which isn't part of `execFile`'s declared type, hence the local type.
  type PromisifiedExecFile = typeof execFile & {
    [key: symbol]: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
  };
  (execFile as PromisifiedExecFile)[custom] = (file: string, args: string[], options: Record<string, unknown>) => execFileImpl(file, args, options);
  // FLUX-1581: branch-manager.ts (pulled into this test's module graph transitively via
  // storage-sync.js → git-sync-env.ts → branch-manager.ts) does `import { exec } from
  // 'child_process'` and `const execAsync = promisify(exec)` at ITS OWN module scope — never
  // actually invoked by any code path this suite exercises (that's branch-manager's unrelated
  // user-`checkCommand` runner), but a hand-rolled `{ execFile }`-only mock has no `exec` export at
  // all, so that top-level `promisify(exec)` throws ("No 'exec' export is defined on the
  // 'child_process' mock") before any test body here even runs. A no-op stub is enough.
  //
  // Deliberately NOT `importOriginal()`+spread: git-exec.ts's runGh/runGit spawn the real `gh`/
  // `git` binaries via `child_process.spawn`, not `execFile`. Spreading the real module would leave
  // `spawn` real too, so `buildGitSyncEnv`'s gh-credential probe (checkGhAuth → runGh → spawn)
  // would shell out to an actual `gh auth status` subprocess on every `git()` call this file makes
  // — turning this suite from a fully hermetic, deterministic mock into one that races a real
  // subprocess against fake-pending-pull assertions (observed as a flaky "resolves without waiting
  // for the pull to settle" failure). Leaving `spawn` absent, as before, makes that probe fail
  // fast and synchronously instead — the same deterministic behavior this suite already relied on.
  function exec(): void {}
  return { execFile, exec };
});

import { attachWorktreeIfPresent } from './storage-sync.js';

describe('attachWorktreeIfPresent — background startup pull (FLUX-1002)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-storage-sync-bg-'));
    await fs.mkdir(path.join(root, '.flux-store'), { recursive: true });
    execFileImpl.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves without waiting for the pull to settle', async () => {
    let releasePull: (() => void) | undefined;
    execFileImpl.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === 'pull') {
        return new Promise((resolve) => { releasePull = () => resolve({ stdout: '', stderr: '' }); });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    // Resolves even though the pull's promise is still pending — proves the pull is
    // backgrounded, not just fast.
    await attachWorktreeIfPresent(root);

    expect(releasePull).toBeDefined();
    const pullCalls = execFileImpl.mock.calls.filter((c) => c[1][0] === 'pull');
    expect(pullCalls).toEqual([['git', ['pull', '--ff-only', 'origin', 'flux-data'], expect.anything()]]);

    releasePull!();
  });

  it('does not throw or reject activation when the backgrounded pull fails', async () => {
    execFileImpl.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === 'pull') return Promise.reject(new Error('unreachable remote'));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(attachWorktreeIfPresent(root)).resolves.toBeUndefined();
    // Give the rejected background promise's .catch() a turn so it doesn't surface as an
    // unhandled rejection in the test run.
    await new Promise((r) => setTimeout(r, 10));
  });

  // FLUX-1184: startWatchers()'s chokidar watcher no longer replays an 'add' for pre-existing
  // files (ignoreInitial:true, to kill the boot reload-storm), so it can no longer double as the
  // catch-up path for a background pull's late-landing writes. attachWorktreeIfPresent now diffs
  // HEAD before/after the pull itself and reports exactly the changed files via `onPulledFiles`.
  describe('onPulledFiles reconciliation callback (FLUX-1184)', () => {
    it('reports the changed files when the pull fast-forwards HEAD', async () => {
      let revParseCalls = 0;
      execFileImpl.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'rev-parse') {
          revParseCalls += 1;
          return Promise.resolve({ stdout: revParseCalls === 1 ? 'abc123\n' : 'def456\n', stderr: '' });
        }
        if (args[0] === 'pull') return Promise.resolve({ stdout: '', stderr: '' });
        if (args[0] === 'diff') return Promise.resolve({ stdout: 'FLUX-1.md\nFLUX-2.md\n', stderr: '' });
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const onPulledFiles = vi.fn();
      await attachWorktreeIfPresent(root, onPulledFiles);
      // The reconciliation runs after the backgrounded pull settles — give it a turn.
      await new Promise((r) => setTimeout(r, 10));

      expect(onPulledFiles).toHaveBeenCalledTimes(1);
      const [storeDirArg, changedPaths] = onPulledFiles.mock.calls[0]!;
      expect(storeDirArg).toBe(path.join(root, '.flux-store'));
      expect(changedPaths).toEqual(['FLUX-1.md', 'FLUX-2.md']);

      const diffCalls = execFileImpl.mock.calls.filter((c) => c[1][0] === 'diff');
      expect(diffCalls).toEqual([['git', ['diff', '--name-only', 'abc123', 'def456'], expect.anything()]]);
    });

    it('does not call onPulledFiles when the pull is a no-op (HEAD unchanged)', async () => {
      execFileImpl.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'rev-parse') return Promise.resolve({ stdout: 'abc123\n', stderr: '' });
        if (args[0] === 'pull') return Promise.resolve({ stdout: 'Already up to date.\n', stderr: '' });
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const onPulledFiles = vi.fn();
      await attachWorktreeIfPresent(root, onPulledFiles);
      await new Promise((r) => setTimeout(r, 10));

      expect(onPulledFiles).not.toHaveBeenCalled();
      expect(execFileImpl.mock.calls.some((c) => c[1][0] === 'diff')).toBe(false);
    });

    it('does not call onPulledFiles when the pull fails', async () => {
      execFileImpl.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'rev-parse') return Promise.resolve({ stdout: 'abc123\n', stderr: '' });
        if (args[0] === 'pull') return Promise.reject(new Error('unreachable remote'));
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const onPulledFiles = vi.fn();
      await expect(attachWorktreeIfPresent(root, onPulledFiles)).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 10));

      expect(onPulledFiles).not.toHaveBeenCalled();
    });

    it('skips the extra rev-parse round-trips entirely when no callback is passed', async () => {
      execFileImpl.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'pull') return Promise.resolve({ stdout: '', stderr: '' });
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      await attachWorktreeIfPresent(root);
      await new Promise((r) => setTimeout(r, 10));

      expect(execFileImpl.mock.calls.some((c) => c[1][0] === 'rev-parse')).toBe(false);
    });
  });
});

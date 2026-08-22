// FLUX-1641: copilot.ts previously never prechecked the CLI binary before spawning — a missing
// `copilot` surfaced as a bare `spawn copilot ENOENT` instead of the actionable install message
// claude-code.ts/gemini.ts already give via shared.ts's checkBinaryInstalled. That shared checker
// is PATH-only (which/where), but copilot's own resolver (resolveCopilotBinaryUncached in
// copilot.ts) also accepts a VS Code globalStorage `copilot` binary and (Windows only) a
// node+npm-loader.js fallback — a PATH-only check would falsely reject those installs. This locks
// `checkCopilotBinaryInstalled` (the resolver-aware precheck added for this ticket) against all of
// resolveCopilotBinaryUncached's branches, POSIX and Windows alike, and against re-probing (no
// negative cache — see the Major 1 fix below).
//
// Review follow-up (FLUX-1641): the original version of this file never pinned `process.platform`,
// so all cases ran whatever the host happened to be — on win32 the PATH-found case fails (Windows
// requires a `.exe` match) and the Windows-only branches had zero coverage at all. Every case below
// pins `process.platform` explicitly, mirroring the repo idiom at `gh-availability.test.ts`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { execSync as ExecSync } from 'child_process';
import type { existsSync as ExistsSync } from 'fs';
import * as path from 'path';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn() };
});

const NOT_INSTALLED_MESSAGE = '"copilot" is not installed or not on PATH. Please install it before starting an agent session.';

function notFoundError(): Error {
  return Object.assign(new Error('not found'), { status: 1 });
}

describe('checkCopilotBinaryInstalled (FLUX-1641)', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetCopilotBinaryCacheForTest } = await import('./copilot.js');
    resetCopilotBinaryCacheForTest();
    // Default: nothing resolves (no PATH match, no globalStorage file) — individual tests opt
    // into a "found" scenario by overriding these mocks.
    const { execSync } = await import('child_process');
    vi.mocked(execSync).mockImplementation((() => { throw notFoundError(); }) as unknown as typeof ExecSync);
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    const { resetCopilotBinaryCacheForTest } = await import('./copilot.js');
    resetCopilotBinaryCacheForTest();
  });

  describe('POSIX (darwin/linux)', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env.XDG_CONFIG_HOME = '/home/test/.config';
    });

    it('throws the actionable install message when resolution finds nothing on PATH or in globalStorage', async () => {
      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).rejects.toThrow(NOT_INSTALLED_MESSAGE);
    });

    it('resolves without throwing when `which copilot` finds a real path on PATH', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((() => '/usr/local/bin/copilot\n') as unknown as typeof ExecSync);
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(((p: unknown) => p === '/usr/local/bin/copilot') as unknown as typeof ExistsSync);

      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    });

    // The divergence this ticket fixes: a globalStorage-only install is spawnable (copilot.ts's own
    // resolver falls through to it) but a PATH-only checker (shared.ts's checkBinaryInstalled) would
    // falsely reject it. `which copilot` still fails here — only the globalStorage candidate exists.
    it('resolves without throwing when only a VS Code globalStorage copilot binary exists (not on PATH)', async () => {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME;
      if (!xdgConfigHome) throw new Error('XDG_CONFIG_HOME must be set by the POSIX test setup');
      const globalStoragePath = path.join(
        xdgConfigHome,
        'Code',
        'User',
        'globalStorage',
        'github.copilot-chat',
        'copilotCli',
        'copilot',
      );
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(((p: unknown) => p === globalStoragePath) as unknown as typeof ExistsSync);

      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    });

    it('uses the resolver-aware Copilot precheck for board chat, so globalStorage-only installs are accepted', async () => {
      const { execSync } = await import('child_process');
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(((p: unknown) => String(p).includes('copilotCli')) as unknown as typeof ExistsSync);

      const { copilotBoardSpec } = await import('./copilot-board.js');
      await expect(copilotBoardSpec.checkBinary?.()).resolves.toBeUndefined();
      expect(vi.mocked(execSync)).toHaveBeenCalledWith('which copilot', expect.objectContaining({ encoding: 'utf8' }));
    });
  });

  describe('win32', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    it('resolves without throwing when `where copilot` finds a real .exe on PATH', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation((() => 'C:\\tools\\copilot.exe\r\n') as unknown as typeof ExecSync);
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(((p: unknown) => p === 'C:\\tools\\copilot.exe') as unknown as typeof ExistsSync);

      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    });

    it('resolves without throwing when only a VS Code globalStorage copilot.exe exists (not on PATH)', async () => {
      process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
      const globalStoragePath = path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'copilotCli', 'copilot.exe');
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(((p: unknown) => p === globalStoragePath) as unknown as typeof ExistsSync);

      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    });

    // The single highest-value gap flagged in review: the Windows node+npm-loader.js fallback
    // (resolveCopilotBinaryUncached step 3) is the whole reason a copilot-specific resolver-aware
    // checker exists over shared.ts's PATH-only one, and had zero coverage. Nothing on PATH, no
    // globalStorage binary, no `.exe` anywhere — only `npm prefix -g`'s node_modules tree has the
    // JS entry point, exactly like an npm-global install of `@github/copilot` without a shim on PATH.
    it('resolves without throwing via the node + npm-loader.js fallback when nothing is on PATH or in globalStorage', async () => {
      delete process.env.APPDATA; // no VS Code globalStorage candidates at all
      const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
      const npmPrefix = 'C:\\Users\\test\\AppData\\Roaming\\npm';
      const entryPoint = path.join(npmPrefix, 'node_modules', '@github', 'copilot', 'npm-loader.js');

      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementation(((cmd: string) => {
        if (cmd === 'where copilot') throw notFoundError();
        if (cmd === 'where node') return `${nodePath}\r\n`;
        if (cmd === 'npm prefix -g') return `${npmPrefix}\r\n`;
        throw notFoundError();
      }) as unknown as typeof ExecSync);

      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation(((p: unknown) => p === nodePath || p === entryPoint) as unknown as typeof ExistsSync);

      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    });

    it('throws the actionable install message when no PATH/globalStorage/npm-loader candidate resolves', async () => {
      delete process.env.APPDATA;
      const { checkCopilotBinaryInstalled } = await import('./copilot.js');
      await expect(checkCopilotBinaryInstalled('FLUX-TEST')).rejects.toThrow(NOT_INSTALLED_MESSAGE);
    });
  });

  // Major 1 fix: checkCopilotBinaryInstalled must NOT negative-cache a "not found" resolution.
  // resolveCopilotBinaryUncached swallows every execSync failure with a bare `catch {}` — it
  // cannot tell a clean "not on PATH" from a transient 10s-timeout kill under load (the exact
  // FLUX-985/996 distinction shared.ts's isDefinitiveNotInstalled exists to make) — so caching
  // "not found" risks serving a false negative for a real install. Every call must re-probe.
  it('re-probes on every call while unresolved — no negative cache, so a later install self-heals immediately', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { checkCopilotBinaryInstalled } = await import('./copilot.js');
    const { execSync } = await import('child_process');

    await expect(checkCopilotBinaryInstalled('FLUX-TEST')).rejects.toThrow(NOT_INSTALLED_MESSAGE);
    await expect(checkCopilotBinaryInstalled('FLUX-TEST')).rejects.toThrow(NOT_INSTALLED_MESSAGE);
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(2);

    // Binary "installed" later in this process's lifetime — the very next call (no TTL to wait out)
    // must pick it up.
    vi.mocked(execSync).mockImplementation((() => '/usr/local/bin/copilot\n') as unknown as typeof ExecSync);
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation(((p: unknown) => p === '/usr/local/bin/copilot') as unknown as typeof ExistsSync);

    await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(3);
  });

  it('caches a positive resolution — a resolved hit does not re-probe on the next call', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { execSync } = await import('child_process');
    vi.mocked(execSync).mockImplementation((() => '/usr/local/bin/copilot\n') as unknown as typeof ExecSync);
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation(((p: unknown) => p === '/usr/local/bin/copilot') as unknown as typeof ExistsSync);

    const { checkCopilotBinaryInstalled } = await import('./copilot.js');
    await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    await expect(checkCopilotBinaryInstalled('FLUX-TEST')).resolves.toBeUndefined();
    expect(vi.mocked(execSync)).toHaveBeenCalledTimes(1);
  });

  it('leaves non-Copilot board specs on the shared PATH-only default', async () => {
    const { claudeBoardSpec } = await import('./claude-board.js');
    const { codexBoardSpec } = await import('./codex-board.js');
    const { geminiBoardSpec } = await import('./gemini-board.js');

    expect(claudeBoardSpec.checkBinary).toBeUndefined();
    expect(codexBoardSpec.checkBinary).toBeUndefined();
    expect(geminiBoardSpec.checkBinary).toBeUndefined();
  });
});

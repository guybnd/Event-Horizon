import { describe, it, expect, afterEach } from 'vitest';
import { substituteArgs, isSharedHttpPlatformProven, ensureSharedServer, getSharedServerUrl, serverKey, evictSharedServersForPath } from './shared-mcp-server.js';
import type { ModuleDeclaration } from './modules.js';

describe('substituteArgs', () => {
  it('replaces ${PROJECT} and ${PORT} placeholders', () => {
    const out = substituteArgs(
      ['--project', '${PROJECT}', '--port', '${PORT}', '--flag'],
      { PROJECT: 'C:\\repo', PORT: '9201' },
    );
    expect(out).toEqual(['--project', 'C:\\repo', '--port', '9201', '--flag']);
  });

  it('leaves unknown placeholders untouched', () => {
    expect(substituteArgs(['${NOPE}'], { PORT: '1' })).toEqual(['${NOPE}']);
  });
});

describe('isSharedHttpPlatformProven', () => {
  const orig = process.env.EVENT_HORIZON_SHARED_MCP;
  afterEach(() => {
    if (orig === undefined) delete process.env.EVENT_HORIZON_SHARED_MCP;
    else process.env.EVENT_HORIZON_SHARED_MCP = orig;
  });

  it('is on for win32 and off for others by default', () => {
    expect(isSharedHttpPlatformProven()).toBe(process.platform === 'win32');
  });

  it('honors the EVENT_HORIZON_SHARED_MCP=0 escape hatch', () => {
    process.env.EVENT_HORIZON_SHARED_MCP = '0';
    expect(isSharedHttpPlatformProven()).toBe(false);
  });
});

describe('ensureSharedServer guards', () => {
  const moduleNoShared: ModuleDeclaration = { id: 'x', name: 'X', description: '', enabled: true };

  it('returns null when the module has no sharedHttp', async () => {
    expect(await ensureSharedServer(moduleNoShared, 'C:\\repo')).toBeNull();
    expect(getSharedServerUrl('x', 'C:\\repo')).toBeNull();
  });

  it('returns null when no project path is given', async () => {
    const m: ModuleDeclaration = { ...moduleNoShared, sharedHttp: { command: 'serena', args: [] } };
    expect(await ensureSharedServer(m, '')).toBeNull();
  });

  it('getSharedServerUrl returns null without a project path', () => {
    expect(getSharedServerUrl('x', '')).toBeNull();
  });
});

describe('serverKey (FLUX-579 per-worktree composite key)', () => {
  it('combines module id with the project path', () => {
    const key = serverKey('serena', 'C:\\repo');
    expect(key.startsWith('serena::')).toBe(true);
    expect(key).toContain('repo');
  });

  it('gives DIFFERENT keys for the same module in different worktrees', () => {
    const main = serverKey('serena', 'C:\\repo');
    const worktree = serverKey('serena', 'C:\\.eh-worktrees\\repo-FLUX-1');
    expect(main).not.toBe(worktree);
  });

  it('gives the SAME key for the same module+path regardless of casing/separators on win32', () => {
    if (process.platform !== 'win32') return; // canonicalization lowercases only on win32
    expect(serverKey('serena', 'C:\\Repo')).toBe(serverKey('serena', 'c:/repo'));
  });

  it('distinguishes different modules in the same worktree', () => {
    expect(serverKey('serena', 'C:\\repo')).not.toBe(serverKey('other', 'C:\\repo'));
  });
});

describe('evictSharedServersForPath (FLUX-579)', () => {
  it('is a no-op (returns 0) when nothing is registered for the path', () => {
    expect(evictSharedServersForPath('C:\\nope')).toBe(0);
  });

  it('returns 0 for an empty path', () => {
    expect(evictSharedServersForPath('')).toBe(0);
  });
});

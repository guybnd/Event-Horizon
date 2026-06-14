import { describe, it, expect, afterEach } from 'vitest';
import { substituteArgs, isSharedHttpPlatformProven, ensureSharedServer, getSharedServerUrl } from './shared-mcp-server.js';
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
    expect(getSharedServerUrl('x')).toBeNull();
  });

  it('returns null when no project path is given', async () => {
    const m: ModuleDeclaration = { ...moduleNoShared, sharedHttp: { command: 'serena', args: [] } };
    expect(await ensureSharedServer(m, '')).toBeNull();
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { substituteArgs, isSharedHttpPlatformProven, ensureSharedServer, getSharedServerUrl, serverKey, evictSharedServersForPath, mcpHandshakeOk } from './shared-mcp-server.js';
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

describe('mcpHandshakeOk (FLUX-1004: bounded single attempt)', () => {
  it('returns false quickly — not hanging until HANDSHAKE_TIMEOUT_MS — against a server that accepts the connection but never responds', async () => {
    // This is exactly the failure mode the ticket describes: a Serena that answers the TCP
    // connect but never sends an HTTP response. Before FLUX-1004 the `fetch` had no `signal`,
    // so this would hang indefinitely (the fix's own timeout is what makes this test terminate
    // at all rather than blowing the suite's timeout).
    const server = net.createServer((socket) => {
      // Accept the connection; deliberately never write a response or end it.
      socket.on('error', () => { /* ignore ECONNRESET from the aborted client */ });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const startedAt = Date.now();
      const ok = await mcpHandshakeOk(port);
      const elapsedMs = Date.now() - startedAt;
      expect(ok).toBe(false);
      // Bounded by the fetch's own AbortSignal.timeout, with generous margin for CI jitter —
      // the regression this guards against is "never resolves" / "~45s", not exact timing.
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      server.close();
    }
  }, 20_000);

  it('returns false immediately when nothing is listening on the port', async () => {
    await expect(mcpHandshakeOk(65_530)).resolves.toBe(false);
  });
});

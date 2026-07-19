import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'path';
import os from 'os';
import type { AddressInfo } from 'node:net';
import { attachWorkspace, resolveWorkspaceFromRoot, workspaceScope } from './middleware.js';
import { openWorkspace, closeWorkspace, listWorkspaces, getWorkspace, getDefaultWorkspace } from './workspace-context.js';
import { activateWorkspace } from './task-store.js';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import eventsRouter from './routes/events.js';

function tmpRoot(name: string): string {
  return path.join(os.tmpdir(), 'flux-http-workspace-routing-test', name);
}

/**
 * FLUX-1530 (epic FLUX-1230 S12): the HTTP-middleware and SSE counterpart of
 * mcp-http-workspace-routing.test.ts — `attachWorkspace` (X-EH-Workspace header) and the SSE route
 * (`?ws=`, since EventSource can't send headers) both now resolve per request against the S1
 * registry instead of hardwiring the process-global `getWorkspace()`.
 */
describe('resolveWorkspaceFromRoot / attachWorkspace (FLUX-1530)', () => {
  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
  });

  it('resolves a registered root to its own workspace, regardless of which one is currently active/default', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b')); // opened last -> becomes active/default
    expect(resolveWorkspaceFromRoot(wsA.root!)).toBe(wsA);
    expect(resolveWorkspaceFromRoot(wsB.root!)).toBe(wsB);
  });

  it('an unset or unregistered root falls back to the default workspace, never an error (FLUX-1557)', () => {
    openWorkspace(tmpRoot('b')); // some other board open — must not "win" the unbound fallback
    const defaultWs = getDefaultWorkspace();
    expect(resolveWorkspaceFromRoot(undefined)).toBe(defaultWs);
    expect(resolveWorkspaceFromRoot(tmpRoot('never-registered'))).toBe(defaultWs);
  });

  it('collapses a repeated header/query value (string[]) to its first entry', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    openWorkspace(tmpRoot('b'));
    expect(resolveWorkspaceFromRoot([wsA.root!, tmpRoot('b')])).toBe(wsA);
  });

  it('single-workspace mode (empty registry): resolves to getWorkspace() for both an unset and a bogus root', () => {
    expect(resolveWorkspaceFromRoot(undefined)).toBe(getWorkspace());
    expect(resolveWorkspaceFromRoot(tmpRoot('unregistered'))).toBe(getWorkspace());
  });

  it('attachWorkspace reads X-EH-Workspace off the request and lands req.workspace on the matching registry entry', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    openWorkspace(tmpRoot('b'));
    const req = { headers: { 'x-eh-workspace': wsA.root } } as unknown as express.Request;
    const next = vi.fn();
    attachWorkspace(req, {} as express.Response, next);
    expect(req.workspace).toBe(wsA);
    expect(next).toHaveBeenCalledOnce();
  });

  it('FLUX-1455: resolves the legacy default/boot root to defaultWorkspace even after another board is registered', async () => {
    let bootRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-http-workspace-routing-boot-'));
    try { bootRoot = realpathSync.native(bootRoot); } catch { /* keep as given */ }
    try {
      await activateWorkspace(bootRoot);
      const defaultWs = getDefaultWorkspace();
      openWorkspace(tmpRoot('other'));

      expect(resolveWorkspaceFromRoot(bootRoot)).toBe(defaultWs);
      // FLUX-1557: the unbound `getWorkspace()` fallback is now deterministically the default
      // workspace too — opening another board no longer pulls it away from `defaultWs`.
      expect(getWorkspace()).toBe(defaultWs);
    } finally {
      await fs.rm(bootRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  it.skipIf(process.platform !== 'win32')('FLUX-1571: resolves a registered root even when the caller passes a differently-cased or 8.3-short-name form of it', async () => {
    let root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-http-workspace-routing-casing-'));
    try { root = realpathSync.native(root); } catch { /* keep as given */ }
    try {
      const ws = openWorkspace(root);
      // A client that echoes back a different-but-on-disk-identical form of the same root (e.g. an
      // 8.3 short name, or Windows' case-insensitive-but-case-preserving casing) must still resolve
      // to the SAME workspace, not silently miss and fall through to the default board.
      const differentlyCased = root === root.toUpperCase() ? root.toLowerCase() : root.toUpperCase();
      expect(resolveWorkspaceFromRoot(differentlyCased)).toBe(ws);

      const req = { headers: { 'x-eh-workspace': differentlyCased } } as unknown as express.Request;
      const next = vi.fn();
      attachWorkspace(req, {} as express.Response, next);
      expect(req.workspace).toBe(ws);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);

  it('attachWorkspace falls back to ?ws= when the header is absent (iframe/link navigations cannot set headers)', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b'));

    const req = { headers: {}, query: { ws: wsA.root } } as unknown as express.Request;
    attachWorkspace(req, {} as express.Response, vi.fn());
    expect(req.workspace).toBe(wsA);

    // Header wins over the query param when both are present.
    const reqBoth = { headers: { 'x-eh-workspace': wsB.root }, query: { ws: wsA.root } } as unknown as express.Request;
    attachWorkspace(reqBoth, {} as express.Response, vi.fn());
    expect(reqBoth.workspace).toBe(wsB);
  });

  it('workspaceScope binds the request so bare getWorkspace() calls resolve to req.workspace', () => {
    const wsA = openWorkspace(tmpRoot('a'));
    openWorkspace(tmpRoot('b'));
    const req = { headers: { 'x-eh-workspace': wsA.root }, query: {} } as unknown as express.Request;
    attachWorkspace(req, {} as express.Response, vi.fn());

    let insideBinding: unknown = null;
    workspaceScope(req, {} as express.Response, () => { insideBinding = getWorkspace(); });
    expect(insideBinding).toBe(wsA);
    // FLUX-1557: outside the binding, the unbound fallback is the default workspace, not wsA.
    expect(getWorkspace()).not.toBe(wsA);
  });

  it('attachWorkspace with no header, or an unknown root, lands req.workspace on the default workspace (FLUX-1557)', () => {
    openWorkspace(tmpRoot('b')); // some other board open — must not "win" the unbound fallback
    const defaultWs = getDefaultWorkspace();

    const reqNoHeader = { headers: {} } as unknown as express.Request;
    attachWorkspace(reqNoHeader, {} as express.Response, vi.fn());
    expect(reqNoHeader.workspace).toBe(defaultWs);

    const reqUnknown = { headers: { 'x-eh-workspace': tmpRoot('never-registered') } } as unknown as express.Request;
    attachWorkspace(reqUnknown, {} as express.Response, vi.fn());
    expect(reqUnknown.workspace).toBe(defaultWs);
  });
});

describe('SSE route workspace routing via ?ws= (FLUX-1530)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api/events', eventsRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/events`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
  });

  function connectSse(query: string): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}${query}`, resolve);
      req.on('error', reject);
    });
  }

  it('tags the SSE client with the workspace named by ?ws=, not the currently-active default', async () => {
    const wsA = openWorkspace(tmpRoot('a'));
    const wsB = openWorkspace(tmpRoot('b')); // opened last -> would be the (wrong) default if ?ws= were ignored
    const res = await connectSse(`?ws=${encodeURIComponent(wsA.root!)}`);
    try {
      expect(wsA.sseClients.size).toBe(1);
      expect(wsB.sseClients.size).toBe(0);
    } finally {
      res.destroy();
    }
  });

  it('an unset or unknown ?ws= tags the SSE client with the default workspace (FLUX-1557)', async () => {
    openWorkspace(tmpRoot('b')); // some other board open — must not "win" the unbound fallback
    const defaultWs = getDefaultWorkspace();

    const resNoParam = await connectSse('');
    try {
      expect(defaultWs.sseClients.size).toBe(1);
    } finally {
      resNoParam.destroy();
    }

    const resUnknown = await connectSse(`?ws=${encodeURIComponent(tmpRoot('never-registered'))}`);
    try {
      // >=1 rather than an exact count: resNoParam's server-side prune (on `.destroy()` above) races
      // with this connection, so the set may or may not have shrunk back to 0 by the time we check.
      expect(defaultWs.sseClients.size).toBeGreaterThanOrEqual(1);
    } finally {
      resUnknown.destroy();
    }
  });
});

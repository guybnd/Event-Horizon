import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import type { AddressInfo } from 'node:net';
import { attachWorkspace, resolveWorkspaceFromRoot, workspaceScope, requireWorkspace, isAgentAuthenticatedRequest } from './middleware.js';
import { openWorkspace, closeWorkspace, listWorkspaces, getWorkspace, getDefaultWorkspace } from './workspace-context.js';
import { activateWorkspace, openWorkspaceLive, createTask } from './task-store.js';
import { getWorkspaceRoot } from './workspace.js';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import eventsRouter from './routes/events.js';
import workspacesRouter from './routes/workspaces.js';

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

/**
 * FLUX-1675: a mutating request whose routing header/`?ws=` names a board that isn't currently
 * loaded must be refused with 400 WORKSPACE_NOT_LOADED instead of `attachWorkspace`'s FLUX-1557
 * "never an error" fallback silently landing the write on the active/default board. Reads keep
 * the silent fallback (locked by the GET case below).
 */
describe('requireWorkspace refuses misrouted mutations (FLUX-1675)', () => {
  let bootRoot: string;

  beforeAll(async () => {
    bootRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-http-workspace-routing-mutation-'));
    try { bootRoot = realpathSync.native(bootRoot); } catch { /* keep as given */ }
    await activateWorkspace(bootRoot);
  }, 20_000);

  afterAll(async () => {
    await fs.rm(bootRoot, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
  });

  function fakeRes() {
    const res = {} as express.Response;
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  }

  it('registered non-active target: next() called, req.workspace resolves to it, workspaceHeaderUnresolved falsy', () => {
    const wsA = openWorkspace(tmpRoot('mutation-a'));
    openWorkspace(tmpRoot('mutation-b')); // opened last -> active, must not "win"
    const req = { headers: { 'x-eh-workspace': wsA.root }, method: 'POST' } as unknown as express.Request;
    attachWorkspace(req, {} as express.Response, vi.fn());
    const res = fakeRes();
    const next = vi.fn();
    requireWorkspace(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.workspace).toBe(wsA);
    expect(req.workspaceHeaderUnresolved).toBeFalsy();
  });

  it('unloaded target + POST: 400 WORKSPACE_NOT_LOADED, next not called, nothing created on the active board', () => {
    const req = { headers: { 'x-eh-workspace': tmpRoot('mutation-unloaded') }, method: 'POST' } as unknown as express.Request;
    attachWorkspace(req, {} as express.Response, vi.fn());
    const res = fakeRes();
    const next = vi.fn();
    requireWorkspace(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKSPACE_NOT_LOADED' }));
  });

  it('unloaded target + GET: next() called, no 400 (FLUX-1557 read-fallback preserved)', () => {
    const req = { headers: { 'x-eh-workspace': tmpRoot('mutation-unloaded-get') }, method: 'GET' } as unknown as express.Request;
    attachWorkspace(req, {} as express.Response, vi.fn());
    const res = fakeRes();
    const next = vi.fn();
    requireWorkspace(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('header absent + POST: next() called, no 400, req.workspace is the default workspace (single-workspace mode preserved)', () => {
    const defaultWs = getDefaultWorkspace();
    const req = { headers: {}, method: 'POST' } as unknown as express.Request;
    attachWorkspace(req, {} as express.Response, vi.fn());
    const res = fakeRes();
    const next = vi.fn();
    requireWorkspace(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.workspace).toBe(defaultWs);
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

/**
 * FLUX-1678 Part 1: `POST /api/workspaces/switch` mutates global, all-clients-visible state (which
 * board every portal client sees) and must be portal/human-only — an agent should route by
 * `X-EH-Workspace` instead. The signal is mere presence of an agent identity header
 * (`x-eh-conversation-id`/`x-eh-session-id`), the same headers `attachWorkspace` reads for
 * `x-eh-workspace`; the portal's raw-`fetch` `switchWorkspace` call never sends either.
 */
describe('isAgentAuthenticatedRequest (FLUX-1678)', () => {
  it('true when x-eh-session-id is present', () => {
    const req = { headers: { 'x-eh-session-id': 'sess-1' } } as unknown as express.Request;
    expect(isAgentAuthenticatedRequest(req)).toBe(true);
  });

  it('true when x-eh-conversation-id is present', () => {
    const req = { headers: { 'x-eh-conversation-id': 'conv-1' } } as unknown as express.Request;
    expect(isAgentAuthenticatedRequest(req)).toBe(true);
  });

  it('false for a portal-shaped request (only content-type, no agent headers)', () => {
    const req = { headers: { 'content-type': 'application/json' } } as unknown as express.Request;
    expect(isAgentAuthenticatedRequest(req)).toBe(false);
  });

  it('collapses a repeated header (string[]) to its first entry', () => {
    const req = { headers: { 'x-eh-session-id': ['sess-1', 'sess-2'] } } as unknown as express.Request;
    expect(isAgentAuthenticatedRequest(req)).toBe(true);
  });
});

describe('POST /api/workspaces/switch refuses agent callers (FLUX-1678)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces', workspacesRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/workspaces`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function postSwitch(targetPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ path: targetPath });
      const req = http.request(
        `${baseUrl}/switch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : undefined }));
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it('an agent-authenticated request (x-eh-session-id) is refused with 403 SWITCH_PORTAL_ONLY, no board rebind', async () => {
    const before = getWorkspaceRoot();
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-switch-guard-agent-'));
    try {
      const { status, body } = await postSwitch(target, { 'x-eh-session-id': 'sess-1' });
      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'SWITCH_PORTAL_ONLY' });
      expect(getWorkspaceRoot()).toBe(before);
    } finally {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('an agent-authenticated request via x-eh-conversation-id is refused the same way', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-switch-guard-agent-conv-'));
    try {
      const { status, body } = await postSwitch(target, { 'x-eh-conversation-id': 'conv-1' });
      expect(status).toBe(403);
      expect(body).toMatchObject({ code: 'SWITCH_PORTAL_ONLY' });
    } finally {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('a portal-shaped request (no agent headers) is unaffected — proceeds past the guard', async () => {
    // Deliberately a non-existent path, not a real mkdtemp dir: a real, existing target would
    // let the handler run to completion (activateWorkspace -> saveAppSettings ->
    // autoRegisterWorkspace), which writes the developer's REAL global settings.json (no test
    // override exists for that path — see FLUX-1678 review). The route's own `existsSync` 400
    // fires immediately after the guard, so asserting 400-not-403 proves the request got past
    // the guard with zero side effects, without ever reaching activation.
    const target = path.join(os.tmpdir(), 'flux-switch-guard-portal-nonexistent');
    const { status, body } = await postSwitch(target);
    expect(status).toBe(400);
    expect(body).not.toMatchObject({ code: 'SWITCH_PORTAL_ONLY' });
  });
});

/**
 * FLUX-1678 Part 2: `doActivateWorkspace` used to clear `ws.tasks`/`ws.docs`/`ws.parseErrors`
 * up front, then refill asynchronously — so a read landing mid-activation (`GET /api/tasks/:id`,
 * MCP `get_ticket`/`list_tickets`, all of which read `ws.tasks` directly, unguarded by the
 * `isActivating` 503) served 404 for a ticket whose file was intact on disk the whole time. These
 * tests drive `activateWorkspace` directly (per the ticket's own test-writing note) rather than
 * racing HTTP timing, and assert on the state `ws.tasks` settles into after each (re)activation —
 * the atomicity claim is that it's never observably empty/partial for a ticket that's still on
 * disk, not that any particular intermediate state is unreachable from outside this file.
 */
describe('atomic index rebuild across activateWorkspace (FLUX-1678)', () => {
  let bootRoot: string;
  let fluxDir: string;

  beforeEach(async () => {
    bootRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-atomic-reload-'));
    try { bootRoot = realpathSync.native(bootRoot); } catch { /* keep as given */ }
    fluxDir = path.join(bootRoot, '.flux');
    await activateWorkspace(bootRoot);
  }, 20_000);

  afterEach(async () => {
    await fs.rm(bootRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function writeTicket(id: string, title: string) {
    await fs.writeFile(path.join(fluxDir, `${id}.md`), matter.stringify('body', { id, title, status: 'Todo' }));
  }

  it('a ticket present before a re-activation, and one written moments before it, are both resolvable after', async () => {
    await writeTicket('FLUX-9001', 'Pre-existing');
    await activateWorkspace(bootRoot);
    expect(getWorkspace().tasks['FLUX-9001']?.title).toBe('Pre-existing');

    // Simulates a ticket created in the instant before an agent/portal triggers a switch — no
    // watcher round-trip has necessarily happened yet by the time the switch itself runs.
    await writeTicket('FLUX-9002', 'Created just before switch');

    await activateWorkspace(bootRoot);

    expect(getWorkspace().tasks['FLUX-9001']?.title).toBe('Pre-existing');
    expect(getWorkspace().tasks['FLUX-9002']?.title).toBe('Created just before switch');
  }, 20_000);

  it('a ticket created mid-scan (after the on-disk snapshot, before the scan finishes) is never pruned (FLUX-1678 review)', async () => {
    await writeTicket('FLUX-9010', 'Existing');
    await activateWorkspace(bootRoot);
    expect(getWorkspace().tasks['FLUX-9010']).toBeDefined();

    // Deterministically reproduce the race the reviewer flagged: intercept the ticket-dir
    // `readdir` call inside `initDir` (task-store.ts:1505) — the on-disk snapshot the prune is
    // built from — and create a brand-new ticket immediately after it resolves but before the
    // rest of the scan (and the prune) runs. That new ticket's file did not exist yet when the
    // snapshot was taken, so it can never appear in `idsOnDisk`; the only thing that decides
    // whether it survives is whether the prune candidate set was captured before or after this
    // point. Filtered on `fluxDir` with no `withFileTypes` option so it doesn't also intercept
    // `loadDocsDirectory`'s readdir of the docs tree.
    let injected = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realReaddir = fs.readdir.bind(fs) as (...a: any[]) => Promise<unknown>;
    const mockReaddir = async (dir: unknown, ...rest: unknown[]) => {
      const result = await realReaddir(dir, ...rest);
      if (!injected && dir === fluxDir && rest.length === 0) {
        injected = true;
        await createTask({ title: 'Created mid-scan', status: 'Todo' }, getWorkspace());
      }
      return result;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(mockReaddir as any);

    try {
      await activateWorkspace(bootRoot);
    } finally {
      spy.mockRestore();
    }

    expect(injected).toBe(true);
    const created = Object.values(getWorkspace().tasks).find((t) => t.title === 'Created mid-scan');
    expect(created).toBeDefined();
    await expect(fs.access(path.join(fluxDir, `${created!.id}.md`))).resolves.toBeUndefined();
  }, 20_000);

  it('a ticket actually deleted from disk is pruned on the next re-activation', async () => {
    await writeTicket('FLUX-9003', 'To be deleted');
    await activateWorkspace(bootRoot);
    expect(getWorkspace().tasks['FLUX-9003']).toBeDefined();

    await fs.rm(path.join(fluxDir, 'FLUX-9003.md'));
    await activateWorkspace(bootRoot);
    expect(getWorkspace().tasks['FLUX-9003']).toBeUndefined();
  }, 20_000);

  it('switching to another board and back does not leak either board\'s tickets into the other (cross-board prune correctness)', async () => {
    await writeTicket('FLUX-9004', 'Board A ticket');

    let otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-atomic-reload-other-'));
    try { otherRoot = realpathSync.native(otherRoot); } catch { /* keep as given */ }
    try {
      await fs.mkdir(path.join(otherRoot, '.flux'), { recursive: true });
      await fs.writeFile(
        path.join(otherRoot, '.flux', 'FLUX-8001.md'),
        matter.stringify('body', { id: 'FLUX-8001', title: 'Board B ticket', status: 'Todo' }),
      );

      await activateWorkspace(otherRoot);
      expect(getWorkspace().tasks['FLUX-8001']?.title).toBe('Board B ticket');
      expect(getWorkspace().tasks['FLUX-9004']).toBeUndefined();

      await activateWorkspace(bootRoot);
      expect(getWorkspace().tasks['FLUX-9004']?.title).toBe('Board A ticket');
      expect(getWorkspace().tasks['FLUX-8001']).toBeUndefined();
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, 20_000);
});

/**
 * FLUX-1678 Part 2 (step 6/7): `openWorkspaceLive` used to no-op unconditionally on an
 * already-open board (`if (ws.fluxWatcher) return ws`), so the only way to recover a stale index
 * (e.g. after missing file changes across a restart) was a destructive close+open cycle.
 * `reload:true` (wired from `POST /api/workspaces/open`) rescans atomically instead.
 */
describe('openWorkspaceLive reload:true rescans an already-open board (FLUX-1678)', () => {
  let root: string;
  let fluxDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-open-reload-'));
    try { root = realpathSync.native(root); } catch { /* keep as given */ }
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
  }, 20_000);

  afterEach(async () => {
    await closeWorkspace(root).catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('a ticket written out-of-band after the board is already open is picked up only when reload:true', async () => {
    const ws = await openWorkspaceLive(root);
    expect(ws.tasks['FLUX-7001']).toBeUndefined();

    await fs.writeFile(
      path.join(fluxDir, 'FLUX-7001.md'),
      matter.stringify('body', { id: 'FLUX-7001', title: 'Written after open', status: 'Todo' }),
    );

    // Default (reload:false) preserves the pre-existing cheap idempotent no-op.
    const notReloaded = await openWorkspaceLive(root);
    expect(notReloaded.tasks['FLUX-7001']).toBeUndefined();

    const reloaded = await openWorkspaceLive(root, { reload: true });
    expect(reloaded.tasks['FLUX-7001']?.title).toBe('Written after open');
  }, 20_000);
});

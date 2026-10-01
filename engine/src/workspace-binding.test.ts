import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import type { AddressInfo } from 'node:net';

/**
 * Multi-board binding fix. Two root causes made agents on a secondary board report "unable to bind
 * to a workspace that is definitely open":
 *
 *   1. Only `lastWorkspace` is re-activated at engine boot, so every other board the portal showed as
 *      open was gone from the live registry after a restart — and a session's `X-EH-Workspace`
 *      header naming it MISSED the registry and silently fell back to the default board while still
 *      reporting `binding: 'header'`.
 *   2. A hand-launched session (static `.mcp.json`, no header) had no way to bind at all.
 *
 * These tests pin the resolver that closes (1) — auto-open of a registered-but-not-live board,
 * honest `'header-unresolved'` for an unknown root — the boot restore of the remembered open set,
 * and the cwd → board matching `bind_workspace` uses for (2). The heavy `openWorkspaceLive` path
 * (bootstrap + watchers + git) is mocked to a bare registry `openWorkspace`; its real behavior is
 * covered by http-workspace-routing.test.ts / routes/workspaces.test.ts.
 */

const mocks = vi.hoisted(() => ({
  registered: [] as { path: string; label?: string }[],
  remembered: [] as string[],
  openLive: vi.fn<(root: string) => Promise<unknown>>(),
}));

vi.mock('./task-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-store.js')>();
  return { ...actual, openWorkspaceLive: mocks.openLive };
});

vi.mock('./workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace.js')>();
  return {
    ...actual,
    getWorkspacesList: vi.fn(async () => mocks.registered),
    findRegisteredWorkspace: vi.fn(async (root: string) => mocks.registered.find((w) => actual.pathsEqual(w.path, root)) ?? null),
    getRememberedOpenWorkspaces: vi.fn(async () => [...mocks.remembered]),
    rememberOpenWorkspace: vi.fn(async (root: string) => {
      if (!mocks.remembered.some((p) => actual.pathsEqual(p, root))) mocks.remembered.push(root);
    }),
    forgetOpenWorkspace: vi.fn(async (root: string) => {
      mocks.remembered = mocks.remembered.filter((p) => !actual.pathsEqual(p, root));
    }),
  };
});

import { matchRegisteredWorkspaceForPath } from './workspace.js';
import { resolveWorkspaceBinding, restoreRememberedOpenWorkspaces, resolveLiveWorkspace } from './workspace-binding.js';
import { attachWorkspace, workspaceScope, requireWorkspace } from './middleware.js';
import {
  openWorkspace,
  closeWorkspace,
  listWorkspaces,
  getDefaultWorkspace,
  getWorkspace,
  getWorkspaceByRoot,
  getRequestBinding,
  getRequestedWorkspaceRoot,
  runWithWorkspace,
} from './workspace-context.js';

let sandbox: string;
/** A real on-disk board folder (`<sandbox>/<name>/.flux`) so the resolver's "folder + store exist" gate passes. */
async function makeBoard(name: string): Promise<string> {
  const root = path.join(sandbox, name);
  await fs.mkdir(path.join(root, '.flux'), { recursive: true });
  return root;
}

beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-ws-binding-'));
  try { sandbox = realpathSync.native(sandbox); } catch { /* keep as given */ }
  mocks.openLive.mockImplementation(async (root: string) => openWorkspace(root));
});

afterAll(async () => {
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
});

afterEach(async () => {
  await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
  mocks.registered = [];
  mocks.remembered = [];
  mocks.openLive.mockClear();
});

describe('matchRegisteredWorkspaceForPath (bind_workspace path → board)', () => {
  const repos = path.join(os.tmpdir(), 'eh-match-fixture');
  const entries = [
    { path: path.join(repos, 'alpha') },
    { path: path.join(repos, 'alpha-tools') },
    { path: path.join(repos, 'beta', 'nested') },
  ];

  it('matches the board root itself and any path inside it', () => {
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, 'alpha'))?.path).toBe(entries[0]!.path);
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, 'alpha', 'engine', 'src'))?.path).toBe(entries[0]!.path);
  });

  it('does not confuse a sibling whose name shares a prefix (alpha vs alpha-tools)', () => {
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, 'alpha-tools', 'x'))?.path).toBe(entries[1]!.path);
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, 'alphabet', 'x'))).toBeNull();
  });

  it('maps a task worktree (<parent>/.eh-worktrees/<repo>-<id>) back to its registered repo, preferring the longest repo name', () => {
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, '.eh-worktrees', 'alpha-FLUX-12', 'src'))?.path).toBe(entries[0]!.path);
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, '.eh-worktrees', 'alpha-tools-FLUX-7'))?.path).toBe(entries[1]!.path);
    expect(matchRegisteredWorkspaceForPath(entries, path.join(repos, '.eh-worktrees', 'gamma-FLUX-1'))).toBeNull();
  });

  it('returns null for an empty path or a path outside every board', () => {
    expect(matchRegisteredWorkspaceForPath(entries, '')).toBeNull();
    expect(matchRegisteredWorkspaceForPath(entries, path.join(os.tmpdir(), 'elsewhere'))).toBeNull();
  });
});

describe('resolveWorkspaceBinding', () => {
  it('no header → default-fallback with no workspace', async () => {
    expect(await resolveWorkspaceBinding(undefined)).toEqual({ ws: null, source: 'default-fallback', opened: false });
    expect(await resolveWorkspaceBinding([])).toEqual({ ws: null, source: 'default-fallback', opened: false });
    expect(mocks.openLive).not.toHaveBeenCalled();
  });

  it('a live registry board resolves to header without opening anything', async () => {
    const root = await makeBoard('live');
    const ws = openWorkspace(root);
    const binding = await resolveWorkspaceBinding(root);
    expect(binding.ws).toBe(ws);
    expect(binding.source).toBe('header');
    expect(binding.opened).toBe(false);
    expect(mocks.openLive).not.toHaveBeenCalled();
  });

  it('the boot/default root resolves to the default workspace (never a registry entry)', async () => {
    const defaultWs = getDefaultWorkspace();
    const prior = defaultWs.root;
    const bootRoot = await makeBoard('boot');
    defaultWs.root = bootRoot;
    try {
      expect(resolveLiveWorkspace(bootRoot)).toBe(defaultWs);
      const binding = await resolveWorkspaceBinding(bootRoot);
      expect(binding.ws).toBe(defaultWs);
      expect(binding.source).toBe('header');
    } finally {
      defaultWs.root = prior;
    }
  });

  it('a REGISTERED board that is not live is auto-opened and bound (the post-restart secondary-board fix) and remembered', async () => {
    const root = await makeBoard('registered-not-live');
    mocks.registered = [{ path: root }];
    expect(getWorkspaceByRoot(root)).toBeUndefined();

    const binding = await resolveWorkspaceBinding(root);
    expect(binding.source).toBe('header');
    expect(binding.opened).toBe(true);
    expect(binding.ws).toBe(getWorkspaceByRoot(root));
    expect(mocks.openLive).toHaveBeenCalledWith(root);
    // Persisted so a later engine restart restores it.
    await vi.waitFor(() => expect(mocks.remembered).toContain(root));
  });

  it('a registered board whose folder lost its store is NOT opened into a phantom — unresolved instead', async () => {
    const root = path.join(sandbox, 'registered-no-store');
    await fs.mkdir(root, { recursive: true });
    mocks.registered = [{ path: root }];
    const binding = await resolveWorkspaceBinding(root);
    expect(binding).toMatchObject({ ws: null, source: 'header-unresolved', requestedRoot: root });
    expect(mocks.openLive).not.toHaveBeenCalled();
  });

  it('a root nothing on this engine knows about is header-unresolved, echoing the requested root', async () => {
    const root = path.join(sandbox, 'never-registered');
    const binding = await resolveWorkspaceBinding(root);
    expect(binding).toEqual({ ws: null, source: 'header-unresolved', requestedRoot: root, opened: false });
  });

  it('a failing auto-open degrades to header-unresolved rather than throwing out of the request path', async () => {
    const root = await makeBoard('open-fails');
    mocks.registered = [{ path: root }];
    mocks.openLive.mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const binding = await resolveWorkspaceBinding(root);
      expect(binding.source).toBe('header-unresolved');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('restoreRememberedOpenWorkspaces (boot)', () => {
  it('re-opens every remembered, still-registered board except the default; forgets stale entries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const keep = await makeBoard('restore-keep');
      const gone = path.join(sandbox, 'restore-gone'); // never created on disk
      const unregistered = await makeBoard('restore-unregistered');
      const defaultRoot = await makeBoard('restore-default');
      mocks.registered = [{ path: keep }, { path: gone }, { path: defaultRoot }];
      mocks.remembered = [keep, gone, unregistered, defaultRoot];

      const restored = await restoreRememberedOpenWorkspaces(defaultRoot);

      expect(restored).toEqual([keep]);
      expect(mocks.openLive).toHaveBeenCalledTimes(1);
      expect(mocks.openLive).toHaveBeenCalledWith(keep);
      expect(getWorkspaceByRoot(keep)).toBeDefined();
      // Stale entries scrubbed; the surviving one kept.
      expect(mocks.remembered).toEqual([keep]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('is a no-op with nothing remembered', async () => {
    expect(await restoreRememberedOpenWorkspaces(null)).toEqual([]);
    expect(mocks.openLive).not.toHaveBeenCalled();
  });
});

describe('runWithWorkspace binding source / getRequestBinding', () => {
  it('defaults to header for a workspace and default-fallback for null; honors an explicit source', () => {
    const ws = openWorkspace(path.join(sandbox, 'als'));
    expect(runWithWorkspace(ws, () => getRequestBinding())).toBe('header');
    expect(runWithWorkspace(null, () => getRequestBinding())).toBe('default-fallback');
    expect(runWithWorkspace(ws, () => getRequestBinding(), { source: 'session' })).toBe('session');
    expect(getRequestBinding()).toBe('default-fallback');
  });

  it('header-unresolved carries the requested root and still resolves getWorkspace() to the default board', () => {
    const wanted = path.join(sandbox, 'wanted');
    const seen = runWithWorkspace(null, () => ({ binding: getRequestBinding(), requested: getRequestedWorkspaceRoot(), ws: getWorkspace() }), {
      source: 'header-unresolved',
      requestedRoot: wanted,
    });
    expect(seen.binding).toBe('header-unresolved');
    expect(seen.requested).toBe(wanted);
    expect(seen.ws).toBe(getDefaultWorkspace());
    expect(getRequestedWorkspaceRoot()).toBeNull();
  });

  it('a null workspace can never masquerade as a verified header/session binding', () => {
    expect(runWithWorkspace(null, () => getRequestBinding(), { source: 'header' })).toBe('default-fallback');
    expect(runWithWorkspace(null, () => getRequestBinding(), { source: 'session' })).toBe('default-fallback');
  });
});

describe('attachWorkspace + workspaceScope over HTTP (REST auto-open / unresolved)', () => {
  let server: http.Server;
  let baseUrl: string;
  let priorDefaultRoot: string | null;

  beforeAll(async () => {
    const defaultWs = getDefaultWorkspace();
    priorDefaultRoot = defaultWs.root;
    defaultWs.root = await makeBoard('rest-default'); // requireWorkspace needs a bound default root
    const app = express();
    app.use(attachWorkspace);
    app.use(workspaceScope);
    const probe = (req: express.Request, res: express.Response) => {
      res.json({
        binding: getRequestBinding(),
        root: getWorkspace().root,
        unresolved: req.workspaceHeaderUnresolved === true,
        requested: getRequestedWorkspaceRoot(),
      });
    };
    app.get('/probe', probe);
    app.post('/mutate', requireWorkspace, probe);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    getDefaultWorkspace().root = priorDefaultRoot;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function call(method: 'GET' | 'POST', route: string, wsHeader?: string) {
    const res = await fetch(`${baseUrl}${route}`, { method, headers: wsHeader ? { 'x-eh-workspace': wsHeader } : {} });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  it('no header → default-fallback on the default board (unchanged fast path)', async () => {
    const { body } = await call('GET', '/probe');
    expect(body.binding).toBe('default-fallback');
    expect(body.root).toBe(getDefaultWorkspace().root);
    expect(mocks.openLive).not.toHaveBeenCalled();
  });

  it('header naming a registered-but-not-live board auto-opens it — a mutation succeeds on THAT board instead of 400 WORKSPACE_NOT_LOADED', async () => {
    const root = await makeBoard('rest-registered');
    mocks.registered = [{ path: root }];
    const { status, body } = await call('POST', '/mutate', root);
    expect(status).toBe(200);
    expect(body.binding).toBe('header');
    expect(body.root).toBe(root);
    expect(body.unresolved).toBe(false);
    expect(getWorkspaceByRoot(root)).toBeDefined();
  });

  it('header naming an unregistered root: reads fall back to the default board but disclose header-unresolved; mutations are refused', async () => {
    const root = path.join(sandbox, 'rest-unknown');
    const read = await call('GET', '/probe', root);
    expect(read.status).toBe(200);
    expect(read.body.binding).toBe('header-unresolved');
    expect(read.body.requested).toBe(root);
    expect(read.body.root).toBe(getDefaultWorkspace().root);
    expect(read.body.unresolved).toBe(true);

    const write = await call('POST', '/mutate', root);
    expect(write.status).toBe(400);
    expect(write.body.code).toBe('WORKSPACE_NOT_LOADED');
  });
});

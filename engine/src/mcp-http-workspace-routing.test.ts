import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { realpathSync } from 'fs';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListRootsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Multi-board binding: the heavy `openWorkspaceLive` (bootstrap + watchers + git) is replaced by a
 * bare registry `openWorkspace` so the auto-open / bind_workspace paths can be exercised against
 * in-memory boards, and the settings-file registry is replaced by `mocks.registered`.
 */
const mocks = vi.hoisted(() => ({
  registered: [] as { path: string; label?: string }[],
}));

vi.mock('./task-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-store.js')>();
  const ctx = await import('./workspace-context.js');
  return { ...actual, openWorkspaceLive: vi.fn(async (root: string) => ctx.openWorkspace(root)) };
});

vi.mock('./workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace.js')>();
  return {
    ...actual,
    getWorkspacesList: vi.fn(async () => mocks.registered),
    findRegisteredWorkspace: vi.fn(async (root: string) => mocks.registered.find((w) => actual.pathsEqual(w.path, root)) ?? null),
    resolveRegisteredWorkspaceForPath: vi.fn(async (anyPath: string) => actual.matchRegisteredWorkspaceForPath(mocks.registered, anyPath)),
    rememberOpenWorkspace: vi.fn(async () => {}),
    forgetOpenWorkspace: vi.fn(async () => {}),
  };
});

// FLUX-1781: spy (not stub) `renewClaim` so the claim-scope test can assert WHICH root a
// tool call renewed against, while every other test keeps its real (harmless no-op-when-no-claim)
// behaviour.
vi.mock('./worktree-claims.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree-claims.js')>();
  return { ...actual, renewClaim: vi.fn(actual.renewClaim) };
});

import { handleMcpHttpRequest } from './mcp-server.js';
import { openWorkspace, closeWorkspace, listWorkspaces, getDefaultWorkspace, getWorkspaceByRoot, normalizeWorkspaceKey } from './workspace-context.js';
import { openWorkspaceLive } from './task-store.js';
import { renewClaim } from './worktree-claims.js';

const openWorkspaceLiveMock = vi.mocked(openWorkspaceLive);
const renewClaimMock = vi.mocked(renewClaim);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && ('structuredContent' in value || 'content' in value);
}

let sandbox = path.join(os.tmpdir(), 'flux-mcp-workspace-routing-test');
function tmpRoot(name: string): string {
  return path.join(sandbox, name);
}

/**
 * FLUX-1448 (epic FLUX-1230 S3): per-connection MCP workspace binding. Mirrors
 * mcp-http-conversation-routing.test.ts's real-HTTP-transport harness (FLUX-1213) — two
 * concurrent connections prove isolation the same way, just keyed on `x-eh-workspace` (resolved
 * against the S1 registry, workspace-context.ts) instead of `x-eh-conversation-id`. Both
 * workspaces seed the SAME ticket id (`FLUX-1`) with different titles — the exact cross-board
 * id-collision this ticket exists to prevent.
 *
 * Multi-board binding follow-up: a header naming a registered-but-not-live board is auto-opened
 * (the post-restart secondary-board fix), an unknown root is disclosed as `header-unresolved` and
 * refused, and a headerless session can bind itself with `bind_workspace`.
 */
describe('MCP HTTP per-connection workspace binding (FLUX-1448)', () => {
  let server: http.Server;
  let baseUrl: URL;
  let rootA: string;
  let rootB: string;
  let rootC: string;
  let rootD: string;

  beforeAll(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-mcp-workspace-routing-'));
    try { sandbox = realpathSync.native(sandbox); } catch { /* keep as given */ }
    rootA = tmpRoot('a');
    rootB = tmpRoot('b');
    rootC = tmpRoot('c');
    rootD = tmpRoot('d');
    // Real folders with a store so the auto-open / bind gates ("folder + .flux exist") pass.
    for (const r of [rootA, rootB, rootC, rootD]) await fs.mkdir(path.join(r, '.flux'), { recursive: true });
    mocks.registered = [{ path: rootA }, { path: rootB }, { path: rootC }, { path: rootD }];

    const wsA = openWorkspace(rootA);
    wsA.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Workspace A ticket', status: 'Todo', history: [] };
    const wsB = openWorkspace(rootB);
    wsB.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Workspace B ticket', status: 'Todo', history: [] };
    // rootC is registered but deliberately NOT opened — the "engine restarted, portal still shows the
    // board" state a dispatched session's header runs into.
    // FLUX-1557: the unbound/unrouted fallback resolves to the default workspace, never whichever
    // registry entry was opened last — seed it with its own distinctly-titled ticket so the
    // "unrouted" test below can tell the two apart.
    getDefaultWorkspace().tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Default board ticket', status: 'Todo', history: [] };

    server = http.createServer((req, res) => {
      handleMcpHttpRequest(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterAll(async () => {
    delete getDefaultWorkspace().tasks['FLUX-1'];
    await Promise.all(listWorkspaces().map((ws) => ws.root && closeWorkspace(ws.root)));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  });

  async function connectClient(workspaceRoot: string | undefined, label: string): Promise<Client> {
    const headers = workspaceRoot ? { 'x-eh-workspace': workspaceRoot } : undefined;
    const transport = new StreamableHTTPClientTransport(baseUrl, headers ? { requestInit: { headers } } : undefined);
    const client = new Client({ name: `eh-ws-routing-test-${label}`, version: '1.0.0' }, { capabilities: {} });
    // Cast: same exactOptionalPropertyTypes/sessionId mismatch mcp-schema-probe.ts casts around —
    // StreamableHTTPClientTransport genuinely implements Transport.
    await client.connect(transport as Transport);
    return client;
  }

  async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const raw: unknown = await client.callTool({ name, arguments: args });
    if (!isCallToolResult(raw)) throw new Error(`expected a ${name} result`);
    return raw;
  }

  async function getTicketTitle(client: Client, ticketId: string): Promise<unknown> {
    const raw = await callTool(client, 'get_ticket', { ticketId });
    return (raw as { structuredContent?: { title?: unknown } }).structuredContent?.title;
  }

  async function boardConfig(client: Client): Promise<{ binding?: string; workspaceRoot?: string | null; requestedRoot?: string }> {
    const raw = await callTool(client, 'get_board_config');
    return (raw.structuredContent ?? {}) as { binding?: string; workspaceRoot?: string | null; requestedRoot?: string };
  }

  function sameRoot(a: string | null | undefined, b: string): boolean {
    return !!a && normalizeWorkspaceKey(a) === normalizeWorkspaceKey(b);
  }

  /** A fresh re-`openWorkspace()`d board (LRU-evict, re-point, roots auto-bind) is a brand new
   *  in-memory `Workspace` with no tasks — this mocked harness never re-hydrates from disk. Reseed
   *  the probe ticket once the object exists so a later `get_ticket` proves we landed on the RIGHT
   *  board, not merely that `binding`/`workspaceRoot` reported the right root. */
  function seedFluxOne(root: string, title: string): void {
    const ws = getWorkspaceByRoot(root);
    if (ws) ws.tasks['FLUX-1'] = { id: 'FLUX-1', title, status: 'Todo', history: [] };
  }

  /**
   * FLUX-1781: a headerless client that advertises the MCP `roots` capability. `rootUri` seeds a
   * `roots/list` response with a single root; omitting it (with `hang: true`) registers a handler
   * that never resolves, so the SERVER's own `listRoots` call must hit its 2s timeout.
   */
  async function connectRootsClient(opts: { name: string; rootUri?: string; hang?: boolean }): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(baseUrl);
    const client = new Client({ name: opts.name, version: '1.0.0' }, { capabilities: { roots: {} } });
    if (opts.hang) {
      client.setRequestHandler(ListRootsRequestSchema, () => new Promise(() => { /* never resolves */ }));
    } else {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: opts.rootUri ? [{ uri: opts.rootUri }] : [],
      }));
    }
    await client.connect(transport as Transport);
    return client;
  }

  it('two concurrent connections bound to different workspaces resolve the SAME ticket id to their OWN board', async () => {
    const [clientA, clientB] = await Promise.all([
      connectClient(rootA, 'A'),
      connectClient(rootB, 'B'),
    ]);
    try {
      const [titleA, titleB] = await Promise.all([
        getTicketTitle(clientA, 'FLUX-1'),
        getTicketTitle(clientB, 'FLUX-1'),
      ]);
      expect(titleA).toBe('Workspace A ticket');
      expect(titleB).toBe('Workspace B ticket');
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  });

  it('a client naming the legacy default/boot root binds to defaultWorkspace even though it is never a registry entry (the scratch-chat-on-the-wrong-board fix)', async () => {
    const defaultWs = getDefaultWorkspace();
    const priorRoot = defaultWs.root;
    const priorTask = defaultWs.tasks['FLUX-1'];
    const bootRoot = tmpRoot('boot');
    defaultWs.root = path.resolve(bootRoot);
    defaultWs.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'Boot board ticket', status: 'Todo', history: [] };
    try {
      // rootB is the registry's most-recently-opened board — before the fix, a session spawned on
      // the boot board sent its root back but the registry-only lookup missed, so boundWorkspace()
      // silently served rootB's board instead.
      const client = await connectClient(bootRoot, 'boot');
      try {
        expect(await getTicketTitle(client, 'FLUX-1')).toBe('Boot board ticket');
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      defaultWs.root = priorRoot;
      if (priorTask) defaultWs.tasks['FLUX-1'] = priorTask;
      else delete defaultWs.tasks['FLUX-1'];
    }
  });

  it('an unrouted client (no x-eh-workspace header) falls back to the default workspace and discloses default-fallback (FLUX-1557/1573)', async () => {
    const client = await connectClient(undefined, 'unrouted');
    try {
      expect(await getTicketTitle(client, 'FLUX-1')).toBe('Default board ticket');
      expect((await boardConfig(client)).binding).toBe('default-fallback');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('a header naming a REGISTERED board the engine has not opened is auto-opened and bound — not silently served the default board', async () => {
    expect(getWorkspaceByRoot(rootC)).toBeUndefined();
    const client = await connectClient(rootC, 'C');
    try {
      const cfg = await boardConfig(client);
      expect(cfg.binding).toBe('header');
      expect(sameRoot(cfg.workspaceRoot, rootC)).toBe(true);
      expect(getWorkspaceByRoot(rootC)).toBeDefined();
      // Board C has no FLUX-1 — proving we are NOT reading the default board's ticket.
      const res = await callTool(client, 'get_ticket', { ticketId: 'FLUX-1' });
      expect(res.isError).toBe(true);
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('a header naming an UNREGISTERED root is disclosed as header-unresolved and every non-diagnostic tool is refused until bind_workspace', async () => {
    const unknownRoot = tmpRoot('never-registered');
    const client = await connectClient(unknownRoot, 'unknown-root');
    try {
      const cfg = await boardConfig(client);
      expect(cfg.binding).toBe('header-unresolved');
      expect(cfg.requestedRoot).toBe(unknownRoot);

      const refused = await callTool(client, 'get_ticket', { ticketId: 'FLUX-1' });
      expect(refused.isError).toBe(true);
      expect(String((refused.content as { text?: string }[])[0]?.text)).toContain('bind_workspace');
      // Diagnostics stay available.
      const listed = await callTool(client, 'list_workspaces');
      expect(listed.isError).not.toBe(true);

      // Self-heal: bind by a path INSIDE board A (an agent passes its cwd, not the board root).
      const bound = await callTool(client, 'bind_workspace', { path: path.join(rootA, 'engine', 'src') });
      expect(bound.isError).not.toBe(true);
      const sc = bound.structuredContent as { binding?: string; workspaceRoot?: string; previousBinding?: string; opened?: boolean };
      expect(sc.binding).toBe('session');
      expect(sc.previousBinding).toBe('header-unresolved');
      expect(sc.opened).toBe(false);
      expect(sameRoot(sc.workspaceRoot, rootA)).toBe(true);

      // Subsequent calls on the same MCP session resolve to board A.
      expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace A ticket');
      expect((await boardConfig(client)).binding).toBe('session');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('bind_workspace lets a headerless session bind to a specific board (and refuses a path outside every registered board)', async () => {
    const client = await connectClient(undefined, 'headerless-bind');
    try {
      const miss = await callTool(client, 'bind_workspace', { path: path.join(os.tmpdir(), 'not-a-board-anywhere') });
      expect(miss.isError).toBe(true);
      expect(await getTicketTitle(client, 'FLUX-1')).toBe('Default board ticket');

      const bound = await callTool(client, 'bind_workspace', { path: rootB });
      expect(bound.isError).not.toBe(true);
      expect((bound.structuredContent as { previousBinding?: string }).previousBinding).toBe('default-fallback');
      expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace B ticket');
    } finally {
      await client.close().catch(() => {});
    }
  });

  it('bind_workspace is refused on a connection already bound via a resolved X-EH-Workspace header (dispatched sessions stay put)', async () => {
    const client = await connectClient(rootA, 'header-bound');
    try {
      const res = await callTool(client, 'bind_workspace', { path: rootB });
      expect(res.isError).toBe(true);
      expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace A ticket');
    } finally {
      await client.close().catch(() => {});
    }
  });

  // ─── FLUX-1781: session binding no longer silently drops to the default board ───────────────

  describe('FLUX-1781: re-point instead of drop (case 1 — the bound board is no longer the same live object)', () => {
    it('a session binding survives an LRU-evict-and-not-reopen: the next call re-opens the board and still resolves binding: "session"', async () => {
      const client = await connectClient(undefined, 're-point-evicted');
      try {
        const bound = await callTool(client, 'bind_workspace', { path: rootB });
        expect(bound.isError).not.toBe(true);
        await closeWorkspace(rootB); // registered, but no longer live — "evicted and gone".
        expect(getWorkspaceByRoot(rootB)).toBeUndefined();

        const cfg = await boardConfig(client);
        expect(cfg.binding).toBe('session');
        expect(sameRoot(cfg.workspaceRoot, rootB)).toBe(true);
        expect(getWorkspaceByRoot(rootB)).toBeDefined(); // re-opened by the re-point.
        seedFluxOne(rootB, 'Workspace B ticket');
        expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace B ticket');
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('a session binding survives evict-then-reopened-by-someone-else (new object, same root)', async () => {
      const client = await connectClient(undefined, 're-point-reopened');
      try {
        const bound = await callTool(client, 'bind_workspace', { path: rootB });
        expect(bound.isError).not.toBe(true);
        await closeWorkspace(rootB);
        openWorkspace(rootB); // a DIFFERENT caller reopens it — a fresh Workspace object, same root.
        seedFluxOne(rootB, 'Workspace B ticket');

        const cfg = await boardConfig(client);
        expect(cfg.binding).toBe('session');
        expect(sameRoot(cfg.workspaceRoot, rootB)).toBe(true);
        expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace B ticket');
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('a session binding whose board is no longer REGISTERED at all is dropped (not re-pointed)', async () => {
      const client = await connectClient(undefined, 're-point-deregistered');
      try {
        const bound = await callTool(client, 'bind_workspace', { path: rootD });
        expect(bound.isError).not.toBe(true);
        await closeWorkspace(rootD);
        const idx = mocks.registered.findIndex((w) => w.path === rootD);
        mocks.registered.splice(idx, 1); // deregister — this board no longer exists on the engine.
        try {
          const cfg = await boardConfig(client);
          expect(cfg.binding).toBe('default-fallback');
        } finally {
          mocks.registered.push({ path: rootD }); // restore for any later test.
        }
      } finally {
        await client.close().catch(() => {});
      }
    });
  });

  describe('FLUX-1781: transient re-open failure refuses the call instead of serving the default board', () => {
    it('a bound session whose board fails to re-open TRANSIENTLY keeps its binding, refuses the call, and recovers on the next request', async () => {
      const client = await connectClient(undefined, 'transient');
      try {
        const bound = await callTool(client, 'bind_workspace', { path: rootB });
        expect(bound.isError).not.toBe(true);
        const canonicalRootB = (bound.structuredContent as { workspaceRoot?: string }).workspaceRoot ?? rootB;
        await closeWorkspace(rootB);
        openWorkspaceLiveMock.mockImplementationOnce(async () => {
          throw new Error('simulated transient failure (file lock / watcher limit / git contention)');
        });

        const refused = await callTool(client, 'list_tickets');
        expect(refused.isError).toBe(true);
        expect((refused.structuredContent as { code?: string } | undefined)?.code).toBe('transient_retry');
        const refusalText = String((refused.content as { text?: string }[])[0]?.text ?? '');
        expect(refusalText).toContain(canonicalRootB);
        expect(refusalText).toContain('list_tickets');

        // The binding survives the transient failure — the NEXT request (mock restored) recovers.
        const cfg = await boardConfig(client);
        expect(cfg.binding).toBe('session');
        expect(sameRoot(cfg.workspaceRoot, rootB)).toBe(true);
        seedFluxOne(rootB, 'Workspace B ticket');
        expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace B ticket');
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('the four diagnostic tools still run under a transient re-open failure', async () => {
      const client = await connectClient(undefined, 'transient-allowlist');
      try {
        const bound = await callTool(client, 'bind_workspace', { path: rootB });
        expect(bound.isError).not.toBe(true);
        await closeWorkspace(rootB);
        openWorkspaceLiveMock.mockImplementationOnce(async () => {
          throw new Error('simulated transient failure');
        });

        const cfg = await boardConfig(client); // get_board_config is allowlisted.
        expect(cfg.binding).toBe('default-fallback'); // this one request never got a live board.
      } finally {
        await client.close().catch(() => {});
      }
    });
  });

  describe('FLUX-1781: auto-bind from the client\'s MCP `roots` (an unbound connection re-derives its board)', () => {
    it('a headerless client advertising `roots` inside a registered board auto-binds on its FIRST tool call — no bind_workspace needed', async () => {
      const client = await connectRootsClient({ name: 'eh-ws-routing-test-roots-b', rootUri: pathToFileURL(rootB).toString() });
      try {
        const cfg = await boardConfig(client);
        expect(cfg.binding).toBe('session');
        expect(sameRoot(cfg.workspaceRoot, rootB)).toBe(true);
        seedFluxOne(rootB, 'Workspace B ticket');
        expect(await getTicketTitle(client, 'FLUX-1')).toBe('Workspace B ticket');
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('roots pointing outside every registered board is not an error — just no auto-bind, stays default-fallback', async () => {
      const outside = path.join(os.tmpdir(), 'flux-roots-outside-any-board');
      await fs.mkdir(outside, { recursive: true });
      const client = await connectRootsClient({ name: 'eh-ws-routing-test-roots-outside', rootUri: pathToFileURL(outside).toString() });
      try {
        expect((await boardConfig(client)).binding).toBe('default-fallback');
      } finally {
        await client.close().catch(() => {});
        await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('a client advertising NO `roots` capability never triggers a probe', async () => {
      // No `roots` in the negotiated capabilities — the SDK client itself refuses to register a
      // ListRoots handler in that case (assertRequestHandlerCapability), which independently proves
      // the server can never successfully probe this connection; installUnresolvedBindingGuard must
      // skip the attempt entirely rather than let a `roots/list` fail the tool call.
      const client = await connectClient(undefined, 'no-roots-capability');
      try {
        expect((await boardConfig(client)).binding).toBe('default-fallback');
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('a probe that times out leaves the tool call succeeding on default-fallback — the McpError never surfaces as a tool error', async () => {
      const client = await connectRootsClient({ name: 'eh-ws-routing-test-roots-hang', hang: true });
      try {
        const cfg = await boardConfig(client);
        expect(cfg.binding).toBe('default-fallback');
      } finally {
        await client.close().catch(() => {});
      }
    }, 10_000);

    it('an auto-bound connection renews its FLUX-1771 worktree claim against the AUTO-BOUND root, not the default board\'s', async () => {
      const client = await connectRootsClient({ name: 'eh-ws-routing-test-roots-claim', rootUri: pathToFileURL(rootB).toString() });
      try {
        await boardConfig(client); // triggers the roots probe + auto-bind (fresh Workspace, no tasks yet).
        seedFluxOne(rootB, 'Workspace B ticket');
        renewClaimMock.mockClear();

        const res = await callTool(client, 'get_ticket', { ticketId: 'FLUX-1' });
        expect(res.isError).not.toBe(true);
        expect(renewClaimMock).toHaveBeenCalled();
        const [rootArg] = renewClaimMock.mock.calls[0]!;
        expect(sameRoot(rootArg as string | null, rootB)).toBe(true);
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('a settled probe result is revalidated on the NEXT request — a deregistered auto-bound board falls back to default, not a stale session binding', async () => {
      const client = await connectRootsClient({ name: 'eh-ws-routing-test-roots-stale', rootUri: pathToFileURL(rootD).toString() });
      try {
        const first = await boardConfig(client); // triggers the roots probe + auto-bind.
        expect(first.binding).toBe('session');
        expect(sameRoot(first.workspaceRoot, rootD)).toBe(true);

        await closeWorkspace(rootD);
        const idx = mocks.registered.findIndex((w) => w.path === rootD);
        mocks.registered.splice(idx, 1); // deregister — this board no longer exists on the engine.
        try {
          // rootsProbe is cached per-connection and settled from the first call — without
          // revalidating its resolved Workspace against the live registry, this second request
          // would still dispatch as binding: 'session' against the torn-down Workspace.
          const second = await boardConfig(client);
          expect(second.binding).toBe('default-fallback');
        } finally {
          mocks.registered.push({ path: rootD }); // restore for any later test.
        }
      } finally {
        await client.close().catch(() => {});
      }
    });
  });

  describe('FLUX-1781: a lost binding is disclosed loudly (fallback for clients with no `roots`)', () => {
    it('a fresh unrouted connection sees the notice as the LAST content block, once — then never again for that session', async () => {
      // Force a fresh, deterministic loss: bind a throwaway session, then close its transport.
      const lostClient = await connectClient(undefined, 'to-be-lost-mirrored');
      const boundAway = await callTool(lostClient, 'bind_workspace', { path: rootA });
      expect(boundAway.isError).not.toBe(true);
      await lostClient.close();

      const client = await connectClient(undefined, 'warned-mirrored');
      try {
        const first = await callTool(client, 'get_board_config');
        const content = first.content as { type: string; text: string }[];
        expect(content.length).toBeGreaterThan(0);
        expect(content[content.length - 1]?.text).toContain('Binding notice');
        expect(content[content.length - 1]?.text).toContain('bind_workspace');
        // The structured-content mirror is still parseable at content[0] for a non-structured client.
        expect(() => JSON.parse(content[0]?.text ?? '')).not.toThrow();
        expect(first.structuredContent).toBeTruthy();

        const second = await callTool(client, 'get_board_config');
        const content2 = second.content as { type: string; text: string }[];
        expect(content2.some((c) => c.text.includes('Binding notice'))).toBe(false);
      } finally {
        await client.close().catch(() => {});
      }
    });

    it('a structured-content client (name containing "claude") sees the notice as its ONLY content block, structuredContent unchanged', async () => {
      const lostClient = await connectClient(undefined, 'to-be-lost-structured');
      const boundAway = await callTool(lostClient, 'bind_workspace', { path: rootB });
      expect(boundAway.isError).not.toBe(true);
      await lostClient.close();

      const transport = new StreamableHTTPClientTransport(baseUrl);
      const client = new Client({ name: 'claude-code-flux-1781-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport as Transport);
      try {
        const res = await callTool(client, 'get_board_config');
        const content = res.content as { type: string; text: string }[];
        expect(content.length).toBe(1);
        expect(content[0]?.text).toContain('Binding notice');
        expect(res.structuredContent).toBeTruthy();
        expect((res.structuredContent as { binding?: string }).binding).toBe('default-fallback');
      } finally {
        await client.close().catch(() => {});
      }
    });
  });
});

// FLUX-1554: Furnace multi-workspace hardening. Two live boards (A ambient/default, B a second
// registered board) sharing one engine process must never bleed into each other:
//   - the furnace-store cache/persist is per-root, not split-brain (A's ambient activity must not
//     redirect a B-owned batch's sidecar, and A's first touch must not permanently blind the cache
//     to B's directory);
//   - ignite/trigger/board-write/`gh` cwd all bind to the BATCH's own root, not whichever board is
//     ambiently active or made the request;
//   - the MCP/REST surface refuses to read or mutate another board's batch by bare id.
//
// `git-exec.js` and `task-store.js`'s `updateTaskWithHistory` are mocked (real fetch/file I/O would
// make these tests slow and unrelated to the routing bug); `furnace-store.ts`'s real `atomicWriteFile`
// persistence is left REAL so the split-brain assertions read genuine sidecar files on disk.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const runGh = vi.fn(async (_args: string[], _opts?: { cwd?: string }) => ({ stdout: '', stderr: '' }));
vi.mock('./git-exec.js', () => ({
  runGh: (args: string[], opts?: { cwd?: string }) => runGh(args, opts),
  runGit: vi.fn(),
}));

const reclaimReadyWorktrees = vi.fn(async (_root: string) => [] as string[]);
vi.mock('./pr-cleanup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pr-cleanup.js')>();
  return { ...actual, reclaimReadyWorktrees: (root: string) => reclaimReadyWorktrees(root) };
});

// Mirrors temper-gate-multi-workspace.test.ts's convention: apply board writes into the REAL
// per-workspace `tasks` cache honoring the explicit `ws` argument, without real file I/O — the point
// of these tests is exactly that explicit `ws` threading (or self-binding via `runWithWorkspace`), so
// the mock must not silently collapse it back to the ambient workspace.
vi.mock('./task-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-store.js')>();
  const { getWorkspace: getWs } = await import('./workspace-context.js');
  const updateTaskWithHistory = vi.fn(async (
    taskId: string,
    options: { extraFields?: Record<string, unknown>; deleteFields?: string[]; nextStatus?: string },
    ws?: unknown,
  ) => {
    const target = (ws as { tasks: Record<string, Record<string, unknown>> } | undefined) ?? getWs();
    const t = target.tasks[taskId];
    if (!t) return true;
    if (options.extraFields) Object.assign(t, options.extraFields);
    if (options.deleteFields) for (const f of options.deleteFields) delete t[f];
    if (options.nextStatus) t.status = options.nextStatus;
    return true;
  });
  return { ...actual, updateTaskWithHistory };
});

import { setWorkspaceRoot } from './workspace.js';
import { openWorkspace, closeWorkspace, getDefaultWorkspace, runWithWorkspace, type Workspace } from './workspace-context.js';
import { attachWorkspace, workspaceScope, requireWorkspace } from './middleware.js';
import furnaceRouter from './routes/furnace.js';
import { handleMcpHttpRequest } from './mcp-server.js';
import {
  createFurnaceBatch,
  updateFurnaceBatch,
  mutateFurnaceBatch,
  getFurnaceBatch,
  ensureFurnaceLoaded,
  __resetFurnaceStoreForTests,
} from './furnace-store.js';
import { checkTriggers, dismissTicketFlag } from './furnace-stoker.js';
import { newBatchTicket } from './models/furnace.js';

interface ToolCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('Furnace multi-workspace hardening (FLUX-1554)', () => {
  let rootA: string;
  let rootB: string;
  let wsA: Workspace;
  let wsB: Workspace;

  beforeEach(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-mw-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-furnace-mw-b-'));
    await fs.mkdir(path.join(rootA, '.flux'), { recursive: true });
    await fs.mkdir(path.join(rootB, '.flux'), { recursive: true });
    setWorkspaceRoot(rootA); // binds defaultWorkspace to A (matches production boot) — A is "ambient".
    wsA = getDefaultWorkspace();
    wsB = openWorkspace(rootB); // registers + activates a second live board.
    for (const k of Object.keys(wsA.tasks)) delete wsA.tasks[k];
    for (const k of Object.keys(wsB.tasks)) delete wsB.tasks[k];
    __resetFurnaceStoreForTests();
    runGh.mockClear();
    reclaimReadyWorktrees.mockClear();
    // Stub ONLY the ticket-spawn call (feedCoal → dispatchSession's `/cli-session/start` POST) so it
    // never makes a real network call — without this it would either hang on a real round-trip (the
    // exact source of a flaky cross-test timing race) or, worse, hit this machine's actual live engine
    // (see CLAUDE.md's "never touch the live engine" rule). Every other URL (this file's own local test
    // servers, the MCP SDK's HTTP transport) passes through to the real `fetch` untouched — mirrors
    // furnace-integration.test.ts's `fetchMock`. No test here asserts on a successful spawn.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if (!/\/cli-session\/start$/.test(String(url))) return realFetch(url as RequestInfo, init);
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'Task not found' }),
      } as Response;
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (wsB.root) await closeWorkspace(wsB.root);
    await fs.rm(rootA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(rootB, { recursive: true, force: true }).catch(() => {});
  });

  describe('store split-brain', () => {
    it('a batch created on B and mutated while A is ambient persists ONLY under Bs furnace-batches dir', async () => {
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B batch', workspaceRoot: wsB.root! }));
      const sidecarB = path.join(rootB, '.flux', 'furnace-batches', `${batch.id}.json`);
      const sidecarA = path.join(rootA, '.flux', 'furnace-batches', `${batch.id}.json`);
      expect(existsSync(sidecarB)).toBe(true);
      expect(existsSync(sidecarA)).toBe(false);

      // Ambient is STILL A here (no runWithWorkspace) — this is the split-brain scenario: mutating a
      // B-owned batch while A is the "active" board.
      await updateFurnaceBatch(batch.id, { title: 'B batch renamed' });
      expect(existsSync(sidecarA)).toBe(false); // never spilled into A's dir
      const raw = JSON.parse(await fs.readFile(sidecarB, 'utf-8')) as { title: string };
      expect(raw.title).toBe('B batch renamed');
    });

    it('reboot: each board loads only its OWN directory — no stale reload, no cross-board bleed', async () => {
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B batch', workspaceRoot: wsB.root! }));
      await updateFurnaceBatch(batch.id, { title: 'B batch v2' }); // mutated while A is ambient

      __resetFurnaceStoreForTests(); // simulate an engine restart — cache wiped, nothing loaded yet
      await ensureFurnaceLoaded(); // ambient is A — loads A's (empty) dir only
      expect(getFurnaceBatch(batch.id)).toBeUndefined(); // B's batch is NOT visible from A's first touch

      await runWithWorkspace(wsB, () => ensureFurnaceLoaded()); // B's own first touch
      expect(getFurnaceBatch(batch.id)?.title).toBe('B batch v2'); // reloads the LAST mutation, not stale
    });
  });

  describe('board writes land on the owning board', () => {
    it('dismissTicketFlag clears the flag on the BATCHs own board even though A is ambient — same-id ticket on A is untouched', async () => {
      // Same bare ticket id on both boards — the exact cross-board collision this fix prevents.
      wsA.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'A ticket', status: 'Require Input', swimlane: 'require-input' };
      wsB.tasks['FLUX-1'] = { id: 'FLUX-1', title: 'B ticket', status: 'Require Input', swimlane: 'require-input' };

      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
        title: 'B batch', tickets: [newBatchTicket('FLUX-1', 0)], workspaceRoot: wsB.root!,
      }));

      // Ambient stays A — proves `dismissTicketFlag` self-binds to the batch's own board rather than
      // relying on the caller to have bound it.
      const res = await dismissTicketFlag(batch.id, 'FLUX-1');
      expect(res.ok).toBe(true);

      expect(wsB.tasks['FLUX-1']?.swimlane).toBeNull();
      expect(wsA.tasks['FLUX-1']?.swimlane).toBe('require-input'); // A's same-id ticket is untouched
    });
  });

  describe('ignite / trigger bind the batchs own root', () => {
    it('igniteBatch (via a satisfied trigger) resolves the worktree pool against Bs root while A is ambient', async () => {
      const upstream = await runWithWorkspace(wsB, () => createFurnaceBatch({
        title: 'upstream', kind: 'parallel', tickets: [newBatchTicket('U1', 0)], workspaceRoot: wsB.root!,
      }));
      await mutateFurnaceBatch(upstream.id, (b) => {
        b.status = 'done';
        b.prs = [{ url: 'https://github.com/o/r/pull/1', branch: 'flux/u1', ticketId: 'U1', reviewState: 'merged' }];
      });
      const draft = await runWithWorkspace(wsB, () => createFurnaceBatch({
        title: 'triggered', kind: 'parallel', tickets: [newBatchTicket('T1', 0)],
        trigger: { type: 'pr', ref: 'https://github.com/o/r/pull/1' }, workspaceRoot: wsB.root!,
      }));

      await checkTriggers(); // called unbound, exactly like the real background loop's tick
      // igniteBatch fires its post-claim kick tick unawaited (`void stokerTick(id)`, matching production
      // — "don't wait for the next interval"); flush it out before this test's own teardown closes `wsB`,
      // so it can't race the NEXT test's `beforeEach` remounting the shared default-workspace singleton.
      await new Promise((resolve) => setImmediate(resolve));

      expect(getFurnaceBatch(draft.id)?.status).toBe('burning');
      // The worktree reclaim inside igniteBatch resolved `requireWorkspaceRoot()` to B's root, not A's
      // (the ambient board at the moment checkTriggers ran) — the exact misroute this ticket fixes.
      expect(reclaimReadyWorktrees).toHaveBeenCalledWith(wsB.root);
      expect(reclaimReadyWorktrees).not.toHaveBeenCalledWith(wsA.root);
    });

    it('a pr-type trigger only matches a PR on the batchs OWN board — a same-url PR that only exists on A does not satisfy Bs trigger', async () => {
      const prUrl = 'https://github.com/o/r/pull/2';
      const upstreamOnA = await runWithWorkspace(wsA, () => createFurnaceBatch({
        title: 'upstream on A', kind: 'parallel', tickets: [newBatchTicket('A1', 0)],
      }));
      await mutateFurnaceBatch(upstreamOnA.id, (b) => {
        b.status = 'done';
        b.prs = [{ url: prUrl, branch: 'flux/a1', ticketId: 'A1', reviewState: 'merged' }];
      });
      const draftOnB = await runWithWorkspace(wsB, () => createFurnaceBatch({
        title: 'triggered on B', kind: 'parallel', tickets: [newBatchTicket('B1', 0)],
        trigger: { type: 'pr', ref: prUrl }, workspaceRoot: wsB.root!,
      }));

      await checkTriggers();

      expect(getFurnaceBatch(draftOnB.id)?.status).toBe('draft'); // must NOT auto-ignite off board A's PR
    });
  });

  describe('gh() cwd binds to the batchs own board (POST /:id/merge)', () => {
    it('merges in Bs checkout even when the request is bound to board A', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/furnace', attachWorkspace, workspaceScope, requireWorkspace, furnaceRouter);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
          title: 'merge me', kind: 'parallel', tickets: [newBatchTicket('M1', 0)], workspaceRoot: wsB.root!,
        }));
        await mutateFurnaceBatch(batch.id, (b) => {
          b.prs = [{ url: 'https://github.com/o/r/pull/9', branch: 'flux/m1', ticketId: 'M1', reviewState: 'approved' }];
        });

        // Request bound to board B — the batch's OWN board. (Pre-FLUX-1567 this test bound the request
        // to board A instead, to prove the internal `gh` cwd rebind ran against the batch's own root
        // regardless of which board issued the request; FLUX-1567's ownership gate now refuses a
        // cross-board request before it ever reaches that rebind — see the "refuses cross-board access"
        // describe block below for that refusal, incl. this exact merge route.)
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-EH-Workspace': wsB.root! },
          body: '{}',
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { merged: string[] };
        expect(body.merged).toEqual(['flux/m1']);

        const cwds = runGh.mock.calls.map(([, opts]) => (opts as { cwd?: string } | undefined)?.cwd);
        expect(cwds).toContain(wsB.root); // gh ran in the batch's OWN repo
        expect(cwds).not.toContain(wsA.root); // never in the ambient default board
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('REST by-id routes refuse cross-board access (FLUX-1567)', () => {
    async function withServer(fn: (baseUrl: string) => Promise<void>): Promise<void> {
      const app = express();
      app.use(express.json());
      app.use('/api/furnace', attachWorkspace, workspaceScope, requireWorkspace, furnaceRouter);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      try {
        await fn(`http://127.0.0.1:${port}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    it('GET /api/furnace/:id from board A on board Bs batch -> 404', async () => {
      await withServer(async (baseUrl) => {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, { headers: { 'X-EH-Workspace': wsA.root! } });
        expect(res.status).toBe(404);
      });
    });

    it('PUT /api/furnace/:id from board A on board Bs batch -> 404, batch unchanged', async () => {
      await withServer(async (baseUrl) => {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-EH-Workspace': wsA.root! },
          body: JSON.stringify({ title: 'hijacked' }),
        });
        expect(res.status).toBe(404);
        expect(getFurnaceBatch(batch.id)?.title).toBe('B only');
      });
    });

    it('DELETE /api/furnace/:id from board A on board Bs batch -> 404, batch not deleted', async () => {
      await withServer(async (baseUrl) => {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}`, { method: 'DELETE', headers: { 'X-EH-Workspace': wsA.root! } });
        expect(res.status).toBe(404);
        expect(getFurnaceBatch(batch.id)).toBeDefined();
      });
    });

    it('POST /api/furnace/:id/ignite from board A on board Bs batch -> 404, batch not ignited', async () => {
      await withServer(async (baseUrl) => {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
          title: 'B only', kind: 'parallel', tickets: [newBatchTicket('B1', 0)], workspaceRoot: wsB.root!,
        }));
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/ignite`, { method: 'POST', headers: { 'X-EH-Workspace': wsA.root! } });
        expect(res.status).toBe(404);
        expect(getFurnaceBatch(batch.id)?.status).toBe('draft');
      });
    });

    it('POST /api/furnace/:id/merge from board A on board Bs batch -> 404, gh never runs', async () => {
      await withServer(async (baseUrl) => {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
          title: 'B only', kind: 'parallel', tickets: [newBatchTicket('M1', 0)], workspaceRoot: wsB.root!,
        }));
        await mutateFurnaceBatch(batch.id, (b) => {
          b.prs = [{ url: 'https://github.com/o/r/pull/9', branch: 'flux/m1', ticketId: 'M1', reviewState: 'approved' }];
        });
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-EH-Workspace': wsA.root! },
          body: '{}',
        });
        expect(res.status).toBe(404);
        expect(runGh).not.toHaveBeenCalled();
      });
    });

    it('POST /api/furnace/:id/tickets/:ticketId/retry from board A on board Bs batch -> 404', async () => {
      await withServer(async (baseUrl) => {
        const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
          title: 'B only', kind: 'parallel', tickets: [newBatchTicket('B1', 0)], workspaceRoot: wsB.root!,
        }));
        const res = await fetch(`${baseUrl}/api/furnace/${batch.id}/tickets/B1/retry`, { method: 'POST', headers: { 'X-EH-Workspace': wsA.root! } });
        expect(res.status).toBe(404);
      });
    });
  });

  describe('REST GET /api/furnace is scoped to the bound board', () => {
    it('a request bound to A never lists Bs batches', async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/furnace', attachWorkspace, workspaceScope, requireWorkspace, furnaceRouter);
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        await runWithWorkspace(wsA, () => createFurnaceBatch({ title: 'A only' }));
        await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));

        const res = await fetch(`${baseUrl}/api/furnace`, { headers: { 'X-EH-Workspace': wsA.root! } });
        expect(res.status).toBe(200);
        const batches = (await res.json()) as { title: string }[];
        expect(batches.map((b) => b.title)).toEqual(['A only']);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('MCP ownership — a connection bound to one board cannot act on the others batch by id', () => {
    let mcpServer: http.Server;
    let mcpBaseUrl: URL;

    beforeEach(async () => {
      mcpServer = http.createServer((req, res) => {
        handleMcpHttpRequest(req, res).catch((err: unknown) => {
          res.statusCode = 500;
          res.end(String(err));
        });
      });
      await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
      const { port } = mcpServer.address() as AddressInfo;
      mcpBaseUrl = new URL(`http://127.0.0.1:${port}/mcp`);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    });

    async function connectClient(workspaceRoot: string, label: string): Promise<Client> {
      const transport = new StreamableHTTPClientTransport(mcpBaseUrl, { requestInit: { headers: { 'x-eh-workspace': workspaceRoot } } });
      const client = new Client({ name: `eh-furnace-mw-${label}`, version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport as Transport);
      return client;
    }

    async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
    }

    function textOf(res: ToolCallResult): string | undefined {
      const first = res.content?.[0];
      return first && first.type === 'text' ? first.text : undefined;
    }

    it('furnace_get(batchId) from board A refuses board Bs batch as not_found', async () => {
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
      const clientA = await connectClient(wsA.root!, 'A');
      try {
        const res = await callTool(clientA, 'furnace_get', { batchId: batch.id });
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.code).toBe('not_found');
      } finally {
        await clientA.close().catch(() => {});
      }
    });

    it('furnace_get() list from board A never includes board Bs batches', async () => {
      await runWithWorkspace(wsA, () => createFurnaceBatch({ title: 'A only' }));
      await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
      const clientA = await connectClient(wsA.root!, 'A');
      try {
        const res = await callTool(clientA, 'furnace_get', {});
        const text = textOf(res);
        expect(text).toBeTruthy();
        const body = JSON.parse(text!) as { batches: { title: string }[] };
        expect(body.batches.map((b) => b.title)).toEqual(['A only']);
      } finally {
        await clientA.close().catch(() => {});
      }
    });

    it('furnace_update from board A refuses to mutate board Bs batch', async () => {
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
      const clientA = await connectClient(wsA.root!, 'A');
      try {
        const res = await callTool(clientA, 'furnace_update', { batchId: batch.id, title: 'Hijacked' });
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.code).toBe('not_found');
        expect(getFurnaceBatch(batch.id)?.title).toBe('B only');
      } finally {
        await clientA.close().catch(() => {});
      }
    });

    it('furnace_batch action:"ignite" from board A refuses to ignite board Bs batch', async () => {
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
        title: 'B only', tickets: [newBatchTicket('B1', 0)], workspaceRoot: wsB.root!,
      }));
      const clientA = await connectClient(wsA.root!, 'A');
      try {
        const res = await callTool(clientA, 'furnace_batch', { action: 'ignite', batchId: batch.id });
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.code).toBe('not_found');
        expect(getFurnaceBatch(batch.id)?.status).toBe('draft'); // never ignited
      } finally {
        await clientA.close().catch(() => {});
      }
    });

    it('furnace_ticket action:"retry" from board A refuses to act on board Bs ticket', async () => {
      wsB.tasks['FLUX-9'] = { id: 'FLUX-9', title: 'B ticket', status: 'Todo' };
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({
        title: 'B only', tickets: [newBatchTicket('FLUX-9', 0)], workspaceRoot: wsB.root!,
      }));
      await mutateFurnaceBatch(batch.id, (b) => {
        const t = b.tickets.find((x) => x.ticketId === 'FLUX-9');
        if (t) t.state = 'failed';
      });
      const clientA = await connectClient(wsA.root!, 'A');
      try {
        const res = await callTool(clientA, 'furnace_ticket', { action: 'retry', batchId: batch.id, ticketId: 'FLUX-9' });
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.code).toBe('not_found');
      } finally {
        await clientA.close().catch(() => {});
      }
    });

    it('a connection bound to board B can read its own batch normally', async () => {
      const batch = await runWithWorkspace(wsB, () => createFurnaceBatch({ title: 'B only', workspaceRoot: wsB.root! }));
      const clientB = await connectClient(wsB.root!, 'B');
      try {
        const res = await callTool(clientB, 'furnace_get', { batchId: batch.id });
        expect(res.isError).toBeFalsy();
      } finally {
        await clientB.close().catch(() => {});
      }
    });
  });
});

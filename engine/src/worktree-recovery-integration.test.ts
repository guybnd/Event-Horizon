// FLUX-1644: assembled-caller coverage for the worktree husk-recovery routing. task-worktree.test.ts
// proves `createTaskWorktree`/`resolveTaskWorktreePath` in isolation; THIS file proves the five
// lifecycle callers that were switched from `taskWorktreeDir` to `resolveTaskWorktreePath` — REST
// branch status/delete, ticket delete, manual worktree detach, and the MCP `branch` tool's
// delete action — actually resolve to a registered `-r2` recovery worktree instead of the
// canonical husk when both exist, and never select an external (non-`.eh-worktrees`) checkout.
//
// Pattern: real Express app + real HTTP server mounting the REAL tasks router (mirrors the REST
// half of status-transition-service.test.ts's "REST PUT ↔ MCP parity" harness), plus a real
// in-memory MCP client/server pair (same harness) — combined with a REAL git repo (mirrors
// task-worktree.test.ts's gitInit/makeParent helpers), since this suite needs actual git worktrees
// on disk, not just ticket files.
import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { requireWorkspace } from './middleware.js';
import { taskWorktreeDir, createTaskWorktree } from './task-worktree.js';

const execFileAsync = promisify(execFile);

// Real git worktree ops are slow on Windows under parallel suite load (mirrors task-worktree.test.ts).
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

function isCallToolResult(x: unknown): x is CallToolResult {
  return !!x && typeof x === 'object' && 'content' in x;
}

describe('worktree husk-recovery routing — assembled callers (FLUX-1644)', () => {
  let parent: string;
  let repo: string;
  let fluxDir: string;
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-wt-recovery-'));
    repo = path.join(parent, 'EventHorizon');
    await fs.mkdir(repo, { recursive: true });
    await execFileAsync('git', ['-C', repo, 'init', '-b', 'master'], { windowsHide: true });
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@test.com'], { windowsHide: true });
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test'], { windowsHide: true });
    await fs.writeFile(path.join(repo, 'README.md'), '# test\n', 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', '.'], { windowsHide: true });
    await execFileAsync('git', ['-C', repo, 'commit', '-m', 'init'], { windowsHide: true });

    fluxDir = path.join(repo, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(repo);

    server = buildMcpServer();
    client = new Client({ name: 'eh-worktree-recovery-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { default: tasksRouter } = await import('./routes/tasks.js');
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', requireWorkspace, tasksRouter);
    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  /** Seed a ticket to both the disk `.flux/<id>.md` and the live cache, mirroring
   *  status-transition-service.test.ts's `seedTask`. */
  async function seedTicket(id: string, branch: string) {
    const frontmatter = {
      id,
      title: `worktree recovery ${id}`,
      status: 'In Progress',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      branch,
      history: [] as unknown[],
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTicket(id: string) {
    delete getWorkspace().tasks[id];
  }

  /** Build the FLUX-1644 fixture: a non-empty, unregistered, unrepairable canonical husk at
   *  `<repo>-<id>`, plus a REAL registered `<repo>-<id>-r2` worktree checked out on `branch`.
   *  Goes through the real `createTaskWorktree` (rather than a raw `git worktree add`) so its
   *  cache-invalidation runs exactly as it would in production — a raw out-of-band `git worktree
   *  add` would leave `resolveTaskWorktreePath`'s short-TTL registered-worktree read cache
   *  (task-worktree.ts's `listWorktreesCached`) stale for up to 3s, which the assembled callers
   *  under test here would never actually observe in practice (every production caller that
   *  creates a worktree does so through `createTaskWorktree`, which invalidates that same cache
   *  on the way out). */
  async function makeHuskAndRecoveryFixture(id: string, branch: string): Promise<{ canonical: string; recovery: string }> {
    const canonical = taskWorktreeDir(repo, id);
    await fs.mkdir(canonical, { recursive: true });
    await fs.writeFile(path.join(canonical, 'leftover.txt'), 'un-pushed work\n', 'utf8');
    const recovery = await createTaskWorktree(repo, id, branch);
    if (path.resolve(recovery) !== path.resolve(`${canonical}-r2`)) {
      throw new Error(`fixture setup expected the husk to route to -r2, got: ${recovery}`);
    }
    return { canonical, recovery };
  }

  it('GET /:id/branch reports the registered `-r2` recovery worktree, not the canonical husk', async () => {
    const id = 'WTR-1';
    const branch = 'flux/wtr-1';
    const { canonical, recovery } = await makeHuskAndRecoveryFixture(id, branch);
    await seedTicket(id, branch);
    try {
      const res = await fetch(`${baseUrl}/api/tasks/${id}/branch`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { worktree: string | null };
      expect(body.worktree).not.toBeNull();
      expect(path.resolve(body.worktree!)).toBe(path.resolve(recovery));
      expect(existsSync(canonical)).toBe(true); // husk untouched
    } finally {
      dropTicket(id);
    }
  });

  it('DELETE /:id/branch (force) detaches the `-r2` recovery worktree, leaving the canonical husk untouched', async () => {
    const id = 'WTR-2';
    const branch = 'flux/wtr-2';
    const { canonical, recovery } = await makeHuskAndRecoveryFixture(id, branch);
    await seedTicket(id, branch);
    try {
      const res = await fetch(`${baseUrl}/api/tasks/${id}/branch`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      expect(res.status).toBe(200);
      expect(existsSync(recovery)).toBe(false);
      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(path.join(canonical, 'leftover.txt'))).toBe(true);
    } finally {
      dropTicket(id);
    }
  });

  it('DELETE /:id (ticket delete) detaches the `-r2` recovery worktree, leaving the canonical husk untouched', async () => {
    const id = 'WTR-3';
    const branch = 'flux/wtr-3';
    const { canonical, recovery } = await makeHuskAndRecoveryFixture(id, branch);
    await seedTicket(id, branch);
    try {
      const res = await fetch(`${baseUrl}/api/tasks/${id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(existsSync(recovery)).toBe(false);
      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(path.join(canonical, 'leftover.txt'))).toBe(true);
      expect(getWorkspace().tasks[id]).toBeUndefined();
    } finally {
      dropTicket(id);
    }
  });

  it('POST /:id/worktree/detach detaches the `-r2` recovery worktree specifically (not a 404 against the missing canonical path)', async () => {
    const id = 'WTR-4';
    const branch = 'flux/wtr-4';
    const { canonical, recovery } = await makeHuskAndRecoveryFixture(id, branch);
    await seedTicket(id, branch);
    try {
      const res = await fetch(`${baseUrl}/api/tasks/${id}/worktree/detach`, { method: 'POST' });
      expect(res.status).toBe(200); // NOT 404 — a 404 would mean it resolved to the absent canonical path
      expect(existsSync(recovery)).toBe(false);
      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(path.join(canonical, 'leftover.txt'))).toBe(true);
    } finally {
      dropTicket(id);
    }
  });

  it('MCP branch({action:"delete", force:true}) detaches the `-r2` recovery worktree, leaving the canonical husk untouched', async () => {
    const id = 'WTR-5';
    const branch = 'flux/wtr-5';
    const { canonical, recovery } = await makeHuskAndRecoveryFixture(id, branch);
    await seedTicket(id, branch);
    try {
      const result = await callTool({ name: 'branch', arguments: { ticketId: id, action: 'delete', force: true } });
      expect(result.isError).toBeFalsy();
      expect(existsSync(recovery)).toBe(false);
      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(path.join(canonical, 'leftover.txt'))).toBe(true);
    } finally {
      dropTicket(id);
    }
  });

  it('never selects or detaches an EXTERNAL checkout (outside .eh-worktrees/) on the ticket\'s branch', async () => {
    const id = 'WTR-6';
    const branch = 'flux/wtr-6';
    // An external, non-EH-managed checkout of the branch — no `.eh-worktrees` entry for this
    // ticket at all, so resolveTaskWorktreePath must fall back to the (nonexistent) canonical path
    // rather than ever discovering/touching this external tree.
    const external = path.join(parent, 'manual-checkout-wtr-6');
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', branch, external], { windowsHide: true });
    await seedTicket(id, branch);
    try {
      const statusRes = await fetch(`${baseUrl}/api/tasks/${id}/branch`);
      const statusBody = (await statusRes.json()) as { worktree: string | null };
      expect(statusBody.worktree).toBeNull(); // no owned/registered EH worktree — canonical doesn't exist

      const detachRes = await fetch(`${baseUrl}/api/tasks/${id}/worktree/detach`, { method: 'POST' });
      expect(detachRes.status).toBe(404); // "No worktree for this ticket" — never the external tree

      const deleteRes = await fetch(`${baseUrl}/api/tasks/${id}/branch`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      expect(deleteRes.status).toBe(200);

      // The external checkout survives every single operation above, completely untouched.
      expect(existsSync(external)).toBe(true);
      const { stdout } = await execFileAsync('git', ['-C', external, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true });
      expect(stdout.trim()).toBe(branch);
    } finally {
      dropTicket(id);
      await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', external], { windowsHide: true }).catch(() => {});
    }
  });
});

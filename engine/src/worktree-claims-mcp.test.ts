// FLUX-1771: functional MCP-tool coverage for the worktree claim — over the real buildMcpServer()
// + InMemoryTransport round-trip (background-process-holds-mcp.test.ts's pattern). InMemoryTransport
// bypasses HTTP entirely, so `getVerifiedSessionId()` falls back to `process.env.EH_SESSION_ID`/
// `EH_SESSION_TOKEN` (the same fallback the stdio `--mcp` path uses) — unset, this simulates exactly
// the non-EH chat session this ticket exists to protect (no verified session id).
//
// Real git repo via the shared git-fixture helper (per CLAUDE.md convention) — `branch(action:'create')`
// with `worktree:true` performs a genuine `git worktree add`, so a mocked workspace can't exercise it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { createTask } from './task-store.js';
import { signConversation } from './session-binding.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createGitFixture, git } from './test-helpers/git-fixture.js';
import { getClaim, __resetWorktreeClaimsForTest } from './worktree-claims.js';

const execFileAsync = promisify(execFile);

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

interface ToolCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('worktree claim — MCP tool coverage (FLUX-1771)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let parent: string;
  let repo: string;

  beforeAll(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-wtclaim-mcp-'));
    repo = path.join(parent, 'EventHorizon');
    await createGitFixture({ dest: repo });
    // `branch(action:'create')` pushes the new branch to `origin` (ensureTicketIsolation's default)
    // — createGitFixture deliberately strips the clone's origin (mirrors a bare `git init`), so give
    // it a real bare remote here, same pattern as branch-manager.test.ts.
    const origin = path.join(parent, 'origin.git');
    await execFileAsync('git', ['init', '--bare', origin], { windowsHide: true });
    await git(repo, ['remote', 'add', 'origin', origin]);
    await git(repo, ['push', '-u', 'origin', 'master']);
    await fs.mkdir(path.join(repo, '.flux'), { recursive: true });
    setWorkspaceRoot(repo);

    server = buildMcpServer();
    client = new Client({ name: 'eh-worktree-claim-mcp-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
  });

  // DEFAULT_MAX_TASK_WORKTREES = 4 — each test's worktree(s) must be torn down before the next
  // test runs, or the suite would exhaust the board-wide cap partway through.
  let branchedTicketIds: string[];

  beforeEach(() => {
    __resetWorktreeClaimsForTest();
    branchedTicketIds = [];
  });

  afterEach(async () => {
    for (const id of branchedTicketIds) {
      await callTool('branch', { ticketId: id, action: 'delete', force: true }).catch(() => {});
    }
    bindSession(undefined);
  });

  function bindSession(sessionId: string | undefined): void {
    if (!sessionId) {
      delete process.env.EH_SESSION_ID;
      delete process.env.EH_SESSION_TOKEN;
      return;
    }
    process.env.EH_SESSION_ID = sessionId;
    process.env.EH_SESSION_TOKEN = signConversation(sessionId);
  }

  async function callTool(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    return (await client.callTool({ name, arguments: input })) as unknown as ToolCallResult;
  }

  it('branch(action:create) from a connection with NO verified EH session opens a claim', async () => {
    bindSession(undefined);
    const ticket = await createTask({ title: 'Chat-created branch', status: 'In Progress' });
    const res = await callTool('branch', { ticketId: ticket.id, action: 'create' });
    expect(res.isError).toBeFalsy();
    branchedTicketIds.push(ticket.id);
    const claim = getClaim(repo, ticket.id);
    expect(claim).toBeDefined();
    expect(claim?.worktreePath).toBeTruthy();
  });

  it('branch(action:create) from an EH-DISPATCHED session (verified id) opens no claim — already covered by hasLiveSessionOnBranch', async () => {
    bindSession('verified-sess-a');
    const ticket = await createTask({ title: 'Dispatched branch', status: 'In Progress' });
    const res = await callTool('branch', { ticketId: ticket.id, action: 'create' });
    expect(res.isError).toBeFalsy();
    branchedTicketIds.push(ticket.id);
    expect(getClaim(repo, ticket.id)).toBeUndefined();
  });

  it('a subsequent EH tool call naming the claimed ticket renews it; an unrelated ticket does not', async () => {
    bindSession(undefined);
    const ticket = await createTask({ title: 'Renewed by heartbeat', status: 'In Progress' });
    const other = await createTask({ title: 'Unrelated ticket', status: 'In Progress' });
    await callTool('branch', { ticketId: ticket.id, action: 'create' });
    branchedTicketIds.push(ticket.id);
    const before = getClaim(repo, ticket.id)?.expiresAt;
    expect(before).toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 20)); // ensure a distinguishable timestamp
    await callTool('get_ticket', { ticketId: other.id });
    expect(getClaim(repo, ticket.id)?.expiresAt).toBe(before); // unrelated ticket: no renewal

    await callTool('get_ticket', { ticketId: ticket.id });
    const after = getClaim(repo, ticket.id)?.expiresAt;
    expect(after).toBeTruthy();
    expect(Date.parse(after as string)).toBeGreaterThan(Date.parse(before as string));
  });

  it('a tool call with no ticketId in its arguments does not throw and renews nothing', async () => {
    bindSession(undefined);
    const ticket = await createTask({ title: 'No-op heartbeat target', status: 'In Progress' });
    await callTool('branch', { ticketId: ticket.id, action: 'create' });
    branchedTicketIds.push(ticket.id);
    const before = getClaim(repo, ticket.id)?.expiresAt;

    const res = await callTool('list_workspaces', {});
    expect(res.isError).toBeFalsy();
    expect(getClaim(repo, ticket.id)?.expiresAt).toBe(before);
  });

  // FLUX-1778: the leaf tests in worktree-claims.test.ts call releaseClaimsForWorktree/
  // releaseClaimsForBranch/releaseClaim directly with synthetic paths — they verify the string
  // match logic but never exercise the real seam that calls them. These two drive an actual claim
  // through the real teardown paths (branch delete → removeTaskWorktree → releaseClaimsForWorktree;
  // terminal status → task-store's updateTaskWithHistoryLocked → releaseClaim) over the genuine
  // path strings `createTaskWorktree`/`resolveTaskWorktreePath` produce.
  it('branch(action:delete) on a claimed ticket releases the claim (releaseClaimsForWorktree, real path)', async () => {
    bindSession(undefined);
    const ticket = await createTask({ title: 'Claimed then branch-deleted', status: 'In Progress' });
    const createRes = await callTool('branch', { ticketId: ticket.id, action: 'create' });
    expect(createRes.isError).toBeFalsy();
    branchedTicketIds.push(ticket.id);
    expect(getClaim(repo, ticket.id)).toBeDefined();

    const deleteRes = await callTool('branch', { ticketId: ticket.id, action: 'delete', force: true });
    expect(deleteRes.isError).toBeFalsy();
    expect(getClaim(repo, ticket.id)).toBeUndefined();
  });

  it('moving a claimed ticket to a terminal status releases the claim (releaseClaim, real seam)', async () => {
    bindSession(undefined);
    const ticket = await createTask({ title: 'Claimed then completed', status: 'In Progress' });
    const createRes = await callTool('branch', { ticketId: ticket.id, action: 'create' });
    expect(createRes.isError).toBeFalsy();
    branchedTicketIds.push(ticket.id);
    expect(getClaim(repo, ticket.id)).toBeDefined();

    const statusRes = await callTool('change_status', { ticketId: ticket.id, newStatus: 'Done', noDiffExpected: true });
    expect(statusRes.isError).toBeFalsy();
    expect(getClaim(repo, ticket.id)).toBeUndefined();
  });
});

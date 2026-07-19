// FLUX-1569: a single end-to-end test that drives ONE ticket through the whole agent-facing
// lifecycle — Grooming -> Todo -> In Progress -> Ready — via the REAL MCP `change_status` tool
// against a real temp `.flux` board, the way an agent actually does it. Existing suites
// (gate-runner.test.ts, gate-policy.test.ts, status-transition-service.test.ts) cover the
// individual deciders in isolation; none of them walks one ticket through every hop and asserts
// the wiring between stages holds end to end. Deliberately scoped to the BRANCHLESS/no-PR path
// (gates forced to `you`) so it's fast, deterministic, and never touches git/gh — the `finish`/PR/
// Done path is explicitly out of scope (see the ticket body).

import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Belt-and-suspenders: assert the plan-review gate is never actually dispatched, without spawning
// a real review session.
vi.mock('./gate-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./gate-runner.js')>('./gate-runner.js');
  return { ...actual, startPlanGateNow: vi.fn() };
});
// The branchless ticket driven here should never reach the PR-creation surface — mock it so a
// regression that accidentally makes it branch-shaped fails loudly instead of shelling out.
vi.mock('./branch-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./branch-manager.js')>('./branch-manager.js');
  return { ...actual, getTicketBranchStatus: vi.fn(), createPullRequest: vi.fn() };
});
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { getConfig } from './config.js';
import { getTicketBranchStatus, createPullRequest } from './branch-manager.js';
import { startPlanGateNow } from './gate-runner.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

type HistoryEntryLike = Record<string, unknown> & { type?: string; from?: string; to?: string; comment?: string };

describe('Ticket lifecycle integration (Grooming -> Todo -> In Progress -> Ready, no PR)', () => {
  let root: string;
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-lifecycle-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);

    server = buildMcpServer();
    client = new Client({ name: 'eh-lifecycle-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    // Force both gates to `you` — the "no agent/PR involved" path. Also disable the deterministic
    // plan lint (FLUX-1379): it's orthogonal to what this suite verifies (the wiring between
    // stages, not plan-quality heuristics) and would otherwise bounce a minimal test fixture body.
    getConfig().gatePolicy = { boardDefault: { plan: 'you', review: 'you' } };
    getConfig().planLint = false;
    vi.mocked(startPlanGateNow).mockReset();
    vi.mocked(getTicketBranchStatus).mockReset();
    vi.mocked(createPullRequest).mockReset();
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  function resultText(res: CallToolResult): string {
    return (res.content[0] as { text?: string })?.text ?? '';
  }

  function statusChanges(id: string): HistoryEntryLike[] {
    const history = (getWorkspace().tasks[id]?.history ?? []) as HistoryEntryLike[];
    return history.filter((e) => e.type === 'status_change');
  }

  async function createGroomingTicket(title: string): Promise<string> {
    const res = await callTool({
      name: 'create_ticket',
      arguments: {
        title,
        status: 'Grooming',
        effort: 'M',
        body: 'A minimal fixture body — plan lint is disabled for this suite (see beforeEach).',
      },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(resultText(res)) as { id: string };
    expect(parsed.id).toBeTruthy();
    return parsed.id;
  }

  it('drives a branchless ticket through every hop, asserting status + history at each one', async () => {
    const id = await createGroomingTicket('Lifecycle happy path');
    expect(getWorkspace().tasks[id].status).toBe('Grooming');
    expect(getWorkspace().tasks[id].branch).toBeFalsy();

    // Grooming -> Todo: the plan gate must NOT intercept (gate value 'you').
    const toTodo = await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'Todo' } });
    expect(toTodo.isError).toBeFalsy();
    expect(getWorkspace().tasks[id].status).toBe('Todo');
    expect(startPlanGateNow).not.toHaveBeenCalled();
    let moves = statusChanges(id);
    expect(moves.at(-1)).toMatchObject({ from: 'Grooming', to: 'Todo' });

    // Todo -> In Progress: no comment required.
    const toInProgress = await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'In Progress' } });
    expect(toInProgress.isError).toBeFalsy();
    expect(getWorkspace().tasks[id].status).toBe('In Progress');
    moves = statusChanges(id);
    expect(moves.at(-1)).toMatchObject({ from: 'Todo', to: 'In Progress' });

    // In Progress -> Ready: a completion comment IS required, and this branchless ticket must
    // never touch the PR-creation surface.
    const toReady = await callTool({
      name: 'change_status',
      arguments: { ticketId: id, newStatus: 'Ready', comment: 'Implemented and validated; no PR — branchless ticket.' },
    });
    expect(toReady.isError).toBeFalsy();
    expect(getWorkspace().tasks[id].status).toBe('Ready');
    moves = statusChanges(id);
    expect(moves.at(-1)).toMatchObject({ from: 'In Progress', to: 'Ready' });
    const comments = (getWorkspace().tasks[id].history as HistoryEntryLike[]).filter((e) => e.type === 'comment');
    expect(comments.at(-1)?.comment).toContain('branchless ticket');

    // No git/gh/PR side effects at any point in the walk.
    expect(getTicketBranchStatus).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(getWorkspace().tasks[id].implementationLink).toBeFalsy();
  });

  it('refuses -> Ready without a completion comment, leaving status unchanged', async () => {
    const id = await createGroomingTicket('Lifecycle: Ready comment gate');
    await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'Todo' } });
    await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'In Progress' } });

    const res = await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'Ready' } });
    expect(res.isError).toBe(true);
    expect(getWorkspace().tasks[id].status).toBe('In Progress');
    expect(statusChanges(id).some((e) => e.to === 'Ready')).toBe(false);
  });

  it('refuses -> Require Input without a comment (the question), leaving status unchanged', async () => {
    const id = await createGroomingTicket('Lifecycle: Require Input comment gate');
    await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'Todo' } });
    await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'In Progress' } });

    const res = await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'Require Input' } });
    expect(res.isError).toBe(true);
    expect(getWorkspace().tasks[id].status).toBe('In Progress');
    expect(getWorkspace().tasks[id].swimlane).toBeFalsy();

    // With a comment, the SAME move succeeds — it sets the swimlane rather than changing status
    // (Require Input is a swimlane on top of the current status, not a column of its own).
    const ok = await callTool({ name: 'change_status', arguments: { ticketId: id, newStatus: 'Require Input', comment: 'Which flavor do you want?' } });
    expect(ok.isError).toBeFalsy();
    expect(getWorkspace().tasks[id].status).toBe('In Progress');
    expect(getWorkspace().tasks[id].swimlane).toBe('require-input');
  });
});

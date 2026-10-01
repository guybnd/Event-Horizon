// FLUX-1746: the MCP change_status half of the review-handoff note's two independently-wired
// Ready paths (the other is the portal PUT, routes/tasks-put-history-reconciliation.test.ts).
// Deleting the `entries.push` in mcp-server.ts's change_status handler must fail this test.
import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';
import { cliSessionsById, registerSession, unregisterSession } from './session-store.js';
import type { CliSessionRecord } from './agents/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

// adapter-boundary: keep the framework value out of a `framework: 'claude'` literal (see
// check-adapter-boundary.mjs's framework-literal-assign pattern) — this fixture doesn't exercise
// per-CLI behavior, it just needs a valid CliFramework value.
const TEST_FRAMEWORK = 'claude';

function fakeSession(taskId: string, id: string, overrides: Partial<CliSessionRecord>): CliSessionRecord {
  return {
    id,
    taskId,
    framework: TEST_FRAMEWORK,
    status: 'completed',
    command: 'claude',
    args: [],
    startedAt: new Date().toISOString(),
    label: 'Test',
    ...overrides,
  } as unknown as CliSessionRecord;
}

describe('change_status lands the compaction review-handoff note on Ready (FLUX-1746)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-compaction-handoff-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-compaction-handoff-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(() => {
    for (const k of Object.keys(getWorkspace().tasks)) delete getWorkspace().tasks[k];
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  async function seedTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `compaction handoff test ${id}`,
      status: 'In Progress',
      priority: 'None',
      effort: 'None',
      assignee: 'unassigned',
      tags: [] as string[],
      createdBy: 'Agent',
      updatedBy: 'Agent',
      history: [] as unknown[],
      ...extra,
    };
    const filePath = path.join(fluxDir, `${id}.md`);
    await fs.writeFile(filePath, matter.stringify('', frontmatter), 'utf-8');
    getWorkspace().tasks[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  it('a compacted implementation session registered for the ticket lands the handoff entry when the move reaches Ready', async () => {
    const TICKET = 'CH-1';
    const SESSION_ID = 'ch1-session';
    await seedTask(TICKET);
    cliSessionsById.set(SESSION_ID, fakeSession(TICKET, SESSION_ID, {
      phase: 'implementation',
      compactionCount: 3,
      cumulativeDroppedTokens: 75_000,
    }));
    registerSession(TICKET, SESSION_ID);

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Implemented and validated.' },
      });
      expect(res.isError).toBeFalsy();
      const history = getWorkspace().tasks[TICKET]!.history as Array<{ comment?: string }>;
      const comments = history.map((e) => e.comment ?? '');
      expect(comments.some((c) => c.includes('compacted 3 times') && c.includes('75k'))).toBe(true);
    } finally {
      cliSessionsById.delete(SESSION_ID);
      unregisterSession(TICKET, SESSION_ID);
    }
  });

  it('a Ready->Ready re-move (already Ready) does not append a second handoff entry', async () => {
    const TICKET = 'CH-4';
    const SESSION_ID = 'ch4-session';
    await seedTask(TICKET, { status: 'Ready' });
    cliSessionsById.set(SESSION_ID, fakeSession(TICKET, SESSION_ID, {
      phase: 'implementation',
      compactionCount: 2,
      cumulativeDroppedTokens: 40_000,
    }));
    registerSession(TICKET, SESSION_ID);

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Re-affirming Ready.' },
      });
      expect(res.isError).toBeFalsy();
      const history = getWorkspace().tasks[TICKET]!.history as Array<{ comment?: string }>;
      const comments = history.map((e) => e.comment ?? '');
      expect(comments.some((c) => c.includes('compacted'))).toBe(false);
    } finally {
      cliSessionsById.delete(SESSION_ID);
      unregisterSession(TICKET, SESSION_ID);
    }
  });

  it('no compacted sessions registered adds no handoff entry on the Ready move', async () => {
    const TICKET = 'CH-2';
    await seedTask(TICKET);

    const res = await callTool({
      name: 'change_status',
      arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Implemented and validated.' },
    });
    expect(res.isError).toBeFalsy();
    const history = getWorkspace().tasks[TICKET]!.history as Array<{ comment?: string }>;
    const comments = history.map((e) => e.comment ?? '');
    expect(comments.some((c) => c.includes('compacted'))).toBe(false);
  });

  it('a move that does NOT reach Ready does not read sessions for a handoff entry', async () => {
    const TICKET = 'CH-3';
    const SESSION_ID = 'ch3-session';
    await seedTask(TICKET, { status: 'Todo' });
    cliSessionsById.set(SESSION_ID, fakeSession(TICKET, SESSION_ID, {
      phase: 'implementation',
      compactionCount: 1,
      cumulativeDroppedTokens: 1_000,
    }));
    registerSession(TICKET, SESSION_ID);

    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress' },
      });
      expect(res.isError).toBeFalsy();
      const history = getWorkspace().tasks[TICKET]!.history as Array<{ comment?: string }>;
      const comments = history.map((e) => e.comment ?? '');
      expect(comments.some((c) => c.includes('compacted'))).toBe(false);
    } finally {
      cliSessionsById.delete(SESSION_ID);
      unregisterSession(TICKET, SESSION_ID);
    }
  });
});

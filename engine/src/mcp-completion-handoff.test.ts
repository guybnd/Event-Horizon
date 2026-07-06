import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { tasksCache } from './task-store.js';
import { setWorkspaceRoot } from './workspace.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Mirrors the narrowing helper in mcp-action-dispatch.test.ts — `callTool`'s declared return
 *  type is wider than the SDK's own `CallToolResult`. */
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

type HistoryEntryLike = Record<string, unknown> & { type?: string; comment?: string };

/**
 * FLUX-1147: `completion` is an optional structured payload accepted by both `change_status` and
 * `finish_ticket`, persisted as extra fields on the `comment` history entry the transition already
 * writes (never on ticket frontmatter). These round-trip through a real in-memory MCP client/server
 * pair against a real temp-workspace ticket file (mirrors furnace-batch-mcp.test.ts's setup) — a
 * bare in-memory `tasksCache` entry with no `_path` fails at the `updateTaskWithHistory` disk write,
 * not just the schema/handler logic these tests are meant to pin.
 */
describe('completion payload on change_status / finish_ticket (FLUX-1147)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-completion-handoff-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-completion-handoff-'));
    fluxDir = path.join(root, '.flux');
    await fs.mkdir(fluxDir, { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function callTool(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing tool result');
    return res;
  }

  /** Writes a real ticket file (so `updateTaskWithHistory`'s disk write has a valid `_path`) and
   *  seeds `tasksCache` the same way `loadTask`/`createTask` would. */
  async function seedTask(id: string, status: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `completion handoff test ${id}`,
      status,
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
    tasksCache[id] = { ...frontmatter, body: '', id, _path: filePath };
  }

  function dropTask(id: string) {
    delete tasksCache[id];
  }

  it('change_status: persists a valid completion payload on the comment entry, never on frontmatter', async () => {
    const TICKET = 'COMPLETION-CS-1';
    await seedTask(TICKET, 'Todo');
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: {
          ticketId: TICKET,
          newStatus: 'Ready',
          comment: 'Implemented the thing.',
          completion: {
            changedFiles: ['engine/src/foo.ts'],
            validation: [{ command: 'npm run typecheck', passed: true }],
            decisions: ['Used X instead of Y.'],
            residualRisk: 'None.',
          },
        },
      });
      expect(res.isError).toBeFalsy();

      const task = tasksCache[TICKET];
      expect(task.completion).toBeUndefined(); // not a frontmatter field
      const history = task.history as HistoryEntryLike[];
      const commentEntry = history.find((e) => e.type === 'comment');
      expect(commentEntry?.completion).toEqual({
        changedFiles: ['engine/src/foo.ts'],
        validation: [{ command: 'npm run typecheck', passed: true }],
        decisions: ['Used X instead of Y.'],
        residualRisk: 'None.',
      });
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: omitting completion is a fully backward-compatible no-op', async () => {
    const TICKET = 'COMPLETION-CS-2';
    await seedTask(TICKET, 'Todo');
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'In Progress' },
      });
      expect(res.isError).toBeFalsy();
      const history = tasksCache[TICKET].history as HistoryEntryLike[];
      expect(history.some((e) => 'completion' in e)).toBe(false);
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: a garbage completion payload is dropped, never blocking the status move', async () => {
    const TICKET = 'COMPLETION-CS-3';
    await seedTask(TICKET, 'Todo');
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: {
          ticketId: TICKET,
          newStatus: 'Ready',
          comment: 'Done.',
          completion: { changedFiles: 'not-an-array', validation: 12345, residualRisk: { nope: true } },
        },
      });
      expect(res.isError).toBeFalsy();
      const task = tasksCache[TICKET];
      expect(task.status).toBe('Ready');
      const history = task.history as HistoryEntryLike[];
      const commentEntry = history.find((e) => e.type === 'comment');
      expect(commentEntry?.completion).toEqual({});
    } finally {
      dropTask(TICKET);
    }
  });

  it('change_status: an empty completion object is stored as empty, not dropped', async () => {
    const TICKET = 'COMPLETION-CS-4';
    await seedTask(TICKET, 'Todo');
    try {
      const res = await callTool({
        name: 'change_status',
        arguments: { ticketId: TICKET, newStatus: 'Ready', comment: 'Done.', completion: {} },
      });
      expect(res.isError).toBeFalsy();
      const history = tasksCache[TICKET].history as HistoryEntryLike[];
      const commentEntry = history.find((e) => e.type === 'comment');
      expect(commentEntry?.completion).toEqual({});
    } finally {
      dropTask(TICKET);
    }
  });

  it('finish_ticket: persists completion on the completion comment entry for a branchless ticket', async () => {
    const TICKET = 'COMPLETION-FT-1';
    // A baselineCommit that doesn't resolve keeps captureDiff a safe no-op (returns null, no
    // sidecar write) without needing real branch/commit state for this test.
    await seedTask(TICKET, 'Ready', { baselineCommit: 'not-a-real-commit-for-test' });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: {
          ticketId: TICKET,
          implementationLink: 'abc1234',
          completionComment: 'Finished.',
          completion: { decisions: ['Shipped as a branchless change.'] },
        },
      });
      expect(res.isError).toBeFalsy();
      const task = tasksCache[TICKET];
      expect(task.status).toBe('Done');
      const history = task.history as HistoryEntryLike[];
      const commentEntry = history.find((e) => e.type === 'comment' && e.comment === 'Finished.');
      expect(commentEntry?.completion).toEqual({ decisions: ['Shipped as a branchless change.'] });
    } finally {
      dropTask(TICKET);
    }
  });

  it('finish_ticket: omitting completion is a fully backward-compatible no-op', async () => {
    const TICKET = 'COMPLETION-FT-2';
    await seedTask(TICKET, 'Ready', { baselineCommit: 'not-a-real-commit-for-test' });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Finished.' },
      });
      expect(res.isError).toBeFalsy();
      const history = tasksCache[TICKET].history as HistoryEntryLike[];
      const commentEntry = history.find((e) => e.type === 'comment' && e.comment === 'Finished.');
      expect(commentEntry && 'completion' in commentEntry).toBe(false);
    } finally {
      dropTask(TICKET);
    }
  });
});

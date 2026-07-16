// FLUX-1443: server-side, framework-agnostic guards refusing `branch(action:'create')` and
// `finish_ticket` for a Scratch ticket (task.kind === 'scratch') — the two structural hard-blocks
// that close the "scratch implements solo" hole regardless of which CLI adapter is driving the
// session (unlike the FILE_MUTATION_TOOLS gate, which is Claude-Code-only enforcement — see
// claude-code-disallowed-tools.test.ts). Follows the in-memory `client.callTool(...)` round-trip
// pattern from merge-lock-mcp.test.ts.
import { getWorkspace } from './workspace-context.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

describe('Scratch ticket guards — branch(create) / finish_ticket (FLUX-1443)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;
  let fluxDir: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-scratch-guard-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-scratch-guard-'));
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

  function textOf(res: CallToolResult): string {
    const first = res.content[0];
    return first && first.type === 'text' ? (first.text as string) : '';
  }

  async function seedTask(id: string, extra: Record<string, unknown> = {}) {
    const frontmatter = {
      id,
      title: `scratch guard test ${id}`,
      status: 'Todo',
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

  function dropTask(id: string) {
    delete getWorkspace().tasks[id];
  }

  it('refuses branch(action:"create") for a scratch-kind ticket, pointing at extract_ticket', async () => {
    const TICKET = 'SCRATCHGUARD-1';
    await seedTask(TICKET, { kind: 'scratch' });
    try {
      const res = await callTool({
        name: 'branch',
        arguments: { ticketId: TICKET, action: 'create' },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Scratch ticket');
      expect(textOf(res)).toContain('extract_ticket');
      expect(getWorkspace().tasks[TICKET].branch).toBeUndefined();
    } finally {
      dropTask(TICKET);
    }
  });

  it('refuses finish_ticket for a scratch-kind ticket, pointing at extract_ticket', async () => {
    const TICKET = 'SCRATCHGUARD-2';
    await seedTask(TICKET, { kind: 'scratch', status: 'Ready' });
    try {
      const res = await callTool({
        name: 'finish_ticket',
        arguments: { ticketId: TICKET, implementationLink: 'abc1234', completionComment: 'Done.' },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('Scratch ticket');
      expect(textOf(res)).toContain('extract_ticket');
      expect(getWorkspace().tasks[TICKET].status).toBe('Ready'); // refused before any transition
    } finally {
      dropTask(TICKET);
    }
  });

  it('does not refuse branch(action:"create") for a non-scratch ticket on the kind check (fails later, on real git ops)', async () => {
    const TICKET = 'SCRATCHGUARD-3';
    await seedTask(TICKET);
    try {
      const res = await callTool({
        name: 'branch',
        arguments: { ticketId: TICKET, action: 'create' },
      });
      // No workspace git repo in this temp root, so branch creation itself fails downstream —
      // the assertion here is only that it does NOT fail with the scratch-guard message.
      expect(textOf(res)).not.toContain('Scratch ticket');
    } finally {
      dropTask(TICKET);
    }
  });
});

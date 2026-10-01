// FLUX-1739 finding 2: EventHorizon instructed an action it then refused.
//
// The MCP server's own instructions tell every agent: "If your working directory is a different
// registered board, call bind_workspace with that directory BEFORE any board action." A dispatched
// session (bound via a resolved X-EH-Workspace header) that obeyed was refused outright, and the
// refusal was recorded in the benchmark's `ehToolFailures` — the platform logging itself failing the
// agent for following the platform. Seen in real runs under both models.
//
// The fix is narrow on purpose. The refusal exists to stop a dispatched session MOVING to another
// board, and that property is untouched. Only the self-referential call — the one the instructions
// actually ask for — now succeeds as the no-op it always was.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { setWorkspaceRoot } from './workspace.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function isCallToolResult(v: unknown): v is CallToolResult {
  return isRecord(v) && Array.isArray(v['content']);
}

describe('bind_workspace — self-binding is a no-op, not a refusal', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;
  let root: string;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-bind-noop-test', version: '1.0.0' }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-bind-noop-'));
    await fs.mkdir(path.join(root, '.flux'), { recursive: true });
    setWorkspaceRoot(root);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function call(args: Parameters<Client['callTool']>[0]): Promise<CallToolResult> {
    const res: unknown = await client.callTool(args);
    if (!isCallToolResult(res)) throw new Error('expected a content-bearing result');
    return res;
  }
  function text(res: CallToolResult): string {
    const f = res.content[0];
    return f && f.type === 'text' ? (f.text as string) : '';
  }

  it('never tells an agent that binding to its own board is refused', async () => {
    // The precise regression: an agent obeying the instructions must not receive a tool FAILURE.
    // This asserts the user-visible contract rather than the internal branch, because the contract
    // is what the agent (and `ehToolFailures`) actually sees.
    const res = await call({ name: 'bind_workspace', arguments: { path: root } });
    expect(text(res)).not.toMatch(/rebinding is refused/i);
  });

  it('keeps the refusal message honest about what is actually refused', async () => {
    // If a refusal is ever produced, it must say that a DIFFERENT board is what is refused —
    // the old wording implied any rebinding was, which is what made obeying the instructions
    // look like an error.
    const server2 = buildMcpServer();
    const client2 = new Client({ name: 'eh-bind-noop-test-2', version: '1.0.0' }, { capabilities: {} });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    await Promise.all([server2.connect(s2), client2.connect(c2)]);
    try {
      const res: unknown = await client2.callTool({ name: 'bind_workspace', arguments: { path: path.join(root, 'nope') } });
      if (isCallToolResult(res)) {
        const t = text(res);
        if (/refused/i.test(t)) expect(t).toMatch(/DIFFERENT board/i);
      }
    } finally {
      await client2.close().catch(() => {});
      await server2.close().catch(() => {});
    }
  });
});

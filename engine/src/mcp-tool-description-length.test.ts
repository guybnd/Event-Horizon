import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';

/**
 * FLUX-1386: keeps every tool description at or under 50 words so incident-history
 * prose doesn't creep back in and re-bill every session spawn. Rationale/history
 * belongs in .docs/event-horizon/reference/mcp-tools.md, not the tool description.
 */
const MAX_WORDS = 50;

describe('MCP tool description word budget (FLUX-1386)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  beforeAll(async () => {
    server = buildMcpServer();
    client = new Client({ name: 'eh-tool-description-length-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  it(`every tool description is ≤${MAX_WORDS} words`, async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const overBudget = tools
      .map((tool) => ({ name: tool.name, words: (tool.description ?? '').trim().split(/\s+/).filter(Boolean).length }))
      .filter((t) => t.words > MAX_WORDS);

    expect(overBudget, `tools over the ${MAX_WORDS}-word budget: ${JSON.stringify(overBudget)}`).toEqual([]);
  });
});

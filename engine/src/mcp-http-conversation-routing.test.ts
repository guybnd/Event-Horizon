import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { handleMcpHttpRequest } from './mcp-server.js';
import { signConversation } from './session-binding.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || !('text' in first)) throw new Error('expected text content');
  return first.text;
}

/**
 * FLUX-1213: the `event-horizon` MCP server is ONE shared HTTP mount (FLUX-645) — every session
 * (board orchestrator + every dispatched ticket) connects to the same `/mcp` URL. Before this fix,
 * `ask_user_question`/`permission_prompt`/`propose_board_rebase` read the caller's identity from
 * `process.env.EH_CONVERSATION_ID`/`TOKEN` — the ENGINE's own process-global env, not any
 * particular HTTP session's — so every dispatched ticket's prompt silently misrouted to
 * `__board__`. The fix threads each session's bound identity as `x-eh-conversation-id`/
 * `x-eh-conversation-token` HTTP headers (set per-session at spawn time — see
 * eventHorizonSpawnOverride in agents/claude-code.ts) and reads them back per-request via an
 * AsyncLocalStorage context set in `handleMcpHttpRequest`. These tests exercise the REAL HTTP
 * transport (not InMemoryTransport) so two concurrent per-ticket connections prove out isolation.
 */
describe('MCP HTTP per-session conversation routing (FLUX-1213)', () => {
  let server: http.Server;
  let baseUrl: URL;
  let capturedRequests: Array<{ url: string; body: Record<string, unknown> }>;

  beforeAll(async () => {
    // Stub the outbound fetch calls the tool handlers make to the engine's own HITL routes —
    // same boundary permission-prompt-normalize.test.ts mocks at — capturing what conversationId/
    // conversationToken each tool call resolved to, without needing the full index.ts express app.
    // The SDK's own StreamableHTTPClientTransport ALSO calls the global fetch (to reach our real
    // test HTTP server below) — pass anything that isn't one of the mcp-server.ts HITL routes
    // through to the real fetch instead of treating it as unexpected.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string; headers?: unknown; method?: string }) => {
      const isHitlRoute = /\/api\/board\/(ask-question|permission-request|board-rebase)$/.test(String(url));
      if (!isHitlRoute) return realFetch(url as string, init as RequestInit);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      capturedRequests.push({ url: String(url), body });
      if (String(url).includes('/api/board/ask-question')) {
        return { ok: true, json: async () => ({ answers: {} }) };
      }
      if (String(url).includes('/api/board/permission-request')) {
        return { ok: true, json: async () => ({ behavior: 'allow' }) };
      }
      return { ok: true, json: async () => ({ id: 'batch-1', count: 1 }) };
    });

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
    vi.unstubAllGlobals();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    capturedRequests = [];
  });

  async function connectClient(conversationId?: string): Promise<Client> {
    const headers = conversationId
      ? { 'x-eh-conversation-id': conversationId, 'x-eh-conversation-token': signConversation(conversationId) }
      : undefined;
    const transport = new StreamableHTTPClientTransport(baseUrl, headers ? { requestInit: { headers } } : undefined);
    const client = new Client({ name: `eh-routing-test-${conversationId ?? 'unbound'}`, version: '1.0.0' }, { capabilities: {} });
    // Cast: same exactOptionalPropertyTypes/sessionId mismatch mcp-schema-probe.ts casts around —
    // StreamableHTTPClientTransport genuinely implements Transport.
    await client.connect(transport as Transport);
    return client;
  }

  async function askQuestion(client: Client): Promise<void> {
    const raw: unknown = await client.callTool({
      name: 'ask_user_question',
      arguments: {
        questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    });
    if (!isCallToolResult(raw)) throw new Error('expected a content-bearing tool result');
    textOf(raw); // consume — the assertion is on the captured outgoing fetch, not the tool's own reply
  }

  it('two concurrent per-ticket sessions each route ask_user_question to their OWN ticket, never to each other', async () => {
    capturedRequests = [];
    const [clientA, clientB] = await Promise.all([connectClient('FLUX-AAA'), connectClient('FLUX-BBB')]);
    try {
      await Promise.all([askQuestion(clientA), askQuestion(clientB)]);
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }

    const askCalls = capturedRequests.filter((r) => r.url.includes('/api/board/ask-question'));
    expect(askCalls).toHaveLength(2);
    const ids = askCalls.map((r) => r.body.conversationId).sort();
    expect(ids).toEqual(['FLUX-AAA', 'FLUX-BBB']);
  });

  it('permission_prompt carries this session\'s OWN conversationId + a token that verifies for it (and only it)', async () => {
    capturedRequests = [];
    const client = await connectClient('FLUX-CCC');
    try {
      const raw: unknown = await client.callTool({ name: 'permission_prompt', arguments: { tool_name: 'Bash', input: { command: 'ls' } } });
      if (!isCallToolResult(raw)) throw new Error('expected a content-bearing tool result');
    } finally {
      await client.close().catch(() => {});
    }

    const call = capturedRequests.find((r) => r.url.includes('/api/board/permission-request'));
    expect(call?.body.conversationId).toBe('FLUX-CCC');
    expect(call?.body.conversationToken).toBe(signConversation('FLUX-CCC'));
  });

  it('a session with no bound identity (no headers) is unrouted — conversationId is null, not the engine\'s own env', async () => {
    capturedRequests = [];
    // Guard against the test host process happening to carry these — would falsely "pass" via the
    // process.env fallback instead of proving the ALS-context-present-but-empty path is exercised.
    const savedId = process.env.EH_CONVERSATION_ID;
    const savedToken = process.env.EH_CONVERSATION_TOKEN;
    delete process.env.EH_CONVERSATION_ID;
    delete process.env.EH_CONVERSATION_TOKEN;
    try {
      const client = await connectClient(undefined);
      try {
        await askQuestion(client);
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      if (savedId !== undefined) process.env.EH_CONVERSATION_ID = savedId;
      if (savedToken !== undefined) process.env.EH_CONVERSATION_TOKEN = savedToken;
    }

    const call = capturedRequests.find((r) => r.url.includes('/api/board/ask-question'));
    expect(call?.body.conversationId).toBeNull();
  });

  it('the board orchestrator session (__board__) still routes to __board__', async () => {
    capturedRequests = [];
    const client = await connectClient('__board__');
    try {
      await askQuestion(client);
    } finally {
      await client.close().catch(() => {});
    }

    const call = capturedRequests.find((r) => r.url.includes('/api/board/ask-question'));
    expect(call?.body.conversationId).toBe('__board__');
  });
});

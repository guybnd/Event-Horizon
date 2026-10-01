import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, ElicitRequestFormParamsSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';
import { getWorkspace } from './workspace-context.js';

// FLUX-1774: no real filesystem fixture needed — `appendTranscriptEvent` is mocked so the
// transcript round-trip is asserted without a workspace root, keeping this file in the fast
// `unit` tier (no `engine/test-tiers.json` entry required, same as mcp-prompts.test.ts and
// mcp-http-conversation-routing.test.ts, which this file is modeled on).
const appendTranscriptEvent = vi.fn();
vi.mock('./transcript.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transcript.js')>();
  return { ...actual, appendTranscriptEvent: (...args: unknown[]) => appendTranscriptEvent(...args) };
});

function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content);
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || !('text' in first)) throw new Error('expected text content');
  return first.text as string;
}

async function askProceed(
  client: Client,
  opts: { multiSelect?: boolean } = {},
): Promise<CallToolResult> {
  const raw: unknown = await client.callTool({
    name: 'ask_user_question',
    arguments: {
      questions: [{
        question: 'Proceed?',
        header: 'Confirm',
        options: [{ label: 'Yes', description: 'Go ahead' }, { label: 'No' }],
        ...(opts.multiSelect ? { multiSelect: true } : {}),
      }],
    },
  });
  if (!isCallToolResult(raw)) throw new Error('expected a content-bearing tool result');
  return raw;
}

/**
 * FLUX-1774: `ask_user_question`'s channel precedence rules 2-4 — an MCP client with no
 * EH-spawned conversation binding (no `x-eh-conversation-id`/token, i.e. this test's InMemoryTransport
 * connection, same as an unrouted manual MCP client) either elicits directly (rule 2, if the client
 * advertises `elicitation`), parks via the portal (rule 3, covered by the pre-existing REST-hop
 * tests), or fails fast (rule 4). Rule 1 (an EH-spawned session keeps the durable portal park even
 * when the client also advertises elicitation) is covered separately in
 * mcp-http-conversation-routing.test.ts, which exercises the real per-session conversation binding
 * these InMemoryTransport clients don't carry.
 */
describe('ask_user_question elicitation channel precedence (FLUX-1774)', () => {
  // Guard against the host process's OWN env carrying EH_CONVERSATION_ID/TOKEN (true whenever
  // this suite runs inside an EH-spawned agent session, e.g. this very ticket's implementation
  // session) — getBoundConversation() falls back to process.env with no ALS context (the case for
  // these InMemoryTransport connections), and a real bound identity would make `ehSpawned` true,
  // routing every call through rule 1's `fetch()` to a nonexistent engine instead of the elicitation
  // path under test. Same guard mcp-http-conversation-routing.test.ts uses for the same reason.
  let savedEnv: Record<string, string | undefined>;
  const ENV_KEYS = ['EH_CONVERSATION_ID', 'EH_CONVERSATION_TOKEN', 'EH_SESSION_ID', 'EH_SESSION_TOKEN'] as const;

  beforeEach(() => {
    appendTranscriptEvent.mockClear();
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]; else delete process.env[k];
    }
  });

  /** A fresh server per connection — an McpServer/Protocol instance can only ever bind one
   *  transport, so a shared server across tests throws "Already connected to a transport" on the
   *  second connect(). Returns both halves so the caller can close the server after the client. */
  async function connect(capabilities: Record<string, unknown>): Promise<{ client: Client; server: ReturnType<typeof buildMcpServer> }> {
    const server = buildMcpServer();
    const client = new Client({ name: 'eh-elicit-test', version: '1.0.0' }, { capabilities });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }

  it('elicits via elicitation/create, validates against the SDK schema, and maps the accepted answer back to the portal shape', async () => {
    const { client, server } = await connect({ elicitation: {} });
    try {
      let seenParams: unknown;
      client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
        seenParams = request.params;
        // Confirms buildElicitationRequest's hand-built schema is valid per the installed SDK —
        // the "unit-test buildElicitationRequest against ElicitRequestFormParamsSchema" the plan
        // recommends, exercised through the real wire request rather than the (private) helper.
        expect(() => ElicitRequestFormParamsSchema.parse(request.params)).not.toThrow();
        return { action: 'accept', content: { q0: 'Yes' } };
      });

      const result = await askProceed(client);
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual({ answers: { 'Proceed?': 'Yes' } });

      const params = seenParams as { message: string; requestedSchema: { properties: Record<string, unknown> } };
      expect(params.message).toBe('Proceed?');
      expect(params.requestedSchema.properties.q0).toMatchObject({
        type: 'string',
        title: 'Confirm',
        description: 'Proceed?',
        enum: ['Yes', 'No'],
        enumNames: ['Yes — Go ahead', 'No'],
      });

      // Transcript round-trip: recorded on the __board__ stream (no bound conversation) even
      // though no fetch was ever parked.
      expect(appendTranscriptEvent).toHaveBeenCalledWith('__board__', expect.objectContaining({ type: 'ask-question' }));
      expect(appendTranscriptEvent).toHaveBeenCalledWith('__board__', expect.objectContaining({
        type: 'ask-answer', answers: { 'Proceed?': 'Yes' },
      }));
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it('multiSelect: array-enum property elicits and returns string[]', async () => {
    const { client, server } = await connect({ elicitation: {} });
    try {
      client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
        const parsed = ElicitRequestFormParamsSchema.parse(request.params);
        const q0 = (parsed.requestedSchema.properties as Record<string, { type: string }>).q0;
        expect(q0?.type).toBe('array');
        return { action: 'accept', content: { q0: ['Yes'] } };
      });

      const result = await askProceed(client, { multiSelect: true });
      expect(JSON.parse(textOf(result))).toEqual({ answers: { 'Proceed?': ['Yes'] } });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it.each(['decline', 'cancel'] as const)('%s yields the existing unanswered text, not an error', async (action) => {
    const { client, server } = await connect({ elicitation: {} });
    try {
      client.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => ({ action }));
      const result = await askProceed(client);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('did not answer in time');
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it('junk accepted content (no recognizable option label) also yields the unanswered text', async () => {
    const { client, server } = await connect({ elicitation: {} });
    try {
      client.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => ({ action: 'accept', content: { q0: 'not-an-option' } }));
      const result = await askProceed(client);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('did not answer in time');
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it('no elicitation capability + no portal SSE client watching the board: immediate channel_unavailable, no park', async () => {
    expect(getWorkspace().sseClients.size).toBe(0);
    const { client, server } = await connect({});
    try {
      const result = await askProceed(client);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: 'channel_unavailable' });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});

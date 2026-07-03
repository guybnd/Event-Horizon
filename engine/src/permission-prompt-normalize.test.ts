import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from './mcp-server.js';

/**
 * FLUX-1026: the human-resolved approval forward path in `permission_prompt` must always return a
 * decision that satisfies Claude Code's permission-prompt-tool contract — {behavior:'allow',
 * updatedInput:<record>} or {behavior:'deny', message:<string>}. A human ALLOW is POSTed to the
 * resolve endpoint WITHOUT updatedInput, so the held /permission-request fetch resolves to a bare
 * {behavior:'allow'}. Forwarding that verbatim crashed the CLI with a Zod invalid_union. These tests
 * mock the approval-channel fetch and assert the tool normalizes every case at the CLI boundary.
 */
describe('permission_prompt normalization (FLUX-1026)', () => {
  let client: Client;
  let server: ReturnType<typeof buildMcpServer>;

  // Reply the mocked approval-channel fetch will return for the next call.
  let nextReply: { ok: boolean; body: unknown };

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (url: any) => {
      // Only the approval-request round-trip is exercised here.
      if (String(url).includes('/api/board/permission-request')) {
        return {
          ok: nextReply.ok,
          json: async () => nextReply.body,
        } as any;
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    server = buildMcpServer();
    client = new Client({ name: 'eh-perm-normalize-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    nextReply = undefined as any;
  });

  // `Bash` is confirm-tier → permission_prompt falls through to the approval-channel fetch.
  const decide = async (input: unknown) => {
    const res: any = await client.callTool({
      name: 'permission_prompt',
      arguments: { tool_name: 'Bash', input },
    });
    return JSON.parse(res.content?.[0]?.text);
  };

  it('human ALLOW without updatedInput → echoes the original tool input (no Zod crash)', async () => {
    nextReply = { ok: true, body: { behavior: 'allow' } };
    const decision = await decide({ command: 'npm run check' });
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'npm run check' } });
  });

  it('ALLOW with an explicit updatedInput is preserved (edited-input path)', async () => {
    nextReply = { ok: true, body: { behavior: 'allow', updatedInput: { command: 'ls' } } };
    const decision = await decide({ command: 'rm -rf /' });
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('ALLOW with undefined input still yields a record ({}), never a missing key', async () => {
    nextReply = { ok: true, body: { behavior: 'allow' } };
    const decision = await decide(undefined);
    expect(decision).toEqual({ behavior: 'allow', updatedInput: {} });
  });

  it('DENY with a message is forwarded as-is', async () => {
    nextReply = { ok: true, body: { behavior: 'deny', message: 'nope' } };
    const decision = await decide({ command: 'ls' });
    expect(decision).toEqual({ behavior: 'deny', message: 'nope' });
  });

  it('DENY without a message gets a valid default message', async () => {
    nextReply = { ok: true, body: { behavior: 'deny' } };
    const decision = await decide({ command: 'ls' });
    expect(decision.behavior).toBe('deny');
    expect(typeof decision.message).toBe('string');
    expect(decision.message.length).toBeGreaterThan(0);
  });

  it('malformed/empty approval body → a valid deny (never an unschema-able allow)', async () => {
    nextReply = { ok: true, body: null };
    const decision = await decide({ command: 'ls' });
    expect(decision.behavior).toBe('deny');
    expect(typeof decision.message).toBe('string');
  });

  it('non-ok approval channel → a valid deny', async () => {
    nextReply = { ok: false, body: null };
    const decision = await decide({ command: 'ls' });
    expect(decision.behavior).toBe('deny');
    expect(typeof decision.message).toBe('string');
  });
});

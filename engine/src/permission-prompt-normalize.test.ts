import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer } from './mcp-server.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `Client.callTool()`'s declared return type is a wider union than the SDK's own exported
 *  `CallToolResult` (it also allows a legacy `{ toolResult }`-only shape) — narrow it here with a
 *  runtime shape check instead of trusting every call site to remember a cast. */
function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value['content']);
}

/** Narrow the content-block union down to the 'text' variant this tool always returns. */
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (!first || !('text' in first)) throw new Error('expected text content');
  return first.text;
}

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
  let nextReply: { ok: boolean; body: unknown } | undefined;

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      // Only the approval-request round-trip is exercised here.
      if (String(url).includes('/api/board/permission-request')) {
        return {
          ok: nextReply!.ok,
          json: async () => nextReply!.body,
        };
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
    nextReply = undefined;
  });

  // `Bash` is confirm-tier → permission_prompt falls through to the approval-channel fetch.
  const decide = async (input: unknown) => {
    const raw: unknown = await client.callTool({
      name: 'permission_prompt',
      arguments: { tool_name: 'Bash', input },
    });
    if (!isCallToolResult(raw)) throw new Error('expected a content-bearing tool result');
    return JSON.parse(textOf(raw));
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
